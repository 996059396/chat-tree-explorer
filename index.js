/**
 * Chat Tree Explorer - a SillyTavern / TauriTavern third-party extension.
 *
 * Shows every chat of one character card as a single tree:
 *   - chats that share the same context are merged into one trunk
 *   - different player choices become side branches
 *   - every generated alternative (swipe) of an assistant turn becomes a
 *     variant of that turn, with its own downstream branches
 *
 * Everything runs locally in the browser: chat payloads are read through the
 * regular SillyTavern HTTP API, nothing is uploaded and nothing is cached on
 * disk.
 */

import { buildChatTree, parseChatPayload, normalizeForCompare, clearFingerprintCache } from './tree-core.js';
import { buildSpatialModel } from './spatial-layout.js';
import { SpatialView } from './spatial-view.js';
import { plainTextForDisplay } from './spatial-text.js';

const EXT_ID = 'chat-tree-explorer';
const STORAGE_KEY = 'chat-tree-explorer:settings:v1';
const ROLE_LABELS = { user: '你', assistant: 'AI', system: '系统', root: '根' };

const DEFAULT_SETTINGS = {
    includeSystem: true,
    mergeSimilar: true,
    threshold: 0.82,
    compressChains: true,
    chainMin: 6,
    activeVariantOnly: false,
    branchOrder: 'recent',
    showColors: true,
    viewMode: 'spatial',
    spatialHideStructured: true,
    spatialHideSystem: true,
    spatialShowAnchors: true,
    spatialShowMinimap: true,
    spatialTimeMode: 'turn',
    spatialLaneScope: 'layer',
    spatialShowAllStrands: false,
    spatialAutoRotate: false,
};

const state = {
    overlay: null,
    els: {},
    characters: [],
    character: null,
    chatList: [],
    selectedFiles: new Set(),
    parsed: new Map(),
    errors: [],
    tree: null,
    chatInfo: new Map(),
    nodeVariant: new Map(),
    collapsed: new Set(),
    expandedChains: new Set(),
    selectedNodeId: null,
    searchQuery: '',
    matches: null,
    matchOrder: [],
    rowById: new Map(),
    loading: false,
    abortController: null,
    fileLoadController: null,
    loadToken: 0,
    loadSeq: 0,
    spatial: null,
    spatialModel: null,
    focusChatKey: null,
    expandedSegments: new Set(),
    rebuildTimer: null,
    searchTimer: null,
    settings: loadSettings(),
};

/* -------------------------------------------------------------------------- */
/* Small helpers                                                               */
/* -------------------------------------------------------------------------- */

function h(tag, className, text) {
    const element = document.createElement(tag);
    if (className) {
        element.className = className;
    }
    if (text !== undefined && text !== null) {
        element.textContent = String(text);
    }
    return element;
}

function getContext() {
    try {
        return window.SillyTavern?.getContext?.() || null;
    } catch {
        return null;
    }
}

function loadSettings() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) {
            return { ...DEFAULT_SETTINGS };
        }
        const parsed = JSON.parse(raw);
        const merged = { ...DEFAULT_SETTINGS, ...(parsed || {}) };

        // Values from older versions / hand-edited storage must never break
        // the range input or the tree builder.
        merged.threshold = Math.min(1, Math.max(0.55, Number(merged.threshold) || DEFAULT_SETTINGS.threshold));
        merged.chainMin = Math.max(2, Number(merged.chainMin) || DEFAULT_SETTINGS.chainMin);
        merged.includeSystem = Boolean(merged.includeSystem);
        merged.mergeSimilar = Boolean(merged.mergeSimilar);
        merged.compressChains = Boolean(merged.compressChains);
        merged.activeVariantOnly = Boolean(merged.activeVariantOnly);
        merged.showColors = Boolean(merged.showColors);
        merged.branchOrder = merged.branchOrder === 'oldest' ? 'oldest' : 'recent';
        merged.viewMode = merged.viewMode === 'tree' ? 'tree' : 'spatial';
        merged.spatialHideStructured = Boolean(merged.spatialHideStructured);
        merged.spatialHideSystem = Boolean(merged.spatialHideSystem);
        merged.spatialShowAnchors = Boolean(merged.spatialShowAnchors);
        merged.spatialShowMinimap = Boolean(merged.spatialShowMinimap);
        merged.spatialTimeMode = merged.spatialTimeMode === 'timestamp' ? 'timestamp' : 'turn';
        merged.spatialLaneScope = merged.spatialLaneScope === 'global' ? 'global' : 'layer';
        merged.spatialShowAllStrands = Boolean(merged.spatialShowAllStrands);
        merged.spatialAutoRotate = Boolean(merged.spatialAutoRotate);

        return merged;
    } catch {
        return { ...DEFAULT_SETTINGS };
    }
}

function saveSettings() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state.settings));
    } catch {
        // Storage may be unavailable in private mode - settings are optional.
    }
}

function toast(message, type = 'info') {
    const fn = window.toastr?.[type];
    if (typeof fn === 'function') {
        fn(message);
    } else {
        console.info(`[${EXT_ID}] ${message}`);
    }
}

function stripExtension(fileName) {
    return String(fileName || '').replace(/\.jsonl$/i, '');
}

function normalizeTimestamp(value) {
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed && !/^\d+(?:\.\d+)?$/.test(trimmed)) {
            const parsed = Date.parse(trimmed);
            if (Number.isFinite(parsed) && parsed > 0) {
                return parsed;
            }
        }
    }

    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) {
        return 0;
    }
    // Some builds report seconds, others milliseconds.
    return numeric < 1e11 ? numeric * 1000 : numeric;
}

function formatDate(value) {
    const time = Number(value);
    if (!time) {
        return '';
    }
    try {
        return new Intl.DateTimeFormat('zh-CN', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
        }).format(new Date(time));
    } catch {
        return '';
    }
}

function snippet(text, limit = 200) {
    const value = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (!value) {
        return '（空消息）';
    }
    return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

function requestHeaders() {
    try {
        const headers = getContext()?.getRequestHeaders?.();
        if (typeof Headers !== 'undefined' && headers instanceof Headers) {
            return Object.fromEntries(headers.entries());
        }
        if (headers && typeof headers === 'object') {
            return { ...headers };
        }
    } catch {
        // fall through
    }
    return { 'Content-Type': 'application/json' };
}

async function postJson(url, body, signal) {
    const response = await fetch(url, {
        method: 'POST',
        headers: requestHeaders(),
        body: JSON.stringify(body ?? {}),
        signal,
        credentials: 'same-origin',
    });

    if (!response.ok) {
        let detail = '';
        try {
            const data = await response.json();
            detail = data?.error || data?.details || '';
        } catch {
            // keep empty detail
        }
        throw new Error(`${url} → HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
    }

    return response.json();
}

/* -------------------------------------------------------------------------- */
/* Data loading                                                                */
/* -------------------------------------------------------------------------- */

async function loadCharacters() {
    const ctx = getContext();
    let list = Array.isArray(ctx?.characters) ? ctx.characters.filter(Boolean) : [];

    if (!list.length) {
        try {
            const response = await postJson('/api/characters/all', {});
            if (Array.isArray(response)) {
                list = response.filter(Boolean);
            }
        } catch (error) {
            console.warn(`[${EXT_ID}] character list failed`, error);
        }
    }

    return list
        .map((raw) => ({
            name: String(raw.name ?? raw.display_name ?? ''),
            avatar: String(raw.avatar ?? ''),
            chat: String(raw.chat ?? ''),
        }))
        .filter((character) => character.avatar || character.name);
}

function findCurrentCharacter(list) {
    const ctx = getContext();
    const raw = Array.isArray(ctx?.characters) ? ctx.characters : [];
    const index = Number(ctx?.characterId);
    const currentRaw = Number.isInteger(index) && index >= 0 ? raw[index] : null;

    if (currentRaw?.avatar) {
        const match = list.find((character) => character.avatar === currentRaw.avatar);
        if (match) {
            return match;
        }
    }

    const name = String(ctx?.name2 || '');
    return list.find((character) => character.name === name) || null;
}

async function loadChatList(character, signal) {
    const response = await postJson('/api/characters/chats', {
        avatar_url: character.avatar,
        ch_name: character.name,
        simple: false,
    }, signal);

    const items = Array.isArray(response) ? response : [];

    return items
        .map((item) => {
            const file = String(item.file_name || (item.file_id ? `${item.file_id}.jsonl` : '')).trim();
            return {
                file,
                size: Number(item.file_size) || 0,
                messages: Number(item.chat_items ?? item.message_count) || 0,
                date: normalizeTimestamp(item.last_mes ?? item.last_message_date),
            };
        })
        .filter((chat) => chat.file)
        .sort((a, b) => (b.date - a.date) || a.file.localeCompare(b.file));
}

async function loadChatFile(character, chat, signal) {
    const payload = await postJson('/api/chats/get', {
        avatar_url: character.avatar,
        ch_name: character.name,
        // Both TauriTavern and SillyTavern strip a trailing .jsonl, but other
        // tools (JS-Slash-Runner) send the bare stem; match that convention.
        file_name: stripExtension(chat.file),
    }, signal);

    return parseChatPayload(payload, {
        key: chat.file,
        file: chat.file,
        name: stripExtension(chat.file),
        date: chat.date,
    });
}

/**
 * Resolve branch lineage (chat → main chat) so branches can be grouped and
 * coloured by their root conversation.
 */
const CJK_STOP_BIGRAMS = new Set([
    '的是', '一个', '我们', '你们', '他们', '这个', '那个', '什么', '怎么', '没有',
    '可以', '就是', '因为', '所以', '但是', '如果', '然后', '现在', '这样', '那样',
    '知道', '觉得', '时候', '已经', '还是', '只是', '不是', '不能', '不会', '一起',
    '这里', '那里', '起来', '出来', '过来', '下去', '一下', '有点', '自己', '其实',
    '真的', '不过', '而且', '或者', '虽然', '于是', '开始', '继续', '看到', '听见',
    '说道', '看着', '看着', '身边', '面前', '心中', '似乎', '仿佛', '突然', '立刻',
]);

const LATIN_STOPWORDS = new Set([
    'the', 'and', 'you', 'that', 'was', 'for', 'are', 'with', 'his', 'her', 'she',
    'him', 'they', 'them', 'this', 'have', 'from', 'not', 'but', 'what', 'when',
    'your', 'just', 'like', 'very', 'will', 'would', 'could', 'should', 'there',
    'their', 'about', 'into', 'then', 'than', 'been', 'were', 'said', 'says',
]);

function hashText(text) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
}

function signatureTokens(text) {
    const normalized = normalizeForCompare(text).slice(0, 6000);
    const tokens = new Set();
    for (const word of normalized.match(/[a-z0-9_]{2,}/g) || []) {
        if (word.length <= 24 && !LATIN_STOPWORDS.has(word)) {
            tokens.add(word);
        }
    }
    for (const run of normalized.match(/[\p{Script=Han}]{2,}/gu) || []) {
        const chars = Array.from(run);
        for (let index = 0; index + 1 < chars.length; index++) {
            const bigram = chars[index] + chars[index + 1];
            if (!CJK_STOP_BIGRAMS.has(bigram)) {
                tokens.add(bigram);
            }
        }
    }
    return tokens;
}

/**
 * Per-chat recognition signature: distinctive tokens, a message barcode and
 * the first/last user + final message snippets. Real corpora show that most
 * chats share their greeting and even their last user turn, so a single
 * "unique message" anchor is not enough; the signature combines several cues.
 */
function computeChatSignatures() {
    const perChat = [];
    const documentFrequency = new Map();

    for (const chat of state.chatList) {
        const parsed = state.parsed.get(chat.file);
        if (!parsed) {
            continue;
        }
        const messages = parsed.messages.filter((message) => message.role !== 'system');
        const tokenCounts = new Map();
        for (const message of messages) {
            if (message.role !== 'user') {
                continue;
            }
            const tokens = signatureTokens(message.mes);
            for (const token of tokens) {
                tokenCounts.set(token, (tokenCounts.get(token) || 0) + 1);
            }
        }
        const tokenSet = new Set(tokenCounts.keys());
        for (const token of tokenSet) {
            documentFrequency.set(token, (documentFrequency.get(token) || 0) + 1);
        }

        const dialogue = messages.filter((message) => message.role === 'user' || message.role === 'assistant');
        const step = Math.max(1, Math.floor(dialogue.length / 14));
        const barcode = [];
        for (let index = 0; index < dialogue.length && barcode.length < 14; index += step) {
            const message = dialogue[index];
            const text = plainTextForDisplay(message.mes);
            barcode.push({
                role: message.role,
                hue: hashText(text) % 360,
                ratio: Math.min(1, Math.max(0.05, text.length / 1500)),
            });
        }

        const firstUser = messages.find((message) => message.role === 'user');
        let lastUser = null;
        let lastMessage = null;
        for (const message of messages) {
            if (message.role === 'user') {
                lastUser = message;
            }
            if (message.role !== 'system') {
                lastMessage = message;
            }
        }

        perChat.push({
            file: chat.file,
            tokenCounts,
            tokenSet,
            barcode,
            firstUser: plainTextForDisplay(firstUser?.mes, 220),
            lastUser: plainTextForDisplay(lastUser?.mes, 220),
            lastMessage: plainTextForDisplay(lastMessage?.mes, 220),
            lastMessageRole: lastMessage?.role || 'assistant',
        });
    }

    const chatCount = Math.max(1, perChat.length);
    const rareDf = Math.max(2, Math.ceil(chatCount * 0.06));
    const result = new Map();

    for (const entry of perChat) {
        const scored = [];
        for (const [token, count] of entry.tokenCounts) {
            const df = documentFrequency.get(token) || 1;
            if (df > rareDf || count < 2 || token.length < 2) {
                continue;
            }
            const score = count * (df <= 2 ? 3 : df <= 4 ? 2 : 1) / (1 + Math.log(1 + df));
            scored.push({ token, score, count, df });
        }
        scored.sort((a, b) => b.score - a.score || a.df - b.df || b.count - a.count);
        result.set(entry.file, {
            keywords: scored.slice(0, 3).map((item) => item.token),
            barcode: entry.barcode,
            firstUser: entry.firstUser,
            lastUser: entry.lastUser,
            lastMessage: entry.lastMessage,
            lastMessageRole: entry.lastMessageRole,
        });
    }
    return result;
}

function computeChatInfo() {
    const info = new Map();
    const signatures = computeChatSignatures();
    const byBase = new Map();

    for (const chat of state.chatList) {
        byBase.set(stripExtension(chat.file), chat);
    }

    const parentOf = new Map();
    for (const chat of state.chatList) {
        const base = stripExtension(chat.file);
        const parsed = state.parsed.get(chat.file);
        const main = parsed?.header?.chat_metadata?.main_chat;
        let parent = main ? stripExtension(String(main)) : '';

        if (!parent || parent === base) {
            // SillyTavern writes branch files in two conventions:
            //   "<root> - Branch #N"  and  "Branch #N - <root>"
            // plus the rare "Checkpoint #N - <root>".
            const suffix = base.match(/^(.*?)\s*-\s*(?:Branch|Checkpoint)\s*#\d+$/i);
            const prefix = base.match(/^(?:Branch|Checkpoint)\s*#\d+\s*-\s*(.+)$/i);
            const candidate = suffix ? suffix[1] : prefix ? prefix[1] : '';
            if (candidate && candidate !== base) {
                parent = candidate;
            }
        }

        if (parent && parent !== base && byBase.has(parent)) {
            parentOf.set(base, parent);
        }
    }

    const lineage = new Map();
    for (const chat of state.chatList) {
        const base = stripExtension(chat.file);
        const seen = new Set();
        let current = base;
        let depth = 0;
        while (parentOf.has(current) && !seen.has(current)) {
            seen.add(current);
            current = parentOf.get(current);
            depth++;
        }
        lineage.set(base, { root: current, depth });
    }

    const roots = new Set();
    for (const { root } of lineage.values()) {
        roots.add(root);
    }
    const rootList = Array.from(roots).sort();
    const hueOf = new Map();
    rootList.forEach((root, index) => {
        hueOf.set(root, (index * 137.508) % 360);
    });

    for (const chat of state.chatList) {
        const base = stripExtension(chat.file);
        const { root, depth } = lineage.get(base) || { root: base, depth: 0 };
        const hue = hueOf.get(root) ?? 0;
        info.set(chat.file, {
            ...(signatures.get(chat.file) || {}),
            base,
            file: chat.file,
            name: base,
            root,
            depth,
            hue,
            date: chat.date,
            dateLabel: formatDate(chat.date),
            messages: chat.messages,
            color: `hsl(${hue.toFixed(1)} 60% ${(56 + Math.min(depth, 4) * 5).toFixed(1)}%)`,
            rootColor: `hsl(${hue.toFixed(1)} 60% 56%)`,
        });
    }

    state.chatInfo = info;
}

/* -------------------------------------------------------------------------- */
/* Overlay shell                                                               */
/* -------------------------------------------------------------------------- */

function buildOverlay() {
    const overlay = document.createElement('div');
    overlay.id = 'ctv-overlay';
    overlay.className = 'ctv-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.innerHTML = `
        <div class="ctv-shell">
            <header class="ctv-header">
                <button class="ctv-icon-btn ctv-sidebar-toggle" title="聊天与选项" aria-label="聊天与选项"><i class="fa-solid fa-bars"></i></button>
                <div class="ctv-brand"><i class="fa-solid fa-sitemap"></i><span>聊天分支树</span></div>
                <div class="ctv-view-switch" role="tablist" aria-label="视图切换">
                    <button class="ctv-view-btn" data-view="spatial" role="tab">⌘ 空间</button>
                    <button class="ctv-view-btn" data-view="tree" role="tab">☰ 树</button>
                </div>
                <select class="ctv-select ctv-character" aria-label="选择角色卡"></select>
                <div class="ctv-focus-chip ctv-hidden">
                    <i class="ctv-dot"></i>
                    <span class="ctv-focus-name"></span>
                    <button class="ctv-focus-clear" title="取消聚焦">×</button>
                </div>
                <div class="ctv-header-spacer"></div>
                <button class="ctv-icon-btn ctv-reset-camera" title="重置空间视角" aria-label="重置空间视角"><i class="fa-solid fa-compass"></i></button>
                <button class="ctv-icon-btn ctv-reload" title="重新读取磁盘数据" aria-label="重新读取"><i class="fa-solid fa-rotate"></i></button>
                <button class="ctv-icon-btn ctv-close" title="关闭 (Esc)" aria-label="关闭"><i class="fa-solid fa-xmark"></i></button>
            </header>
            <div class="ctv-body">
                <aside class="ctv-sidebar">
                    <div class="ctv-stats"></div>
                    <div class="ctv-search-row">
                        <input type="search" class="ctv-search" placeholder="搜索消息内容…" aria-label="搜索消息内容" />
                        <div class="ctv-search-nav ctv-hidden">
                            <button class="ctv-link ctv-prev-match" title="上一个结果">‹</button>
                            <span class="ctv-match-count"></span>
                            <button class="ctv-link ctv-next-match" title="下一个结果">›</button>
                        </div>
                    </div>
                    <div class="ctv-section-head">
                        <span>聊天记录</span>
                        <span class="ctv-section-actions">
                            <button class="ctv-link ctv-select-all">全选</button>
                            <button class="ctv-link ctv-select-none">清空</button>
                        </span>
                    </div>
                    <div class="ctv-chat-list"></div>
                    <details class="ctv-options">
                        <summary>选项</summary>
                        <label class="ctv-option"><input type="checkbox" data-option="includeSystem" /> <span>包含系统消息</span></label>
                        <label class="ctv-option"><input type="checkbox" data-option="mergeSimilar" /> <span>合并高相似度消息</span></label>
                        <label class="ctv-option"><input type="checkbox" data-option="compressChains" /> <span>折叠连续楼层</span></label>
                        <label class="ctv-option"><input type="checkbox" data-option="activeVariantOnly" /> <span>只看当前变体的后续</span></label>
                        <label class="ctv-option"><input type="checkbox" data-option="showColors" /> <span>按聊天着色</span></label>
                        <label class="ctv-option ctv-range">
                            <span>相似度阈值 <b class="ctv-threshold-value"></b></span>
                            <input type="range" min="0.55" max="1" step="0.01" data-option="threshold" />
                        </label>
                        <label class="ctv-option">
                            <span>分支排序</span>
                            <select class="ctv-select ctv-small-select" data-option="branchOrder">
                                <option value="recent">最近活动</option>
                                <option value="oldest">最早出现</option>
                            </select>
                        </label>
                        <label class="ctv-option">
                            <span>时间轴</span>
                            <select class="ctv-select ctv-small-select" data-option="spatialTimeMode">
                                <option value="turn">楼层</option>
                                <option value="timestamp">真实时间</option>
                            </select>
                        </label>
                        <label class="ctv-option">
                            <span>车道范围</span>
                            <select class="ctv-select ctv-small-select" data-option="spatialLaneScope">
                                <option value="layer">每层独立</option>
                                <option value="global">全局复用</option>
                            </select>
                        </label>
                        <div class="ctv-option-group-title">空间视图</div>
                        <label class="ctv-option"><input type="checkbox" data-option="spatialHideStructured" /> <span>隐藏预设 / 结构化消息</span></label>
                        <label class="ctv-option"><input type="checkbox" data-option="spatialHideSystem" /> <span>隐藏系统消息</span></label>
                        <label class="ctv-option"><input type="checkbox" data-option="spatialShowAnchors" /> <span>显示聊天锚点</span></label>
                        <label class="ctv-option"><input type="checkbox" data-option="spatialShowMinimap" /> <span>显示小地图</span></label>
                        <label class="ctv-option"><input type="checkbox" data-option="spatialShowAllStrands" /> <span>显示所有聊天丝线</span></label>
                        <label class="ctv-option"><input type="checkbox" data-option="spatialAutoRotate" /> <span>自动旋转</span></label>
                        <div class="ctv-option-row">
                            <button class="ctv-link ctv-preset-iso">等轴</button>
                            <button class="ctv-link ctv-preset-front">正面</button>
                            <button class="ctv-link ctv-preset-top">俯视</button>
                        </div>
                        <div class="ctv-option-row">
                            <button class="ctv-link ctv-reset-camera-inline">重置空间视角</button>
                            <button class="ctv-link ctv-collapse-segments">重新折叠连续段</button>
                        </div>
                        <div class="ctv-errors ctv-hidden"></div>
                    </details>
                </aside>
                <main class="ctv-main">
                    <div class="ctv-progress ctv-hidden">
                        <div class="ctv-progress-bar"><i></i></div>
                        <span class="ctv-progress-text"></span>
                    </div>
                    <div class="ctv-tree"></div>
                    <div class="ctv-spatial ctv-hidden">
                        <div class="ctv-spatial-toolbar">
                            <button data-preset="iso">等轴</button>
                            <button data-preset="front">正面</button>
                            <button data-preset="top">俯视</button>
                            <button data-preset="fit">全部</button>
                        </div>
                    </div>
                    <div class="ctv-empty ctv-hidden"></div>
                </main>
                <aside class="ctv-detail ctv-hidden"></aside>
            </div>
        </div>`;

    document.body.appendChild(overlay);

    const els = {
        overlay,
        character: overlay.querySelector('.ctv-character'),
        stats: overlay.querySelector('.ctv-stats'),
        search: overlay.querySelector('.ctv-search'),
        searchNav: overlay.querySelector('.ctv-search-nav'),
        matchCount: overlay.querySelector('.ctv-match-count'),
        chatList: overlay.querySelector('.ctv-chat-list'),
        tree: overlay.querySelector('.ctv-tree'),
        spatial: overlay.querySelector('.ctv-spatial'),
        viewSpatial: overlay.querySelector('[data-view="spatial"]'),
        viewTree: overlay.querySelector('[data-view="tree"]'),
        focusChip: overlay.querySelector('.ctv-focus-chip'),
        focusName: overlay.querySelector('.ctv-focus-name'),
        empty: overlay.querySelector('.ctv-empty'),
        detail: overlay.querySelector('.ctv-detail'),
        progress: overlay.querySelector('.ctv-progress'),
        progressBar: overlay.querySelector('.ctv-progress-bar i'),
        progressText: overlay.querySelector('.ctv-progress-text'),
        errors: overlay.querySelector('.ctv-errors'),
        sidebar: overlay.querySelector('.ctv-sidebar'),
    };

    state.overlay = overlay;
    state.els = els;

    overlay.querySelector('.ctv-close').addEventListener('click', closeViewer);
    overlay.querySelector('.ctv-reload').addEventListener('click', () => reloadCharacter(true));
    overlay.querySelector('.ctv-reset-camera').addEventListener('click', () => state.spatial?.resetCamera());
    overlay.querySelector('.ctv-reset-camera-inline').addEventListener('click', () => state.spatial?.resetCamera());
    overlay.querySelector('.ctv-collapse-segments').addEventListener('click', () => {
        state.expandedSegments.clear();
        rebuildSpatialModel({ preserveCamera: true });
    });
    overlay.querySelector('.ctv-preset-iso').addEventListener('click', () => state.spatial?.setPreset('iso'));
    overlay.querySelector('.ctv-preset-front').addEventListener('click', () => state.spatial?.setPreset('front'));
    overlay.querySelector('.ctv-preset-top').addEventListener('click', () => state.spatial?.setPreset('top'));
    overlay.querySelectorAll('.ctv-spatial-toolbar [data-preset]').forEach((button) => {
        button.addEventListener('click', () => {
            const preset = button.dataset.preset;
            if (preset === 'fit') {
                state.spatial?.resetCamera();
            } else {
                state.spatial?.setPreset(preset);
            }
        });
    });
    overlay.querySelector('.ctv-sidebar-toggle').addEventListener('click', () => {
        overlay.classList.toggle('ctv-sidebar-open');
    });

    els.viewSpatial?.addEventListener('click', () => setViewMode('spatial'));
    els.viewTree?.addEventListener('click', () => setViewMode('tree'));
    overlay.querySelector('.ctv-focus-clear')?.addEventListener('click', () => {
        focusChatInSpatial(state.focusChatKey, { toggle: true });
    });

    els.character.addEventListener('change', () => {
        const character = state.characters[Number(els.character.value)];
        if (character) {
            selectCharacter(character);
        }
    });

    els.search.addEventListener('input', () => {
        clearTimeout(state.searchTimer);
        state.searchTimer = setTimeout(() => {
            state.searchQuery = els.search.value.trim();
            if (state.searchQuery) {
                state.collapsed.clear();
            }
            rebuildMatches();
            renderTree();
        }, 250);
    });

    overlay.querySelector('.ctv-next-match').addEventListener('click', () => jumpToMatch(1));
    overlay.querySelector('.ctv-prev-match').addEventListener('click', () => jumpToMatch(-1));

    overlay.querySelector('.ctv-select-all').addEventListener('click', () => {
        const character = state.character;
        state.chatList.forEach((chat) => state.selectedFiles.add(chat.file));
        renderChatList();
        loadMissingChats().then((completed) => {
            if (!completed || state.character !== character) {
                return;
            }
            computeChatInfo();
            renderChatList();
            rebuildTree();
        });
    });
    overlay.querySelector('.ctv-select-none').addEventListener('click', () => {
        state.selectedFiles.clear();
        renderChatList();
        rebuildTree();
    });

    overlay.querySelectorAll('[data-option]').forEach((input) => {
        const key = input.dataset.option;
        if (input.type === 'checkbox') {
            input.checked = Boolean(state.settings[key]);
        } else if (input.type === 'range') {
            input.value = String(state.settings[key]);
        } else {
            input.value = String(state.settings[key]);
        }

        input.addEventListener('change', () => {
            if (input.type === 'checkbox') {
                state.settings[key] = input.checked;
            } else if (input.type === 'range') {
                state.settings[key] = Number(input.value);
            } else {
                state.settings[key] = input.value;
            }
            saveSettings();
            syncOptionLabels();

            if (key === 'showColors' || key === 'activeVariantOnly' || key === 'compressChains') {
                renderTree();
            } else if (key === 'spatialHideStructured' || key === 'spatialHideSystem' || key === 'spatialTimeMode' || key === 'spatialLaneScope') {
                rebuildSpatialModel();
                applyViewMode();
            } else if (key === 'spatialShowAnchors' || key === 'spatialShowMinimap' || key === 'spatialShowAllStrands' || key === 'spatialAutoRotate') {
                syncSpatialSettings();
            } else {
                scheduleRebuild();
            }
        });
    });

    syncOptionLabels();
    syncSpatialSettings();
    applyViewMode();

    overlay.addEventListener('click', (event) => {
        if (event.target === overlay) {
            closeViewer();
        }
    });
}

function syncOptionLabels() {
    const overlay = state.overlay;
    if (!overlay) {
        return;
    }
    const value = overlay.querySelector('.ctv-threshold-value');
    if (value) {
        value.textContent = state.settings.mergeSimilar
            ? state.settings.threshold.toFixed(2)
            : '关闭';
    }
    const threshold = overlay.querySelector('[data-option="threshold"]');
    if (threshold) {
        threshold.disabled = !state.settings.mergeSimilar;
    }
}

function closeViewer() {
    state.abortController?.abort();
    state.abortController = null;
    state.fileLoadController?.abort();
    state.fileLoadController = null;
    state.loadToken++;
    state.loadSeq++;
    clearFingerprintCache();
    clearTimeout(state.rebuildTimer);
    clearTimeout(state.searchTimer);

    state.overlay?.remove();
    state.overlay = null;
    state.els = {};
    state.spatial?.destroy();
    state.spatial = null;
    state.spatialModel = null;
    state.focusChatKey = null;
    state.tree = null;
    state.parsed = new Map();
    state.chatList = [];
    state.selectedFiles = new Set();
    state.rowById = new Map();
    state.matches = null;
    state.matchOrder = [];
    state.searchQuery = '';
    state.selectedNodeId = null;
    state.loading = false;
    document.removeEventListener('keydown', onKeyDown);
}

function onKeyDown(event) {
    if (event.key === 'Escape' && state.overlay) {
        closeViewer();
    }
}

/* -------------------------------------------------------------------------- */
/* Character / chat flow                                                       */
/* -------------------------------------------------------------------------- */

async function openViewer() {
    if (state.overlay) {
        state.overlay.focus?.();
        return;
    }

    buildOverlay();
    document.addEventListener('keydown', onKeyDown);
    state.overlay?.focus?.();

    showProgress(0, 0, '正在读取角色列表…');

    try {
        state.characters = await loadCharacters();
    } catch (error) {
        showEmpty(`读取角色列表失败：${error?.message || error}`);
        hideProgress();
        return;
    }

    // The overlay may have been closed while the character list was loading.
    if (!state.overlay || !state.els.character) {
        return;
    }

    const select = state.els.character;
    select.textContent = '';

    if (!state.characters.length) {
        showEmpty('没有找到任何角色卡。');
        hideProgress();
        return;
    }

    for (const [index, character] of state.characters.entries()) {
        const option = document.createElement('option');
        option.value = String(index);
        option.textContent = character.name || character.avatar;
        select.appendChild(option);
    }

    const current = findCurrentCharacter(state.characters);
    const initial = current || state.characters[0];
    select.value = String(state.characters.indexOf(initial));

    hideProgress();
    await selectCharacter(initial);
}

async function selectCharacter(character) {
    const token = ++state.loadToken;

    state.character = character;
    state.parsed = new Map();
    state.errors = [];
    state.chatList = [];
    state.selectedFiles = new Set();
    state.tree = null;
    state.chatInfo = new Map();
    state.spatialModel = null;
    state.focusChatKey = null;

    state.abortController?.abort();
    state.fileLoadController?.abort();
    clearFingerprintCache();

    // Drop the previous character's tree and detail text immediately.
    renderTree();
    state.spatial?.clear();
    updateFocusChip();
    closeDetailPanel();
    renderChatList();
    renderStats();
    applyViewMode();
    showEmpty('正在读取聊天记录…');

    const controller = new AbortController();
    state.abortController = controller;

    try {
        state.chatList = await loadChatList(character, controller.signal);
    } catch (error) {
        if (error?.name === 'AbortError' || state.loadToken !== token) {
            return;
        }
        showEmpty(`读取聊天列表失败：${error?.message || error}`);
        renderChatList();
        return;
    }

    if (state.loadToken !== token || state.character !== character) {
        return;
    }

    state.selectedFiles = new Set(state.chatList.map((chat) => chat.file));
    renderChatList();

    if (!state.chatList.length) {
        showEmpty('该角色卡还没有聊天记录。');
        renderStats();
        return;
    }

    const completed = await loadMissingChats({ token });

    // The user may have switched characters, or a newer load (select-all /
    // checkbox) may have taken over while these files were loading.
    if (!completed || state.loadToken !== token || state.character !== character) {
        return;
    }

    computeChatInfo();
    renderChatList();
    rebuildTree();
}

async function reloadCharacter(force) {
    const character = state.character;
    if (!character) {
        return;
    }
    const token = state.loadToken;
    if (force) {
        state.parsed = new Map();
        clearFingerprintCache();
    }
    state.errors = [];
    renderErrors();

    const completed = await loadMissingChats({ token });
    if (!completed || state.loadToken !== token || state.character !== character) {
        return;
    }
    computeChatInfo();
    renderChatList();
    rebuildTree();
}

/**
 * Fetch every chat file that is selected but not parsed yet.
 *
 * @param {{token?: number}} [options]
 * @returns {Promise<boolean>} true when this load completed and owns the
 *   current corpus; false when it was aborted or superseded.
 */
async function loadMissingChats(options = {}) {
    const character = state.character;
    if (!character) {
        return false;
    }

    const token = options.token ?? state.loadToken;
    if (token !== state.loadToken || state.character !== character) {
        return false;
    }

    // Capture the chat objects now. state.chatList may be replaced while the
    // requests are in flight.
    const pending = state.chatList
        .filter((chat) => state.selectedFiles.has(chat.file) && !state.parsed.has(chat.file));

    if (!pending.length) {
        hideProgress();
        renderErrors();
        return true;
    }

    // A file load is independent from the chat-list fetch, so aborting a
    // superseded load must never cancel the list request.
    state.fileLoadController?.abort();
    const controller = new AbortController();
    state.fileLoadController = controller;
    const seq = ++state.loadSeq;

    state.loading = true;
    showProgress(0, pending.length, `读取聊天记录 0/${pending.length}`);

    const queue = pending.slice();
    let done = 0;

    const worker = async () => {
        while (queue.length) {
            if (controller.signal.aborted || seq !== state.loadSeq || state.loadToken !== token || state.character !== character) {
                return;
            }
            const chat = queue.shift();
            try {
                const parsed = await loadChatFile(character, chat, controller.signal);
                if (controller.signal.aborted || seq !== state.loadSeq || state.loadToken !== token || state.character !== character) {
                    return;
                }
                state.parsed.set(chat.file, parsed);
            } catch (error) {
                if (error?.name === 'AbortError') {
                    return;
                }
                if (seq !== state.loadSeq || state.loadToken !== token || state.character !== character) {
                    return;
                }
                state.errors.push({ file: chat.file, message: String(error?.message || error) });
            }
            done++;
            showProgress(done, pending.length, `读取聊天记录 ${done}/${pending.length}`);
        }
    };

    const workers = [];
    const concurrency = Math.min(3, pending.length);
    for (let i = 0; i < concurrency; i++) {
        workers.push(worker());
    }
    await Promise.all(workers);

    if (seq !== state.loadSeq || state.loadToken !== token || state.character !== character) {
        return false;
    }

    state.loading = false;
    hideProgress();
    renderErrors();
    return true;
}

function renderErrors() {
    const box = state.els.errors;
    if (!box) {
        return;
    }
    box.textContent = '';
    if (!state.errors.length) {
        box.classList.add('ctv-hidden');
        return;
    }
    box.classList.remove('ctv-hidden');
    box.appendChild(h('div', 'ctv-errors-title', `${state.errors.length} 个聊天读取失败`));
    for (const error of state.errors) {
        box.appendChild(h('div', 'ctv-error-line', `${error.file}: ${error.message}`));
    }
}

/* -------------------------------------------------------------------------- */
/* Tree building / rendering                                                   */
/* -------------------------------------------------------------------------- */

function scheduleRebuild(delay = 300) {
    clearTimeout(state.rebuildTimer);
    state.rebuildTimer = setTimeout(() => rebuildTree(), delay);
}

function rebuildTree() {
    if (!state.character) {
        return;
    }

    const chats = [];
    for (const chat of state.chatList) {
        if (!state.selectedFiles.has(chat.file)) {
            continue;
        }
        const parsed = state.parsed.get(chat.file);
        if (!parsed) {
            continue;
        }
        chats.push({
            key: chat.file,
            file: chat.file,
            name: stripExtension(chat.file),
            date: chat.date,
            header: parsed.header,
            messages: parsed.messages,
        });
    }

    if (!chats.length) {
        state.tree = null;
        state.spatialModel = null;
        state.matches = null;
        state.matchOrder = [];
        state.nodeVariant.clear();
        state.collapsed.clear();
        state.expandedChains.clear();
        renderTree();
        state.spatial?.clear();
        closeDetailPanel();
        showEmpty('请至少选择一条聊天记录。');
        renderStats();
        applyViewMode();
        return;
    }

    state.tree = buildChatTree(chats, {
        includeSystem: state.settings.includeSystem,
        mergeSimilar: state.settings.mergeSimilar,
        similarityThreshold: Number(state.settings.threshold),
        branchOrder: state.settings.branchOrder,
    });

    state.nodeVariant.clear();
    state.collapsed.clear();
    state.expandedChains.clear();
    state.expandedSegments.clear();
    state.selectedNodeId = null;
    closeDetailPanel();

    rebuildMatches();
    renderTree();
    rebuildSpatialModel();
    renderStats();
    applyViewMode();
}

function rebuildMatches() {
    if (!state.tree || !state.searchQuery) {
        state.matches = null;
        state.matchOrder = [];
        state.els.searchNav?.classList.add('ctv-hidden');
        state.spatial?.setSearch(null);
        return;
    }

    const query = normalizeForCompare(state.searchQuery);
    if (!query) {
        state.matches = null;
        state.matchOrder = [];
        state.els.searchNav?.classList.add('ctv-hidden');
        state.spatial?.setSearch(null);
        return;
    }

    const matches = new Set();
    const order = [];
    const stack = [state.tree.root];

    while (stack.length) {
        const node = stack.pop();
        order.push(node);
        for (const variant of node.variants.values()) {
            if (variant.norm && variant.norm.includes(query)) {
                matches.add(node.id);
                break;
            }
        }
        for (const child of node.children) {
            stack.push(child);
        }
    }

    const subtreeHasMatch = new Map();
    for (let i = order.length - 1; i >= 0; i--) {
        const node = order[i];
        let has = matches.has(node.id);
        for (const child of node.children) {
            if (subtreeHasMatch.get(child.id)) {
                has = true;
                break;
            }
        }
        subtreeHasMatch.set(node.id, has);
    }

    state.matches = { matches, subtreeHasMatch, query };
    state.els.searchNav?.classList.remove('ctv-hidden');
    state.spatial?.setSearch(matches);
}

function ensureSpatialView() {
    if (state.spatial || !state.els.spatial) {
        return;
    }
    state.spatial = new SpatialView({
        container: state.els.spatial,
        onSelectNode: (ref) => selectNode(ref),
        onFocusChat: (chatKey) => focusChatInSpatial(chatKey, { toggle: true }),
        onSearch: () => state.els.search?.focus(),
        onExpandSegment: (segmentKey) => {
            state.expandedSegments.add(segmentKey);
            rebuildSpatialModel({ preserveCamera: true });
        },
        resolveDisplayName: (chatKey) => stripExtension(chatKey),
    });
    syncSpatialSettings();
}

function syncSpatialSettings() {
    state.spatial?.setSettings({
        showAnchors: state.settings.spatialShowAnchors,
        showMinimap: state.settings.spatialShowMinimap,
        showAllStrands: state.settings.spatialShowAllStrands,
        autoRotate: state.settings.spatialAutoRotate,
    });
}

function rebuildSpatialModel(options = {}) {
    if (!state.tree) {
        state.spatialModel = null;
        return;
    }
    state.spatialModel = buildSpatialModel(state.tree, state.chatInfo, {
        hideSystem: state.settings.spatialHideSystem,
        hideStructured: state.settings.spatialHideStructured,
        timeMode: state.settings.spatialTimeMode,
        laneScope: state.settings.spatialLaneScope,
        expandedSegments: state.expandedSegments,
    });
    if (state.spatial) {
        state.spatial.setData(state.spatialModel, state.chatInfo, {
            preserveCamera: Boolean(options.preserveCamera),
        });
        state.spatial.setVariantState(state.nodeVariant);
        state.spatial.setSelected(state.selectedNodeId);
        state.spatial.setSearch(state.matches?.matches || null);
        state.spatial.setFocusChat(state.focusChatKey);
    }
}

function applyViewMode() {
    const spatial = state.settings.viewMode === 'spatial';
    state.els.tree?.classList.toggle('ctv-hidden', spatial);
    state.els.spatial?.classList.toggle('ctv-hidden', !spatial);
    state.els.viewSpatial?.classList.toggle('active', spatial);
    state.els.viewTree?.classList.toggle('active', !spatial);

    if (!spatial) {
        renderTree();
        return;
    }

    ensureSpatialView();
    if (state.spatialModel) {
        state.spatial?.setData(state.spatialModel, state.chatInfo);
        state.spatial?.setVariantState(state.nodeVariant);
        state.spatial?.setSelected(state.selectedNodeId);
        state.spatial?.setSearch(state.matches?.matches || null);
        state.spatial?.setFocusChat(state.focusChatKey);
    } else {
        state.spatial?.clear();
    }
    state.spatial?.resize();
}

function setViewMode(mode) {
    state.settings.viewMode = mode === 'tree' ? 'tree' : 'spatial';
    saveSettings();
    applyViewMode();
    if (state.settings.viewMode === 'spatial') {
        state.spatial?.requestRender();
    }
}

function updateFocusChip() {
    const chip = state.els.focusChip;
    const name = state.els.focusName;
    if (!chip || !name) {
        return;
    }
    if (!state.focusChatKey) {
        chip.classList.add('ctv-hidden');
        return;
    }
    chip.classList.remove('ctv-hidden');
    name.textContent = stripExtension(state.focusChatKey);
}

function focusChatInSpatial(chatKey, { toggle = false } = {}) {
    if (!chatKey) {
        return;
    }
    if (toggle && state.focusChatKey === chatKey) {
        state.focusChatKey = null;
    } else {
        state.focusChatKey = chatKey;
    }

    if (state.settings.viewMode !== 'spatial' && state.focusChatKey) {
        state.settings.viewMode = 'spatial';
        saveSettings();
    }
    applyViewMode();
    ensureSpatialView();
    state.spatial?.setFocusChat(state.focusChatKey);
    updateFocusChip();
    if (state.focusChatKey) {
        state.spatial?.focusChat(state.focusChatKey);
    }
    renderChatList();
}

function focusNodeInSpatial(nodeId) {
    if (state.settings.viewMode !== 'spatial') {
        state.settings.viewMode = 'spatial';
        saveSettings();
    }
    applyViewMode();
    state.spatial?.setSelected(nodeId);
    state.spatial?.focusNode(nodeId);
}

function getActiveVariant(node) {
    const stored = state.nodeVariant.get(node.id);
    if (stored && node.variants.has(stored)) {
        return node.variants.get(stored);
    }
    const fallback = node.variants.get(node.defaultVariantKey);
    return fallback || node.variantList[0] || null;
}

function variantFilterInfo(node) {
    if (
        !state.settings.activeVariantOnly
        || node.role !== 'assistant'
        || node.variants.size < 2
        || !node.children.length
    ) {
        return { active: false, filtered: node.children };
    }

    const kids = node.children;
    const hasVariantEdges = kids.some((child) => {
        for (const key of child.edgeVariants.keys()) {
            if (key !== '*') {
                return true;
            }
        }
        return false;
    });
    if (!hasVariantEdges) {
        return { active: false, filtered: kids };
    }

    const variant = getActiveVariant(node);
    if (!variant) {
        return { active: false, filtered: kids };
    }

    const filtered = kids.filter((child) => {
        const chats = child.edgeVariants.get(variant.key);
        const any = child.edgeVariants.get('*');
        return Boolean((chats && chats.size) || (any && any.size));
    });

    return { active: true, filtered };
}

function visibleChildren(node) {
    // Never hide search hits behind the variant filter.
    if (state.matches) {
        return node.children;
    }

    const info = variantFilterInfo(node);
    if (!info.active) {
        return node.children;
    }

    // A variant that was never selected in any chat has no recorded
    // continuation. In that case show everything and let the row explain why.
    return info.filtered.length ? info.filtered : node.children;
}

/**
 * Children that are currently rendered. Collapsed nodes hide their subtree.
 * @param {any} node
 */
function renderChildren(node) {
    // While searching, collapsed nodes are re-opened so hits are never hidden.
    if (!state.matches && state.collapsed.has(node.id)) {
        return [];
    }
    return visibleChildren(node);
}

function renderTree() {
    const treeElement = state.els.tree;
    if (!treeElement) {
        return;
    }

    treeElement.textContent = '';
    state.rowById = new Map();

    if (!state.tree) {
        state.matchOrder = [];
        return;
    }

    const root = state.tree.root;
    if (!root.children.length) {
        state.matchOrder = [];
        showEmpty('没有可显示的消息。');
        return;
    }

    hideEmpty();
    const inner = h('div', 'ctv-tree-inner');
    treeElement.appendChild(inner);

    for (const child of visibleChildren(root)) {
        renderSubtree(child, inner, 0);
    }

    state.matchOrder = Array.from(treeElement.querySelectorAll('.ctv-match')).map((element) => element.dataset.nodeId);
    updateMatchCounter();
    highlightSelectedPath();
}

function renderSubtree(node, container, depth) {
    if (!node) {
        return;
    }
    if (state.matches && !state.matches.subtreeHasMatch.get(node.id)) {
        return;
    }

    const kids = renderChildren(node);
    const compressible = state.settings.compressChains
        && kids.length <= 1
        && !(state.matches && state.matches.subtreeHasMatch.get(node.id));

    if (compressible) {
        const run = collectChain(node);
        if (run.length >= state.settings.chainMin) {
            const key = run[0].id;
            if (state.expandedChains.has(key)) {
                renderExpandedChain(run, container, depth);
            } else {
                container.appendChild(renderChainSummary(run, key));
                const last = run[run.length - 1];
                const next = renderChildren(last);
                if (next.length === 1) {
                    renderSubtree(next[0], container, depth);
                } else if (next.length > 1) {
                    renderBranchGroup(last, container, depth);
                }
            }
            return;
        }
    }

    renderNodeAndChildren(node, container, depth, false);
}

function renderNodeAndChildren(node, container, depth, noCompress) {
    renderNodeRow(node, container);
    const kids = renderChildren(node);

    if (kids.length === 1) {
        if (noCompress) {
            renderNodeAndChildren(kids[0], container, depth, true);
        } else {
            renderSubtree(kids[0], container, depth);
        }
        return;
    }

    if (kids.length > 1) {
        renderBranchGroup(node, container, depth);
    }
}

function collectChain(start) {
    const run = [];
    let current = start;

    while (current) {
        const kids = renderChildren(current);
        if (kids.length > 1) {
            break;
        }
        run.push(current);
        if (!kids.length) {
            break;
        }
        current = kids[0];
    }

    return run;
}

function renderExpandedChain(run, container, depth) {
    for (let i = 0; i < run.length; i++) {
        const node = run[i];
        renderNodeRow(node, container);
        const kids = renderChildren(node);

        if (kids.length > 1) {
            renderBranchGroup(node, container, depth);
            return;
        }
        if (!kids.length) {
            return;
        }
        if (i === run.length - 1) {
            renderSubtree(kids[0], container, depth);
            return;
        }
    }
}

function renderChainSummary(run, key) {
    const element = h('div', 'ctv-chain');
    const button = h('button', 'ctv-chain-toggle', `展开 ${run.length} 层`);
    button.addEventListener('click', (event) => {
        event.stopPropagation();
        state.expandedChains.add(key);
        renderTree();
    });

    const roles = h('span', 'ctv-chain-roles');
    const preview = run.slice(0, 8).map((node) => ROLE_LABELS[node.role] || node.role).join(' ');
    roles.textContent = preview + (run.length > 8 ? ' …' : '');

    const first = run[0];
    const last = run[run.length - 1];
    const text = h('span', 'ctv-chain-text');
    text.textContent = `${snippet(getActiveVariant(first)?.text, 60)}  …  ${snippet(getActiveVariant(last)?.text, 60)}`;

    const variants = run.reduce((total, node) => total + Math.max(0, node.variantList.length - 1), 0);
    const badges = h('span', 'ctv-chain-badges');
    badges.textContent = `${run.length} 层${variants ? ` · ${variants} 个变体` : ''}`;

    element.append(button, roles, text, badges);
    return element;
}

function renderBranchGroup(node, container, depth) {
    const group = h('div', 'ctv-branches');
    group.dataset.depth = String(depth);

    for (const child of renderChildren(node)) {
        const branch = h('div', 'ctv-branch');
        const label = h('div', 'ctv-branch-label');
        label.textContent = `分支 · ${child.chats.size} 个聊天 · ${child.variantList.length} 个变体`;
        branch.appendChild(label);
        renderSubtree(child, branch, depth + 1);
        group.appendChild(branch);
    }

    container.appendChild(group);
}

function renderNodeRow(node, container) {
    const row = h('div', `ctv-row ctv-row-${node.role}`);
    row.dataset.nodeId = node.id;
    row.setAttribute('role', 'button');
    row.tabIndex = 0;

    const hasKids = node.children.length > 0;
    const toggle = h('button', 'ctv-toggle', hasKids ? (state.collapsed.has(node.id) ? '▶' : '▼') : '•');
    toggle.setAttribute('aria-label', '折叠 / 展开');
    toggle.addEventListener('click', (event) => {
        event.stopPropagation();
        if (!hasKids) {
            return;
        }
        if (state.collapsed.has(node.id)) {
            state.collapsed.delete(node.id);
        } else {
            state.collapsed.add(node.id);
        }
        renderTree();
    });

    const role = h('span', 'ctv-role', ROLE_LABELS[node.role] || node.role);
    const snippetElement = h('span', 'ctv-snippet');
    const badges = h('span', 'ctv-badges');

    row.append(toggle, role, snippetElement, badges);

    if (node.chats.size > 1) {
        const badge = h('span', 'ctv-badge ctv-badge-chats', `${node.chats.size} 聊天`);
        badges.appendChild(badge);
    }
    if (node.children.length > 1) {
        badges.appendChild(h('span', 'ctv-badge ctv-badge-branch', `${node.children.length} 分支`));
    }
    const filterInfo = variantFilterInfo(node);
    if (filterInfo.active && filterInfo.filtered.length === 0) {
        badges.appendChild(h('span', 'ctv-badge ctv-badge-empty', '该变体无后续 · 显示全部'));
    }

    if (node.variantList.length > 1) {
        const control = h('span', 'ctv-var-control');
        const prev = h('button', 'ctv-var-btn', '‹');
        const label = h('span', 'ctv-var-label');
        const next = h('button', 'ctv-var-btn', '›');
        prev.addEventListener('click', (event) => {
            event.stopPropagation();
            stepVariant(node, -1);
        });
        next.addEventListener('click', (event) => {
            event.stopPropagation();
            stepVariant(node, 1);
        });
        control.append(prev, label, next);
        badges.appendChild(control);
    }

    if (state.settings.showColors) {
        const dots = h('span', 'ctv-dots');
        const seen = new Set();
        let count = 0;
        for (const chatKey of node.chats) {
            const info = state.chatInfo.get(chatKey);
            const color = info?.rootColor || info?.color;
            if (!color || seen.has(color)) {
                continue;
            }
            seen.add(color);
            const dot = h('i', 'ctv-dot');
            dot.style.background = color;
            dot.title = info?.root || chatKey;
            dots.appendChild(dot);
            count++;
            if (count >= 5) {
                break;
            }
        }
        if (count) {
            badges.appendChild(dots);
        }
    }

    row.addEventListener('click', () => selectNode(node));
    row.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            selectNode(node);
        }
    });

    container.appendChild(row);
    state.rowById.set(node.id, row);

    updateRowVariant(node, row);

    if (state.matches?.matches.has(node.id)) {
        row.classList.add('ctv-match');
    }
    if (state.selectedNodeId === node.id) {
        row.classList.add('ctv-selected');
    }
}

function updateRowVariant(node, row) {
    const variant = getActiveVariant(node);
    const snippetElement = row.querySelector('.ctv-snippet');
    if (snippetElement) {
        snippetElement.textContent = snippet(variant?.text, 220);
    }
    const label = row.querySelector('.ctv-var-label');
    if (label && node.variantList.length) {
        const index = node.variantList.findIndex((item) => item.key === variant?.key);
        label.textContent = `${index + 1}/${node.variantList.length}`;
        label.title = node.role === 'assistant' ? '生成变体 (swipe)' : '近似变体';
    }
}

function stepVariant(node, direction) {
    const list = node.variantList;
    if (!list.length) {
        return;
    }
    const current = getActiveVariant(node);
    const index = list.findIndex((item) => item.key === current?.key);
    const next = (index + direction + list.length) % list.length;
    state.nodeVariant.set(node.id, list[next].key);

    const row = state.rowById.get(node.id);
    if (row) {
        updateRowVariant(node, row);
    }
    if (state.selectedNodeId === node.id) {
        renderDetail(node);
    }
    state.spatial?.setVariantState(state.nodeVariant);
    if (state.settings.activeVariantOnly) {
        // The tree itself does not change - only which children are visible.
        renderTree();
    }
}

function selectNode(node) {
    state.selectedNodeId = node.id;

    for (const row of state.rowById.values()) {
        row.classList.remove('ctv-selected');
    }
    highlightSelectedPath();
    state.spatial?.setSelected(node.id);
    renderDetail(node);
}

function highlightSelectedPath() {
    for (const row of state.rowById.values()) {
        row.classList.remove('ctv-selected');
        row.classList.remove('ctv-ancestor');
    }

    if (!state.tree || !state.selectedNodeId) {
        return;
    }

    let node = findNodeById(state.tree.root, state.selectedNodeId);
    while (node) {
        const row = state.rowById.get(node.id);
        if (row) {
            row.classList.add(node.id === state.selectedNodeId ? 'ctv-selected' : 'ctv-ancestor');
        }
        node = node.parent;
    }
}

function findNodeById(root, id) {
    const stack = [root];
    while (stack.length) {
        const node = stack.pop();
        if (node.id === id) {
            return node;
        }
        for (const child of node.children) {
            stack.push(child);
        }
    }
    return null;
}

/* -------------------------------------------------------------------------- */
/* Detail panel                                                                */
/* -------------------------------------------------------------------------- */

function closeDetailPanel() {
    const panel = state.els.detail;
    if (panel) {
        panel.textContent = '';
        panel.classList.add('ctv-hidden');
    }
    state.selectedNodeId = null;
}

function renderDetail(node) {
    const panel = state.els.detail;
    if (!panel) {
        return;
    }

    panel.textContent = '';
    panel.classList.remove('ctv-hidden');

    const variant = getActiveVariant(node);

    const header = h('div', 'ctv-detail-head');
    const title = h('div', 'ctv-detail-title');
    title.appendChild(h('span', `ctv-role ctv-role-${node.role}`, ROLE_LABELS[node.role] || node.role));
    title.appendChild(h('span', 'ctv-detail-subtitle', `${node.chats.size} 个聊天 · ${node.occurrences.length} 次出现`));

    const close = h('button', 'ctv-icon-btn ctv-detail-close', '×');
    close.addEventListener('click', () => {
        closeDetailPanel();
        highlightSelectedPath();
    });
    header.append(title, close);
    panel.appendChild(header);

    // Breadcrumb of ancestors: makes the path and turn order explicit.
    const ancestors = [];
    let parent = node.parent;
    while (parent && parent.role !== 'root') {
        ancestors.push(parent);
        parent = parent.parent;
    }
    ancestors.reverse();
    if (ancestors.length) {
        const crumbs = h('div', 'ctv-detail-breadcrumb');
        for (const ancestor of ancestors.slice(-10)) {
            const variant = ancestor.variants?.get(ancestor.defaultVariantKey) || ancestor.variantList?.[0];
            const button = h('button', 'ctv-crumb', `#${ancestor.depth} ${ancestor.role === 'user' ? '你' : ancestor.role === 'system' ? '系统' : 'AI'}`);
            button.title = snippet(variant?.text, 80);
            button.addEventListener('click', () => {
                selectNode(ancestor);
                if (state.settings.viewMode === 'spatial') {
                    state.spatial?.setSelected(ancestor.id);
                    state.spatial?.focusNode(ancestor.id);
                }
            });
            crumbs.appendChild(button);
        }
        crumbs.appendChild(h('span', 'ctv-crumb ctv-crumb-current', `#${node.depth} 当前`));
        panel.appendChild(crumbs);
    }

    if (node.variantList.length > 1) {
        const list = h('div', 'ctv-detail-variants');
        node.variantList.forEach((item, index) => {
            const button = h('button', 'ctv-detail-variant');
            if (item.key === variant?.key) {
                button.classList.add('active');
            }
            button.appendChild(h('span', 'ctv-detail-variant-index', String(index + 1)));
            button.appendChild(h('span', 'ctv-detail-variant-text', snippet(item.text, 90)));
            const meta = h('span', 'ctv-detail-variant-meta');
            meta.textContent = `${item.selectedCount} 选 / ${item.chats.size} 聊`;
            button.appendChild(meta);
            button.addEventListener('click', () => {
                state.nodeVariant.set(node.id, item.key);
                const row = state.rowById.get(node.id);
                if (row) {
                    updateRowVariant(node, row);
                }
                renderDetail(node);
                state.spatial?.setVariantState(state.nodeVariant);
                if (state.settings.activeVariantOnly) {
                    renderTree();
                }
            });
            list.appendChild(button);
        });
        panel.appendChild(list);
    }

    const text = h('pre', 'ctv-detail-text');
    text.textContent = variant?.text || '（空消息）';
    panel.appendChild(text);

    const actions = h('div', 'ctv-detail-actions');
    const copy = h('button', 'ctv-btn', '复制文本');
    copy.addEventListener('click', async () => {
        await copyText(variant?.text || '');
        toast('已复制到剪贴板', 'success');
    });
    actions.appendChild(copy);

    const locate = h('button', 'ctv-btn', '在空间中定位');
    locate.addEventListener('click', () => focusNodeInSpatial(node.id));
    actions.appendChild(locate);

    const chatKeys = Array.from(node.chats);
    if (chatKeys.length) {
        // Prefer a chat where the currently displayed variant was selected.
        const occurrence = node.occurrences.find((item) => item.variantKey === variant?.key) || node.occurrences[0];
        const open = h('button', 'ctv-btn', '打开该聊天');
        open.title = occurrence ? stripExtension(occurrence.chatKey) : '';
        open.addEventListener('click', () => openChatFor(occurrence?.chatKey || chatKeys[0]));
        actions.appendChild(open);

        const focus = h('button', 'ctv-btn', '聚焦此聊天');
        focus.addEventListener('click', () => focusChatInSpatial(occurrence?.chatKey || chatKeys[0], { toggle: true }));
        actions.appendChild(focus);
    }
    panel.appendChild(actions);

    const meta = h('div', 'ctv-detail-meta');
    meta.appendChild(h('div', 'ctv-detail-meta-title', '出现位置'));

    const occurrences = new Map();
    for (const occurrence of node.occurrences) {
        if (!occurrences.has(occurrence.chatKey)) {
            occurrences.set(occurrence.chatKey, []);
        }
        occurrences.get(occurrence.chatKey).push(occurrence);
    }

    let shown = 0;
    for (const [chatKey, list] of occurrences) {
        if (shown++ >= 40) {
            meta.appendChild(h('div', 'ctv-detail-meta-line', `… 其余 ${occurrences.size - 40} 个聊天省略`));
            break;
        }
        const info = state.chatInfo.get(chatKey);
        const line = h('div', 'ctv-detail-meta-line');
        const dot = h('i', 'ctv-dot');
        dot.style.background = info?.rootColor || '#888';
        line.appendChild(dot);
        line.appendChild(h('span', 'ctv-detail-chat-name', stripExtension(chatKey)));
        line.appendChild(h('span', 'ctv-detail-chat-index', list.map((item) => `#${item.index}`).join(', ')));
        meta.appendChild(line);
    }
    panel.appendChild(meta);
}

async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
    } catch {
        const area = document.createElement('textarea');
        area.value = text;
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        try {
            document.execCommand('copy');
        } catch {
            // ignore
        }
        area.remove();
    }
}

async function openChatFor(chatKey) {
    const ctx = getContext();
    const character = state.character;
    if (!ctx?.openCharacterChat || !character) {
        toast('当前环境不支持直接打开聊天', 'warning');
        return;
    }

    const stem = stripExtension(chatKey);
    try {
        // SillyTavern >= 1.12: openCharacterChat(fileName, avatar)
        await ctx.openCharacterChat(stem, character.avatar);
        closeViewer();
        return;
    } catch (error) {
        try {
            // Older signature: openCharacterChat(name, chatFile)
            await ctx.openCharacterChat(character.name, stem);
            closeViewer();
            return;
        } catch {
            toast(`打开聊天失败：${error?.message || error}`, 'error');
        }
    }
}

/* -------------------------------------------------------------------------- */
/* Sidebar / stats                                                             */
/* -------------------------------------------------------------------------- */

function renderChatList() {
    const list = state.els.chatList;
    if (!list) {
        return;
    }

    list.textContent = '';

    if (!state.chatList.length) {
        list.appendChild(h('div', 'ctv-hint', '没有聊天记录'));
        return;
    }

    for (const chat of state.chatList) {
        const info = state.chatInfo.get(chat.file);
        const item = h('label', 'ctv-chat-item');
        if (!state.selectedFiles.has(chat.file)) {
            item.classList.add('ctv-disabled');
        }

        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = state.selectedFiles.has(chat.file);
        box.addEventListener('change', () => {
            const character = state.character;
            if (box.checked) {
                state.selectedFiles.add(chat.file);
                loadMissingChats().then((completed) => {
                    if (!completed || state.character !== character) {
                        return;
                    }
                    computeChatInfo();
                    renderChatList();
                    rebuildTree();
                });
            } else {
                state.selectedFiles.delete(chat.file);
                renderChatList();
                rebuildTree();
            }
        });

        const dot = h('i', 'ctv-dot');
        dot.style.background = info?.color || '#666';

        const text = h('span', 'ctv-chat-text');
        const name = h('span', 'ctv-chat-name', stripExtension(chat.file));
        text.appendChild(name);

        const parts = [];
        if (chat.messages) {
            parts.push(`${chat.messages} 条`);
        }
        if (info?.depth) {
            parts.push(`分支 ${info.depth}`);
        }
        if (chat.date) {
            parts.push(formatDate(chat.date));
        }
        text.appendChild(h('span', 'ctv-chat-meta', parts.join(' · ')));

        // A compact visual fingerprint: role-coloured bars derived from the
        // message sequence. Helps recognise a chat before reading any text.
        if (info?.barcode?.length) {
            const strip = h('span', 'ctv-barcode');
            strip.title = '消息指纹：颜色来自内容，高度来自文本量';
            for (const cell of info.barcode) {
                const bar = h('i', 'ctv-barcode-cell');
                bar.style.background = `hsl(${cell.hue} 70% 58%)`;
                bar.style.height = `${4 + Math.round(cell.ratio * 8)}px`;
                bar.style.opacity = cell.role === 'user' ? '0.95' : '0.55';
                strip.appendChild(bar);
            }
            text.appendChild(strip);
        }

        if (info?.keywords?.length) {
            const chips = h('span', 'ctv-keywords');
            for (const keyword of info.keywords.slice(0, 3)) {
                chips.appendChild(h('span', 'ctv-keyword', keyword));
            }
            text.appendChild(chips);
        }

        const titleParts = [];
        if (info?.root && info.root !== info.base) {
            titleParts.push(`源自：${info.root}`);
        }
        if (info?.lastUser) {
            titleParts.push(`你：${info.lastUser}`);
        }
        if (info?.keywords?.length) {
            titleParts.push(`关键词：${info.keywords.join(' / ')}`);
        }
        if (titleParts.length) {
            text.title = titleParts.join('\n');
        }

        const locate = h('button', 'ctv-locate', '◎');
        locate.title = '在空间视图中定位这条聊天';
        locate.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            focusChatInSpatial(chat.file);
        });

        item.append(box, dot, text, locate);
        list.appendChild(item);
    }
}

function renderStats() {
    const box = state.els.stats;
    if (!box) {
        return;
    }

    box.textContent = '';

    const stats = state.tree?.stats;
    if (!stats) {
        box.appendChild(h('div', 'ctv-hint', '尚未载入消息'));
        return;
    }

    const rows = [
        ['聊天', `${state.selectedFiles.size} / ${state.chatList.length}`],
        ['消息', String(stats.messageCount)],
        ['节点', String(stats.nodeCount)],
        ['共享节点', String(stats.sharedNodeCount)],
        ['分叉点', String(stats.branchPointCount)],
        ['变体', String(stats.variantCount)],
        ['空间节点', state.spatialModel ? String(state.spatialModel.stats.visibleNodes) : '—'],
        ['隐藏', state.spatialModel ? String(state.spatialModel.stats.hiddenNodes) : '—'],
    ];

    const grid = h('div', 'ctv-stat-grid');
    for (const [label, value] of rows) {
        const cell = h('div', 'ctv-stat');
        cell.appendChild(h('span', 'ctv-stat-value', value));
        cell.appendChild(h('span', 'ctv-stat-label', label));
        grid.appendChild(cell);
    }
    box.appendChild(grid);
}

function updateMatchCounter() {
    const counter = state.els.matchCount;
    if (!counter) {
        return;
    }
    const total = state.matches ? state.matches.matches.size : 0;
    counter.textContent = state.searchQuery ? `${total} 条结果` : '';
}

function jumpToMatch(direction) {
    if (!state.tree) {
        return;
    }
    if (!state.matchOrder.length && state.matches) {
        state.matchOrder = Array.from(state.matches.matches);
    }
    if (!state.matchOrder.length) {
        return;
    }
    const current = state.matchOrder.findIndex((id) => state.rowById.get(id)?.classList.contains('ctv-selected'));
    let next = current + direction;
    if (next < 0) {
        next = state.matchOrder.length - 1;
    }
    if (next >= state.matchOrder.length) {
        next = 0;
    }
    const id = state.matchOrder[next];
    const node = findNodeById(state.tree.root, id);
    if (!node) {
        return;
    }
    if (state.settings.viewMode === 'spatial') {
        selectNode(node);
        state.spatial?.focusNode(id);
    } else {
        state.rowById.get(id)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        selectNode(node);
    }
}

/* -------------------------------------------------------------------------- */
/* Progress / empty states                                                     */
/* -------------------------------------------------------------------------- */

function showProgress(done, total, text) {
    const box = state.els.progress;
    if (!box) {
        return;
    }
    box.classList.remove('ctv-hidden');
    const percent = total ? Math.round((done / total) * 100) : 0;
    state.els.progressBar.style.width = `${percent}%`;
    state.els.progressText.textContent = text;
}

function hideProgress() {
    state.els.progress?.classList.add('ctv-hidden');
}

function showEmpty(message) {
    const box = state.els.empty;
    if (!box) {
        return;
    }
    box.textContent = '';
    box.appendChild(h('div', 'ctv-empty-text', message));
    box.classList.remove('ctv-hidden');
}

function hideEmpty() {
    state.els.empty?.classList.add('ctv-hidden');
}

/* -------------------------------------------------------------------------- */
/* Bootstrap                                                                   */
/* -------------------------------------------------------------------------- */

function installMenuEntry() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu || document.getElementById('ctv-menu-item')) {
        return Boolean(menu);
    }

    const item = h('div', 'list-group-item flex-container flexGap5 interactable');
    item.id = 'ctv-menu-item';
    item.setAttribute('role', 'button');
    item.innerHTML = '<div class="fa-fw fa-solid fa-sitemap extensionsMenuExtensionButton"></div><span>聊天分支树</span>';
    item.addEventListener('click', () => openViewer());
    menu.appendChild(item);
    return true;
}

function installSlashCommand() {
    const ctx = getContext();
    if (!ctx?.SlashCommandParser || !ctx?.SlashCommand || window.__ctvSlashCommand) {
        return;
    }
    try {
        ctx.SlashCommandParser.addCommandObject(ctx.SlashCommand.fromProps({
            name: 'chattree',
            helpString: '打开聊天分支树查看器',
            callback: () => {
                openViewer();
                return '';
            },
        }));
        window.__ctvSlashCommand = true;
    } catch (error) {
        console.warn(`[${EXT_ID}] slash command registration failed`, error);
    }
}

async function boot() {
    if (window.__ctvBooted) {
        return;
    }
    window.__ctvBooted = true;

    const ready = window.__TAURITAVERN__?.ready ?? window.__TAURITAVERN_MAIN_READY__;
    if (ready && typeof ready.then === 'function') {
        try {
            await ready;
        } catch {
            // host not ready, continue anyway
        }
    }

    // Wait for the SillyTavern context and the extension menu.
    for (let attempt = 0; attempt < 240; attempt++) {
        if (getContext() && installMenuEntry()) {
            break;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
    }

    installSlashCommand();
}

boot().catch((error) => {
    console.warn(`[${EXT_ID}] bootstrap failed`, error);
});
