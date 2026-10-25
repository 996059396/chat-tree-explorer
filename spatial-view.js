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
const FOV = Math.PI / 4.5;

function formatTimeShort(epoch) {
    const value = Number(epoch);
    if (!Number.isFinite(value) || value <= 0) {
        return '';
    }
    try {
        return new Intl.DateTimeFormat('zh-CN', {
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
        }).format(new Date(value));
    } catch {
        return '';
    }
}

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

function roundedPolyline(ctx, points, radius = 9) {
    if (!points.length) {
        return;
    }
    ctx.moveTo(points[0].x, points[0].y);
    if (points.length === 2) {
        ctx.lineTo(points[1].x, points[1].y);
        return;
    }
    for (let index = 1; index < points.length - 1; index++) {
        const prev = points[index - 1];
        const point = points[index];
        const next = points[index + 1];
        const v1x = point.x - prev.x;
        const v1y = point.y - prev.y;
        const v2x = next.x - point.x;
        const v2y = next.y - point.y;
        const l1 = Math.hypot(v1x, v1y) || 1;
        const l2 = Math.hypot(v2x, v2y) || 1;
        const r = Math.min(radius, l1 / 2, l2 / 2);
        const ax = point.x - (v1x / l1) * r;
        const ay = point.y - (v1y / l1) * r;
        const bx = point.x + (v2x / l2) * r;
        const by = point.y + (v2y / l2) * r;
        ctx.lineTo(ax, ay);
        ctx.quadraticCurveTo(point.x, point.y, bx, by);
    }
    const last = points[points.length - 1];
    ctx.lineTo(last.x, last.y);
}

function overlap(a, b) {
    return !(a.x + a.w < b.x || b.x + b.w < a.x || a.y + a.h < b.y || b.y + b.h < a.y);
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
    constructor({ container, onSelectNode, onFocusChat, onExpandSegment, onSearch, resolveDisplayName }) {
        this.container = container;
        this.onSelectNode = onSelectNode || (() => {});
        this.onFocusChat = onFocusChat || (() => {});
        this.onExpandSegment = onExpandSegment || (() => {});
        this.onSearch = onSearch || (() => {});
        this.resolveDisplayName = resolveDisplayName || ((key) => key);

        this.canvas = document.createElement('canvas');
        this.canvas.className = 'ctv-spatial-canvas';
        this.canvas.tabIndex = 0;
        this.canvas.setAttribute('aria-label', '聊天空间视图');
        container.appendChild(this.canvas);

        this.tooltip = document.createElement('div');
        this.tooltip.className = 'ctv-spatial-tooltip ctv-hidden';
        container.appendChild(this.tooltip);

        this.minimap = document.createElement('canvas');
        this.minimap.className = 'ctv-spatial-minimap';
        this.minimap.title = '小地图：点击/拖动移动镜头';
        container.appendChild(this.minimap);
        this.minimapCtx = this.minimap.getContext('2d');
        this.minimapDrag = false;
        this.miniMap = null;

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
            maxTags: 140,
            showMinimap: true,
            showLaneHeaders: true,
        };

        this.selectedNodeId = null;
        this.hoveredNodeId = null;
        this.searchMatches = null;
        this.focusChatKey = null;

        this.camera = {
            target: { x: 0, y: 0, z: 0 },
            yaw: 0.18,
            pitch: 0.38,
            distance: 60,
        };
        this.goal = {
            target: { x: 0, y: 0, z: 0 },
            yaw: 0.18,
            pitch: 0.38,
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
        this.laneHeaders = [];
        this.minimapStatic = document.createElement('canvas');
        this.minimapStaticCtx = this.minimapStatic.getContext('2d');
        this.minimapDirty = true;
        this.axisCache = null;
        this.densityCache = null;
        this._framePathSet = null;
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
        this.computeEdgeRoutes();
        this.minimapDirty = true;
        this.axisCache = null;
        this.densityCache = null;
        if (!options.preserveCamera && (!this._fitted || changed)) {
            this.fitInitial();
            this._fitted = true;
        }
        this.requestRender();
    }

    setSettings(patch) {
        this.settings = { ...this.settings, ...patch };
        if (this.minimap) {
            this.minimap.style.display = this.settings.showMinimap === false ? 'none' : 'block';
        }
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
        this.minimapDirty = true;
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
        this.minimapDirty = true;
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
        const focal = (this.height / 2) / Math.tan(FOV / 2);
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
        // Start on the branching/ending region, and never zoom out so far that
        // the labels become dots. The “全部” button still fits everything.
        const startDepth = maxDepth >= 6 ? maxDepth * 0.5 : 0;
        const focus = this.model.nodes.filter((view) => view.displayDepth >= startDepth);
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

        this.goal.target = { x: (minX + maxX) / 2, y: (minY + maxY) / 2, z: (minZ + maxZ) / 2 };
        const radius = Math.max(6, Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2);
        const readableDistance = (this.height / 2) / Math.tan(FOV / 2) / 3.2;
        this.goal.distance = clamp(
            Math.min(radius / Math.tan(FOV / 2) * 1.12 + 6, readableDistance),
            8,
            4800,
        );
        this.goal.yaw = 0.18;
        this.goal.pitch = 0.38;
        this.startAnimation();
    }

    fitAll() {
        if (!this.model) {
            return;
        }
        const { bounds } = this.model;
        this.goal.target = { ...bounds.center };
        const radius = Math.max(6, bounds.radius);
        this.goal.distance = clamp(radius / Math.tan(FOV / 2) * 1.12 + 6, 12, 4800);
        this.goal.yaw = 0.18;
        this.goal.pitch = 0.38;
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
        this.goal.distance = clamp(radius / Math.tan(FOV / 2) * 1.28, 10, 2000);
        this.startAnimation();
    }

    setPreset(name) {
        const presets = {
            iso: { yaw: 0.18, pitch: 0.85 },
            front: { yaw: 0, pitch: 0.22 },
            top: { yaw: 0, pitch: 1.35 },
        };
        const preset = presets[name];
        if (!preset) {
            return;
        }
        this.goal.yaw = preset.yaw;
        this.goal.pitch = preset.pitch;
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
                return;
            }
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                this.moveSelection(event.key === 'ArrowDown' ? 'down' : 'up');
            } else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
                event.preventDefault();
                this.moveSelection(event.key === 'ArrowRight' ? 'next' : 'prev');
            } else if (event.key === 'Enter') {
                const current = this.selectedNodeId ? this.resolveViewForNode(this.selectedNodeId) : null;
                if (current) {
                    this.focusNode(current.id);
                }
            } else if (event.key === 'Home' || event.key === 'End') {
                event.preventDefault();
                this.jumpToPathEnd(event.key === 'End');
            } else if (event.key === 'f' || event.key === 'F') {
                const current = this.selectedNodeId ? this.resolveViewForNode(this.selectedNodeId) : null;
                if (current) {
                    this.focusNode(current.id);
                } else {
                    this.fitAll();
                    this._fitted = true;
                }
            } else if (event.key === '/') {
                event.preventDefault();
                this.onSearch();
            }
        });

        const jump = (event) => {
            const rect = this.minimap.getBoundingClientRect();
            const point = this.minimapToWorld(event.clientX - rect.left, event.clientY - rect.top);
            if (!point) {
                return;
            }
            this.camera.target.x = point.x;
            this.camera.target.y = point.y;
            this.goal.target = { ...this.camera.target };
            this.requestRender();
        };
        this.minimap.addEventListener('pointerdown', (event) => {
            event.preventDefault();
            event.stopPropagation();
            this.minimap.setPointerCapture?.(event.pointerId);
            this.minimapDrag = true;
            jump(event);
        });
        this.minimap.addEventListener('pointermove', (event) => {
            if (!this.minimapDrag) {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            jump(event);
        });
        this.minimap.addEventListener('pointerup', () => {
            this.minimapDrag = false;
        });
        this.minimap.addEventListener('pointercancel', () => {
            this.minimapDrag = false;
        });
    }

    moveSelection(direction) {
        if (!this.model) {
            return;
        }
        let current = this.selectedNodeId ? this.resolveViewForNode(this.selectedNodeId) : null;
        if (!current) {
            const focusPath = this.focusChatKey ? this.model.chatPaths.get(this.focusChatKey) : null;
            current = focusPath?.[0] || this.model.nodes.find((view) => view.role !== 'root') || null;
            if (current) {
                this.selectAndCenter(current);
            }
            return;
        }

        let target = null;
        if (direction === 'down') {
            const focus = this.focusChatKey;
            target = current.children.find((child) => focus && child.ref.chats?.has(focus))
                || current.children[0]
                || null;
        } else if (direction === 'up') {
            target = current.parent && current.parent.role !== 'root' ? current.parent : null;
        } else {
            const parent = current.parent;
            if (!parent || !parent.children.length) {
                return;
            }
            const index = parent.children.indexOf(current);
            const offset = direction === 'next' ? 1 : -1;
            target = parent.children[(index + offset + parent.children.length) % parent.children.length];
        }

        if (target) {
            this.selectAndCenter(target);
        }
    }

    jumpToPathEnd(toEnd) {
        if (!this.model) {
            return;
        }
        const focusPath = this.focusChatKey ? this.model.chatPaths.get(this.focusChatKey) : null;
        let target = focusPath
            ? focusPath[toEnd ? focusPath.length - 1 : 0]
            : null;
        if (!target) {
            const nodes = this.model.nodes.filter((view) => view.role !== 'root');
            target = nodes.reduce((best, view) => {
                if (!best) return view;
                if (toEnd) return view.y > best.y ? view : best;
                return view.y < best.y ? view : best;
            }, null);
        }
        if (target) {
            this.selectAndCenter(target);
        }
    }

    selectAndCenter(view) {
        this.onSelectNode(view.ref);
        this.selectedNodeId = view.id;
        this.goal.target = { x: view.x, y: view.y, z: view.z };
        this.startAnimation();
    }

    minimapToWorld(localX, localY) {
        if (!this.miniMap) {
            return null;
        }
        const { minX, minY, scale, ox, oy } = this.miniMap;
        return {
            x: minX + (localX - ox) / scale,
            y: minY + (localY - oy) / scale,
        };
    }

    renderMinimap() {
        const canvas = this.minimap;
        const ctx = this.minimapCtx;
        if (!canvas || !ctx) {
            return;
        }
        if (this.settings.showMinimap === false) {
            this.minimap.style.display = 'none';
            return;
        }
        this.minimap.style.display = 'block';

        const cssW = canvas.clientWidth || 200;
        const cssH = canvas.clientHeight || 130;
        const dpr = this.dpr;
        const targetW = Math.floor(cssW * dpr);
        const targetH = Math.floor(cssH * dpr);
        if (canvas.width !== targetW || canvas.height !== targetH) {
            canvas.width = targetW;
            canvas.height = targetH;
            this.minimapStatic.width = targetW;
            this.minimapStatic.height = targetH;
            this.minimapDirty = true;
        }
        if (!this.model) {
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            return;
        }

        // The static layer only changes when the tree, selection or focus
        // changes - camera moves just blit it and repaint the viewport.
        if (this.minimapDirty) {
            this.minimapDirty = false;
            const staticCtx = this.minimapStaticCtx;
            staticCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
            staticCtx.clearRect(0, 0, cssW, cssH);
            this.drawMinimapStatic(staticCtx, cssW, cssH);
        }

        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(this.minimapStatic, 0, 0);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this.drawMinimapViewport(ctx);
    }

    drawMinimapStatic(ctx, cssW, cssH) {
        const bounds = this.model.bounds;
        const pad = 10;
        const worldW = Math.max(1, bounds.maxX - bounds.minX);
        const worldH = Math.max(1, bounds.maxY - bounds.minY);
        const scale = Math.min((cssW - pad * 2) / worldW, (cssH - pad * 2) / worldH);
        const ox = (cssW - worldW * scale) / 2 - bounds.minX * scale;
        const oy = (cssH - worldH * scale) / 2 - bounds.minY * scale;
        this.miniMap = { minX: bounds.minX, minY: bounds.minY, scale, ox, oy };

        const mapX = (x) => ox + x * scale;
        const mapY = (y) => oy + y * scale;

        const focus = this.focusChatKey;

        // Lane stripes: one column per branch lane, active depth range only.
        const laneGroups = new Map();
        for (const view of this.model.nodes) {
            if (view.role === 'root') {
                continue;
            }
            const lane = view.lane ?? 0;
            const group = laneGroups.get(lane) || {
                minY: Infinity,
                maxY: -Infinity,
                chats: new Set(),
            };
            group.minY = Math.min(group.minY, view.y);
            group.maxY = Math.max(group.maxY, view.y);
            for (const chatKey of view.ref.chats || []) {
                group.chats.add(chatKey);
            }
            laneGroups.set(lane, group);
        }
        for (const [lane, group] of laneGroups) {
            const laneX = lane * this.model.options.laneGap;
            const firstChat = group.chats.size === 1 ? Array.from(group.chats)[0] : null;
            const info = firstChat ? this.chatInfo.get(firstChat) : null;
            ctx.strokeStyle = group.chats.size > 1
                ? 'rgba(130,170,230,0.2)'
                : `hsla(${info?.hue ?? 210},70%,60%,0.28)`;
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.moveTo(mapX(laneX), mapY(group.minY));
            ctx.lineTo(mapX(laneX), mapY(group.maxY));
            ctx.stroke();
        }

        // Focused path so the minimap doubles as a locator.
        if (focus) {
            const path = this.model.chatPaths.get(focus);
            const info = this.chatInfo.get(focus);
            if (path && path.length) {
                ctx.strokeStyle = `hsla(${info?.hue ?? 210},75%,62%,0.8)`;
                ctx.lineWidth = 2;
                ctx.beginPath();
                path.forEach((view, index) => {
                    const x = mapX(view.x);
                    const y = mapY(view.y);
                    if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
                });
                ctx.stroke();
            }
        }

        // Fork ticks.
        for (const view of this.model.nodes) {
            if (view.role === 'root' || view.children.length < 2) {
                continue;
            }
            ctx.fillStyle = 'rgba(255,214,120,0.7)';
            ctx.fillRect(mapX(view.x) - 1.5, mapY(view.y) - 1.5, 3, 3);
        }

        ctx.strokeStyle = 'rgba(120,160,220,0.22)';
        ctx.lineWidth = 1;
        for (const edge of this.model.edges) {
            if (focus && !(edge.child.ref.chats && edge.child.ref.chats.has(focus))) {
                continue;
            }
            ctx.beginPath();
            ctx.moveTo(mapX(edge.parent.x), mapY(edge.parent.y));
            ctx.lineTo(mapX(edge.child.x), mapY(edge.child.y));
            ctx.stroke();
        }

        for (const view of this.model.nodes) {
            if (view.role === 'root') {
                continue;
            }
            const role = roleColor(view.role);
            const focused = !focus || (view.ref.chats && view.ref.chats.has(focus));
            ctx.fillStyle = focused ? rgba(role, 0.85) : rgba(role, 0.16);
            const r = view.segmentNodes ? 2.4 : view.chatCount > 1 ? 1.8 : 1.3;
            ctx.beginPath();
            ctx.arc(mapX(view.x), mapY(view.y), r, 0, Math.PI * 2);
            ctx.fill();
            if (view.id === this.selectedNodeId) {
                ctx.strokeStyle = 'rgba(255,224,140,0.95)';
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.arc(mapX(view.x), mapY(view.y), r + 2, 0, Math.PI * 2);
                ctx.stroke();
            }
        }
    }

    drawMinimapViewport(ctx) {
        if (!this.miniMap) {
            return;
        }
        const { scale, ox, oy } = this.miniMap;
        const mapX = (x) => ox + x * scale;
        const mapY = (y) => oy + y * scale;
        const worldHeight = 2 * this.camera.distance * Math.tan(FOV / 2);
        const worldWidth = worldHeight * (this.width / Math.max(1, this.height));
        const cx = this.camera.target.x;
        const cy = this.camera.target.y;
        ctx.strokeStyle = 'rgba(255,255,255,0.4)';
        ctx.lineWidth = 1;
        ctx.strokeRect(
            mapX(cx - worldWidth / 2),
            mapY(cy - worldHeight / 2),
            Math.max(6, worldWidth * scale),
            Math.max(4, worldHeight * scale),
        );
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
            this.camera.pitch = clamp(this.camera.pitch + dy * 0.006, 0.04, 1.36);
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
            } else if (hit?.type === 'header') {
                if (hit.header.chatKey) {
                    this.onFocusChat(hit.header.chatKey);
                } else {
                    this.onSelectNode(hit.header.view.ref);
                    this.selectedNodeId = hit.header.view.id;
                    this.requestRender();
                }
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
        const focal = (this.height / 2) / Math.tan(FOV / 2);
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

        for (let index = this.laneHeaders.length - 1; index >= 0; index--) {
            const header = this.laneHeaders[index];
            const r = header.rect;
            if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
                return { type: 'header', header };
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
        } else if (hit?.type === 'anchor' || hit?.type === 'header') {
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
        const basis = this.basis();
        this.drawBackground(ctx);
        this.drawGround(ctx, basis);

        const focal = (this.height / 2) / Math.tan(FOV / 2);

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

        this._framePathSet = this.selectedPathSet();
        this.drawEdges(ctx);
        this.drawStrands(ctx);
        this.drawNodes(ctx, focal);
        this.drawDivergenceMarkers(ctx);
        this.drawAnchors(ctx);
        this.drawLaneHeaders(ctx, basis);
        this.drawFocusOverlay(ctx);
        this.renderMinimap();
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

    buildAxisTicks(basis) {
        const options = this.model.options;
        const projectY = (y) => this.project({ x: 0, y, z: 0 }, basis);

        if (options.timeMode === 'timestamp') {
            if (!this.axisCache) {
                const byTime = new Map();
                for (const view of this.model.nodes) {
                    if (view.role === 'root' || !view.timeMin) {
                        continue;
                    }
                    const previous = byTime.get(view.timeMin);
                    if (previous === undefined || view.y < previous) {
                        byTime.set(view.timeMin, view.y);
                    }
                }
                this.axisCache = Array.from(byTime, ([time, y]) => ({ time, y })).sort((a, b) => a.y - b.y);
            }
            const entries = this.axisCache;
            const ticks = [];
            let lastScreenY = -Infinity;
            for (const entry of entries) {
                const projected = projectY(entry.y);
                if (!projected) {
                    continue;
                }
                if (projected.y - lastScreenY >= 36) {
                    ticks.push({ y: entry.y, label: formatTimeShort(entry.time) });
                    lastScreenY = projected.y;
                }
            }
            if (ticks.length >= 2) {
                return ticks;
            }
        }

        const maxDepth = this.model.stats.maxDepth;
        const a = projectY(0);
        const b = projectY(options.turnSpacing);
        const pxPerTurn = a && b ? Math.abs(b.y - a.y) : 8;
        const step = [1, 2, 5, 10, 20, 50, 100, 200].find((value) => value * pxPerTurn >= 36) || 200;
        const ticks = [];
        for (let turn = 0; turn <= maxDepth; turn += step) {
            ticks.push({ y: turn * options.turnSpacing, label: `#${turn}` });
        }
        return ticks;
    }

    drawDensity(ctx, basis) {
        const { minY, maxY } = this.model.bounds;
        const bucketCount = 48;
        if (!this.densityCache) {
            const span = Math.max(1, maxY - minY);
            const counts = new Array(bucketCount).fill(0);
            for (const view of this.model.nodes) {
                if (view.role === 'root') {
                    continue;
                }
                const index = Math.min(
                    bucketCount - 1,
                    Math.max(0, Math.floor(((view.y - minY) / span) * bucketCount)),
                );
                const weight = view.segmentNodes
                    ? Math.max(1, view.segmentCount)
                    : Math.max(1, view.ref.occurrences?.length || 1);
                counts[index] += weight;
            }
            this.densityCache = { counts, max: Math.max(1, ...counts), minY, span };
        }
        const { counts, max, minY: cacheMinY, span } = this.densityCache;
        for (let index = 0; index < bucketCount; index++) {
            if (!counts[index]) {
                continue;
            }
            const y = cacheMinY + ((index + 0.5) / bucketCount) * span;
            const projected = this.project({ x: 0, y, z: 0 }, basis);
            if (!projected || projected.y < 0 || projected.y > this.height) {
                continue;
            }
            const ratio = counts[index] / max;
            const width = 2 + 7 * ratio;
            const height = Math.max(2, Math.min(6, (this.height / bucketCount) * 0.6));
            ctx.fillStyle = `rgba(130,180,255,${(0.1 + 0.4 * ratio).toFixed(3)})`;
            ctx.fillRect(2, projected.y - height / 2, width, height);
        }
    }

    drawGround(ctx, basis) {
        if (!this.model) {
            return;
        }
        const { minX, maxX, minY, maxY, minZ, maxZ } = this.model.bounds;
        const options = this.model.options;
        const groundY = maxY + options.turnSpacing * 2.5;
        const x0 = minX - options.laneGap * 2;
        const x1 = maxX + options.laneGap * 2;
        const z0 = minZ - options.layerGap * 2;
        const z1 = maxZ + options.layerGap * 2;
        const topY = Math.min(0, minY);
        const bottomY = Math.max(maxY, groundY);

        const line = (a, b, style, width = 1) => {
            const pa = this.project(a, basis);
            const pb = this.project(b, basis);
            if (!pa || !pb) {
                return;
            }
            ctx.strokeStyle = style;
            ctx.lineWidth = width;
            ctx.beginPath();
            ctx.moveTo(pa.x, pa.y);
            ctx.lineTo(pb.x, pb.y);
            ctx.stroke();
        };

        // Ground grid.
        for (let z = z0; z <= z1 + 0.01; z += options.layerGap) {
            line({ x: x0, y: groundY, z }, { x: x1, y: groundY, z }, 'rgba(110,150,220,0.07)');
        }
        for (let x = x0; x <= x1 + 0.01; x += options.laneGap) {
            line({ x, y: groundY, z: z0 }, { x, y: groundY, z: z1 }, 'rgba(110,150,220,0.07)');
        }

        const ticks = this.buildAxisTicks(basis);

        // Back wall.
        for (let x = x0; x <= x1 + 0.01; x += options.laneGap) {
            line({ x, y: topY, z: z0 }, { x, y: bottomY, z: z0 }, 'rgba(110,150,220,0.04)');
        }
        for (const tick of ticks) {
            line({ x: x0, y: tick.y, z: z0 }, { x: x1, y: tick.y, z: z0 }, 'rgba(140,180,255,0.06)');
        }
        line(
            { x: x0 - 1.5, y: topY, z: z0 },
            { x: x0 - 1.5, y: bottomY, z: z0 },
            'rgba(150,190,255,0.22)',
        );

        // Screen-space ruler.
        ctx.strokeStyle = 'rgba(150,190,255,0.16)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(12, 10);
        ctx.lineTo(12, this.height - 10);
        ctx.stroke();
        for (const tick of ticks) {
            const projected = this.project({ x: 0, y: tick.y, z: 0 }, basis);
            if (!projected || projected.y < 0 || projected.y > this.height) {
                continue;
            }
            ctx.strokeStyle = 'rgba(150,190,255,0.24)';
            ctx.beginPath();
            ctx.moveTo(12, projected.y);
            ctx.lineTo(22, projected.y);
            ctx.stroke();
            ctx.font = `9px ${FONT_STACK}`;
            ctx.fillStyle = 'rgba(150,190,255,0.58)';
            ctx.textBaseline = 'middle';
            ctx.fillText(tick.label, 26, projected.y);
        }
        ctx.font = `9px ${FONT_STACK}`;
        ctx.fillStyle = 'rgba(150,190,255,0.6)';
        ctx.textBaseline = 'top';
        ctx.fillText(options.timeMode === 'timestamp' ? '时间轴' : '时间 ↓', 12, 2);

        this.drawDensity(ctx, basis);

        // Horizontal depth planes.
        for (const tick of ticks) {
            line({ x: x0, y: tick.y, z: z0 }, { x: x1, y: tick.y, z: z0 }, 'rgba(140,180,255,0.05)');
            line({ x: x0, y: tick.y, z: z1 }, { x: x1, y: tick.y, z: z1 }, 'rgba(140,180,255,0.05)');
            line({ x: x0, y: tick.y, z: z0 }, { x: x0, y: tick.y, z: z1 }, 'rgba(140,180,255,0.04)');
            line({ x: x1, y: tick.y, z: z0 }, { x: x1, y: tick.y, z: z1 }, 'rgba(140,180,255,0.04)');
        }

        // Side wall + layer labels.
        const sideX = x1;
        for (let z = z0; z <= z1 + 0.01; z += options.layerGap) {
            line({ x: sideX, y: topY, z }, { x: sideX, y: bottomY, z }, 'rgba(110,150,220,0.035)');
        }
        for (const tick of ticks) {
            line({ x: sideX, y: tick.y, z: z0 }, { x: sideX, y: tick.y, z: z1 }, 'rgba(140,180,255,0.04)');
        }
        const layerCount = Math.max(1, Math.ceil((z1 - z0) / options.layerGap));
        for (let layer = 0; layer <= layerCount; layer++) {
            const z = z0 + layer * options.layerGap;
            const projected = this.project({ x: sideX + 1, y: 0, z }, basis);
            if (
                projected
                && projected.x > -50 && projected.x < this.width + 50
                && projected.y > -50 && projected.y < this.height + 50
            ) {
                ctx.font = `9px ${FONT_STACK}`;
                ctx.fillStyle = 'rgba(150,190,255,0.36)';
                ctx.textBaseline = 'middle';
                ctx.fillText(`L${layer}`, projected.x, projected.y);
            }
        }

        // Lane rails.
        const groups = new Map();
        for (const view of this.model.nodes) {
            const key = `${view.lane}:${view.layer}`;
            const group = groups.get(key) || {
                lane: view.lane,
                layer: view.layer,
                minY: Infinity,
                maxY: -Infinity,
            };
            group.minY = Math.min(group.minY, view.y);
            group.maxY = Math.max(group.maxY, view.y);
            groups.set(key, group);
        }
        for (const group of groups.values()) {
            const x = group.lane * options.laneGap;
            const z = group.layer * options.layerGap;
            line({ x, y: group.minY, z }, { x, y: group.maxY, z }, 'rgba(130,170,240,0.16)');
        }
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
        const selectedPath = this._framePathSet || this.selectedPathSet();
        const basis = this.basis();

        const arrow = (a, b, style, width) => {
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const length = Math.hypot(dx, dy);
            if (length < 6) {
                return;
            }
            const ux = dx / length;
            const uy = dy / length;
            const size = Math.min(7, 3 + width * 2);
            const bx = b.x - ux * size * 1.6;
            const by = b.y - uy * size * 1.6;
            ctx.fillStyle = style;
            ctx.beginPath();
            ctx.moveTo(b.x, b.y);
            ctx.lineTo(bx - uy * size * 0.55, by + ux * size * 0.55);
            ctx.lineTo(bx + uy * size * 0.55, by - ux * size * 0.55);
            ctx.closePath();
            ctx.fill();
        };

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
                width = 2.4;
            } else if (child.chatCount === 1 && child.ref.chats) {
                const chatKey = Array.from(child.ref.chats)[0];
                const info = this.chatInfo.get(chatKey);
                color = info ? `hsl(${info.hue ?? 210} 70% 60%,` : 'rgba(120,170,255,';
                alpha = relatedToFocus ? 0.5 : 0.04;
                width = 1.2;
            } else {
                color = 'rgba(130,175,255,';
                alpha = (relatedToFocus ? 0.3 : 0.03) + Math.min(0.18, child.chatCount * 0.01);
                width = 1 + Math.min(2.2, Math.log2(child.chatCount + 1) * 0.5);
            }

            const fog = this.fog(child._cz);
            const style = `${color}${(alpha * fog).toFixed(3)})`;

            // Git-style routing: straight down within a lane, otherwise a
            // vertical stub → horizontal bend → vertical drop. This makes the
            // parent/child order readable from any camera angle.
            let points = edge.route;
            if (!points) {
                // Fallback for an edge created after the last route pass.
                points = [];
                if (parent.lane === child.lane && parent.layer === child.layer) {
                    points.push(
                        { x: parent.x, y: parent.y, z: parent.z },
                        { x: child.x, y: child.y, z: child.z },
                    );
                } else {
                    const ratio = child.siblingCount > 1
                        ? 0.24 + 0.52 * ((child.branchIndex + 1) / (child.siblingCount + 1))
                        : 0.45;
                    const midY = parent.y + (child.y - parent.y) * ratio;
                    points.push(
                        { x: parent.x, y: parent.y, z: parent.z },
                        { x: parent.x, y: midY, z: parent.z },
                        { x: child.x, y: midY, z: child.z },
                        { x: child.x, y: child.y, z: child.z },
                    );
                }
            }

            const projected = points.map((point) => this.project(point, basis));
            if (projected.some((point) => !point)) {
                continue;
            }

            ctx.strokeStyle = style;
            ctx.lineWidth = width;
            ctx.lineJoin = 'round';
            ctx.lineCap = 'round';
            ctx.beginPath();
            roundedPolyline(ctx, projected, 10);
            ctx.stroke();

            const arrowAlpha = Math.min(1, alpha * fog * 1.8);
            arrow(projected[projected.length - 2], projected[projected.length - 1], `${color}${arrowAlpha.toFixed(3)})`, width);
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

    /**
     * Precompute obstacle-aware orthogonal routes once per model.
     *
     * Nodes live on discrete (lane, layer, depth) coordinates. A vertical
     * segment through an intermediate node is rerouted through a half-lane
     * channel; horizontal transitions stay in the gap between two turn rows.
     * This keeps long/skip edges from cutting through message beads.
     */
    computeEdgeRoutes() {
        if (!this.model) {
            return;
        }
        const options = this.model.options;
        const ts = options.turnSpacing;
        const laneGap = options.laneGap;
        const laneYs = new Map();
        for (const view of this.model.nodes) {
            if (view.role === 'root') {
                continue;
            }
            const key = `${view.lane}:${view.layer}`;
            if (!laneYs.has(key)) {
                laneYs.set(key, []);
            }
            laneYs.get(key).push(view.y);
        }

        const clearance = ts * 0.35;
        const blocked = (lane, layer, y1, y2) => {
            const values = laneYs.get(`${lane}:${layer}`);
            if (!values || !values.length) {
                return false;
            }
            const lo = Math.min(y1, y2) + clearance;
            const hi = Math.max(y1, y2) - clearance;
            if (lo >= hi) {
                return false;
            }
            return values.some((y) => y > lo && y < hi);
        };

        for (const edge of this.model.edges) {
            const parent = edge.parent;
            const child = edge.child;
            const p0 = { x: parent.x, y: parent.y, z: parent.z };
            const p3 = { x: child.x, y: child.y, z: child.z };
            const same = parent.lane === child.lane && parent.layer === child.layer;
            const ratio = child.siblingCount > 1
                ? 0.24 + 0.52 * ((child.branchIndex + 1) / (child.siblingCount + 1))
                : 0.45;
            const midY = p0.y + (p3.y - p0.y) * ratio;

            if (same) {
                if (!blocked(parent.lane, parent.layer, p0.y, p3.y)) {
                    edge.route = [p0, p3];
                    continue;
                }
                const side = parent.lane <= 0 ? 1 : -1;
                const channelX = p0.x + side * laneGap * 0.5;
                const gap = Math.min(ts * 0.3, Math.abs(p3.y - p0.y) * 0.3);
                edge.route = [
                    p0,
                    { x: p0.x, y: p0.y + gap, z: p0.z },
                    { x: channelX, y: p0.y + gap, z: p0.z },
                    { x: channelX, y: p3.y - gap, z: p3.z },
                    { x: p3.x, y: p3.y - gap, z: p3.z },
                    p3,
                ];
                continue;
            }

            const parentBlocked = blocked(parent.lane, parent.layer, p0.y, midY);
            const childBlocked = blocked(child.lane, child.layer, midY, p3.y);
            if (!parentBlocked && !childBlocked) {
                edge.route = [
                    p0,
                    { x: p0.x, y: midY, z: p0.z },
                    { x: p3.x, y: midY, z: p3.z },
                    p3,
                ];
                continue;
            }

            const direction = Math.sign(p3.x - p0.x) || 1;
            const parentChannelX = p0.x + direction * laneGap * 0.5;
            const childChannelX = p3.x - direction * laneGap * 0.5;
            const gap = Math.min(ts * 0.3, Math.abs(p3.y - p0.y) * 0.3);
            edge.route = [
                p0,
                { x: p0.x, y: p0.y + gap, z: p0.z },
                { x: parentChannelX, y: p0.y + gap, z: p0.z },
                { x: parentChannelX, y: midY, z: p0.z },
                { x: childChannelX, y: midY, z: p3.z },
                { x: childChannelX, y: p3.y - gap, z: p3.z },
                { x: p3.x, y: p3.y - gap, z: p3.z },
                p3,
            ];
        }
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
        const tagCandidates = [];

        for (const entry of this.screenNodes) {
            const view = entry.view;
            if (view.role === 'root' || view.id === 'root') {
                continue;
            }
            const fog = this.fog(entry.cz);
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
            const matched = Boolean(this.searchMatches && (this.searchMatches.has(view.id) || segmentMatch));

            let alpha = fog * (relatedToFocus ? 1 : 0.12);
            if (view.role === 'assistant') alpha *= 0.92;

            const baseRadius = view.segmentNodes
                ? 4.4
                : 2.4 + Math.min(5.0, Math.sqrt(Math.max(1, view.chatCount)) * 1.15);
            const radius = clamp(baseRadius * Math.sqrt(Math.max(0.3, entry.scale / 8)), 1.8, 7);
            const role = roleColor(view.role);

            // Fake drop shadow + shaded bead: a real 3D anchor instead of a
            // billboard pretending to be a 3D object.
            ctx.fillStyle = `rgba(0,0,0,${0.3 * alpha})`;
            ctx.beginPath();
            ctx.ellipse(entry.x + radius * 0.5, entry.y + radius * 1.6, radius * 1.25, radius * 0.55, 0, 0, Math.PI * 2);
            ctx.fill();

            const gradient = ctx.createRadialGradient(
                entry.x - radius * 0.3, entry.y - radius * 0.35, radius * 0.15,
                entry.x, entry.y, radius,
            );
            gradient.addColorStop(0, `rgba(255,255,255,${0.9 * alpha})`);
            gradient.addColorStop(1, rgba(role, 0.95 * alpha));
            ctx.fillStyle = gradient;
            ctx.beginPath();
            ctx.arc(entry.x, entry.y, radius, 0, Math.PI * 2);
            ctx.fill();

            if (view.chatCount > 1 || selected || matched) {
                ctx.strokeStyle = selected
                    ? `rgba(255,224,140,${alpha})`
                    : matched
                        ? `rgba(255,209,102,${0.9 * alpha})`
                        : `rgba(200,225,255,${0.5 * alpha})`;
                ctx.lineWidth = selected ? 2 : 1;
                ctx.beginPath();
                ctx.arc(entry.x, entry.y, radius + 2.5, 0, Math.PI * 2);
                ctx.stroke();
            }

            entry.radius = radius + 4;
            entry.rect = null;

            const turnLabel = this.model.options.timeMode === 'timestamp' && view.timeMin
                ? formatTimeShort(view.timeMin)
                : `#${view.turn ?? view.displayDepth}`;

            if (entry.scale < 1.2) {
                continue;
            }
            if (entry.scale < 2.8) {
                ctx.font = `9px ${FONT_STACK}`;
                ctx.fillStyle = `rgba(190,210,240,${0.55 * alpha})`;
                ctx.textBaseline = 'middle';
                ctx.fillText(turnLabel, entry.x + radius + 4, entry.y);
                continue;
            }

            tagCandidates.push({ entry, view, alpha, selected, hovered, matched, turnLabel });
        }

        // Tags are screen-space labels pinned to beads. Near-first, with
        // collision avoidance so the graph stays readable.
        tagCandidates.sort((a, b) => {
            const importanceA = a.selected || a.hovered ? 1 : 0;
            const importanceB = b.selected || b.hovered ? 1 : 0;
            return importanceA - importanceB || a.entry.cz - b.entry.cz;
        });
        const placed = [];
        let drawn = 0;
        const maxTags = this.settings.maxTags || 140;
        for (const item of tagCandidates) {
            if (!item.selected && !item.hovered && drawn >= maxTags) {
                continue;
            }
            const tag = this.tagRect(item);
            if (!item.selected && !item.hovered && placed.some((other) => overlap(tag, other))) {
                continue;
            }
            placed.push(tag);
            this.drawTag(ctx, item, tag);
            item.entry.rect = tag;
            drawn++;
        }
    }

    tagRect(item) {
        const { entry, view } = item;
        const side = (view.lane ?? 0) >= 0 ? 1 : -1;
        const full = item.selected || item.hovered || entry.scale >= 9;
        const twoLines = full || entry.scale >= 5.5;
        const width = full
            ? clamp(150 + entry.scale * 4, 170, 240)
            : twoLines
                ? clamp(116 + entry.scale * 3, 120, 190)
                : clamp(94 + entry.scale * 4, 100, 140);
        const height = full ? 44 : twoLines ? 34 : 24;
        const x = side > 0 ? entry.x + entry.radius + 6 : entry.x - entry.radius - 6 - width;
        // Stagger labels above/below the bead so adjacent lanes can both show
        // a label without overlapping.
        const above = ((Math.abs(view.lane ?? 0) + (view.layer ?? 0)) % 2) === 1;
        const y = clamp(above ? entry.y - height - 7 : entry.y + 7, 4, this.height - height - 4);
        return { x, y, w: width, h: height, side, twoLines, above };
    }

    drawTag(ctx, item, tag) {
        const { view, alpha, selected, hovered, matched, turnLabel } = item;
        const info = this.chatInfo.get(view.ref.chats ? Array.from(view.ref.chats)[0] : '');
        const role = roleColor(view.role);
        const hue = info?.hue ?? 210;
        const x = tag.x;
        const y = tag.y;
        const w = tag.w;
        const h = tag.h;

        const bx = tag.side > 0 ? x : x + w;
        ctx.strokeStyle = `hsla(${hue},70%,62%,${0.55 * alpha})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(item.entry.x, item.entry.y);
        ctx.lineTo(bx, y + h / 2);
        ctx.stroke();

        ctx.fillStyle = `rgba(8,12,22,${0.9 * alpha})`;
        roundRectPath(ctx, x, y, w, h, 5);
        ctx.fill();

        ctx.strokeStyle = selected
            ? `rgba(255,224,140,${0.95 * alpha})`
            : matched
                ? `rgba(255,209,102,${0.9 * alpha})`
                : hovered
                    ? `rgba(235,245,255,${0.8 * alpha})`
                    : view.chatCount > 1
                        ? `rgba(138,178,255,${0.4 * alpha})`
                        : `hsla(${hue},65%,60%,${0.55 * alpha})`;
        ctx.lineWidth = selected ? 1.6 : 1;
        if (view.segmentNodes) {
            ctx.setLineDash([5, 4]);
        }
        roundRectPath(ctx, x, y, w, h, 5);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.fillStyle = rgba(role, 0.92 * alpha);
        ctx.fillRect(x, y, 3, h);

        const pad = 6;
        ctx.textBaseline = 'top';
        ctx.font = `600 ${h >= 40 ? 10.5 : 9.5}px ${FONT_STACK}`;
        ctx.fillStyle = `rgba(230,240,255,${0.95 * alpha})`;
        const sender = view.sender || ROLE_LABEL[view.role] || view.role;
        ctx.fillText(
            fitText(ctx, `${turnLabel} ${sender}`, w - pad * 2 - 6, this.textCache),
            x + pad + 3,
            y + 4,
        );

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
        if (view.segmentNodes) {
            badges.push('＋');
        }
        if (badges.length && w > 150 && h >= 34) {
            ctx.font = `8.5px ${FONT_STACK}`;
            ctx.fillStyle = `rgba(170,200,245,${0.72 * alpha})`;
            const badgeText = badges.join('·');
            const badgeW = ctx.measureText(badgeText).width;
            ctx.fillText(badgeText, x + w - pad - badgeW, y + 5);
        }

        const text = String(view.displayText || view.text || '').replace(/\s+/g, ' ').trim();
        const lines = tag.twoLines ? 2 : 1;
        const bodySize = h >= 40 ? 9.5 : 8.6;
        const lineHeight = bodySize * 1.2;
        const chars = Array.from(text);
        let shown = 0;
        let cursorY = y + 3 + (h >= 40 ? 10.5 : 9.5) + 1;
        for (let line = 0; line < lines && shown < chars.length; line++) {
            const fitted = fitText(ctx, chars.slice(shown).join(''), w - pad * 2 - 3, this.textCache);
            if (!fitted) {
                break;
            }
            ctx.font = `${bodySize}px ${FONT_STACK}`;
            ctx.fillStyle = `rgba(205,220,242,${0.9 * alpha})`;
            ctx.fillText(fitted, x + pad + 3, cursorY);
            cursorY += lineHeight;
            if (fitted.endsWith('…')) {
                shown += Math.max(1, Array.from(fitted).length - 1);
            } else {
                shown = chars.length;
            }
        }

        if (h >= 36 && w > 100) {
            const hues = textFeatureHues(text, 8);
            const cell = 3.5;
            let sx = x + pad + 3;
            const sy = y + h - cell - 3;
            ctx.globalAlpha = 0.6 * alpha;
            for (const featureHue of hues) {
                ctx.fillStyle = `hsl(${featureHue},70%,58%)`;
                ctx.fillRect(sx, sy, cell, cell);
                sx += cell + 1.5;
            }
            ctx.globalAlpha = 1;
        }
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

    drawLaneHeaders(ctx, basis) {
        this.laneHeaders = [];
        if (!this.settings.showLaneHeaders || !this.model) {
            return;
        }

        const groups = new Map();
        for (const view of this.model.nodes) {
            if (view.role === 'root') {
                continue;
            }
            const key = `${view.lane}:${view.layer}`;
            const group = groups.get(key) || { view: null };
            if (
                !group.view
                || view.y < group.view.y
                || (view.y === group.view.y && view.x < group.view.x)
            ) {
                group.view = view;
            }
            groups.set(key, group);
        }

        const items = [];
        for (const group of groups.values()) {
            const view = group.view;
            if (!view) {
                continue;
            }
            const projected = this.project(view, basis);
            if (
                !projected
                || projected.x < -40 || projected.x > this.width + 40
                || projected.y < -40 || projected.y > this.height + 40
            ) {
                continue;
            }
            const chats = view.ref.chats ? Array.from(view.ref.chats) : [];
            const single = chats.length === 1 ? chats[0] : null;
            const info = single ? this.chatInfo.get(single) : null;
            let label = single
                ? this.resolveDisplayName(single)
                : String(view.displayText || view.text || '').replace(/\s+/g, ' ').trim();
            if (!label) {
                label = `#${view.turn ?? view.displayDepth}`;
            }
            items.push({
                view,
                projected,
                label,
                single,
                hue: info?.hue ?? 210,
                focused: Boolean(single && this.focusChatKey === single),
            });
        }

        items.sort((a, b) => a.projected.x - b.projected.x);
        const maxRight = this.width - (this.width < 600 ? 96 : 176);
        let cursor = 44;
        let overflow = 0;

        for (const item of items) {
            if (this.laneHeaders.length >= 12) {
                overflow++;
                continue;
            }
            const width = clamp(64 + Math.min(24, item.label.length) * 6, 84, 190);
            const height = 18;
            let x = item.projected.x - width / 2;
            if (x < cursor) {
                x = cursor;
            }
            if (x + width > maxRight) {
                overflow++;
                continue;
            }
            const y = 6;
            const rect = { x, y, w: width, h: height };

            ctx.strokeStyle = `hsla(${item.hue},70%,62%,0.22)`;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(x + width / 2, y + height);
            ctx.lineTo(item.projected.x, item.projected.y);
            ctx.stroke();

            ctx.fillStyle = 'rgba(8,12,22,0.84)';
            roundRectPath(ctx, x, y, width, height, 5);
            ctx.fill();
            ctx.strokeStyle = item.focused
                ? 'rgba(255,214,120,0.92)'
                : `hsla(${item.hue},70%,62%,0.5)`;
            ctx.lineWidth = item.focused ? 1.4 : 1;
            roundRectPath(ctx, x, y, width, height, 5);
            ctx.stroke();
            ctx.fillStyle = `hsl(${item.hue},70%,62%)`;
            ctx.fillRect(x, y, 3, height);

            ctx.font = `8.5px ${FONT_STACK}`;
            ctx.fillStyle = 'rgba(150,190,255,0.55)';
            ctx.textBaseline = 'middle';
            ctx.fillText(`L${item.view.layer}`, x + 7, y + height / 2 + 0.5);

            ctx.font = `9.5px ${FONT_STACK}`;
            ctx.fillStyle = `rgba(215,230,250,${item.focused ? 0.98 : 0.86})`;
            ctx.fillText(
                fitText(ctx, item.label, width - 34, this.textCache),
                x + 24,
                y + height / 2 + 0.5,
            );

            this.laneHeaders.push({ rect, view: item.view, chatKey: item.single });
            cursor = x + width + 4;
        }

        if (overflow > 0) {
            const width = 36;
            const height = 18;
            const x = Math.min(cursor, maxRight - width);
            const y = 6;
            if (x >= 44) {
                ctx.fillStyle = 'rgba(8,12,22,0.84)';
                roundRectPath(ctx, x, y, width, height, 5);
                ctx.fill();
                ctx.strokeStyle = 'rgba(150,190,255,0.4)';
                ctx.lineWidth = 1;
                roundRectPath(ctx, x, y, width, height, 5);
                ctx.stroke();
                ctx.font = `9.5px ${FONT_STACK}`;
                ctx.fillStyle = 'rgba(190,210,240,0.8)';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(`+${overflow}`, x + width / 2, y + height / 2 + 0.5);
                ctx.textAlign = 'start';
            }
        }
    }

    drawCompactAnchors(ctx, anchors) {
        anchors.sort((a, b) => a.cz - b.cz);
        const placed = [];
        let drawn = 0;
        for (const item of anchors) {
            if (drawn >= 14) {
                break;
            }
            const info = this.chatInfo.get(item.anchor.chatKey);
            const label = this.resolveDisplayName(item.anchor.chatKey);
            const width = clamp(64 + label.length * 6.5, 80, 170);
            const height = 20;
            const x = clamp(item.x - width / 2, 4, this.width - width - 4);
            const y = clamp(item.y + 10, 4, this.height - height - 4);
            const rect = { x, y, w: width, h: height };
            if (placed.some((other) => overlap(rect, other))) {
                continue;
            }
            placed.push(rect);
            drawn++;

            const hue = info?.hue ?? 210;
            ctx.fillStyle = 'rgba(8,12,22,0.84)';
            roundRectPath(ctx, x, y, width, height, 5);
            ctx.fill();
            ctx.strokeStyle = `hsla(${hue},70%,62%,0.55)`;
            ctx.lineWidth = 1;
            roundRectPath(ctx, x, y, width, height, 5);
            ctx.stroke();
            ctx.fillStyle = `hsl(${hue},70%,62%)`;
            ctx.fillRect(x, y, 3, height);
            ctx.font = `9.5px ${FONT_STACK}`;
            ctx.fillStyle = 'rgba(210,225,245,0.9)';
            ctx.textBaseline = 'middle';
            ctx.fillText(fitText(ctx, label, width - 12, this.textCache), x + 8, y + height / 2 + 0.5);

            this.screenAnchors.push({ anchor: item.anchor, rect });
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
        if (!this.focusChatKey) {
            return;
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
        this.minimap.remove();
    }
}
