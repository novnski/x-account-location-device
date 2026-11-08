/**
 * Post-first Graphite share cards. The detached snapshot is the only source of
 * account/post data; drawing never starts another X API lookup or reads live DOM.
 */
import browserAPI from '../shared/browser-api.js';
import { isRegion } from '../shared/constants.js';
import { deviceIcon, flagImageUrl } from './icons.js';
import { dialogIcon } from './dialog-icons.js';

const FONT = '"Segoe UI", system-ui, sans-serif';
const WIDTH = 640;
const PADDING = 32;
const CONTENT_WIDTH = WIDTH - PADDING * 2;
const SCALE = 2;
// Stay within mobile canvas limits. Oversized captures fail explicitly, never
// silently omit post text or produce a blank/uncopyable PNG.
const MAX_HEIGHT = 8192;
const MAX_PIXELS = 12000000;
const IMAGE_TIMEOUT_MS = 5000;
const GRAPHEMES = typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;

function graphemes(text) {
    return GRAPHEMES ? Array.from(GRAPHEMES.segment(text), item => item.segment) : Array.from(text);
}

/** Preserve paragraphs and every grapheme; break oversized words/URLs safely. */
export function wrapCardText(ctx, text, maxWidth, font) {
    if (!text) return [];
    if (!(maxWidth > 0)) throw new RangeError('Text needs a positive layout width.');
    ctx.font = font;
    const lines = [];
    for (const paragraph of String(text).replace(/\r\n?/g, '\n').split('\n')) {
        let line = '';
        for (const token of paragraph.match(/\s+|\S+/gu) || []) {
            if (ctx.measureText(line + token).width <= maxWidth) {
                line += token;
                continue;
            }
            if (line.trim()) {
                lines.push(line.trimEnd());
                line = '';
            }
            const word = token.trimStart();
            if (ctx.measureText(word).width <= maxWidth) {
                line = word;
                continue;
            }
            for (const part of graphemes(word)) {
                if (line && ctx.measureText(line + part).width > maxWidth) {
                    lines.push(line);
                    line = '';
                }
                line += part;
            }
        }
        lines.push(line.trimEnd());
    }
    return lines;
}

/** UTC only. Relative DOM labels must not be mistaken for an absolute date. */
export function formatCardDate(value, { seconds = false } = {}) {
    if (typeof value !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return '';
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const pad = number => String(number).padStart(2, '0');
    const time = `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}` +
        (seconds ? `:${pad(date.getUTCSeconds())}` : '');
    return `${date.getUTCDate()} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()} · ${time} UTC`;
}

function aborted() {
    return new DOMException('Post capture cancelled.', 'AbortError');
}

/** One deadline and abort cleanup per image; optional art cannot stall sharing. */
function loadImage(src, signal) {
    if (!src) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(aborted());
        const image = new Image();
        let settled = false;
        const finish = (error, result = null) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            image.onload = image.onerror = null;
            signal?.removeEventListener('abort', onAbort);
            if (error || !result) image.removeAttribute('src');
            if (error) reject(error);
            else resolve(result);
        };
        const onAbort = () => finish(aborted());
        image.crossOrigin = 'anonymous';
        image.referrerPolicy = 'no-referrer';
        image.onload = () => finish(null, image);
        image.onerror = () => finish(null);
        signal?.addEventListener('abort', onAbort, { once: true });
        const timer = setTimeout(() => finish(null), IMAGE_TIMEOUT_MS);
        image.src = src;
    });
}

/** Rasterize the actual shared SVG glyphs, not a second approximate icon set. */
function iconImage(svg, color, signal) {
    svg.setAttribute('color', color);
    svg.setAttribute('style', `color:${color}`);
    const source = new XMLSerializer().serializeToString(svg);
    return loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`, signal);
}

function roundedRect(ctx, x, y, width, height, radius, fill, stroke) {
    ctx.beginPath();
    ctx.roundRect(x, y, width, height, radius);
    if (fill) {
        ctx.fillStyle = fill;
        ctx.fill();
    }
    if (stroke) {
        ctx.strokeStyle = stroke;
        ctx.lineWidth = 1;
        ctx.stroke();
    }
}

function drawLines(ctx, lines, x, top, font, color, lineHeight) {
    ctx.font = font;
    ctx.fillStyle = color;
    // Baselines are explicit so DOM/CSS line-height differences cannot leak in.
    const fontSize = Number(/([\d.]+)px/.exec(font)?.[1]) || 14;
    for (const [index, line] of lines.entries()) {
        ctx.fillText(line, x, top + index * lineHeight + fontSize);
    }
}

function drawContainedImage(ctx, image, x, y, width, height) {
    const ratio = Math.min(width / image.width, height / image.height);
    const drawnWidth = image.width * ratio;
    const drawnHeight = image.height * ratio;
    ctx.drawImage(image, x + (width - drawnWidth) / 2, y + (height - drawnHeight) / 2, drawnWidth, drawnHeight);
}

/** Render the same immutable canvas for preview, clipboard, native share/save. */
export async function createPostCardCanvas(data, signal) {
    if (signal?.aborted) throw aborted();
    const light = document.documentElement.getAttribute('data-x-theme') === 'light';
    const colors = light
        ? { bg: '#FFFFFF', panel: '#F1F4F3', text: '#20272A', dim: '#5E6A70', border: '#D7DDDD', accent: '#236C5C', soft: '#E7F1ED', warning: '#85500D' }
        : { bg: '#1C1F22', panel: '#25292D', text: '#ECF0F1', dim: '#A5AFB6', border: '#353B40', accent: '#91D2C2', soft: '#233A35', warning: '#E7B36A' };
    // The existing Support rose distinguishes account context without making
    // ordinary location/source information look like an accuracy warning.
    const contextColors = light
        ? { bg: '#F9F2F4', accent: '#99475C', border: 'rgba(153, 71, 92, .28)' }
        : { bg: '#2B2429', accent: '#DF9BA8', border: 'rgba(223, 155, 168, .32)' };
    const location = data.location || 'Unknown';
    const device = data.device || 'Unknown';
    const photoUrls = Array.isArray(data.mediaUrls) ? data.mediaUrls.slice(0, 4) : [];
    // Start together, retaining snapshot order. No serial avatar -> media delay.
    const jobs = [
        loadImage(data.profileImageUrl, signal),
        ...photoUrls.map(url => loadImage(url, signal)),
        iconImage(deviceIcon(device, 24), colors.dim, signal),
        iconImage(dialogIcon(isRegion(location) ? 'map' : 'globe', 24), contextColors.accent, signal),
        iconImage(dialogIcon('warn', 16), colors.warning, signal),
        ...['messageCircle', 'repeat2', 'heart', 'eye'].map(name =>
            iconImage(dialogIcon(name, 16), colors.dim, signal)),
        loadImage(flagImageUrl(location), signal),
        loadImage(browserAPI.runtime.getURL('icons/logo.svg'), signal)
    ];
    const assets = await Promise.all(jobs);
    if (signal?.aborted) throw aborted();
    const avatar = assets.shift();
    const photos = assets.splice(0, photoUrls.length);
    const [sourceIcon, locationIcon, warningIcon, ...otherAssets] = assets;
    const metricIcons = otherAssets.slice(0, 4);
    const [flag, logo] = otherAssets.slice(4);

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Your browser could not create this post card. Please try again.');
    const nameFont = `600 22px ${FONT}`;
    const bodyFont = `18px ${FONT}`;
    const valueFont = `600 16px ${FONT}`;
    const smallFont = `13px ${FONT}`;
    const tinyFont = `12px ${FONT}`;
    const name = data.displayName || data.screenName || 'Unknown account';
    const nameLines = wrapCardText(ctx, name, CONTENT_WIDTH - 72, nameFont);
    const headerHeight = Math.max(56, nameLines.length * 28 + 25);
    const bodyLines = wrapCardText(ctx, data.tweetText, CONTENT_WIDTH, bodyFont);
    const bodyTop = PADDING + headerHeight + (bodyLines.length ? 24 : 0);
    let cursor = bodyTop + bodyLines.length * 28;

    // All available photos up to X's native four-photo limit. Contain rather than
    // crop: this is a record of the visible post, not a new editorial crop.
    const media = [];
    if (photos.length) {
        cursor += 20;
        const columns = photos.length === 1 ? 1 : 2;
        const cellWidth = (CONTENT_WIDTH - (columns - 1) * 8) / columns;
        for (let index = 0; index < photos.length; index += columns) {
            const row = photos.slice(index, index + columns);
            const idealHeights = row.map(photo => photo ? cellWidth * photo.height / photo.width : 160);
            const rowHeight = Math.min(columns === 1 ? 380 : 280, Math.max(120, ...idealHeights));
            row.forEach((photo, column) => media.push({
                photo, x: PADDING + column * (cellWidth + 8), y: cursor, width: cellWidth, height: rowHeight
            }));
            cursor += rowHeight + (index + columns < photos.length ? 8 : 0);
        }
    }
    const mediaNotice = Array.isArray(data.mediaUrls) && data.mediaUrls.length > photoUrls.length
        ? `Showing ${photoUrls.length} of ${data.mediaUrls.length} photos.` : '';
    let mediaNoticeTop = 0;
    if (mediaNotice) {
        mediaNoticeTop = cursor + 8;
        cursor = mediaNoticeTop + 18;
    }

    // The publication date belongs to the post; capture time belongs to the
    // provenance footer. Missing/relative timestamps are never fabricated.
    const posted = formatCardDate(data.timestamp);
    const postDate = posted ? `Posted ${posted}` : '';
    const metrics = ['replies', 'retweets', 'likes', 'views'].flatMap((key, index) => {
        const value = data.metrics?.[key];
        return value && value !== '0' ? [{ value: String(value), icon: metricIcons[index] }] : [];
    });
    const metaTop = cursor + (postDate || metrics.length ? 18 : 0);
    ctx.font = smallFont;
    let metricWidth = 0;
    for (const item of metrics) {
        item.width = Math.min(CONTENT_WIDTH, 20 + ctx.measureText(item.value).width);
        item.lines = wrapCardText(ctx, item.value, CONTENT_WIDTH - 20, smallFont);
        metricWidth += item.width;
    }
    metricWidth += Math.max(0, metrics.length - 1) * 24;
    ctx.font = tinyFont;
    const dateWidth = ctx.measureText(postDate).width;
    const inlineMetrics = metricWidth <= CONTENT_WIDTH &&
        (!postDate || !metrics.length || dateWidth + 24 + metricWidth <= CONTENT_WIDTH);
    const metricsTop = metaTop + (postDate && !inlineMetrics ? 28 : 0);
    let metricX = inlineMetrics ? WIDTH - PADDING - metricWidth : PADDING;
    let metricY = metricsTop;
    let metricRowHeight = 20;
    for (const item of metrics) {
        if (metricX > PADDING && metricX + item.width > WIDTH - PADDING) {
            metricX = PADDING;
            metricY += metricRowHeight + 8;
            metricRowHeight = 20;
        }
        item.x = metricX;
        item.y = metricY;
        metricRowHeight = Math.max(metricRowHeight, item.lines.length * 20);
        metricX += item.width + 24;
    }
    if (postDate || metrics.length) cursor = metrics.length ? metricY + metricRowHeight : metaTop + 20;

    const contextTop = cursor + 24;
    const columnWidth = CONTENT_WIDTH / 2;
    const valueWidth = columnWidth - 40 - 34;
    const locationLines = wrapCardText(ctx, location, valueWidth, valueFont);
    const deviceLines = wrapCardText(ctx, device, valueWidth, valueFont);
    const valueHeight = Math.max(locationLines.length, deviceLines.length) * 23;
    const warning = data.locationAccurate === false
        ? 'X reports that this location may be inaccurate.' : '';
    const warningLines = wrapCardText(ctx, warning, CONTENT_WIDTH - 64, smallFont);
    const columnsHeight = 20 + 17 + 8 + valueHeight + 20;
    const contextHeight = columnsHeight + (warning ? 12 + warningLines.length * 19 + 16 : 0);

    const url = (data.tweetUrl || '').replace(/^https:\/\/x\.com\//, 'x.com/');
    const urlLines = wrapCardText(ctx, url, CONTENT_WIDTH, smallFont);
    const urlTop = contextTop + contextHeight + 18;
    const footerTop = urlTop + urlLines.length * 19 + 22;
    const captureDate = formatCardDate(data.captureTime, { seconds: true });
    const captureLabel = captureDate ? `Captured ${captureDate}` : 'Capture time unavailable';
    ctx.font = tinyFont;
    const captureWidth = ctx.measureText(captureLabel).width;
    const version = data.version ? `v${data.version}` : '';
    ctx.font = `600 13px ${FONT}`;
    const brandWidth = 30 + ctx.measureText('X-Posed').width;
    ctx.font = tinyFont;
    const signatureWidth = brandWidth + (version ? 8 + ctx.measureText(version).width : 0);
    const stackedFooter = signatureWidth + 24 + captureWidth > CONTENT_WIDTH;
    const height = Math.ceil(footerTop + (stackedFooter ? 50 : 26) + 28);
    if (height * SCALE > MAX_HEIGHT || WIDTH * height * SCALE * SCALE > MAX_PIXELS) {
        throw new RangeError('This post is too long to capture fully in one image. Open a shorter post and try again. No text was cut off.');
    }

    canvas.width = WIDTH * SCALE;
    canvas.height = height * SCALE;
    ctx.scale(SCALE, SCALE);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = colors.bg;
    ctx.fillRect(0, 0, WIDTH, height);
    roundedRect(ctx, 0.5, 0.5, WIDTH - 1, height - 1, 20, null, colors.border);

    // Author: the same softly squared artwork and hierarchy as the account card.
    const avatarTop = PADDING + Math.max(0, (headerHeight - 56) / 2);
    roundedRect(ctx, PADDING, avatarTop, 56, 56, 11, colors.soft);
    if (avatar) {
        ctx.save();
        ctx.beginPath();
        ctx.roundRect(PADDING, avatarTop, 56, 56, 11);
        ctx.clip();
        drawContainedImage(ctx, avatar, PADDING, avatarTop, 56, 56);
        ctx.restore();
    } else {
        ctx.font = `600 24px ${FONT}`;
        ctx.fillStyle = colors.accent;
        ctx.textAlign = 'center';
        ctx.fillText(graphemes(name)[0]?.toUpperCase() || '?', PADDING + 28, avatarTop + 36);
        ctx.textAlign = 'left';
    }
    drawLines(ctx, nameLines, PADDING + 72, PADDING, nameFont, colors.text, 28);
    drawLines(ctx, [`@${data.screenName || 'unknown'}`], PADDING + 72, PADDING + nameLines.length * 28 + 3,
        `14px ${FONT}`, colors.dim, 20);
    drawLines(ctx, bodyLines, PADDING, bodyTop, bodyFont, colors.text, 28);

    for (const cell of media) {
        roundedRect(ctx, cell.x, cell.y, cell.width, cell.height, 12, colors.panel);
        if (cell.photo) {
            ctx.save();
            ctx.beginPath();
            ctx.roundRect(cell.x, cell.y, cell.width, cell.height, 12);
            ctx.clip();
            drawContainedImage(ctx, cell.photo, cell.x, cell.y, cell.width, cell.height);
            ctx.restore();
        } else {
            ctx.font = smallFont;
            ctx.fillStyle = colors.dim;
            ctx.textAlign = 'center';
            ctx.fillText('Photo unavailable', cell.x + cell.width / 2, cell.y + cell.height / 2 + 4);
            ctx.textAlign = 'left';
        }
        roundedRect(ctx, cell.x + 0.5, cell.y + 0.5, cell.width - 1, cell.height - 1, 12, null, colors.border);
    }
    if (mediaNotice) drawLines(ctx, [mediaNotice], PADDING, mediaNoticeTop, tinyFont, colors.dim, 18);

    if (postDate) drawLines(ctx, [postDate], PADDING, metaTop, tinyFont, colors.dim, 20);
    for (const item of metrics) {
        if (item.icon) ctx.drawImage(item.icon, item.x, item.y + 2, 16, 16);
        drawLines(ctx, item.lines, item.x + 20, item.y, smallFont, colors.dim, 20);
    }

    // One compact, balanced account-context strip; no technical metadata table.
    roundedRect(ctx, PADDING, contextTop, CONTENT_WIDTH, contextHeight, 14, contextColors.bg, contextColors.border);
    const valueTop = contextTop + 45;
    const dividerX = PADDING + columnWidth;
    ctx.beginPath();
    ctx.moveTo(dividerX, contextTop + 20);
    ctx.lineTo(dividerX, contextTop + columnsHeight - 20);
    ctx.strokeStyle = contextColors.border;
    ctx.stroke();
    drawLines(ctx, ['Location reported by X'], PADDING + 20, contextTop + 17, tinyFont, contextColors.accent, 17);
    drawLines(ctx, ['Connected via'], dividerX + 20, contextTop + 17, tinyFont, contextColors.accent, 17);
    if (flag || locationIcon) ctx.drawImage(flag || locationIcon, PADDING + 20, valueTop, 24, 24);
    if (sourceIcon) ctx.drawImage(sourceIcon, dividerX + 20, valueTop, 24, 24);
    drawLines(ctx, locationLines, PADDING + 54, valueTop, valueFont, colors.text, 23);
    drawLines(ctx, deviceLines, dividerX + 54, valueTop, valueFont, colors.text, 23);
    if (warning) {
        const warningTop = contextTop + columnsHeight + 12;
        ctx.beginPath();
        ctx.moveTo(PADDING + 20, contextTop + columnsHeight);
        ctx.lineTo(WIDTH - PADDING - 20, contextTop + columnsHeight);
        ctx.strokeStyle = contextColors.border;
        ctx.stroke();
        if (warningIcon) ctx.drawImage(warningIcon, PADDING + 20, warningTop + 2, 16, 16);
        drawLines(ctx, warningLines, PADDING + 44, warningTop, smallFont, colors.warning, 19);
    }

    drawLines(ctx, urlLines, PADDING, urlTop, smallFont, colors.dim, 19);
    if (logo) ctx.drawImage(logo, PADDING, footerTop, 24, 24);
    drawLines(ctx, ['X-Posed'], PADDING + 30, footerTop + 3, `600 13px ${FONT}`, colors.accent, 18);
    if (version) drawLines(ctx, [version], PADDING + brandWidth + 8, footerTop + 4, tinyFont, colors.dim, 18);
    drawLines(ctx, [captureLabel], stackedFooter ? PADDING : WIDTH - PADDING - captureWidth,
        footerTop + (stackedFooter ? 31 : 4), tinyFont, colors.dim, 18);
    return canvas;
}
