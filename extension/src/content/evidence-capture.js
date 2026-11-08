/**
 * Capture an immutable post snapshot and share its Graphite post card.
 * Preview, clipboard, native share and download all use the same image.
 */

import { VERSION } from '../shared/constants.js';
import { createPostCardCanvas as createEvidenceCanvas } from './post-card.js';
import { glyph } from '../content/icons.js';
import { dialogIcon } from './dialog-icons.js';
import browserAPI from '../shared/browser-api.js';
import { showToast, dismissToast } from './notifications.js';
import { extractCaptureSnapshot } from './capture-snapshot.js';
import { statusIdOf } from './post-identity.js';

let activeCapture = null;

/** Cancel unfinished rendering and release the Share sheet's focus listeners. */
export function cleanupEvidenceCapture() {
    cancelPendingCapture();
    activeShareSheet?.close(false);
}

function cancelPendingCapture() {
    if (!activeCapture) return;
    const previous = activeCapture;
    activeCapture = null;
    previous.controller.abort();
    dismissToast(previous.toast, { immediate: true });
}

/**
 * Capture the post belonging to the clicked badge, not a nearby quoted account.
 * The immutable snapshot is taken before images load or X can recycle the DOM.
 * @param {HTMLElement} tweetElement
 * @param {Object} userInfo
 * @param {string} screenName
 * @param {HTMLElement|null} sourceAuthor
 */
export async function captureEvidence(tweetElement, userInfo, screenName, sourceAuthor = null) {
    cancelPendingCapture();
    const job = { controller: new AbortController(), toast: null };
    activeCapture = job;
    const signal = job.controller.signal;
    try {
        const snapshot = Object.freeze({
            ...extractCaptureSnapshot(tweetElement, screenName, sourceAuthor),
            location: typeof userInfo?.location === 'string' && userInfo.location ? userInfo.location : 'Unknown',
            device: typeof userInfo?.device === 'string' && userInfo.device ? userInfo.device : 'Unknown',
            locationAccurate: userInfo?.locationAccurate,
            captureTime: new Date().toISOString(),
            version: VERSION
        });
        job.toast = showToast({ message: 'Capturing evidence…', iconType: 'info',
            duration: 0, loading: true, dismissible: false });
        const canvas = await createEvidenceCanvas(snapshot, signal);
        if (activeCapture !== job || signal.aborted) return;
        showShareSheet(canvas, {
            screenName: snapshot.screenName,
            tweetUrl: snapshot.tweetUrl,
            location: snapshot.location
        });
    } catch (error) {
        if (activeCapture !== job || signal.aborted) return;
        console.error('X-Posed: Evidence capture failed:', error);
        showErrorNotification(error.message || 'Failed to capture this post. Try again.');
    } finally {
        dismissToast(job.toast, { immediate: true });
        if (activeCapture === job) activeCapture = null;
    }
}

// ---- share sheet: quote / reply / post with the evidence image ----

// Touch / no-hover devices (e.g. Firefox for Android) use the native share sheet.
const TOUCH = !(typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(hover: hover)').matches);
let lastShareMode = 'quote';
let activeShareSheet = null;

// Synchronous data-URL -> Blob so clipboard write / window.open / share can all
// fire inside the click gesture (an async toBlob would trip popup + clipboard guards).
function dataUrlToBlob(dataUrl) {
    const parts = dataUrl.split(',');
    const mime = (/:(.*?);/.exec(parts[0]) || [])[1] || 'image/png';
    const bin = atob(parts[1]);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
}

// Initiated synchronously within a gesture; resolves true if the image landed.
function copyImage(blob) {
    try {
        if (navigator.clipboard && window.ClipboardItem) {
            return navigator.clipboard.write([new window.ClipboardItem({ 'image/png': blob })])
                .then(() => true).catch(() => false);
        }
    } catch (_) { /* clipboard unavailable */ }
    return Promise.resolve(false);
}

// X's official compose intent. Quote = caption + their tweet URL (X embeds it as a
// quote); Reply = caption under their post; New = a standalone post.
function buildIntentUrl(mode, caption, tweetUrl, statusId, screenName) {
    const p = new URLSearchParams();
    let text = caption || '';
    if (mode === 'reply' && statusId) {
        p.set('in_reply_to', statusId);
    } else if (mode === 'quote' && tweetUrl) {
        p.set('url', tweetUrl);
    } else if (mode === 'post' && screenName) {
        // "New post" is a standalone tweet that mentions the account. The @handle goes
        // at the end (not leading) so X does not treat the post as a reply.
        text = `${text} @${screenName}`.trim();
    }
    p.set('text', text);
    return 'https://x.com/intent/post?' + p.toString();
}

function defaultCaption(location) {
    const where = location && location !== 'Unknown' ? location : null;
    return where
        ? `X lists this account’s location as ${where}. (via X-Posed)`
        : 'Account information reported by X. (via X-Posed)';
}

/**
 * Show the share sheet: preview the evidence image, edit a caption, and post it to
 * X as a quote / reply / new post (or copy / save). Replaces the old save-only
 * evidence modal; the post-card renderer supplies the shared immutable canvas.
 */
function showShareSheet(canvas, info) {
    const ce = (tag, cls, txt) => {
        const n = document.createElement(tag);
        if (cls) n.className = cls;
        if (typeof txt === 'string') n.textContent = txt;
        return n;
    };

    const statusId = statusIdOf(info.tweetUrl);
    const filename = generateFilename(info.screenName);

    // Encode the (immutable) rendered canvas once; preview, zoom, clipboard, share, and
    // save all reuse this single data URL instead of re-running toDataURL each time.
    const previewDataUrl = canvas.toDataURL('image/png');
    const blob = dataUrlToBlob(previewDataUrl);
    const returnFocus = activeShareSheet ? activeShareSheet.returnFocus : document.activeElement;
    activeShareSheet?.close(false);
    let closed = false;
    let pending = false;
    let copying = false;
    let zoom = null;

    const overlay = ce('div', 'x-share-overlay');
    const sheet = ce('div', 'x-share-sheet');
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-labelledby', 'x-share-title');
    sheet.tabIndex = -1;

    const head = ce('div', 'x-share-head');
    const htitle = ce('div', 'x-share-title');
    const heading = ce('h2', null, 'Share evidence');
    heading.id = 'x-share-title';
    htitle.append(heading, ce('p', 'x-share-subtitle', `Account information for @${info.screenName}`));
    const closeBtn = ce('button', 'x-share-close');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Close share evidence');
    closeBtn.appendChild(dialogIcon('close', 18));
    head.append(htitle, closeBtn);

    const previewColumn = ce('div', 'x-share-preview-column');
    const sectionHead = ce('div', 'x-share-section-head');
    sectionHead.append(ce('h3', null, 'Evidence image'), ce('span', null, 'PNG'));
    const preview = ce('button', 'x-share-preview');
    preview.type = 'button';
    preview.setAttribute('aria-label', 'Enlarge evidence preview');
    const img = ce('img');
    img.src = previewDataUrl;
    img.alt = `Evidence image for @${info.screenName}`;
    preview.appendChild(img);
    const zoomHint = ce('span', 'x-share-zoomhint');
    zoomHint.append(glyph('zoom', 15), ce('span', null, 'Enlarge preview'));
    preview.appendChild(zoomHint);
    preview.addEventListener('click', () => {
        if (zoom || closed) return;
        zoom = ce('div', 'x-share-zoom');
        zoom.setAttribute('role', 'dialog');
        zoom.setAttribute('aria-modal', 'true');
        zoom.setAttribute('aria-label', 'Enlarged evidence image');
        zoom.tabIndex = -1;
        const big = ce('img');
        big.src = previewDataUrl;
        big.alt = img.alt;
        const zoomClose = ce('button', 'x-share-zoom-close');
        zoomClose.type = 'button';
        zoomClose.setAttribute('aria-label', 'Close enlarged preview');
        zoomClose.appendChild(dialogIcon('close', 20));
        zoomClose.addEventListener('click', () => closeZoom());
        zoom.append(big, zoomClose);
        zoom.addEventListener('click', event => {
            event.stopPropagation();
            if (event.target === zoom || event.target === big) closeZoom();
        });
        sheet.inert = true;
        document.body.appendChild(zoom);
        zoomClose.focus({ preventScroll: true });
    });

    const exports = ce('div', 'x-share-exports');
    const copyBtn = ce('button', 'x-share-ghost');
    copyBtn.type = 'button';
    copyBtn.append(glyph('copy', 16), ce('span', null, 'Copy image'));
    const saveBtn = ce('button', 'x-share-ghost');
    saveBtn.type = 'button';
    saveBtn.append(glyph('save', 16), ce('span', null, 'Save PNG'));
    exports.append(copyBtn, saveBtn);
    previewColumn.append(sectionHead, preview, exports);

    const capWrap = ce('div', 'x-share-capwrap');
    const capLabel = ce('label', 'x-share-caplbl', 'Caption');
    capLabel.htmlFor = 'x-share-caption';
    const cap = ce('textarea', 'x-share-cap');
    cap.id = 'x-share-caption';
    cap.maxLength = 280;
    cap.rows = 4;
    cap.value = defaultCaption(info.location).slice(0, 280);
    cap.setAttribute('aria-describedby', 'x-share-caption-meta');
    const capMeta = ce('div', 'x-share-capmeta');
    capMeta.id = 'x-share-caption-meta';
    const count = ce('span', 'x-share-count');
    const updCount = () => { count.textContent = `${cap.value.length} / 280`; };
    cap.addEventListener('input', updCount);
    updCount();
    capWrap.appendChild(cap);
    capMeta.append(ce('span', null, 'Edit before continuing'), count);
    const captionGroup = ce('div', 'x-share-caption-group');
    captionGroup.append(capLabel, capWrap, capMeta);

    const modeWrap = ce('fieldset', 'x-share-modes');
    modeWrap.hidden = TOUCH;
    modeWrap.appendChild(ce('legend', 'x-share-modelbl', 'Share as'));
    const seg = ce('div', 'x-share-seg');
    const MODES = [
        { key: 'quote', label: 'Quote', desc: 'Opens an X draft with the original post linked for quoting.' },
        { key: 'reply', label: 'Reply', desc: 'Opens an X reply draft under the original post.' },
        { key: 'post', label: 'New post', desc: 'Opens a new X draft mentioning this account.' }
    ];
    const desc = ce('div', 'x-share-desc');
    desc.id = 'x-share-mode-description';
    modeWrap.setAttribute('aria-describedby', desc.id);
    const radios = [];
    let mode = MODES.some(m => m.key === lastShareMode) ? lastShareMode : 'quote';
    const selectMode = key => {
        mode = key;
        lastShareMode = key;
        radios.forEach(radio => { radio.checked = radio.value === key; });
        desc.textContent = MODES.find(item => item.key === key).desc;
    };
    MODES.forEach(item => {
        const label = ce('label', 'x-share-mode');
        const radio = ce('input');
        radio.type = 'radio';
        radio.name = 'x-share-mode';
        radio.value = item.key;
        radio.addEventListener('change', () => { if (radio.checked) selectMode(item.key); });
        label.append(radio, ce('span', null, item.label));
        radios.push(radio);
        seg.appendChild(label);
    });
    modeWrap.append(seg, desc);
    selectMode(mode);

    const shareBtn = ce('button', 'x-share-primary');
    shareBtn.type = 'button';
    shareBtn.append(glyph(TOUCH ? 'share' : 'xLogo', 17), ce('span', null, TOUCH ? 'Share image' : 'Continue to X'));
    const feedback = ce('div', 'x-share-feedback');
    feedback.setAttribute('role', 'status');
    feedback.hidden = true;
    const guide = ce('div', 'x-share-guide');
    guide.append(dialogIcon('infoCircle', 16), ce('p', null, TOUCH
        ? 'Your device’s share sheet chooses the destination. Select X or another app and review before sharing. Location may be approximate.'
        : 'Continue copies the PNG and opens an X draft. Paste the image with Ctrl/⌘+V, review it, then post. Location may be approximate.'));
    const sbody = ce('div', 'x-share-body');
    const side = ce('div', 'x-share-side');
    side.append(modeWrap, captionGroup, guide);
    sbody.append(previewColumn, side);
    const footer = ce('div', 'x-share-footer');
    footer.append(ce('p', 'x-share-footnote', 'Nothing is posted automatically.'), shareBtn);
    sheet.append(head, sbody, feedback, footer);
    overlay.appendChild(sheet);

    function closeZoom(restoreFocus = true) {
        if (!zoom) return;
        zoom.remove();
        zoom = null;
        sheet.inert = false;
        if (restoreFocus && !closed) preview.focus({ preventScroll: true });
    }
    function close(restoreFocus = true) {
        if (closed) return;
        closed = true;
        closeZoom(false);
        overlay.remove();
        document.removeEventListener('keydown', onKey, true);
        document.removeEventListener('focusin', onFocus, true);
        if (activeShareSheet?.overlay === overlay) activeShareSheet = null;
        if (restoreFocus && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    }
    function focusables(root) {
        return Array.from(root.querySelectorAll('button:not([disabled]), textarea:not([disabled]), input:not([disabled]), [tabindex="0"]'))
            .filter(node => node.getClientRects().length > 0 && !node.closest('[hidden]') &&
                (node.type !== 'radio' || node.checked));
    }
    function onFocus(event) {
        const root = zoom || sheet;
        if (!closed && !root.contains(event.target)) (focusables(root)[0] || root).focus({ preventScroll: true });
    }
    function onKey(e) {
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            if (zoom) closeZoom();
            else close();
        } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !zoom) {
            e.preventDefault();
            e.stopPropagation();
            doShare();
        } else if (e.key === 'Tab') {
            const root = zoom || sheet;
            const items = focusables(root);
            const first = items[0] || root;
            const last = items[items.length - 1] || root;
            if (!root.contains(document.activeElement) || document.activeElement === root ||
                (e.shiftKey ? document.activeElement === first : document.activeElement === last)) {
                e.preventDefault();
                (e.shiftKey ? last : first).focus({ preventScroll: true });
            }
        }
    }
    closeBtn.addEventListener('click', () => close());
    overlay.addEventListener('click', event => {
        event.stopPropagation();
        if (event.target === overlay) close();
    });
    function report(message, tone = 'success') {
        if (closed) return;
        feedback.textContent = message;
        feedback.dataset.tone = tone;
        feedback.hidden = false;
    }
    function setPending(value) {
        pending = value;
        shareBtn.disabled = value || copying;
        copyBtn.disabled = value || copying;
        shareBtn.setAttribute('aria-busy', String(value));
    }

    const saveImage = () => {
        if (closed) return;
        const link = document.createElement('a');
        link.download = filename;
        link.href = previewDataUrl;
        document.body.appendChild(link);
        link.click();
        link.remove();
    };
    function nativeFailure(error) {
        if (closed) return;
        setPending(false);
        if (error?.name === 'AbortError') {
            report('Sharing cancelled. Your image is still here.', 'warning');
            return;
        }
        saveImage();
        report('Sharing was unavailable. A PNG download was requested. Attach it manually, or use Save PNG if the download did not start.', 'warning');
    }

    // Clipboard, window.open and native share are invoked before any await, while
    // the initiating click or keyboard gesture still provides user activation.
    function doShare() {
        if (closed || pending || copying || zoom) return;
        setPending(true);
        const caption = cap.value;
        if (TOUCH) {
            try {
                const file = new File([blob], filename, { type: 'image/png' });
                if (navigator.share && navigator.canShare?.({ files: [file] })) {
                    Promise.resolve(navigator.share({ files: [file], text: caption + (info.tweetUrl ? ' ' + info.tweetUrl : '') }))
                        .then(() => close(), nativeFailure);
                } else nativeFailure();
            } catch (error) {
                nativeFailure(error);
            }
            return;
        }

        const clip = copyImage(blob);
        let win = null;
        try {
            win = window.open(buildIntentUrl(mode, caption, info.tweetUrl, statusId, info.screenName), '_blank');
            if (win) win.opener = null;
        } catch { /* Treat browser-denied opens as blocked pop-ups. */ }
        clip.then(copied => {
            if (closed) return;
            if (win && copied) {
                // Only a successful image copy plus a real composer window may
                // produce the reminder in the destination tab.
                try {
                    Promise.resolve(browserAPI.storage.local.set({ xpPasteHint: Date.now() })).catch(() => {});
                } catch { /* The draft and clipboard remain usable without a reminder. */ }
                close();
            } else if (!win) {
                report(copied
                    ? 'The image was copied, but the X window was blocked. Allow pop-ups and try again, or open an X draft and paste with Ctrl/⌘+V.'
                    : 'The X window and image copy were blocked. Allow pop-ups and try again, or use Save PNG to attach the image manually.', 'warning');
            } else {
                report('The X draft opened, but image copy was blocked. Use Copy image to retry, or Save PNG and attach the file in your draft.', 'warning');
            }
            if (!closed) setPending(false);
        });
    }

    shareBtn.addEventListener('click', doShare);
    copyBtn.addEventListener('click', () => {
        if (closed || pending || copying) return;
        copying = true;
        setPending(false);
        copyBtn.setAttribute('aria-busy', 'true');
        copyImage(blob).then(ok => {
            copying = false;
            if (closed) return;
            setPending(false);
            copyBtn.setAttribute('aria-busy', 'false');
            report(ok ? 'Image copied. Paste it into your draft with Ctrl/⌘+V.'
                : 'Your browser blocked image copy. Use Save PNG and attach the file instead.', ok ? 'success' : 'warning');
        });
    });
    saveBtn.addEventListener('click', () => {
        saveImage();
        report(`PNG download started: ${filename}`);
    });

    activeShareSheet = { overlay, close, returnFocus };
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('focusin', onFocus, true);
    cap.focus({ preventScroll: true });
}

/**
 * Generate evidence filename
 */
function generateFilename(screenName) {
    const date = new Date();
    const dateStr = date.toISOString().split('T')[0];
    const timeStr = date.toTimeString().split(' ')[0].replace(/:/g, '-');
    return `evidence_${screenName}_${dateStr}_${timeStr}.png`;
}

/**
 * Show error notification
 */
function showErrorNotification(message) {
    showToast({ title: 'Capture unavailable', message, iconType: 'error', duration: 3000 });
}
