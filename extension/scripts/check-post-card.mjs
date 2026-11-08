/**
 * Exercise the production post-card renderer with Canvas/Image doubles.
 * No browser session, network, clipboard, downloads or image dependencies.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
const graphemes = value => [...segmenter.segment(String(value))].map(item => item.segment);
const canvases = [];
const imageRequests = [];
let theme = 'dark';

class CanvasContext {
    constructor(canvas) {
        this.canvas = canvas;
        this.font = '16px sans-serif';
        this.textBaseline = 'alphabetic';
        this.textAlign = 'start';
        this.fillStyle = '#000000';
        this.strokeStyle = '#000000';
        this.operations = [];
        this.saved = [];
    }
    measureText(value) {
        const size = Number(/([\d.]+)px/.exec(this.font)?.[1] || 16);
        const width = graphemes(value).reduce((sum, part) => sum +
            (/^\s+$/.test(part) ? 0.3 : /[\u2e80-\u9fff]|\p{Extended_Pictographic}/u.test(part) ? 1 : 0.55) * size, 0);
        return { width, actualBoundingBoxAscent: size * 0.8, actualBoundingBoxDescent: size * 0.2 };
    }
    fillText(text, x, y, maxWidth) {
        assert.equal(typeof text, 'string');
        assert.ok(Number.isFinite(x) && Number.isFinite(y), `Finite text coordinates: ${text}`);
        this.operations.push({ type: 'text', text, x, y, maxWidth, font: this.font,
            color: this.fillStyle, align: this.textAlign, baseline: this.textBaseline });
    }
    drawImage(image, ...coordinates) { this.operations.push({ type: 'image', src: image.src, coordinates }); }
    fillRect(x, y, width, height) { this.operations.push({ type: 'rect', x, y, width, height, color: this.fillStyle }); }
    save() { this.saved.push({ font: this.font, fillStyle: this.fillStyle, strokeStyle: this.strokeStyle,
        textAlign: this.textAlign, textBaseline: this.textBaseline }); }
    restore() { Object.assign(this, this.saved.pop() || {}); }
    createLinearGradient() { return { addColorStop() {} }; }
    beginPath() {} closePath() {} moveTo() {} lineTo() {} arcTo() {}
    quadraticCurveTo() {} bezierCurveTo() {} rect() {} roundRect() {} arc() {} ellipse() {}
    fill() {} stroke() {} clip() {} clearRect() {} strokeRect() {}
    scale() {} translate() {} rotate() {} transform() {} setTransform() {} resetTransform() {}
    setLineDash() {}
}

class Canvas {
    constructor() { this.width = 300; this.height = 150; this.context = new CanvasContext(this); canvases.push(this); }
    getContext(type) { assert.equal(type, '2d'); return this.context; }
}

class TestImage {
    constructor() { this.width = 640; this.height = 400; this.naturalWidth = 640; this.naturalHeight = 400; }
    get src() { return this.source || ''; }
    set src(value) {
        this.source = value;
        if (!value) return;
        imageRequests.push(value);
        if (value.includes('pending')) return;
        queueMicrotask(() => {
            if (this.source !== value) return;
            if (value.includes('fail')) this.onerror?.(new Error('Unavailable test image'));
            else this.onload?.();
        });
    }
    removeAttribute(name) { if (name === 'src') this.source = ''; }
    async decode() {}
}

class SVGNode {
    constructor(tag) { this.tagName = tag; this.attributes = new Map(); this.children = []; this.style = {}; }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    removeAttribute(name) { this.attributes.delete(name); }
    appendChild(child) { this.children.push(child); return child; }
    append(...children) { this.children.push(...children); }
    querySelectorAll() { return this.children.flatMap(child => [child, ...child.querySelectorAll()]); }
    cloneNode(deep) {
        const node = new SVGNode(this.tagName); node.attributes = new Map(this.attributes);
        if (deep) node.children = this.children.map(child => child.cloneNode(true));
        return node;
    }
}

globalThis.Image = TestImage;
globalThis.XMLSerializer = class {
    serializeToString(node) {
        return `<${node.tagName} ${[...node.attributes].map(([key, value]) => `${key}="${value}"`).join(' ')}>` +
            node.children.map(child => this.serializeToString(child)).join('') + `</${node.tagName}>`;
    }
};
globalThis.Path2D = class {
    constructor(path) { this.path = path; }
    moveTo() {} lineTo() {} closePath() {} rect() {} arc() {}
    quadraticCurveTo() {} bezierCurveTo() {} addPath() {}
};
globalThis.document = {
    documentElement: { getAttribute: name => name === 'data-x-theme' ? theme : null },
    fonts: { ready: Promise.resolve(), load: async () => [] },
    createElementNS: (_namespace, tag) => new SVGNode(tag),
    createElement: type => { assert.equal(type, 'canvas'); return new Canvas(); }
};
globalThis.window = { devicePixelRatio: 2 };
globalThis.browser = { runtime: { getURL: path => `moz-extension://test/${path}` } };
globalThis.fetch = () => { throw new Error('Post cards must not make API requests'); };

const { createPostCardCanvas, wrapCardText, formatCardDate } = await import('../src/content/post-card.js');
const FONT = '18px "Segoe UI", sans-serif';
const fixture = overrides => ({
    screenName: 'm_yudysky', displayName: 'Matt Yudysky',
    profileImageUrl: 'https://pbs.twimg.com/profile_images/1/avatar_bigger.jpg',
    tweetText: 'A thoughtful post.\n\nA second paragraph, with context worth preserving.',
    mediaUrls: [], metrics: { replies: '1', retweets: null, likes: '12', views: '551' },
    timestamp: '2026-10-17T12:00:00.000Z', captureTime: '2026-10-17T13:55:27.123Z',
    location: 'United States', device: 'United States Android App', locationAccurate: true,
    tweetUrl: 'https://x.com/i/status/2111292050532335953', version: '4.3.0',
    ...overrides
});
const drawn = canvas => canvas.context.operations.filter(operation => operation.type === 'text');
const visibleText = canvas => drawn(canvas).map(operation => operation.text).join('\n');
const compact = value => String(value).replace(/\s/g, '');
let groups = 0;
async function check(name, run) { await run(); groups++; console.log(`PASS ${name}`); }

await check('Wrapping preserves paragraph breaks and does not silently cap the post', () => {
    const context = new Canvas().context;
    const body = 'First paragraph.\n\nSecond paragraph.\n' + 'A sentence worth keeping. '.repeat(180);
    const lines = wrapCardText(context, body, 240, FONT);
    assert.ok(lines.includes(''), 'Keep the intentional empty paragraph');
    assert.ok(lines.length > 50, 'Do not truncate to a small number of lines');
    assert.equal(compact(lines.join('')), compact(body));
    for (const line of lines) assert.ok(context.measureText(line).width <= 240.01, line);
});

await check('Long URLs, CJK and emoji remain complete and grapheme-safe', () => {
    const context = new Canvas().context;
    for (const body of [
        'https://example.test/' + 'path-'.repeat(60) + '?source=the-complete-original',
        '地理的な文脈も元の投稿も大切です。'.repeat(12),
        '👩🏽‍💻'.repeat(20),
        'e\u0301'.repeat(100)
    ]) {
        const lines = wrapCardText(context, body, 120, FONT);
        assert.equal(lines.join(''), body);
        assert.deepEqual(lines.flatMap(graphemes), graphemes(body), 'Never split a cluster between lines');
        for (const line of lines) assert.ok(context.measureText(line).width <= 120.01, line);
    }
    assert.equal(wrapCardText(context, '', 120, FONT).join(''), '');
    assert.equal(wrapCardText(context, '👩🏽‍💻', 1, FONT).join(''), '👩🏽‍💻', 'An overwide single cluster still terminates intact');
});

await check('UTC dates distinguish posted and captured time without millisecond fragments', () => {
    assert.equal(formatCardDate('2026-10-17T13:55:27.123Z'), '17 Oct 2026 · 13:55 UTC');
    assert.equal(formatCardDate('2026-10-17T13:55:27.123Z', { seconds: true }), '17 Oct 2026 · 13:55:27 UTC');
    assert.equal(formatCardDate('2026-10-17T15:55:27+02:00', { seconds: true }), '17 Oct 2026 · 13:55:27 UTC');
    for (const invalid of [null, undefined, '', '1h', 'Oct 13', 'not a date', '2026-99-99T00:00:00Z',
        '2026-10-17T13:55', '2026-10-17T13:55:27.123']) {
        assert.equal(formatCardDate(invalid), '', String(invalid));
    }
});

await check('The actual card draws complete author, body, account context and source', async () => {
    const data = fixture();
    const before = JSON.stringify(data);
    const canvas = await createPostCardCanvas(data);
    assert.ok(canvas instanceof Canvas);
    assert.equal(canvas.width, 1280, 'A crisp 2× 640px card');
    assert.ok(canvas.height > 0 && canvas.height <= 8192);
    assert.ok(canvas.width * canvas.height <= 12_000_000);
    const text = compact(visibleText(canvas));
    for (const expected of [data.displayName, `@${data.screenName}`, data.tweetText, data.location, data.device,
        data.tweetUrl.replace(/^https:\/\//, ''), '17 Oct 2026 · 12:00 UTC', '17 Oct 2026 · 13:55:27 UTC']) {
        assert.ok(text.includes(compact(expected)), `Draw the complete field: ${expected}`);
    }
    assert.equal(JSON.stringify(data), before, 'Never mutate the immutable capture snapshot');
    assert.ok(!visibleText(canvas).includes('EVIDENCE CAPTURE'), 'The old report header is not carried over');
    for (const operation of drawn(canvas)) {
        assert.ok(operation.y >= 0 && operation.y <= canvas.height / 2, `Text stays within the exported card: ${operation.text}`);
    }
});

await check('Long author names, connection sources and full permalinks wrap rather than truncate', async () => {
    const data = fixture({
        displayName: 'A very long display name with meaningful words and emoji 👩🏽‍💻 repeated '.repeat(3),
        location: 'A very long location label that must remain readable without cropping',
        device: 'A long connection source label with every original word still present '.repeat(3),
        tweetUrl: 'https://x.com/long_handle_123/status/2111292050532335953?context=' + 'full-source-'.repeat(12),
        tweetText: 'https://example.test/' + 'a-long-original-path-'.repeat(25)
    });
    const canvas = await createPostCardCanvas(data);
    const text = compact(visibleText(canvas));
    for (const expected of [data.displayName, data.location, data.device, data.tweetText, data.tweetUrl.replace(/^https:\/\//, '')]) {
        assert.ok(text.includes(compact(expected)), `Do not silently shorten: ${expected}`);
    }
});

await check('Uncertainty remains visible and missing metrics do not become invented zero counts', async () => {
    const canvas = await createPostCardCanvas(fixture({ locationAccurate: false,
        metrics: { replies: null, retweets: null, likes: null, views: null } }));
    assert.match(visibleText(canvas), /inaccurate|uncertain/i);
    assert.ok(!drawn(canvas).some(operation => operation.text === '0'), 'No invented metric values');
});

await check('Image failures retain a useful card and successful media keep their original ratio', async () => {
    const failed = await createPostCardCanvas(fixture({
        profileImageUrl: 'https://pbs.twimg.com/profile_images/1/fail_bigger.jpg',
        mediaUrls: ['https://pbs.twimg.com/media/fail.jpg']
    }));
    assert.match(visibleText(failed), /Matt Yudysky/);
    const source = 'https://pbs.twimg.com/media/original.jpg';
    const media = await createPostCardCanvas(fixture({ mediaUrls: [source] }));
    const paint = media.context.operations.find(operation => operation.type === 'image' && operation.src === source);
    assert.ok(paint, 'Render available media');
    const coordinates = paint.coordinates;
    if (coordinates.length === 4) assert.ok(Math.abs(coordinates[2] / coordinates[3] - 640 / 400) < 0.001,
        'Preserve media ratio instead of a content-losing cover crop');
    else if (coordinates.length === 8) assert.ok(Math.abs(coordinates[2] / coordinates[3] - 640 / 400) < 0.001,
        'Use the complete source rectangle');
    else assert.fail(`Unexpected drawImage geometry: ${coordinates.length}`);
});

await check('Light and dark cards use different native palettes and retain the same information', async () => {
    theme = 'dark'; const dark = await createPostCardCanvas(fixture());
    theme = 'light'; const light = await createPostCardCanvas(fixture()); theme = 'dark';
    assert.equal(visibleText(dark), visibleText(light));
    assert.notDeepEqual(dark.context.operations.filter(operation => operation.type === 'rect').map(operation => operation.color),
        light.context.operations.filter(operation => operation.type === 'rect').map(operation => operation.color));
});

await check('Account context uses the existing rose accent without recoloring values or warnings', async () => {
    try {
        for (const [mode, accent, valueColor, warningColor] of [
            ['dark', '#DF9BA8', '#ECF0F1', '#E7B36A'],
            ['light', '#99475C', '#20272A', '#85500D']
        ]) {
            theme = mode;
            const canvas = await createPostCardCanvas(fixture({ locationAccurate: false }));
            const text = drawn(canvas);
            for (const label of ['Location reported by X', 'Connected via']) {
                assert.equal(text.find(operation => operation.text === label)?.color, accent);
            }
            for (const value of ['United States', 'United States Android App']) {
                assert.equal(text.find(operation => operation.text === value)?.color, valueColor);
            }
            assert.equal(text.find(operation => operation.text.includes('may be inaccurate'))?.color, warningColor);
            assert.ok(canvas.context.operations.some(operation => operation.type === 'image' &&
                operation.src.includes('1f1fa-1f1f8.svg')), 'Keep the original flag artwork');
        }
    } finally { theme = 'dark'; }
});

await check('Connection icons keep their neutral color in both themes, independent of the rose panel', async () => {
    try {
        for (const [mode, neutral] of [['dark', '#A5AFB6'], ['light', '#5E6A70']]) {
            theme = mode;
            for (const device of ['United States App Store', 'United States Android App', 'Web', 'Unknown']) {
                const canvas = await createPostCardCanvas(fixture({ device }));
                const icon = canvas.context.operations.find(operation => operation.type === 'image' &&
                    operation.coordinates[0] === 340 && operation.coordinates[2] === 24);
                assert.ok(icon, `Keep the connection icon for ${device}`);
                const svg = decodeURIComponent(icon.src.slice(icon.src.indexOf(',') + 1));
                assert.ok(svg.includes(`color="${neutral}"`), `${mode}: ${device} must remain neutral`);
            }
        }
    } finally { theme = 'dark'; }
});

await check('Busy metric rows move below the posted date and preserve every displayed value', async () => {
    const metrics = { replies: '123,456,789', retweets: '234,567,890', likes: '345,678,901', views: '456,789,012' };
    const canvas = await createPostCardCanvas(fixture({ metrics }));
    const text = drawn(canvas);
    const publication = text.find(operation => operation.text.startsWith('Posted '));
    assert.ok(publication);
    for (const value of Object.values(metrics)) {
        const metric = text.find(operation => operation.text === value);
        assert.ok(metric, `Keep displayed metric ${value}`);
        assert.ok(metric.y > publication.y, 'Metrics cannot collide with the full publication timestamp');
        canvas.context.font = metric.font;
        assert.ok(metric.x + canvas.context.measureText(metric.text).width <= 608.01, 'Keep the metric inside the card');
    }
});

await check('The signature uses the actual logo and keeps provenance after the full source', async () => {
    const canvas = await createPostCardCanvas(fixture());
    const text = drawn(canvas);
    const source = text.find(operation => operation.text.includes('/status/'));
    const signature = text.find(operation => operation.text === 'X-Posed');
    const capture = text.find(operation => operation.text.startsWith('Captured '));
    assert.ok(source && signature && capture);
    assert.ok(signature.y > source.y && capture.y > source.y);
    assert.ok(text.some(operation => operation.text === 'v4.3.0'));
    assert.ok(canvas.context.operations.some(operation => operation.type === 'image' &&
        operation.src === 'moz-extension://test/icons/logo.svg'), 'Use the extension logo asset, not a substitute');
});

await check('Overlong exports fail explicitly before allocating an unsafe backing canvas', async () => {
    const start = canvases.length;
    await assert.rejects(createPostCardCanvas(fixture({ tweetText: 'A long post with all its original text. '.repeat(2500) })),
        error => error instanceof RangeError && /long|large|limit|size|safely/i.test(error.message));
    for (const canvas of canvases.slice(start)) {
        assert.ok(canvas.width <= 32767 && canvas.height <= 8192);
        assert.ok(canvas.width * canvas.height <= 12_000_000, 'No enormous canvas allocation before rejecting');
    }
});

await check('Pre-aborted captures do not request assets and reject with AbortError', async () => {
    const controller = new AbortController(); controller.abort();
    const start = imageRequests.length;
    await assert.rejects(createPostCardCanvas(fixture(), controller.signal), { name: 'AbortError' });
    assert.equal(imageRequests.length, start);
});

await check('Cancellation while an image is pending releases the renderer promptly', async () => {
    const controller = new AbortController();
    const work = createPostCardCanvas(fixture({ profileImageUrl: 'https://pbs.twimg.com/profile_images/1/pending_bigger.jpg' }), controller.signal);
    controller.abort();
    let deadline;
    try {
        await assert.rejects(Promise.race([work, new Promise((_resolve, reject) => {
            deadline = setTimeout(() => reject(new Error('Cancellation stalled')), 250);
        })]), { name: 'AbortError' });
    } finally { clearTimeout(deadline); }
});

await check('Image deadlines release a card with graceful fallbacks, without a real five-second wait', async () => {
    const scheduled = [];
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    globalThis.setTimeout = (callback, delay, ...args) => {
        if (delay !== 5000) return realSetTimeout(callback, delay, ...args);
        const timer = { postCardTestTimer: true, callback, args, cleared: false };
        scheduled.push(timer); return timer;
    };
    globalThis.clearTimeout = timer => {
        if (timer?.postCardTestTimer) timer.cleared = true;
        else realClearTimeout(timer);
    };
    try {
        const work = createPostCardCanvas(fixture({
            profileImageUrl: 'https://pbs.twimg.com/profile_images/1/pending_bigger.jpg',
            mediaUrls: ['https://pbs.twimg.com/media/pending.jpg']
        }));
        await Promise.resolve(); // Complete normal cached art; leave two pending raster images.
        const pending = scheduled.filter(timer => !timer.cleared);
        assert.equal(pending.length, 2);
        for (const timer of pending) timer.callback(...timer.args);
        const canvas = await work;
        assert.match(visibleText(canvas), /Matt Yudysky/);
        assert.match(visibleText(canvas), /Photo unavailable/);
        assert.ok(scheduled.every(timer => timer.cleared), 'Clear every deadline on success or failure');
    } finally {
        globalThis.setTimeout = realSetTimeout;
        globalThis.clearTimeout = realClearTimeout;
    }
});

await check('Capture entry uses the production renderer rather than a second stale layout', () => {
    const source = readFileSync(new URL('../src/content/evidence-capture.js', import.meta.url), 'utf8');
    const imported = /import\s*\{\s*createPostCardCanvas(?:\s+as\s+(\w+))?\s*\}\s*from\s*['"]\.\/post-card\.js['"]/.exec(source);
    assert.ok(imported, 'Import the production post-card renderer');
    assert.ok(new RegExp(`await ${imported[1] || 'createPostCardCanvas'}\\(snapshot, signal\\)`).test(source),
        'Use the new renderer with the immutable capture snapshot and abort signal');
    assert.ok(!/function createEvidenceCanvas\(/.test(source), 'Remove the stale duplicate renderer');
});

await check('Every literal shared dialog glyph used by the renderer exists in the icon set', () => {
    const source = readFileSync(new URL('../src/content/post-card.js', import.meta.url), 'utf8');
    const icons = readFileSync(new URL('../src/content/dialog-icons.js', import.meta.url), 'utf8');
    const keys = new Set([...icons.matchAll(/^\s{4}(\w+):/gm)].map(match => match[1]));
    for (const [, name] of source.matchAll(/dialogIcon\('([^']+)'/g)) {
        assert.ok(keys.has(name), `Use the actual ${name} glyph instead of the unknown-name shield fallback`);
    }
});

console.log(`\n${groups} post-card regression groups passed.`);
