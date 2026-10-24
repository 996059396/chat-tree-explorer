/**
 * Canvas 2.5D/3D renderer for the Chat Tree Explorer spatial view.
 *
 * No external dependencies. The camera is a simple spherical orbit camera with
 * perspective projection; messages are billboarded cards with level-of-detail
 * (dot → pill → card → detailed card). Edges, per-chat strands, anchors and
 * hover tooltips are drawn on top.
 *
 * The renderer only reads the model produced by spatial-layout.js; it never
 * touches chat files or network APIs.
 */

import { textFeatureHues } from './spatial-layout.js';
import { plainTextForDisplay } from './spatial-text.js';

const ROLE_LABEL = { user: '你', assistant: 'AI', system: '系统', segment: '段', root: '根' };
const ROLE_COLOR = {
    user: { r: 96, g: 190, b: 255 },
    assistant: { r: 112, g: 224, b: 154 },
    system: { r: 160, g: 160, b: 170 },
    segment: { r: 232, g: 192, b: 112 },
    root: { r: 220, g: 220, b: 230 },
};
const SHARED_COLOR = { r: 138, g: 178, b: 255 };
const FONT_STACK = '-apple-system, "Segoe UI", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';

function clamp(value, min, max) {
    return value < min ? min : value > max ? max : value;
}

function lerp(a, b, t) {
    return a + (b - a) * t;
}

function rgba(color, alpha) {
    return `rgba(${color.r},${color.g},${color.b},${alpha})`;
}

function roleColor(role) {
    return ROLE_COLOR[role] || ROLE_COLOR.assistant;
}

function roundRectPath(ctx, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + width - r, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + r);
    ctx.lineTo(x + width, y + height - r);
    ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    ctx.lineTo(x + r, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
}

function truncateCache() {
    return new Map();
}

function fitText(ctx, text, maxWidth, cache) {
    const value = String(text || '').replace(/\s+/g, ' ').trim();
    if (!value || maxWidth <= 2) {
        return '';
    }
    const bucket = Math.max(8, Math.round(maxWidth / 8) * 8);
    const key = `${bucket}\u0000${value}`;
    const cached = cache.get(key);
    if (cached !== undefined) {
        return cached;
    }
    if (ctx.measureText(value).width <= maxWidth) {
        cache.set(key, value);
        return value;
    }
    const chars = Array.from(value);
    let low = 0;
    let high = chars.length;
    while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        const candidate = chars.slice(0, mid).join('') + '…';
        if (ctx.measureText(candidate).width <= maxWidth) {
            low = mid;
            high = high;
        } else {
            high = mid - 1;
        }
    }
    const result = low > 0 ? chars.slice(0, low).join('') + '…' : '';
    cache.set(key, result);
    return result;
}

export class SpatialView {
    /**
     * @param {{
     *   container: HTMLElement,
     *   onSelectNode?: (ref:any)=>void,
     *   onFocusChat?: (chatKey:string)=>void,
     *   resolveDisplayName?: (chatKey:string)=>string,
     * }} options
     */
    constructor({ container, onSelectNode, onFocusChat, onExpandSegment, resolveDisplayName }) {
        this.container = container;
        this.onSelectNode = onSelectNode || (() => {});
        this.onFocusChat = onFocusChat || (() => {});
        this.onExpandSegment = onExpandSegment || (() => {});
        this.resolveDisplayName = resolveDisplayName || ((key) => key);

        this.canvas = document.createElement('canvas');
        this.canvas.className = 'ctv-spatial-canvas';
        this.canvas.tabIndex = 0;
        this.canvas.setAttribute('aria-label', '聊天空间视图');
        container.appendChild(this.canvas);

        this.tooltip = document.createElement('div');
        this.tooltip.className = 'ctv-spatial-tooltip ctv-hidden';
        container.appendChild(this.tooltip);

        this.ctx = this.canvas.getContext('2d');
        this.width = 0;
        this.height = 0;
        this.dpr = 1;
        this.model = null;
        this.chatInfo = new Map();
        this.variantState = new Map();
        this.settings = {
            showAnchors: true,
            showAllStrands: false,
            autoRotate: false,
            showStructured: false,
            showDivergence: true,
            maxAnchors: 12,
        };

        this.selectedNodeId = null;
        this.hoveredNodeId = null;
        this.searchMatches = null;
        this.focusChatKey = null;

        this.camera = {
            target: { x: 0, y: 0, z: 0 },
            yaw: 0.72,
            pitch: 0.34,
            distance: 60,
        };
        this.goal = {
            target: { x: 0, y: 0, z: 0 },
            yaw: 0.72,
            pitch: 0.34,
            distance: 60,
        };

        this.animating = false;
        this.frameRequested = false;
        this._fitted = false;
        this._modelKey = '';
        this.drag = null;
        this.pointers = new Map();
        this.pinch = null;
        this.textCache = truncateCache();
        this.screenNodes = [];
        this.screenAnchors = [];
        this.starfield = null;
        this.resizeObserver = null;
        this.autoRotatePhase = 0;

        this._bindEvents();
        this.resize();
    }

    /* ------------------------------------------------------------------ */
    /* Data / state                                                        */
    /* ------------------------------------------------------------------ */

    clear() {
        this.model = null;
        this._fitted = false;
        this._modelKey = '';
        this.screenNodes = [];
        this.screenAnchors = [];
        this.hoveredNodeId = null;
        this.hideTooltip();
        if (this.ctx) {
            this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
            this.ctx.clearRect(0, 0, this.width, this.height);
        }
        this.requestRender();
    }

    setData(model, chatInfo, options = {}) {
        const key = model
            ? `${model.stats.chatCount}:${model.stats.visibleNodes}:${model.stats.maxDepth}:${model.stats.hiddenNodes}`
            : '';
        const changed = key !== this._modelKey;
        this._modelKey = key;

        this.model = model;
        this.chatInfo = chatInfo || new Map();
        this.textCache.clear();
        this.screenNodes = [];
        this.screenAnchors = [];
        this.applyVariantState();
        if (!options.preserveCamera && (!this._fitted || changed)) {
            this.fitInitial();
            this._fitted = true;
        }
        this.requestRender();
    }

    setSettings(patch) {
        this.settings = { ...this.settings, ...patch };
        this.requestRender();
    }

    setVariantState(variantState) {
        this.variantState = variantState || new Map();
        this.applyVariantState();
        this.requestRender();
    }

    applyVariantState() {
        if (!this.model) {
            return;
        }
        for (const view of this.model.nodes) {
            if (view.segmentNodes) {
                continue;
            }
            const ref = view.ref;
            const key = this.variantState.get(view.id);
            const variant = (key && ref.variants?.get(key))
                || ref.variants?.get(ref.defaultVariantKey)
                || ref.variantList?.[0];
            if (variant) {
                view.text = variant.text;
                view.displayText = plainTextForDisplay(variant.text, 2000);
                view.displayLength = view.displayText.length;
                view.textLength = variant.norm.length;
                const index = ref.variantList ? ref.variantList.findIndex((item) => item.key === variant.key) : 0;
                view.variantIndex = index >= 0 ? index : 0;
                view.variantCount = ref.variantList ? ref.variantList.length : 1;
            }
        }
    }

    setSelected(nodeId) {
        this.selectedNodeId = nodeId || null;
        this.requestRender();
    }

    setHover(nodeId) {
        if (this.hoveredNodeId === nodeId) {
            return;
        }
        this.hoveredNodeId = nodeId || null;
        this.requestRender();
    }

    setSearch(matches) {
        this.searchMatches = matches || null;
        this.requestRender();
    }

    setFocusChat(chatKey) {
        this.focusChatKey = chatKey || null;
        this.requestRender();
    }

    /* ------------------------------------------------------------------ */
    /* Camera                                                              */
    /* ------------------------------------------------------------------ */

    basis() {
        const { target, yaw, pitch, distance } = this.camera;
        const cp = Math.cos(pitch);
        const cam = {
            x: target.x + distance * cp * Math.sin(yaw),
            y: target.y + distance * Math.sin(pitch),
            z: target.z + distance * cp * Math.cos(yaw),
        };
        let fx = target.x - cam.x;
        let fy = target.y - cam.y;
        let fz = target.z - cam.z;
        let fl = Math.hypot(fx, fy, fz) || 1;
        fx /= fl;
        fy /= fl;
        fz /= fl;

        let rx = fz;
        let ry = 0;
        let rz = -fx;
        let rl = Math.hypot(rx, ry, rz) || 1;
        rx /= rl;
        rz /= rl;

        let ux = ry * fz - rz * fy;
        let uy = rz * fx - rx * fz;
        let uz = rx * fy - ry * fx;
        const ul = Math.hypot(ux, uy, uz) || 1;
        ux /= ul;
        uy /= ul;
        uz /= ul;

        return { cam, f: { x: fx, y: fy, z: fz }, r: { x: rx, y: ry, z: rz }, u: { x: ux, y: uy, z: uz } };
    }

    project(point, basis) {
        const relX = point.x - basis.cam.x;
        const relY = point.y - basis.cam.y;
        const relZ = point.z - basis.cam.z;
        const cz = relX * basis.f.x + relY * basis.f.y + relZ * basis.f.z;
        if (cz < 0.25) {
            return null;
        }
        const cx = relX * basis.r.x + relY * basis.r.y + relZ * basis.r.z;
        const cy = relX * basis.u.x + relY * basis.u.y + relZ * basis.u.z;
        const focal = (this.height / 2) / Math.tan((Math.PI / 3) / 2);
        return {
            x: this.width / 2 + (cx / cz) * focal,
            y: this.height / 2 - (cy / cz) * focal,
            scale: focal / cz,
            cz,
        };
    }

    fitInitial() {
        if (!this.model) {
            return;
        }
        const maxDepth = this.model.stats.maxDepth;
        // Short trees fit entirely. Long trees are dominated by a tall shared
        // trunk; start on the branching/ending region instead so cards are
        // legible. The compass button still fits everything.
        if (maxDepth < 26) {
            this.fitAll();
            return;
        }
        const startDepth = maxDepth * 0.62;
        const focus = this.model.nodes.filter((view) => view.depth >= startDepth);
        if (focus.length < 10) {
            this.fitAll();
            return;
        }

        let minX = Infinity;
        let minY = Infinity;
        let minZ = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        let maxZ = -Infinity;
        const include = (x, y, z) => {
            minX = Math.min(minX, x); maxX = Math.max(maxX, x);
            minY = Math.min(minY, y); maxY = Math.max(maxY, y);
            minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
        };
        for (const view of focus) {
            include(view.x, view.y, view.z);
        }
        for (const anchor of this.model.chatAnchors) {
            if (anchor.terminalNode.depth >= startDepth) {
                include(anchor.x, anchor.y, anchor.z);
            }
        }

        this.goal.target = { x: (minX + maxX) / 2, y: (minY + maxY) / 2, z: (minZ + maxZ) / 2 };
        const radius = Math.max(6, Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2);
        this.goal.distance = clamp(radius / Math.tan((Math.PI / 3) / 2) * 1.35 + 8, 10, 4800);
        this.goal.yaw = 0.8;
        this.goal.pitch = 0.36;
        this.startAnimation();
    }

    fitAll() {
        if (!this.model) {
            return;
        }
        const { bounds } = this.model;
        this.goal.target = { ...bounds.center };
        const radius = Math.max(6, bounds.radius);
        this.goal.distance = clamp(radius / Math.tan((Math.PI / 3) / 2) * 1.35 + 12, 12, 4800);
        this.goal.yaw = 0.72;
        this.goal.pitch = 0.34;
        this.startAnimation();
    }

    resolveViewForNode(nodeId) {
        if (!this.model) {
            return null;
        }
        const direct = this.model.nodeById.get(nodeId);
        if (direct) {
            return direct;
        }
        for (const view of this.model.nodes) {
            if (view.segmentNodes && view.segmentNodes.some((node) => node.id === nodeId)) {
                return view;
            }
        }
        return null;
    }

    focusNode(nodeId) {
        const view = this.resolveViewForNode(nodeId);
        if (!view) {
            return;
        }
        this.goal.target = { x: view.x, y: view.y, z: view.z };
        this.goal.distance = clamp(this.goal.distance, 10, 90);
        this.startAnimation();
    }

    focusChat(chatKey) {
        const path = this.model?.chatPaths.get(chatKey);
        if (!path || !path.length) {
            return;
        }
        let minX = Infinity;
        let minY = Infinity;
        let minZ = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        let maxZ = -Infinity;
        for (const view of path) {
            minX = Math.min(minX, view.x);
            minY = Math.min(minY, view.y);
            minZ = Math.min(minZ, view.z);
            maxX = Math.max(maxX, view.x);
            maxY = Math.max(maxY, view.y);
            maxZ = Math.max(maxZ, view.z);
        }
        const anchor = this.model.chatAnchors.find((item) => item.chatKey === chatKey);
        if (anchor) {
            minX = Math.min(minX, anchor.x);
            minY = Math.min(minY, anchor.y);
            minZ = Math.min(minZ, anchor.z);
            maxX = Math.max(maxX, anchor.x);
            maxY = Math.max(maxY, anchor.y);
            maxZ = Math.max(maxZ, anchor.z);
        }
        this.goal.target = {
            x: (minX + maxX) / 2,
            y: (minY + maxY) / 2,
            z: (minZ + maxZ) / 2,
        };
        const radius = Math.max(5, Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2);
        this.goal.distance = clamp(radius / Math.tan((Math.PI / 3) / 2) * 1.5, 10, 2000);
        this.startAnimation();
    }

    resetCamera() {
        this.fitAll();
        this._fitted = true;
    }

    startAnimation() {
        this.animating = true;
        this.requestRender();
    }

    /* ------------------------------------------------------------------ */
    /* Sizing / events                                                     */
    /* ------------------------------------------------------------------ */

    resize() {
        const rect = this.container.getBoundingClientRect();
        const width = Math.max(1, Math.floor(rect.width));
        const height = Math.max(1, Math.floor(rect.height));
        const dpr = Math.min(2.5, window.devicePixelRatio || 1);

        // ResizeObserver can fire again after the backing store changes; bail
        // out unless something actually changed to avoid notification loops.
        if (width === this.width && height === this.height && dpr === this.dpr) {
            return;
        }

        this.dpr = dpr;
        this.width = width;
        this.height = height;
        this.canvas.width = Math.floor(width * dpr);
        this.canvas.height = Math.floor(height * dpr);
        this.starfield = null;
        this.requestRender();
    }

    _bindEvents() {
        this.resizeObserver = new ResizeObserver(() => this.resize());
        this.resizeObserver.observe(this.container);

        this.canvas.addEventListener('pointerdown', (event) => this.onPointerDown(event));
        this.canvas.addEventListener('pointermove', (event) => this.onPointerMove(event));
        this.canvas.addEventListener('pointerup', (event) => this.onPointerUp(event));
        this.canvas.addEventListener('pointercancel', (event) => this.onPointerUp(event));
        this.canvas.addEventListener('pointerleave', () => {
            this.setHover(null);
            this.hideTooltip();
        });
        this.canvas.addEventListener('wheel', (event) => this.onWheel(event), { passive: false });
        this.canvas.addEventListener('dblclick', (event) => this.onDoubleClick(event));
        this.canvas.addEventListener('contextmenu', (event) => event.preventDefault());
        this.canvas.addEventListener('keydown', (event) => {
            if (event.key === 'r' || event.key === 'R') {
                this.resetCamera();
            }
        });
    }

    onPointerDown(event) {
        this.canvas.focus({ preventScroll: true });
        this.canvas.setPointerCapture?.(event.pointerId);
        this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (this.pointers.size === 2) {
            const [a, b] = Array.from(this.pointers.values());
            this.pinch = {
                distance: Math.hypot(a.x - b.x, a.y - b.y),
                center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
            };
            this.drag = null;
            return;
        }
        this.drag = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            lastX: event.clientX,
            lastY: event.clientY,
            moved: 0,
            mode: event.button === 2 || event.button === 1 || event.shiftKey ? 'pan' : 'orbit',
        };
        this.hideTooltip();
    }

    onPointerMove(event) {
        const pointer = this.pointers.get(event.pointerId);
        if (pointer) {
            pointer.x = event.clientX;
            pointer.y = event.clientY;
        }

        if (this.pinch && this.pointers.size === 2) {
            const [a, b] = Array.from(this.pointers.values());
            const distance = Math.hypot(a.x - b.x, a.y - b.y);
            const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
            if (this.pinch.distance > 0) {
                this.camera.distance = clamp(this.camera.distance * (this.pinch.distance / distance), 6, 4000);
                this.goal.distance = this.camera.distance;
            }
            this.panBy(center.x - this.pinch.center.x, center.y - this.pinch.center.y);
            this.pinch = { distance, center };
            this.requestRender();
            return;
        }

        if (!this.drag) {
            this.updateHover(event.clientX, event.clientY);
            return;
        }

        const dx = event.clientX - this.drag.lastX;
        const dy = event.clientY - this.drag.lastY;
        this.drag.lastX = event.clientX;
        this.drag.lastY = event.clientY;
        this.drag.moved += Math.abs(dx) + Math.abs(dy);

        if (this.drag.mode === 'pan') {
            this.panBy(dx, dy);
        } else {
            this.camera.yaw -= dx * 0.006;
            this.camera.pitch = clamp(this.camera.pitch + dy * 0.006, -1.25, 1.25);
            this.goal.yaw = this.camera.yaw;
            this.goal.pitch = this.camera.pitch;
        }
        this.requestRender();
    }

    onPointerUp(event) {
        const wasDrag = this.drag;
        this.drag = null;
        this.pointers.delete(event.pointerId);
        if (this.pointers.size < 2) {
            this.pinch = null;
        }
        if (!wasDrag || wasDrag.pointerId !== event.pointerId) {
            return;
        }
        if (wasDrag.moved < 5) {
            const hit = this.pickAt(event.clientX, event.clientY);
            if (hit?.type === 'node') {
                if (hit.view.segmentNodes) {
                    this.onExpandSegment(hit.view.segmentKey);
                    return;
                }
                this.onSelectNode(hit.view.ref);
                this.selectedNodeId = hit.view.id;
                this.requestRender();
            } else if (hit?.type === 'anchor') {
                this.onFocusChat(hit.anchor.chatKey);
            }
        }
    }

    onWheel(event) {
        event.preventDefault();
        const factor = Math.exp(event.deltaY * 0.0012);
        this.camera.distance = clamp(this.camera.distance * factor, 6, 4000);
        this.goal.distance = this.camera.distance;
        this.requestRender();
    }

    onDoubleClick(event) {
        const hit = this.pickAt(event.clientX, event.clientY);
        if (hit?.type === 'node') {
            if (hit.view.segmentNodes) {
                this.onExpandSegment(hit.view.segmentKey);
                return;
            }
            this.focusNode(hit.view.id);
        } else if (hit?.type === 'anchor') {
            this.focusChat(hit.anchor.chatKey);
        }
    }

    panBy(dx, dy) {
        const basis = this.basis();
        const focal = (this.height / 2) / Math.tan((Math.PI / 3) / 2);
        const worldPerPixel = this.camera.distance / focal;
        const moveX = -dx * worldPerPixel;
        const moveY = dy * worldPerPixel;
        this.camera.target.x += basis.r.x * moveX + basis.u.x * moveY;
        this.camera.target.y += basis.r.y * moveX + basis.u.y * moveY;
        this.camera.target.z += basis.r.z * moveX + basis.u.z * moveY;
        this.goal.target = { ...this.camera.target };
    }

    /* ------------------------------------------------------------------ */
    /* Picking / tooltip                                                   */
    /* ------------------------------------------------------------------ */

    pickAt(clientX, clientY) {
        const rect = this.canvas.getBoundingClientRect();
        const x = clientX - rect.left;
        const y = clientY - rect.top;

        for (let index = this.screenNodes.length - 1; index >= 0; index--) {
            const entry = this.screenNodes[index];
            if (entry.rect) {
                if (
                    x >= entry.rect.x && x <= entry.rect.x + entry.rect.w
                    && y >= entry.rect.y && y <= entry.rect.y + entry.rect.h
                ) {
                    return { type: 'node', view: entry.view };
                }
            } else {
                const dx = x - entry.x;
                const dy = y - entry.y;
                if (dx * dx + dy * dy <= entry.radius * entry.radius) {
                    return { type: 'node', view: entry.view };
                }
            }
        }

        for (let index = this.screenAnchors.length - 1; index >= 0; index--) {
            const anchor = this.screenAnchors[index];
            const r = anchor.rect;
            if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
                return { type: 'anchor', anchor: anchor.anchor };
            }
        }
        return null;
    }

    updateHover(clientX, clientY) {
        const hit = this.pickAt(clientX, clientY);
        if (hit?.type === 'node') {
            this.setHover(hit.view.id);
            this.showTooltip(hit.view, clientX, clientY);
            this.canvas.style.cursor = 'pointer';
        } else if (hit?.type === 'anchor') {
            this.setHover(null);
            this.hideTooltip();
            this.canvas.style.cursor = 'pointer';
        } else {
            this.setHover(null);
            this.hideTooltip();
            this.canvas.style.cursor = 'grab';
        }
    }

    showTooltip(view, clientX, clientY) {
        const info = this.chatInfo.get(Array.from(view.ref.chats || [])[0]);
        const role = ROLE_LABEL[view.role] || view.role;
        const sender = view.sender || role;
        const lines = [];
        lines.push(`${sender} · ${role}${view.structured ? ' · 预设/结构化' : ''}${view.rich ? ' · 富文本' : ''}`);
        lines.push(`${view.chatCount} 个聊天经过 · ${view.variantCount} 个变体${view.children.length > 1 ? ` · ${view.children.length} 个分支` : ''}`);
        if (view.segmentNodes) {
            lines.push(`连续 ${view.segmentCount} 层 · 点击卡片展开`);
        }
        lines.push(`显示长度 ${view.displayLength ?? 0} 字${view.textLength ? `（原文 ${view.textLength} 字）` : ''}`);
        if (info?.root && info.root !== info.base) {
            lines.push(`来自：${info.root}`);
        }
        lines.push('');
        lines.push(String(view.displayText || '（无可显示文本）').slice(0, 600));

        this.tooltip.textContent = lines.join('\n');
        this.tooltip.classList.remove('ctv-hidden');
        const containerRect = this.container.getBoundingClientRect();
        const x = clamp(clientX - containerRect.left + 14, 8, this.width - 360);
        const y = clamp(clientY - containerRect.top + 14, 8, this.height - 220);
        this.tooltip.style.left = `${x}px`;
        this.tooltip.style.top = `${y}px`;
    }

    hideTooltip() {
        this.tooltip.classList.add('ctv-hidden');
    }

    /* ------------------------------------------------------------------ */
    /* Rendering                                                           */
    /* ------------------------------------------------------------------ */

    requestRender() {
        if (this.frameRequested) {
            return;
        }
        this.frameRequested = true;
        requestAnimationFrame(() => this.tick());
    }

    tick() {
        this.frameRequested = false;

        let needsAnother = false;
        const ease = 0.22;
        const c = this.camera;
        const g = this.goal;

        c.yaw = lerp(c.yaw, g.yaw, ease);
        c.pitch = lerp(c.pitch, g.pitch, ease);
        c.distance = lerp(c.distance, g.distance, ease);
        c.target.x = lerp(c.target.x, g.target.x, ease);
        c.target.y = lerp(c.target.y, g.target.y, ease);
        c.target.z = lerp(c.target.z, g.target.z, ease);

        if (
            Math.abs(c.yaw - g.yaw) > 0.001
            || Math.abs(c.pitch - g.pitch) > 0.001
            || Math.abs(c.distance - g.distance) > 0.05
            || Math.abs(c.target.x - g.target.x) > 0.01
            || Math.abs(c.target.y - g.target.y) > 0.01
            || Math.abs(c.target.z - g.target.z) > 0.01
        ) {
            needsAnother = true;
        }

        if (this.settings.autoRotate) {
            this.camera.yaw += 0.0018;
            this.goal.yaw = this.camera.yaw;
            needsAnother = true;
        }

        this.render();

        if (needsAnother) {
            this.requestRender();
        }
    }

    render() {
        if (!this.model || this.width <= 1 || this.height <= 1) {
            return;
        }
        const ctx = this.ctx;
        ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        ctx.clearRect(0, 0, this.width, this.height);
        this.drawBackground(ctx);

        const basis = this.basis();
        const focal = (this.height / 2) / Math.tan((Math.PI / 3) / 2);

        // Project nodes.
        this.screenNodes = [];
        for (const view of this.model.nodes) {
            const projected = this.project(view, basis);
            if (!projected) {
                continue;
            }
            view._sx = projected.x;
            view._sy = projected.y;
            view._scale = projected.scale;
            view._cz = projected.cz;
            if (
                projected.x < -600 || projected.x > this.width + 600
                || projected.y < -600 || projected.y > this.height + 600
            ) {
                continue;
            }
            this.screenNodes.push({
                view,
                x: projected.x,
                y: projected.y,
                scale: projected.scale,
                cz: projected.cz,
                rect: null,
                radius: 0,
            });
        }

        // Far to near for painter's algorithm.
        this.screenNodes.sort((a, b) => b.cz - a.cz);

        this.drawEdges(ctx);
        this.drawStrands(ctx);
        this.drawNodes(ctx, focal);
        this.drawDivergenceMarkers(ctx);
        this.drawAnchors(ctx);
        this.drawFocusOverlay(ctx);
    }

    drawBackground(ctx) {
        const gradient = ctx.createRadialGradient(
            this.width * 0.5,
            this.height * 0.42,
            Math.min(this.width, this.height) * 0.1,
            this.width * 0.5,
            this.height * 0.5,
            Math.max(this.width, this.height) * 0.75,
        );
        gradient.addColorStop(0, 'rgba(16,24,40,0.95)');
        gradient.addColorStop(0.55, 'rgba(6,10,20,0.98)');
        gradient.addColorStop(1, 'rgba(1,2,6,1)');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, this.width, this.height);

        if (!this.starfield) {
            this.starfield = this.buildStarfield();
        }
        ctx.globalAlpha = 0.55;
        ctx.drawImage(this.starfield, 0, 0, this.width, this.height);
        ctx.globalAlpha = 1;
    }

    buildStarfield() {
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.floor(this.width / 2));
        canvas.height = Math.max(1, Math.floor(this.height / 2));
        const ctx = canvas.getContext('2d');
        const count = Math.floor((canvas.width * canvas.height) / 2600);
        for (let index = 0; index < count; index++) {
            const x = Math.random() * canvas.width;
            const y = Math.random() * canvas.height;
            const r = Math.random() < 0.92 ? 0.6 : 1.2;
            ctx.fillStyle = `rgba(170,200,255,${0.12 + Math.random() * 0.28})`;
            ctx.beginPath();
            ctx.arc(x, y, r, 0, Math.PI * 2);
            ctx.fill();
        }
        return canvas;
    }

    fog(cz) {
        const near = this.camera.distance * 0.35;
        const far = this.camera.distance * 2.4;
        return clamp(1 - (cz - near) / (far - near), 0.12, 1);
    }

    drawEdges(ctx) {
        const focus = this.focusChatKey;
        const selectedPath = this.selectedPathSet();

        for (const edge of this.model.edges) {
            const parent = edge.parent;
            const child = edge.child;
            if (parent._sx === undefined || child._sx === undefined) {
                continue;
            }

            const relatedToFocus = !focus || (child.ref.chats && child.ref.chats.has(focus));
            const selectedEdge = selectedPath.has(child.id);

            let color;
            let alpha;
            let width;
            if (selectedEdge) {
                color = 'rgba(255,214,120,';
                alpha = 0.95;
                width = 2.2;
            } else if (child.chatCount === 1 && child.ref.chats) {
                const chatKey = Array.from(child.ref.chats)[0];
                const info = this.chatInfo.get(chatKey);
                color = info ? `hsl(${info.hue ?? 210} 70% 60%,` : 'rgba(120,170,255,';
                alpha = relatedToFocus ? 0.5 : 0.05;
                width = 1.2;
            } else {
                color = 'rgba(130,175,255,';
                alpha = (relatedToFocus ? 0.32 : 0.04) + Math.min(0.2, child.chatCount * 0.01);
                width = 1 + Math.min(2.2, Math.log2(child.chatCount + 1) * 0.5);
            }

            const fog = this.fog(child._cz);
            ctx.strokeStyle = `${color}${(alpha * fog).toFixed(3)})`;
            ctx.lineWidth = width;
            ctx.beginPath();
            ctx.moveTo(parent._sx, parent._sy);
            ctx.lineTo(child._sx, child._sy);
            ctx.stroke();
        }
    }

    selectedPathSet() {
        const set = new Set();
        if (!this.model || !this.selectedNodeId) {
            return set;
        }
        let view = this.resolveViewForNode(this.selectedNodeId);
        while (view) {
            set.add(view.id);
            view = view.parent;
        }
        return set;
    }

    drawStrands(ctx) {
        if (!this.model) {
            return;
        }
        const paths = [];
        if (this.focusChatKey) {
            const path = this.model.chatPaths.get(this.focusChatKey);
            if (path) {
                paths.push({ chatKey: this.focusChatKey, path, alpha: 0.55, width: 2.4 });
            }
        }
        if (this.settings.showAllStrands) {
            for (const [chatKey, path] of this.model.chatPaths) {
                if (chatKey === this.focusChatKey) {
                    continue;
                }
                paths.push({ chatKey, path, alpha: 0.06, width: 1 });
            }
        }

        for (const { chatKey, path, alpha, width } of paths) {
            const info = this.chatInfo.get(chatKey);
            const hue = info?.hue ?? 210;
            ctx.strokeStyle = `hsla(${hue}, 75%, 62%, ${alpha})`;
            ctx.lineWidth = width;
            ctx.beginPath();
            let started = false;
            for (const view of path) {
                if (view._sx === undefined) {
                    continue;
                }
                if (!started) {
                    ctx.moveTo(view._sx, view._sy);
                    started = true;
                } else {
                    ctx.lineTo(view._sx, view._sy);
                }
            }
            ctx.stroke();
        }
    }

    drawNodes(ctx, focal) {
        const focus = this.focusChatKey;
        const pathSet = this.selectedPathSet();
        for (const entry of this.screenNodes) {
            const view = entry.view;
            const fog = this.fog(entry.cz);
            const cardW = Math.min(360, 4.6 * entry.scale);
            const cardH = cardW * (1.32 / 4.6);

            const relatedToFocus = !focus || (view.ref.chats && view.ref.chats.has(focus));
            const segmentContains = (nodeId) => Boolean(
                nodeId && view.segmentNodes && view.segmentNodes.some((node) => node.id === nodeId),
            );
            const segmentMatch = Boolean(
                this.searchMatches
                && view.segmentNodes
                && view.segmentNodes.some((node) => this.searchMatches.has(node.id)),
            );
            const selected = view.id === this.selectedNodeId || segmentContains(this.selectedNodeId);
            const hovered = view.id === this.hoveredNodeId;
            const matched = this.searchMatches && (this.searchMatches.has(view.id) || segmentMatch);
            const onSelectedPath = selected || pathSet.has(view.id);

            let alpha = fog * (relatedToFocus ? 1 : 0.16);
            if (view.role === 'assistant') {
                alpha *= 0.9;
            }
            if (view.role === 'user') {
                alpha = Math.min(1, alpha * 1.08);
            }

            if (cardW < 7) {
                const r = clamp(entry.scale * 0.55, 1.2, 3.4);
                const color = roleColor(view.role);
                ctx.fillStyle = rgba(color, alpha * (view.chatCount > 1 ? 0.95 : 0.65));
                ctx.beginPath();
                ctx.arc(entry.x, entry.y, r, 0, Math.PI * 2);
                ctx.fill();
                entry.radius = r + 2;
                if (selected || matched) {
                    ctx.strokeStyle = matched ? 'rgba(255,209,102,0.95)' : 'rgba(255,255,255,0.9)';
                    ctx.lineWidth = 1.4;
                    ctx.beginPath();
                    ctx.arc(entry.x, entry.y, r + 3, 0, Math.PI * 2);
                    ctx.stroke();
                }
                continue;
            }

            if (cardW < 34) {
                const w = Math.max(10, cardW);
                const h = Math.max(6, cardH);
                const x = entry.x - w / 2;
                const y = entry.y - h / 2;
                const color = roleColor(view.role);
                ctx.fillStyle = `rgba(10,15,26,${0.72 * alpha})`;
                roundRectPath(ctx, x, y, w, h, Math.min(4, h / 2));
                ctx.fill();
                ctx.fillStyle = rgba(color, 0.9 * alpha);
                roundRectPath(ctx, x, y, Math.max(2, w * 0.16), h, 2);
                ctx.fill();
                entry.rect = { x, y, w, h };
                if (selected || hovered || matched) {
                    ctx.strokeStyle = matched ? 'rgba(255,209,102,0.95)' : selected ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.45)';
                    ctx.lineWidth = 1.2;
                    roundRectPath(ctx, x - 1, y - 1, w + 2, h + 2, Math.min(5, h / 2));
                    ctx.stroke();
                }
                continue;
            }

            this.drawCard(ctx, entry, view, cardW, cardH, alpha, selected, hovered, matched, onSelectedPath);
        }
    }

    drawCard(ctx, entry, view, width, height, alpha, selected, hovered, matched, onPath) {
        const x = entry.x - width / 2;
        const y = entry.y - height / 2;

        const role = roleColor(view.role);
        const shared = view.chatCount > 1;
        const info = this.chatInfo.get(view.ref.chats ? Array.from(view.ref.chats)[0] : '');
        const borderHue = info?.hue ?? 210;

        // Card body.
        ctx.fillStyle = `rgba(9,14,24,${0.88 * alpha})`;
        roundRectPath(ctx, x, y, width, height, Math.min(8, height * 0.22));
        ctx.fill();

        // Slight tint for branch-specific nodes.
        if (!shared && info) {
            ctx.fillStyle = `hsla(${borderHue}, 65%, 55%, ${0.06 * alpha})`;
            roundRectPath(ctx, x, y, width, height, Math.min(8, height * 0.22));
            ctx.fill();
        }

        // Border.
        if (selected) {
            ctx.strokeStyle = `rgba(255,224,140,${0.95 * alpha})`;
            ctx.lineWidth = 1.8;
        } else if (matched) {
            ctx.strokeStyle = `rgba(255,209,102,${0.9 * alpha})`;
            ctx.lineWidth = 1.4;
        } else if (hovered) {
            ctx.strokeStyle = `rgba(235,245,255,${0.85 * alpha})`;
            ctx.lineWidth = 1.3;
        } else if (shared) {
            ctx.strokeStyle = `rgba(138,178,255,${0.38 * alpha})`;
            ctx.lineWidth = 1;
        } else {
            ctx.strokeStyle = `hsla(${borderHue}, 65%, 60%, ${0.5 * alpha})`;
            ctx.lineWidth = 1;
        }
        if (view.segmentNodes) {
            ctx.setLineDash([5, 4]);
        }
        roundRectPath(ctx, x, y, width, height, Math.min(8, height * 0.22));
        ctx.stroke();
        ctx.setLineDash([]);

        // Role strip.
        ctx.fillStyle = rgba(role, 0.92 * alpha);
        roundRectPath(ctx, x, y, Math.max(2.5, width * 0.018), height, 2);
        ctx.fill();

        // Selected-path glow line.
        if (onPath && !selected) {
            ctx.fillStyle = `rgba(255,214,120,${0.35 * alpha})`;
            ctx.fillRect(x, y + height - 1.5, width, 1.5);
        }

        const padX = Math.max(5, width * 0.028);
        const padY = Math.max(3, height * 0.08);
        const contentX = x + Math.max(6, width * 0.025) + padX * 0.5;
        const contentW = width - (contentX - x) - padX;
        let cursorY = y + padY;

        const senderSize = clamp(height * 0.24, 8, 13);
        const textSize = clamp(height * 0.26, 8.5, 14);
        const metaSize = clamp(height * 0.19, 7, 10.5);

        ctx.textBaseline = 'top';

        // Sender + badges.
        ctx.font = `600 ${senderSize}px ${FONT_STACK}`;
        const senderText = fitText(ctx, view.sender || ROLE_LABEL[view.role] || view.role, contentW * 0.6, this.textCache);
        ctx.fillStyle = rgba(role, 0.98 * alpha);
        ctx.fillText(senderText, contentX, cursorY);

        const badges = [];
        if (view.variantCount > 1) {
            badges.push(`${(view.variantIndex ?? 0) + 1}/${view.variantCount}`);
        }
        if (view.chatCount > 1) {
            badges.push(`${view.chatCount}聊`);
        }
        if (view.children.length > 1) {
            badges.push(`${view.children.length}支`);
        }
        if (view.structured) {
            badges.push('预设');
        } else if (view.rich) {
            badges.push('富文本');
        }
        if (view.displayLength > 600) {
            badges.push('长');
        }
        if (view.segmentNodes) {
            badges.push('＋展开');
        }
        if (badges.length && width > 120) {
            ctx.font = `${metaSize}px ${FONT_STACK}`;
            ctx.fillStyle = `rgba(170,200,245,${0.72 * alpha})`;
            const badgeText = badges.join(' · ');
            const badgeW = ctx.measureText(badgeText).width;
            ctx.fillText(badgeText, x + width - padX - badgeW, cursorY + (senderSize - metaSize) * 0.5);
        }

        cursorY += senderSize + Math.max(1, height * 0.04);

        // Message text. User messages get an extra line because they are short
        // and are the strongest recognition cue; assistant messages are often
        // huge and get a single line (full text in the detail/tooltip).
        ctx.font = `${textSize}px ${FONT_STACK}`;
        ctx.fillStyle = `rgba(222,233,250,${0.92 * alpha})`;
        const lineHeight = textSize * 1.22;
        const maxLines = height > 80 ? 2 : height > 50 ? (view.role === 'user' ? 2 : 1) : 1;
        const textWidth = contentW;
        const raw = String(view.displayText || view.text || '（空消息）').replace(/\s+/g, ' ').trim();
        const chars = Array.from(raw);
        let shown = 0;
        for (let line = 0; line < maxLines && shown < chars.length; line++) {
            const remaining = chars.slice(shown).join('');
            const fitted = fitText(ctx, remaining, textWidth, this.textCache);
            if (!fitted) {
                break;
            }
            ctx.fillText(fitted, contentX, cursorY);
            cursorY += lineHeight;
            // Approximate consumed characters; fitText adds an ellipsis at the
            // end, so only draw a second line if the text was truncated.
            if (!fitted.endsWith('…')) {
                shown = chars.length;
            } else {
                shown += Math.max(1, Array.from(fitted).length - 1);
            }
        }

        // Feature strip + length bar + chat dots.
        if (height > 34 && width > 90) {
            const hues = textFeatureHues(view.displayText || view.text, 8);
            const cell = Math.max(3, Math.min(7, height * 0.1));
            const stripY = y + height - cell - Math.max(2, height * 0.06);
            let stripX = contentX;
            ctx.globalAlpha = 0.65 * alpha;
            for (const hue of hues) {
                ctx.fillStyle = `hsl(${hue}, 70%, 58%)`;
                ctx.fillRect(stripX, stripY, cell, cell);
                stripX += cell + 2;
            }
            ctx.globalAlpha = 1;

            // Relative display length: a quick "how much text is in here" cue.
            const lengthRatio = clamp(view.displayLength / 2000, 0.02, 1);
            const barW = Math.max(12, contentW * 0.35);
            ctx.fillStyle = `rgba(120,150,200,${0.25 * alpha})`;
            ctx.fillRect(x + width - padX - barW, stripY + 1, barW, 2);
            ctx.fillStyle = rgba(role, 0.7 * alpha);
            ctx.fillRect(x + width - padX - barW, stripY + 1, barW * lengthRatio, 2);
        }

        entry.rect = { x, y, w: width, h: height };
    }

    drawDivergenceMarkers(ctx) {
        if (this.settings.showDivergence === false || !this.model) {
            return;
        }
        const focus = this.focusChatKey;
        for (const anchor of this.model.chatAnchors) {
            const view = anchor.divergenceNode;
            if (!view || view._sx === undefined) {
                continue;
            }
            if (focus && anchor.chatKey !== focus) {
                continue;
            }
            const scale = view._scale || 1;
            // Avoid clutter when zoomed out; the marker is most useful close up.
            if (!focus && scale < 1.5) {
                continue;
            }
            const info = this.chatInfo.get(anchor.chatKey);
            const hue = info?.hue ?? 210;
            const r = clamp(scale * 1.1, 2.5, 7);
            ctx.save();
            ctx.translate(view._sx, view._sy);
            ctx.rotate(Math.PI / 4);
            ctx.strokeStyle = `hsla(${hue}, 75%, 66%, ${focus ? 0.95 : 0.4})`;
            ctx.lineWidth = 1.1;
            ctx.strokeRect(-r / 2, -r / 2, r, r);
            ctx.restore();
        }
    }

    drawAnchors(ctx) {
        if (!this.settings.showAnchors || !this.model) {
            return;
        }
        this.screenAnchors = [];
        const anchors = [];
        const sourceAnchors = this.focusChatKey
            ? this.model.chatAnchors.filter((anchor) => anchor.chatKey === this.focusChatKey)
            : this.model.chatAnchors;
        for (const anchor of sourceAnchors) {
            const projected = this.project(anchor, this.basis());
            if (!projected) {
                continue;
            }
            if (
                projected.x < -300 || projected.x > this.width + 300
                || projected.y < -300 || projected.y > this.height + 300
            ) {
                continue;
            }
            anchors.push({ anchor, ...projected });
        }
        const focusItem = this.focusChatKey
            ? anchors.find((item) => item.anchor.chatKey === this.focusChatKey)
            : null;
        const ordered = anchors
            .filter((item) => item !== focusItem)
            .sort((a, b) => a.cz - b.cz);
        if (focusItem) {
            ordered.push(focusItem);
        }

        const placed = [];
        let drawn = 0;
        for (const item of ordered) {
            const isFocus = this.focusChatKey === item.anchor.chatKey;
            if (!isFocus && drawn >= this.settings.maxAnchors) {
                break;
            }
            const info = this.chatInfo.get(item.anchor.chatKey);
            const label = this.resolveDisplayName(item.anchor.chatKey);
            const width = clamp(150 + (item.scale - 2) * 7, 140, 200);
            const height = clamp(width * 0.32, 44, 64);
            const x = item.x - width / 2;
            const y = item.y + 12;
            const rect = { x, y, w: width, h: height };
            if (!isFocus && placed.some((other) => !(
                rect.x + rect.w < other.x || other.x + other.w < rect.x
                || rect.y + rect.h < other.y || other.y + other.h < rect.y
            ))) {
                continue;
            }
            placed.push(rect);
            drawn++;

            const hue = info?.hue ?? 210;
            const alpha = clamp(0.38 + item.scale * 0.22, 0.38, 0.96);
            const pad = 7;
            const titleSize = clamp(height * 0.14, 9, 13);
            const metaSize = clamp(height * 0.105, 7.5, 10);
            const lineSize = clamp(height * 0.12, 8, 11);

            // Connector.
            ctx.strokeStyle = `hsla(${hue}, 70%, 62%, ${0.35 * alpha})`;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(item.anchor.terminalNode._sx ?? item.x, item.anchor.terminalNode._sy ?? item.y);
            ctx.lineTo(item.x, item.y + 8);
            ctx.stroke();

            ctx.fillStyle = `rgba(8,12,22,${0.94 * alpha})`;
            roundRectPath(ctx, x, y, width, height, 7);
            ctx.fill();
            ctx.strokeStyle = isFocus
                ? `rgba(255,214,120,${0.95 * alpha})`
                : `hsla(${hue}, 70%, 62%, ${0.7 * alpha})`;
            ctx.lineWidth = isFocus ? 1.6 : 1;
            roundRectPath(ctx, x, y, width, height, 7);
            ctx.stroke();
            ctx.fillStyle = isFocus ? 'rgba(255,214,120,0.95)' : `hsl(${hue}, 70%, 62%)`;
            ctx.fillRect(x, y, 3, height);

            ctx.textBaseline = 'top';

            // Title + meta.
            ctx.font = `600 ${titleSize}px ${FONT_STACK}`;
            ctx.fillStyle = `rgba(235,243,255,${0.97 * alpha})`;
            ctx.fillText(fitText(ctx, label, width - pad * 2 - 4, this.textCache), x + pad, y + 5);

            const meta = [info?.dateLabel, info?.messages ? `${info.messages} 条` : '', info?.depth ? `分支 ${info.depth}` : '']
                .filter(Boolean)
                .join(' · ');
            let cursorY = y + 5 + titleSize + 2;
            if (meta) {
                ctx.font = `${metaSize}px ${FONT_STACK}`;
                ctx.fillStyle = `rgba(158,184,220,${0.72 * alpha})`;
                ctx.fillText(fitText(ctx, meta, width - pad * 2, this.textCache), x + pad, cursorY);
                cursorY += metaSize + 3;
            }

            // Message barcode.
            const barcode = info?.barcode?.length ? info.barcode.slice(0, 16) : [];
            if (barcode.length && height > 66) {
                const barH = 7;
                let bx = x + pad;
                for (const cell of barcode) {
                    const h = 2.5 + clamp(cell.ratio, 0.05, 1) * (barH - 2.5);
                    ctx.fillStyle = `hsla(${cell.hue}, 70%, 58%, ${(cell.role === 'user' ? 0.9 : 0.55) * alpha})`;
                    ctx.fillRect(bx, cursorY + barH - h, 4, h);
                    bx += 6;
                }
                cursorY += barH + 3;
            }

            // Last user message + terminal message: two recognition cues.
            const drawLine = (role, text, yPos) => {
                const labelText = role === 'user' ? '你 ' : 'AI ';
                const color = role === 'user' ? ROLE_COLOR.user : ROLE_COLOR.assistant;
                ctx.font = `600 ${lineSize}px ${FONT_STACK}`;
                ctx.fillStyle = rgba(color, 0.95 * alpha);
                ctx.fillText(labelText, x + pad, yPos);
                const labelW = ctx.measureText(labelText).width;
                ctx.font = `${lineSize}px ${FONT_STACK}`;
                ctx.fillStyle = `rgba(204,219,240,${0.88 * alpha})`;
                const fitted = fitText(ctx, text, width - pad * 2 - labelW, this.textCache);
                ctx.fillText(fitted, x + pad + labelW, yPos);
            };

            const lastUserText = item.anchor.anchorText || '';
            const terminalText = item.anchor.terminalText || '';
            if (cursorY + lineSize + 2 <= y + height - 3) {
                drawLine(item.anchor.lastUserRole || 'user', lastUserText, cursorY);
                cursorY += lineSize + 2;
            }
            if (
                terminalText
                && terminalText !== lastUserText
                && cursorY + lineSize <= y + height - 2
            ) {
                drawLine(item.anchor.terminalRole || 'assistant', terminalText, cursorY);
            }

            this.screenAnchors.push({ anchor: item.anchor, rect });
        }
    }

    drawFocusOverlay(ctx) {
        if (this.searchMatches && this.searchMatches.size) {
            // Subtle vignette when a search is active.
            ctx.fillStyle = 'rgba(0,0,0,0.08)';
            ctx.fillRect(0, 0, this.width, this.height);
        }
    }

    destroy() {
        this.resizeObserver?.disconnect();
        this.canvas.remove();
        this.tooltip.remove();
    }
}
