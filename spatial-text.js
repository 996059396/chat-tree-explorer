/**
 * Text presentation helpers for the spatial view.
 *
 * Chat messages can contain a lot of HTML / code / markup. The spatial cards
 * need short, human-readable text, while the classifier needs to recognise
 * preset-style structured blocks. Both live here and are pure functions.
 */

const ENTITY_MAP = {
    '&nbsp;': ' ',
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&#x27;': "'",
    '&#x2F;': '/',
};

const STRONG_MARKERS = [
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

const TAVERN_MARKERS = [
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
 * Strip markup and collapse whitespace for card / tooltip display.
 * @param {unknown} value
 * @param {number} [maxLength]
 * @returns {string}
 */
export function plainTextForDisplay(value, maxLength = 0) {
    let text = value === null || value === undefined ? '' : String(value);

    text = text.replace(/<img\b[^>]*>/gi, ' [图片] ');
    text = text.replace(/<(?:video|audio|source)\b[^>]*>/gi, ' [媒体] ');
    text = text.replace(/<br\s*\/?>/gi, '\n');
    text = text.replace(/<\/(?:p|div|li|h[1-6]|tr|blockquote|pre)>/gi, '\n');
    text = text.replace(/<[^>]{0,600}>/g, ' ');

    for (const [entity, replacement] of Object.entries(ENTITY_MAP)) {
        text = text.split(entity).join(replacement);
    }
    text = text.replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code) || 32));
    text = text.replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16) || 32));

    // Keep code blocks but drop the fence noise; the card truncates anyway.
    text = text.replace(/```[a-zA-Z0-9_-]*\s*/g, ' ');
    text = text.replace(/```/g, ' ');

    text = text
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
        .replace(/\r\n?/g, '\n')
        .replace(/[ \t\f\v]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

    if (maxLength > 0 && text.length > maxLength) {
        text = `${text.slice(0, maxLength)}…`;
    }
    return text;
}

/**
 * Classify a message for the "hide preset / structured content" filter.
 * Returns a *hint*; the caller decides whether to hide it.
 * @param {unknown} rawText
 * @param {string} role
 * @returns {{kind:'dialogue'|'system'|'structured', structured:boolean, rich:boolean, reasons:string[]}}
 */
export function classifyMessageText(rawText, role) {
    const raw = rawText === null || rawText === undefined ? '' : String(rawText);
    const reasons = [];

    if (role === 'system') {
        reasons.push('system-role');
        return {
            kind: 'system',
            structured: true,
            rich: /<[^>]+>/.test(raw) || /```/.test(raw),
            reasons,
        };
    }

    let strong = 0;
    for (const pattern of STRONG_MARKERS) {
        if (pattern.test(raw)) {
            strong++;
        }
    }
    let tavern = 0;
    for (const pattern of TAVERN_MARKERS) {
        if (pattern.test(raw)) {
            tavern++;
        }
    }

    if (strong > 0) {
        reasons.push('prompt-markers');
    }
    if (tavern >= 2) {
        reasons.push('tavern-template');
    }
    if (raw.length > 4000 && (strong > 0 || tavern > 0)) {
        reasons.push('long-structured');
    }

    const structured = strong > 0 || tavern >= 2;
    return {
        kind: structured ? 'structured' : 'dialogue',
        structured,
        rich: /<[^>]+>/.test(raw) || /```/.test(raw),
        reasons,
    };
}
