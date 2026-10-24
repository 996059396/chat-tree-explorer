/**
 * Spatial layout for the Chat Tree Explorer.
 *
 * Pure data: turns the conversation tree into a deterministic 3D "strand tree"
 * suitable for a 2.5D/3D renderer. No DOM, no canvas, no network.
 *
 * Model
 * -----
 * - Every chat gets a base point on a circle (angle by golden ratio, radius by
 *   branch depth). Shared conversations therefore sit between their chats.
 * - Every node is placed at the vector average of the base points of the chats
 *   that pass through it. A shared trunk collapses toward the centre; a branch
 *   drifts toward its own chats.
 * - Branch points add a small inherited offset so sibling branches do not
 *   collapse onto the same line.
 * - y = conversation depth, so turns stay aligned across branches.
 *
 * Hidden nodes (system / preset / structured) are projected out: their visible
 * descendants are re-parented to the nearest visible ancestor.
 */

import { plainTextForDisplay, classifyMessageText } from './spatial-text.js';

export const SPATIAL_DEFAULTS = Object.freeze({
    hideSystem: true,
    hideStructured: true,
    turnSpacing: 4.6,
    baseRadius: 10,
    depthRadius: 2.0,
    branchRadius: 3.4,
    // Experiment (391 chats / 1232 nodes) found a flat 0.8 offset keeps tight
    // collisions near zero while ~doubling branch separation. Do not scale it
    // up with fan-out: that increases collisions sharply.
    branchRadiusPerChild: 0.5,
    branchRadiusMaxFan: 10,
    goldenAngle: 2.399963229728653,
    layoutMode: 'lane', // 'lane' | 'radial'
    baseMode: 'per-chat', // radial mode: 'per-chat' | 'per-root'
    laneGap: 8,
    layerGap: 6,
    anchorOffset: 7.0,
    jitter: 0.06,
    maxBaseDepth: 8,
    // Collapse long linear runs into one expandable "N levels" card, like the
    // list view's chain compression. This is what keeps a 100-turn shared
    // trunk from turning the whole spatial view into a line of dots.
    collapseChains: true,
    chainMin: 5,
    chainMax: 20,
});

function hashString(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

function isHidden(ref, options) {
    if (!ref || ref.id === 'root' || ref.role === 'root') {
        return false;
    }
    if (options.hideSystem && ref.role === 'system') {
        return true;
    }
    if (options.hideStructured && ref.structured) {
        return true;
    }
    return false;
}

function defaultVariant(ref) {
    if (!ref || !ref.variants || typeof ref.variants.get !== 'function') {
        return null;
    }
    return ref.variants.get(ref.defaultVariantKey) || (ref.variantList && ref.variantList[0]) || null;
}

function makeView(ref, parent) {
    const variant = defaultVariant(ref);
    const rawText = variant ? variant.text : '';
    const displayText = plainTextForDisplay(rawText, 2000);
    const classification = classifyMessageText(rawText, ref.role);
    return {
        id: ref.id,
        ref,
        parent,
        children: [],
        depth: Number(ref.depth) || 0,
        displayDepth: 0,
        originalDepth: Number(ref.depth) || 0,
        role: ref.role,
        chats: ref.chats,
        chatCount: ref.chats ? ref.chats.size : 0,
        variantCount: ref.variantList ? ref.variantList.length : 1,
        text: rawText,
        displayText,
        displayLength: displayText.length,
        rich: Boolean(classification.rich || ref.rich),
        structured: Boolean(ref.structured ?? classification.structured),
        textLength: variant ? variant.norm.length : 0,
        sender: ref.senderName || '',
        x: 0,
        y: 0,
        z: 0,
        offsetX: 0,
        offsetZ: 0,
        branchIndex: 0,
        siblingCount: 1,
        lane: 0,
        layer: 0,
        turn: 0,
        segmentNodes: null,
        segmentCount: 0,
        segmentKey: '',
        segmentEndText: '',
        segmentLastUserText: '',
        segmentLastUserRole: '',
        segmentTerminalRole: '',
    };
}

/**
 * Project the original tree into the visible dialogue tree.
 * @param {any} root
 * @param {any} options
 */
function projectTree(root, options) {
    let hiddenCount = 0;

    function project(ref, parentView) {
        if (ref.id !== 'root' && isHidden(ref, options)) {
            hiddenCount++;
            const created = [];
            for (const child of ref.children || []) {
                created.push(...project(child, parentView));
            }
            return created;
        }

        const view = makeView(ref, parentView);
        if (parentView) {
            parentView.children.push(view);
        }

        const created = [view];
        for (const child of ref.children || []) {
            created.push(...project(child, view));
        }
        return created;
    }

    const roots = project(root, null);
    return { root: roots[0] || null, hiddenCount };
}

function computeChatBases(chatInfo, options) {
    const entries = Array.from(chatInfo.entries())
        .map(([chatKey, info]) => ({
            chatKey,
            root: info.root || chatKey,
            depth: Number(info.depth) || 0,
            date: Number(info.date) || 0,
        }))
        .sort((a, b) => {
            if (a.root !== b.root) {
                return a.root.localeCompare(b.root);
            }
            if (a.depth !== b.depth) {
                return a.depth - b.depth;
            }
            if (a.date !== b.date) {
                return a.date - b.date;
            }
            return a.chatKey.localeCompare(b.chatKey);
        });

    const bases = new Map();

    if (options.baseMode === 'per-root') {
        const roots = Array.from(new Set(entries.map((entry) => entry.root))).sort();
        const rootIndex = new Map(roots.map((root, index) => [root, index]));
        for (const entry of entries) {
            const index = rootIndex.get(entry.root) || 0;
            const angle = index * options.goldenAngle + entry.depth * 0.31;
            const depth = Math.min(entry.depth, options.maxBaseDepth);
            const radius = options.baseRadius + depth * options.depthRadius;
            bases.set(entry.chatKey, {
                x: Math.cos(angle) * radius,
                z: Math.sin(angle) * radius,
                angle,
                radius,
            });
        }
        return bases;
    }

    entries.forEach((entry, index) => {
        const angle = index * options.goldenAngle;
        const depth = Math.min(entry.depth, options.maxBaseDepth);
        const radius = options.baseRadius + depth * options.depthRadius;
        bases.set(entry.chatKey, {
            x: Math.cos(angle) * radius,
            z: Math.sin(angle) * radius,
            angle,
            radius,
        });
    });
    return bases;
}

function nodeBase(view, bases, fallback) {
    if (!view.chats || !view.chats.size) {
        return fallback;
    }
    let x = 0;
    let z = 0;
    let count = 0;
    for (const chatKey of view.chats) {
        const base = bases.get(chatKey);
        if (base) {
            x += base.x;
            z += base.z;
            count++;
        }
    }
    if (!count) {
        return fallback;
    }
    return { x: x / count, z: z / count };
}

function assignPositions(rootView, bases, options) {
    const stack = [
        {
            view: rootView,
            parentOffsetX: 0,
            parentOffsetZ: 0,
            phase: 0,
            branchIndex: 0,
            siblingCount: 1,
            fallback: { x: 0, z: 0 },
        },
    ];

    while (stack.length) {
        const item = stack.pop();
        const { view } = item;
        const base = nodeBase(view, bases, item.fallback);

        let offsetX = item.parentOffsetX;
        let offsetZ = item.parentOffsetZ;

        if (item.siblingCount > 1) {
            const fan = Math.min(item.siblingCount, options.branchRadiusMaxFan);
            const magnitude = options.branchRadius + options.branchRadiusPerChild * fan;
            const angle = item.phase + (Math.PI * 2 * item.branchIndex) / item.siblingCount;
            offsetX = item.parentOffsetX + Math.cos(angle) * magnitude;
            offsetZ = item.parentOffsetZ + Math.sin(angle) * magnitude;
        }

        if (options.jitter && item.siblingCount === 1) {
            const h = hashString(view.id);
            offsetX += (((h & 0xff) / 255) - 0.5) * options.jitter;
            offsetZ += ((((h >> 8) & 0xff) / 255) - 0.5) * options.jitter;
        }

        view.x = base.x + offsetX;
        view.z = base.z + offsetZ;
        view.y = view.displayDepth * options.turnSpacing;
        view.offsetX = offsetX;
        view.offsetZ = offsetZ;
        view.branchIndex = item.branchIndex;
        view.siblingCount = item.siblingCount;

        const phase = Math.atan2(view.z, view.x) || 0;
        const children = view.children;
        for (let index = 0; index < children.length; index++) {
            stack.push({
                view: children[index],
                parentOffsetX: offsetX,
                parentOffsetZ: offsetZ,
                phase,
                branchIndex: index,
                siblingCount: children.length,
                fallback: base,
            });
        }
    }
}

function makeSegment(run) {
    const first = run[0];
    const last = run[run.length - 1];

    let lastUser = null;
    for (let index = run.length - 1; index >= 0; index--) {
        if (run[index].role === 'user') {
            lastUser = run[index];
            break;
        }
    }

    let variantCount = 0;
    let displayLength = 0;
    let textLength = 0;
    let rich = false;
    for (const view of run) {
        variantCount += Math.max(1, view.variantCount || 1);
        displayLength += view.displayLength || 0;
        textLength += view.textLength || 0;
        rich = rich || Boolean(view.rich);
    }

    const segment = {
        id: `seg:${first.id}`,
        ref: first.ref,
        parent: first.parent,
        children: last.children.slice(),
        depth: first.depth,
        originalDepth: first.originalDepth,
        displayDepth: 0,
        role: 'segment',
        chats: first.chats,
        chatCount: first.chatCount,
        variantCount,
        variantIndex: 0,
        text: first.text || '',
        displayText: `${run.length} 层：${first.displayText || ''} … ${last.displayText || ''}`,
        displayLength,
        textLength,
        rich,
        structured: false,
        sender: `↕ ${run.length} 层`,
        x: 0,
        y: 0,
        z: 0,
        offsetX: 0,
        offsetZ: 0,
        branchIndex: 0,
        siblingCount: 1,
        lane: 0,
        layer: 0,
        turn: 0,
        segmentNodes: run,
        segmentCount: run.length,
        segmentKey: first.id,
        segmentEndText: last.displayText || '',
        segmentLastUserText: lastUser ? lastUser.displayText : '',
        segmentLastUserRole: lastUser ? 'user' : last.role,
        segmentTerminalRole: last.role,
    };

    for (const child of segment.children) {
        child.parent = segment;
    }
    return segment;
}

/**
 * Replace long single-child runs with one expandable segment view. All nodes in
 * a run keep their original data; only the display tree is changed.
 */
function collapseLinearRuns(rootView, options) {
    if (!rootView) {
        return;
    }
    const expanded = options.expandedSegments instanceof Set ? options.expandedSegments : new Set();
    const stack = [rootView];

    while (stack.length) {
        const parent = stack.pop();
        for (let index = 0; index < parent.children.length; index++) {
            const start = parent.children[index];
            const run = [];
            let current = start;
            while (current && current.children.length === 1) {
                run.push(current);
                current = current.children[0];
            }
            if (current && current.children.length === 0) {
                run.push(current);
            }

            const isExpanded = run.some((view) => expanded.has(view.id));
            if (run.length >= options.chainMin && isExpanded) {
                // Keep this whole run expanded, but still process the branches
                // that continue after it.
                const last = run[run.length - 1];
                for (const child of last.children) {
                    stack.push(child);
                }
            } else if (run.length >= options.chainMin) {
                // Split very long linear runs into several segment cards so the
                // trunk still reads as a sequence instead of one huge card.
                const chunkMax = Math.max(options.chainMin + 1, options.chainMax || 20);
                let tail = run;
                let attachParent = parent;
                let attachIndex = index;
                let lastSegment = null;
                while (tail.length) {
                    const chunk = tail.slice(0, chunkMax);
                    const isLast = chunk.length === tail.length;
                    const segment = makeSegment(chunk);
                    segment.parent = attachParent;
                    if (isLast) {
                        segment.children = chunk[chunk.length - 1].children.slice();
                        for (const child of segment.children) {
                            child.parent = segment;
                        }
                    } else {
                        segment.children = [];
                    }
                    attachParent.children[attachIndex] = segment;
                    lastSegment = segment;
                    attachParent = segment;
                    attachIndex = 0;
                    tail = tail.slice(chunkMax);
                }
                stack.push(lastSegment);
            } else {
                // No collapse here, but still process this node's children:
                // it may be a branch point whose subtrees contain long runs.
                stack.push(start);
            }
        }
    }
}

function assignDisplayDepths(rootView) {
    if (!rootView) {
        return;
    }
    rootView.displayDepth = 0;
    const stack = [rootView];
    while (stack.length) {
        const view = stack.pop();
        for (const child of view.children) {
            child.displayDepth = view.displayDepth + 1;
            stack.push(child);
        }
    }
}

/**
 * Lane layout: the conversation is a git-like graph.
 *
 *   X = branch lane (main trunk = 0, branches alternate ±1, ±2, …)
 *   Y = turn depth (time always flows downward)
 *   Z = nesting layer (main child stays in the layer, side branches step back)
 *
 * Lanes are interval-allocated and reused after a branch ends, so wide trees do
 * not explode horizontally. Vertical edges + orthogonal branch bends make the
 * order unambiguous, unlike a radial free-form layout.
 */
function assignLanePositions(rootView, options) {
    if (!rootView) {
        return;
    }

    // Subtree maximum display depth, for lane interval allocation.
    const order = [];
    const stack = [rootView];
    while (stack.length) {
        const view = stack.pop();
        order.push(view);
        for (const child of view.children) {
            stack.push(child);
        }
    }
    for (let index = order.length - 1; index >= 0; index--) {
        const view = order[index];
        let max = view.displayDepth;
        for (const child of view.children) {
            if (child._subtreeMax > max) {
                max = child._subtreeMax;
            }
        }
        view._subtreeMax = max;
    }

    rootView.lane = 0;
    rootView.layer = 0;
    rootView.turn = 1;
    rootView.x = 0;
    rootView.y = 0;
    rootView.z = 0;

    const laneEnds = new Map([[0, rootView._subtreeMax]]);
    const queue = [rootView];

    for (let cursor = 0; cursor < queue.length; cursor++) {
        const parent = queue[cursor];
        const children = [...parent.children].sort(
            (a, b) => (b.chatCount - a.chatCount)
                || (a.displayDepth - b.displayDepth)
                || String(a.id).localeCompare(String(b.id)),
        );

        for (let index = 0; index < children.length; index++) {
            const child = children[index];
            if (index === 0) {
                child.lane = parent.lane;
                child.layer = parent.layer;
            } else {
                let lane = null;
                for (let offset = 1; offset < 256 && lane === null; offset++) {
                    for (const candidate of [parent.lane + offset, parent.lane - offset]) {
                        const end = laneEnds.get(candidate);
                        if (end === undefined || end < child.displayDepth) {
                            lane = candidate;
                            break;
                        }
                    }
                }
                if (lane === null) {
                    lane = parent.lane + 1;
                }
                laneEnds.set(lane, child._subtreeMax);
                child.lane = lane;
                child.layer = parent.layer + 1;
            }

            child.turn = child.displayDepth;
            child.x = child.lane * options.laneGap;
            child.z = child.layer * options.layerGap;
            child.y = child.displayDepth * options.turnSpacing;
            queue.push(child);
        }
    }
}

function collectVisible(rootView, nodes = [], edges = []) {
    if (!rootView) {
        return { nodes, edges };
    }
    const stack = [rootView];
    while (stack.length) {
        const view = stack.pop();
        nodes.push(view);
        for (const child of view.children) {
            edges.push({ parent: view, child });
            stack.push(child);
        }
    }
    return { nodes, edges };
}

/**
 * @param {any} tree result of buildChatTree
 * @param {Map<string, {root:string, depth:number, date?:number, color:string}>} chatInfo
 * @param {Partial<typeof SPATIAL_DEFAULTS>} [options]
 */
export function buildSpatialModel(tree, chatInfo, options = {}) {
    const opts = { ...SPATIAL_DEFAULTS, ...options };
    const projected = projectTree(tree.root, opts);
    const rootView = projected.root;

    if (rootView && opts.collapseChains) {
        collapseLinearRuns(rootView, opts);
    }
    assignDisplayDepths(rootView);

    const { nodes, edges } = collectVisible(rootView);
    const bases = opts.layoutMode === 'lane' ? null : computeChatBases(chatInfo, opts);

    if (rootView) {
        if (opts.layoutMode === 'lane') {
            assignLanePositions(rootView, opts);
        } else {
            assignPositions(rootView, bases, opts);
        }
    }

    // Chat paths and anchors.
    const chatPaths = new Map();
    const chatAnchors = [];

    for (const chatKey of chatInfo.keys()) {
        const path = nodes
            .filter((view) => view.ref.chats && view.ref.chats.has(chatKey))
            .sort((a, b) => a.y - b.y || a.x - b.x);
        if (!path.length) {
            continue;
        }
        chatPaths.set(chatKey, path);

        const terminal = path[path.length - 1];

        let lastUserNode = null;
        let rareNode = null;
        let divergenceNode = null;
        let minChats = Infinity;
        let prevChats = null;
        let hasUnique = false;

        for (const view of path) {
            if (view.segmentNodes) {
                for (const node of view.segmentNodes) {
                    if (node.role === 'user') {
                        lastUserNode = node;
                    }
                    if (node.chatCount === 1) {
                        hasUnique = true;
                    }
                    if (node.chatCount < minChats) {
                        minChats = node.chatCount;
                    }
                    if (divergenceNode === null && prevChats !== null && node.chatCount < prevChats && prevChats > 1) {
                        divergenceNode = view;
                    }
                    prevChats = node.chatCount;
                }
            } else {
                if (view.role === 'user') {
                    lastUserNode = view;
                }
                if (view.chatCount === 1) {
                    hasUnique = true;
                }
                if (view.chatCount < minChats) {
                    minChats = view.chatCount;
                }
                if (divergenceNode === null && prevChats !== null && view.chatCount < prevChats && prevChats > 1) {
                    divergenceNode = view;
                }
                prevChats = view.chatCount;
            }
        }

        // Rare anchor: the last node that is still reasonably specific to this
        // chat. Strict uniqueness is rare in real corpora, so allow <= 3 chats.
        const rareThreshold = Math.max(2, Math.min(3, minChats));
        for (const view of path) {
            if (view.chatCount <= rareThreshold) {
                rareNode = view;
            }
        }
        if (!rareNode) {
            for (const view of path) {
                if (view.chatCount === minChats) {
                    rareNode = view;
                }
            }
        }
        if (!divergenceNode && path[0] && path[0].chatCount === 1) {
            divergenceNode = path[0];
        }

        // The last user message is usually the most recognisable part of a
        // playthrough; fall back to the rarest node, then the ending.
        const anchorNode = lastUserNode || rareNode || terminal;
        const anchorText = lastUserNode
            ? lastUserNode.displayText
            : terminal.segmentNodes
                ? terminal.segmentLastUserText || terminal.segmentEndText
                : terminal.displayText;
        const terminalText = terminal.segmentNodes ? terminal.segmentEndText : terminal.displayText;
        const lastUserRole = lastUserNode
            ? 'user'
            : terminal.segmentNodes
                ? terminal.segmentLastUserRole
                : terminal.role;
        const terminalRole = terminal.segmentNodes ? terminal.segmentTerminalRole : terminal.role;

        const base = bases ? bases.get(chatKey) : null;
        let dx = 0;
        let dz = 0;
        if (opts.layoutMode === 'lane') {
            const side = terminal.lane >= 0 ? 1 : -1;
            dx = side * opts.anchorOffset;
            dz = opts.layerGap * 0.6;
        } else if (base) {
            const length = Math.hypot(base.x, base.z) || 1;
            dx = (base.x / length) * opts.anchorOffset;
            dz = (base.z / length) * opts.anchorOffset;
        }

        chatAnchors.push({
            chatKey,
            base,
            path,
            anchorNode,
            lastUserNode,
            rareNode,
            divergenceNode,
            terminalNode: terminal,
            anchorText: anchorText || '',
            terminalText: terminalText || '',
            lastUserRole,
            terminalRole,
            x: terminal.x + dx,
            y: terminal.y,
            z: terminal.z + dz,
            unique: hasUnique,
        });
    }

    // Bounds include anchors so the camera fits the labels too.
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;

    function include(x, y, z) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
    }

    for (const view of nodes) {
        include(view.x, view.y, view.z);
    }
    if (!Number.isFinite(minX)) {
        minX = maxX = minY = maxY = minZ = maxZ = 0;
    }

    const center = {
        x: (minX + maxX) / 2,
        y: (minY + maxY) / 2,
        z: (minZ + maxZ) / 2,
    };
    const size = {
        x: maxX - minX,
        y: maxY - minY,
        z: maxZ - minZ,
    };
    const radius = Math.max(1, Math.hypot(size.x, size.y, size.z) / 2);

    let branchPoints = 0;
    let maxDepth = 0;
    let sharedNodes = 0;
    for (const view of nodes) {
        if (view.children.length > 1) {
            branchPoints++;
        }
        if (view.displayDepth > maxDepth) {
            maxDepth = view.displayDepth;
        }
        if (view.chatCount > 1) {
            sharedNodes++;
        }
    }

    return {
        options: opts,
        nodes,
        edges,
        chatPaths,
        chatAnchors,
        chatBases: bases,
        bounds: { minX, maxX, minY, maxY, minZ, maxZ, center, size, radius },
        stats: {
            visibleNodes: nodes.length,
            hiddenNodes: projected.hiddenCount,
            edges: edges.length,
            branchPoints,
            sharedNodes,
            chatCount: chatPaths.size,
            maxDepth,
        },
        nodeById: new Map(nodes.map((view) => [view.id, view])),
    };
}

/**
 * A stable, cheap visual "fingerprint" for a message: 8 hue values derived from
 * its text. Used by the renderer to draw a colour strip so messages can be
 * recognised at a glance before any text is legible.
 * @param {string} text
 * @param {number} count
 * @returns {number[]} hues 0..360
 */
export function textFeatureHues(text, count = 8) {
    const value = String(text || '');
    const hues = [];
    let h = hashString(value);
    for (let i = 0; i < count; i++) {
        h ^= h << 13;
        h ^= h >>> 17;
        h ^= h << 5;
        h >>>= 0;
        hues.push(h % 360);
    }
    return hues;
}
