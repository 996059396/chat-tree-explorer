/**
 * Chat Tree Explorer - pure data layer.
 *
 * No DOM, no network, no storage. This module turns parsed chat files into a
 * compact tree:
 *
 *   - a chat is parsed into ordered message turns
 *   - consecutive "turns" become tree nodes
 *   - assistant messages at the same position are grouped into one node with
 *     variants (the familiar SillyTavern swipes)
 *   - user/system messages only merge when their text is identical or highly
 *     similar, so different player choices stay separate branches
 *
 * The renderer only needs the plain object graph returned by buildChatTree().
 */

export const CORE_VERSION = 2;

const STRONG_PROMPT_MARKERS = [
    /<\|im_start\|>/i,
    /<\|im_end\|>/i,
    /<<SYS>>/i,
    /\[\/?INST\]/i,
    /<\|system\|>/i,
    /<\|user\|>/i,
    /<\|assistant\|>/i,
    /<\/?system>/i,
    /^\s*###\s*(instruction|response|system|user|assistant)\b/im,
    /^\s*(system|assistant|user|human|ai)\s*:\s*/im,
    /\[system note:/i,
    /\[start a new chat\]/i,
];

const TAVERN_TEMPLATE_MARKERS = [
    /\{\{char\}\}/i,
    /\{\{user\}\}/i,
    /write\s+\{\{char\}\}['’]s next reply/i,
    /continue the (story|roleplay|chat)/i,
    /do not write as/i,
    /\[ooc:/i,
    /\(ooc:/i,
    /\[memory:/i,
    /\[note:/i,
];

/**
 * Classify a message for the "hide preset / structured" filter. Kept inline
 * so tree-core stays dependency-free (it is also loaded through a data: URL in
 * the offline tests).
 * @param {string} text
 * @param {string} role
 */
/**
 * Parse SillyTavern's humanized send_date values. Returns 0 when unknown.
 * Formats seen in practice:
 *   "2025-11-15 @06h 13m 15s 123ms", "2025-11-15 06:13:15",
 *   ISO strings, and date-only strings.
 * @param {unknown} value
 * @returns {number} epoch milliseconds (local time)
 */
export function parseSendDate(value) {
    if (typeof value !== 'string') {
        return 0;
    }
    const raw = value.trim();
    if (!raw) {
        return 0;
    }
    const direct = Date.parse(raw);
    if (Number.isFinite(direct) && direct > 0) {
        return direct;
    }

    let match = raw.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})\s*[@ ]?\s*(\d{1,2})h\s*(\d{1,2})m\s*(\d{1,2})s(?:\s*(\d{1,3})ms)?/i);
    if (match) {
        const [, year, month, day, hour, minute, second, ms] = match;
        return new Date(
            Number(year), Number(month) - 1, Number(day),
            Number(hour), Number(minute), Number(second), Number(ms || 0),
        ).getTime();
    }

    match = raw.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T@]+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/);
    if (match) {
        const [, year, month, day, hour, minute, second] = match;
        return new Date(
            Number(year), Number(month) - 1, Number(day),
            Number(hour), Number(minute), Number(second || 0), 0,
        ).getTime();
    }

    match = raw.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
    if (match) {
        const [, year, month, day] = match;
        return new Date(Number(year), Number(month) - 1, Number(day)).getTime();
    }
    return 0;
}

export function classifyMessage(text, role) {
    const raw = String(text ?? '');
    if (role === 'system') {
        return { kind: 'system', structured: true };
    }
    let strong = 0;
    for (const pattern of STRONG_PROMPT_MARKERS) {
        if (pattern.test(raw)) {
            strong++;
        }
    }
    let tavern = 0;
    for (const pattern of TAVERN_TEMPLATE_MARKERS) {
        if (pattern.test(raw)) {
            tavern++;
        }
    }
    const structured = strong > 0 || tavern >= 2;
    return { kind: structured ? 'structured' : 'dialogue', structured };
}

export const DEFAULT_OPTIONS = Object.freeze({
    /** Merge near-identical user/system messages into one node. */
    mergeSimilar: true,
    /** Dice threshold (0..1). Higher = stricter. Only used when mergeSimilar. */
    similarityThreshold: 0.82,
    /** Do not try fuzzy matching below this normalized length. */
    minFuzzyLength: 12,
    /** Include is_system messages in the tree. */
    includeSystem: true,
    /** 'recent' | 'oldest' - ordering of sibling branches. */
    branchOrder: 'recent',
});

/* -------------------------------------------------------------------------- */
/* Text normalization and similarity                                           */
/* -------------------------------------------------------------------------- */

const ZERO_WIDTH_RE = /[​-‍⁠﻿\u0000]/g;
const INVISIBLE_RE = /[­͏؜᠎]/g;

/**
 * Normalize text for comparison. This intentionally does not preserve the
 * exact original; the original text is always kept separately for display.
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeForCompare(value) {
    if (value === null || value === undefined) {
        return '';
    }

    let text = String(value);
    try {
        text = text.normalize('NFKC');
    } catch {
        // Older engines: keep the original text.
    }

    text = text
        .replace(ZERO_WIDTH_RE, '')
        .replace(INVISIBLE_RE, '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(?:p|div|li|h[1-6]|tr|blockquote)>/gi, '\n')
        .replace(/<[^>]{0,400}>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#0*39;/gi, "'")
        .replace(/\r\n?/g, '\n')
        .replace(/[ \t\f\v]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
        .toLowerCase();

    return text;
}

/**
 * Fast 64-bit-ish key with two independent 32-bit FNV-1a lanes.
 * @param {string} text
 * @returns {string}
 */
export function hashKey(text) {
    let h1 = 0x811c9dc5;
    let h2 = 0x9e3779b9;
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        h1 ^= code;
        h1 = Math.imul(h1, 0x01000193);
        h2 ^= code + 0x85ebca6b;
        h2 = Math.imul(h2, 0xc2b2ae35);
    }
    return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

/**
 * Internal 32-bit hash used for n-gram fingerprints.
 * @param {string} text
 * @returns {number}
 */
function hash32(text) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
}

const FP_CACHE_LIMIT = 3000;
const fpCache = new Map();

/**
 * Release the fingerprint cache. Call this when the chat corpus is dropped
 * (character switch / viewer close); cached feature sets can be large.
 */
export function clearFingerprintCache() {
    fpCache.clear();
}

/**
 * Build a capped set of hashed features (words + character n-grams).
 * The cap keeps long roleplay messages cheap to compare.
 * @param {string} normalized
 * @returns {Set<number>}
 */
export function fingerprint(normalized) {
    if (!normalized) {
        return new Set();
    }

    const cached = fpCache.get(normalized);
    if (cached) {
        return cached;
    }

    const features = new Set();

    if (normalized.length <= 24) {
        features.add(hash32('s:' + normalized));
    }

    // Word-ish tokens are useful for Latin text; CJK runs are usually one
    // token, so character n-grams below carry the real signal for CJK.
    const tokenRe = /[\p{L}\p{N}_]{2,}/gu;
    let match;
    let tokenCount = 0;
    while ((match = tokenRe.exec(normalized)) !== null && tokenCount < 240) {
        features.add(hash32('w:' + match[0]));
        tokenCount++;
    }

    const length = normalized.length;
    const gram = length >= 8 ? 3 : 2;
    const span = length - gram + 1;
    if (span > 0) {
        const step = Math.max(1, Math.ceil(span / 520));
        for (let i = 0; i < span; i += step) {
            let hash = 0x811c9dc5;
            for (let j = 0; j < gram; j++) {
                hash ^= normalized.charCodeAt(i + j);
                hash = Math.imul(hash, 0x01000193);
            }
            features.add(hash >>> 0);
        }
    }

    if (fpCache.size >= FP_CACHE_LIMIT) {
        fpCache.clear();
    }
    fpCache.set(normalized, features);
    return features;
}

/**
 * Dice similarity of two normalized strings.
 * @param {string} a
 * @param {string} b
 * @returns {number} 0..1
 */
export function similarityNorm(a, b) {
    if (a === b) {
        return a.length ? 1 : 0;
    }
    if (!a || !b) {
        return 0;
    }

    const minLength = Math.min(a.length, b.length);
    const maxLength = Math.max(a.length, b.length);
    if (minLength / maxLength < 0.5) {
        return 0;
    }

    const setA = fingerprint(a);
    const setB = fingerprint(b);
    if (!setA.size || !setB.size) {
        return 0;
    }

    let intersection = 0;
    const [small, large] = setA.size <= setB.size ? [setA, setB] : [setB, setA];
    for (const feature of small) {
        if (large.has(feature)) {
            intersection++;
        }
    }

    return (2 * intersection) / (setA.size + setB.size);
}

/**
 * Similarity between two variant objects. Fingerprints are cached on the
 * variant object so repeated matching does not re-hash long messages.
 * @param {{norm:string, _fp?:Set<number>}} a
 * @param {{norm:string, _fp?:Set<number>}} b
 * @returns {number}
 */
export function similarityVariants(a, b) {
    if (a.norm === b.norm) {
        return a.norm.length ? 1 : 0;
    }
    if (!a.norm || !b.norm) {
        return 0;
    }
    const minLength = Math.min(a.norm.length, b.norm.length);
    const maxLength = Math.max(a.norm.length, b.norm.length);
    if (minLength / maxLength < 0.5) {
        return 0;
    }

    if (!a._fp) {
        a._fp = fingerprint(a.norm);
    }
    if (!b._fp) {
        b._fp = fingerprint(b.norm);
    }

    const setA = a._fp;
    const setB = b._fp;
    if (!setA.size || !setB.size) {
        return 0;
    }

    let intersection = 0;
    const [small, large] = setA.size <= setB.size ? [setA, setB] : [setB, setA];
    for (const feature of small) {
        if (large.has(feature)) {
            intersection++;
        }
    }

    return (2 * intersection) / (setA.size + setB.size);
}

/* -------------------------------------------------------------------------- */
/* Payload parsing                                                             */
/* -------------------------------------------------------------------------- */

/**
 * A SillyTavern chat payload is a JSON array whose first non-empty record may
 * be a header object. Some payloads do not have a header.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isChatHeader(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    if (Object.prototype.hasOwnProperty.call(value, 'mes')) {
        return false;
    }
    return (
        Object.prototype.hasOwnProperty.call(value, 'chat_metadata') ||
        Object.prototype.hasOwnProperty.call(value, 'user_name') ||
        Object.prototype.hasOwnProperty.call(value, 'character_name') ||
        Object.prototype.hasOwnProperty.call(value, 'create_date')
    );
}

/**
 * Extract one message into a role + variant list. Swipes live at top level in
 * SillyTavern, but some databases store them under extra, so both are read.
 * @param {any} raw
 * @returns {null | {
 *   role: 'user'|'assistant'|'system',
 *   mes: string,
 *   name: string,
 *   sendDate: string,
 *   selectedKey: string,
 *   selectedNorm: string,
 *   variants: Array<{key:string, text:string, norm:string, swipeIndex:number, selected:boolean}>,
 *   extraSwipes: boolean,
 * }}
 */
export function extractMessage(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return null;
    }

    const isUser = raw.is_user === true || raw.is_user === 'true';
    const isSystem = raw.is_system === true || raw.is_system === 'true';
    const role = isSystem ? 'system' : isUser ? 'user' : 'assistant';

    const rawMes = raw.mes;
    const mes = typeof rawMes === 'string' ? rawMes : rawMes === null || rawMes === undefined ? '' : String(rawMes);

    let swipes = [];
    let extraSwipes = false;
    if (Array.isArray(raw.swipes)) {
        swipes = raw.swipes;
    } else if (raw.extra && Array.isArray(raw.extra.swipes)) {
        swipes = raw.extra.swipes;
        extraSwipes = true;
    }
    swipes = swipes
        .filter((item) => typeof item === 'string' || typeof item === 'number')
        .map((item) => (typeof item === 'string' ? item : String(item)));

    let swipeId = raw.swipe_id;
    if (swipeId === undefined || swipeId === null) {
        swipeId = raw.extra?.swipe_id;
    }
    const numericSwipeId = Number(swipeId);

    // `swipes` is the generation history, `mes` is what the chat actually
    // shows. They frequently differ (the message was edited or regex
    // processed), so `mes` is kept as its own variant, inserted at the
    // position of the selected swipe.
    let entries;
    let selectedIndex;

    if (!swipes.length) {
        entries = [{ text: mes, swipeIndex: 0 }];
        selectedIndex = 0;
    } else {
        const clamped = Number.isInteger(numericSwipeId)
            ? Math.max(0, Math.min(swipes.length - 1, numericSwipeId))
            : 0;

        entries = swipes.map((text, index) => ({ text, swipeIndex: index }));

        if (mes === '' || swipes[clamped] === mes) {
            selectedIndex = clamped;
        } else {
            const found = swipes.indexOf(mes);
            if (found >= 0) {
                selectedIndex = found;
            } else {
                // The edited text takes the place of the selected swipe.
                entries.splice(clamped + 1, 0, { text: mes, swipeIndex: clamped });
                selectedIndex = clamped + 1;
            }
        }
    }

    const variants = [];
    const seen = new Set();
    for (let index = 0; index < entries.length; index++) {
        const entry = entries[index];
        const norm = normalizeForCompare(entry.text);
        const key = hashKey(norm);
        const selected = index === selectedIndex;
        if (seen.has(key)) {
            if (selected) {
                const existing = variants.find((variant) => variant.key === key);
                if (existing) {
                    existing.selected = true;
                }
            }
            continue;
        }
        seen.add(key);
        variants.push({ key, text: entry.text, norm, swipeIndex: entry.swipeIndex, selected });
    }

    let selectedKey = '';
    let selectedNorm = '';
    const selectedVariant = variants.find((variant) => variant.selected) || variants[0];
    if (selectedVariant) {
        selectedKey = selectedVariant.key;
        selectedNorm = selectedVariant.norm;
    }

    const classification = classifyMessage(mes, role);

    return {
        role,
        mes,
        name: typeof raw.name === 'string' ? raw.name : '',
        sendDate: typeof raw.send_date === 'string' ? raw.send_date : '',
        sendEpoch: parseSendDate(raw.send_date),
        selectedKey,
        selectedNorm,
        variants,
        extraSwipes,
        kind: classification.kind,
        structured: classification.structured,
        rich: /<[^>]+>/.test(mes) || /```/.test(mes),
        extra: raw.extra && typeof raw.extra === 'object' ? raw.extra : null,
    };
}

/**
 * @param {unknown} rawPayload
 * @param {{key?:string, file?:string, name?:string, date?:number}} [meta]
 */
export function parseChatPayload(rawPayload, meta = {}) {
    let records = rawPayload;
    if (records && !Array.isArray(records) && Array.isArray(records.messages)) {
        records = records.messages;
    }
    if (!Array.isArray(records)) {
        return {
            key: meta.key || meta.file || '',
            file: meta.file || meta.key || '',
            name: meta.name || '',
            date: Number(meta.date) || 0,
            header: null,
            messages: [],
            invalid: true,
        };
    }

    let header = null;
    let start = 0;
    if (records.length && isChatHeader(records[0])) {
        header = records[0];
        start = 1;
    }

    const messages = [];
    for (let index = start; index < records.length; index++) {
        const message = extractMessage(records[index]);
        if (message) {
            messages.push(message);
        }
    }

    return {
        key: meta.key || meta.file || '',
        file: meta.file || meta.key || '',
        name: meta.name || '',
        date: Number(meta.date) || 0,
        header,
        messages,
        invalid: false,
    };
}

/* -------------------------------------------------------------------------- */
/* Tree building                                                               */
/* -------------------------------------------------------------------------- */

function makeNode(role, parent) {
    return {
        id: '',
        role,
        parent,
        depth: 0,
        children: [],
        variants: new Map(),
        variantList: [],
        defaultVariantKey: '',
        chats: new Set(),
        occurrences: [],
        edgeVariants: new Map(),
        assistantChild: null,
        order: 0,
        lastActivity: 0,
        minIndex: Number.POSITIVE_INFINITY,
        branchPoint: false,
        senderName: '',
        sampleDate: '',
        dialogueCount: 0,
        structuredCount: 0,
        richCount: 0,
        structured: false,
        rich: false,
        timeMin: 0,
        timeMax: 0,
    };
}

function makeVariant(source) {
    return {
        key: source.key,
        text: source.text,
        norm: source.norm,
        firstSwipeIndex: source.swipeIndex || 0,
        count: 0,
        selectedCount: 0,
        chats: new Set(),
        selectedChats: new Set(),
        _fp: null,
    };
}

function getOrCreateVariant(node, source) {
    let variant = node.variants.get(source.key);
    if (!variant) {
        variant = makeVariant(source);
        node.variants.set(source.key, variant);
    }
    return variant;
}

function addVariantSource(node, source) {
    const variant = getOrCreateVariant(node, source);
    variant.count++;
    return variant;
}

/**
 * Pick the most-used selected variant for display.
 * @param {any} node
 */
function chooseDefaultVariant(node) {
    let best = null;
    for (const variant of node.variants.values()) {
        if (!best) {
            best = variant;
            continue;
        }
        if (variant.selectedCount > best.selectedCount) {
            best = variant;
        } else if (variant.selectedCount === best.selectedCount) {
            if (variant.firstSwipeIndex < best.firstSwipeIndex) {
                best = variant;
            } else if (variant.firstSwipeIndex === best.firstSwipeIndex && variant.count > best.count) {
                best = variant;
            }
        }
    }
    return best;
}

function recordEdgeVariant(node, parentVariantKey, chatKey) {
    const key = parentVariantKey || '*';
    let chats = node.edgeVariants.get(key);
    if (!chats) {
        chats = new Set();
        node.edgeVariants.set(key, chats);
    }
    chats.add(chatKey);
}

function findFuzzyChild(parent, message, options, chatKey) {
    if (!options.mergeSimilar || message.selectedNorm.length < options.minFuzzyLength) {
        return null;
    }

    // Reuse the probe's fingerprint across every candidate comparison.
    const probe = { norm: message.selectedNorm, _fp: null };
    let best = null;
    let bestScore = 0;
    for (const child of parent.children) {
        if (child.role !== message.role) {
            continue;
        }
        for (const variant of child.variants.values()) {
            const score = similarityVariants(probe, variant);
            if (score > bestScore) {
                bestScore = score;
                best = child;
                if (score === 1) {
                    break;
                }
            }
        }
        if (bestScore === 1) {
            break;
        }
    }

    if (best && bestScore >= options.similarityThreshold) {
        return best;
    }
    return null;
}

/**
 * @param {any} parent
 * @param {any} message
 * @param {any} options
 * @param {string} chatKey
 */
function selectChild(parent, message, options, chatKey) {
    if (message.role === 'assistant') {
        // At a given context every assistant message is an alternative
        // generation of the same turn. Group them into one node; each distinct
        // text becomes a variant (swipe).
        if (parent.assistantChild) {
            return parent.assistantChild;
        }
        return null;
    }

    // Exact match first: this must work even with fuzzy merging disabled.
    for (const child of parent.children) {
        if (child.role === message.role && child.variants.has(message.selectedKey)) {
            return child;
        }
    }

    return findFuzzyChild(parent, message, options, chatKey);
}

function attachChild(parent, child) {
    child.parent = parent;
    parent.children.push(child);
    if (child.role === 'assistant') {
        parent.assistantChild = child;
    }
}

/**
 * @param {any} node
 * @param {any} message
 * @param {string} chatKey
 * @param {number} messageIndex
 */
function applyMessage(node, message, chatKey, messageIndex, chatDate = 0) {
    node.chats.add(chatKey);
    if (messageIndex < node.minIndex) {
        node.minIndex = messageIndex;
    }
    if (!node.senderName && message.name) {
        node.senderName = message.name;
    }
    if (!node.sampleDate && message.sendDate) {
        node.sampleDate = message.sendDate;
    }
    if (message.structured || message.kind === 'system') {
        node.structuredCount++;
    } else {
        node.dialogueCount++;
    }
    if (message.rich) {
        node.richCount++;
    }
    const epoch = Number(message.sendEpoch) || Number(chatDate) || 0;
    if (epoch > 0) {
        if (!node.timeMin || epoch < node.timeMin) {
            node.timeMin = epoch;
        }
        if (epoch > node.timeMax) {
            node.timeMax = epoch;
        }
    }

    let selectedKey = message.selectedKey;
    for (const source of message.variants) {
        const variant = addVariantSource(node, source);
        variant.chats.add(chatKey);
        if (source.selected) {
            variant.selectedChats.add(chatKey);
            variant.selectedCount++;
            selectedKey = variant.key;
        }
    }

    // Defensive: a malformed payload can have no variants at all.
    if (!node.variants.size) {
        const fallback = { key: hashKey(''), text: message.mes || '', norm: normalizeForCompare(message.mes || ''), swipeIndex: 0, selected: true };
        const variant = getOrCreateVariant(node, fallback);
        variant.count++;
        variant.chats.add(chatKey);
        variant.selectedChats.add(chatKey);
        variant.selectedCount++;
        selectedKey = variant.key;
    }

    if (!selectedKey || !node.variants.has(selectedKey)) {
        selectedKey = node.defaultVariantKey || node.variants.keys().next().value || '';
    }

    node.occurrences.push({
        chatKey,
        index: messageIndex,
        variantKey: selectedKey,
    });

    return selectedKey;
}

/**
 * Build the tree.
 *
 * @param {Array<{
 *   key: string,
 *   file?: string,
 *   name?: string,
 *   date?: number,
 *   header?: any,
 *   messages: any[],
 * }>} chats
 * @param {Partial<typeof DEFAULT_OPTIONS>} [options]
 */
export function buildChatTree(chats, options = {}) {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const root = makeNode('root', null);
    root.id = 'root';

    let nextNodeId = 1;
    let nextOrder = 0;
    let totalMessages = 0;

    const sortedChats = (Array.isArray(chats) ? chats : [])
        .filter((chat) => chat && Array.isArray(chat.messages) && chat.messages.length)
        .map((chat) => ({ ...chat, key: chat.key || chat.file || '', date: Number(chat.date) || 0 }))
        .sort((a, b) => {
            if (a.date !== b.date) {
                return a.date - b.date;
            }
            return String(a.key).localeCompare(String(b.key));
        });

    for (const chat of sortedChats) {
        const chatKey = chat.key;
        let current = root;
        let parentVariantKey = '';

        for (let index = 0; index < chat.messages.length; index++) {
            const message = chat.messages[index];
            if (!message) {
                continue;
            }
            if (message.role === 'system' && !opts.includeSystem) {
                continue;
            }

            totalMessages++;

            let node = selectChild(current, message, opts, chatKey);
            if (!node) {
                node = makeNode(message.role, current);
                node.id = 'n' + nextNodeId++;
                node.order = nextOrder++;
                attachChild(current, node);
            }

            const activeVariantKey = applyMessage(node, message, chatKey, index, chat.date);
            node.lastActivity = Math.max(node.lastActivity, chat.date || 0);

            if (current !== root) {
                recordEdgeVariant(node, parentVariantKey, chatKey);
            } else {
                recordEdgeVariant(node, '*', chatKey);
            }

            current = node;
            parentVariantKey = activeVariantKey;
        }
    }

    finalizeTree(root, opts);

    let nodeCount = 0;
    let sharedNodeCount = 0;
    let branchPointCount = 0;
    let variantCount = 0;
    let maxDepth = 0;

    const stack = [root];
    while (stack.length) {
        const node = stack.pop();
        if (node !== root) {
            nodeCount++;
            if (node.chats.size > 1) {
                sharedNodeCount++;
            }
            if (node.branchPoint) {
                branchPointCount++;
            }
            variantCount += node.variants.size;
            if (node.depth > maxDepth) {
                maxDepth = node.depth;
            }
        }
        for (let i = node.children.length - 1; i >= 0; i--) {
            stack.push(node.children[i]);
        }
    }

    return {
        root,
        options: opts,
        stats: {
            chatCount: sortedChats.length,
            messageCount: totalMessages,
            nodeCount,
            sharedNodeCount,
            branchPointCount,
            variantCount,
            maxDepth,
            overlapRate: nodeCount ? sharedNodeCount / nodeCount : 0,
        },
        chatCount: sortedChats.length,
    };
}

/**
 * @param {any} root
 * @param {any} options
 */
function finalizeTree(root, options) {
    const stack = [root];
    while (stack.length) {
        const node = stack.pop();
        const defaultVariant = chooseDefaultVariant(node);
        node.defaultVariantKey = defaultVariant ? defaultVariant.key : '';
        node.variantList = Array.from(node.variants.values()).sort((a, b) => {
            if (a.firstSwipeIndex !== b.firstSwipeIndex) {
                return a.firstSwipeIndex - b.firstSwipeIndex;
            }
            if (a.selectedCount !== b.selectedCount) {
                return b.selectedCount - a.selectedCount;
            }
            return a.text.localeCompare(b.text);
        });
        node.branchPoint = node.children.length > 1;
        node.structured = node.structuredCount > 0 && node.dialogueCount === 0;
        node.rich = node.richCount > 0;

        if (node.children.length > 1) {
            node.children.sort((a, b) => {
                if (options.branchOrder === 'oldest') {
                    if (a.minIndex !== b.minIndex) {
                        return a.minIndex - b.minIndex;
                    }
                    return a.order - b.order;
                }
                if (a.lastActivity !== b.lastActivity) {
                    return b.lastActivity - a.lastActivity;
                }
                if (a.minIndex !== b.minIndex) {
                    return a.minIndex - b.minIndex;
                }
                return a.order - b.order;
            });
        }

        for (const child of node.children) {
            child.depth = node.depth + 1;
            stack.push(child);
        }
    }
}

/**
 * Count how many nodes carry each chat. Useful for the chat sidebar and for
 * quick sanity checks. Not part of the renderer hot path.
 * @param {any} root
 * @returns {Map<string, number>}
 */
export function countNodesByChat(root) {
    const counts = new Map();
    const stack = [root];
    while (stack.length) {
        const node = stack.pop();
        for (const chatKey of node.chats) {
            counts.set(chatKey, (counts.get(chatKey) || 0) + 1);
        }
        for (const child of node.children) {
            stack.push(child);
        }
    }
    return counts;
}
