/** Exercise the bundled MAIN-world chat observer with fake native transports. No network or browser login. */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { rollup } from 'rollup';

const bundle = await rollup({ input: fileURLToPath(new URL('../src/content/page-script.js', import.meta.url)) });
const { output } = await bundle.generate({ format: 'iife' });
await bundle.close();
const production = output[0].code;
const endpoint = 'https://api.x.com/graphql/query-id/GetUsersByIdsForXChat?variables=%7B%22ids%22%3A%5B%22222%22%5D%7D';
const responseFor = (id = '222', handle = 'example') => ({ data: { get_member_results: { results: [{
    status: 'Found', id, member_results: { rest_id: id, result: {
        __typename: 'User', rest_id: id, core: { screen_name: handle, name: 'Example' },
        chat_permissions: { can_dm: true, private_marker: 'DO_NOT_RELAY' },
        private_message: 'DO_NOT_RELAY', relationship_counts: { followers: 99 }
    } }
}] } } });

class Target {
    constructor() { this.listeners = new Map(); }
    addEventListener(type, callback, options = {}) {
        const entries = this.listeners.get(type) || [];
        entries.push({ callback, once: options?.once === true });
        this.listeners.set(type, entries);
    }
    dispatchEvent(event) {
        for (const entry of [...(this.listeners.get(event.type) || [])]) {
            if (entry.once) this.listeners.set(event.type, this.listeners.get(event.type).filter(item => item !== entry));
            entry.callback.call(this, event);
        }
    }
}

function harness() {
    const window = new Target();
    const document = { cookie: 'twid=u%3D111', querySelector: () => null };
    const nativeRequests = [];
    const events = [];
    const shadowCalls = [];
    const shadowEvents = [];
    class CustomEvent {
        constructor(type, init = {}) { this.type = type; this.detail = init.detail; }
    }
    class Response {
        constructor(data, { url = endpoint, status = 200 } = {}) {
            this.data = data; this.url = url; this.status = status;
        }
        async json() { return this.data; }
        async text() { return JSON.stringify(this.data); }
        clone() { return new Response(this.data, this); }
    }
    class XHR extends Target {
        open(method, url) { this.method = method; this.url = url; }
        setRequestHeader() {}
        send() {}
        finish(data, { url = this.url, status = 200, responseType = 'json', text } = {}) {
            this.responseURL = url; this.status = status; this.responseType = responseType;
            this.response = data; this.responseText = text ?? JSON.stringify(data);
            this.dispatchEvent({ type: 'loadend' });
        }
    }
    class Element {
        attachShadow(options) {
            shadowCalls.push({ host: this, args: [...arguments] });
            if (this.shadowError) throw this.shadowError;
            if (this.attachedRoot) throw new Error('Shadow already attached');
            const root = { mode: options.mode, private_marker: 'DO_NOT_RELAY_ROOT', host: this };
            this.attachedRoot = root;
            this.shadowRoot = root.mode === 'open' ? root : null;
            return root;
        }
    }
    window.fetch = (input, init) => new Promise(resolve => nativeRequests.push({ input, init, resolve }));
    window.addEventListener('x-posed-shadow-root-ready', event => shadowEvents.push(event));
    for (const type of ['x-posed-chat-users', 'x-posed-profiles', 'x-posed-headers-captured']) {
        window.addEventListener(type, event => events.push({ type, detail: JSON.parse(event.detail) }));
    }
    vm.runInNewContext(production, { window, document, location: new URL('https://x.com/i/chat/'),
        Response, XMLHttpRequest: XHR, CustomEvent, Headers, URL, console, Element,
        performance, setTimeout, clearTimeout, AbortController, fetch: window.fetch });
    const setting = (enabled, type = 'x-posed-set-chat') => window.dispatchEvent(new CustomEvent(type, {
        detail: JSON.stringify({ enabled })
    }));
    const start = (url = endpoint, init) => {
        const promise = window.fetch(url, init);
        return { promise, native: nativeRequests.at(-1) };
    };
    const reply = async (request, data = responseFor(), options = {}) => {
        request.native.resolve(new Response(data, options));
        const response = await request.promise;
        if (options.read !== false) await response.json();
        await new Promise(resolve => setTimeout(resolve, 0));
        return response;
    };
    return { window, document, Response, XHR, Element, shadowCalls, shadowEvents, setting, start, reply, nativeRequests, events,
        chats: () => events.filter(event => event.type === 'x-posed-chat-users') };
}

let groups = 0;
async function check(name, run) { await run(); groups++; console.log(`PASS ${name}`); }

await check('Late open shadow roots signal readiness without changing native arguments or returned roots', async () => {
    const h = harness(); h.setting(true);
    const host = new h.Element();
    const options = { mode: 'open', delegatesFocus: true };
    const extra = { untouched: true };
    const root = host.attachShadow(options, extra);
    assert.equal(root, host.shadowRoot);
    assert.equal(root.host, host);
    assert.equal(h.shadowCalls[0].host, host);
    assert.equal(h.shadowCalls[0].args[0], options);
    assert.equal(h.shadowCalls[0].args[1], extra);
    assert.equal(h.shadowEvents.length, 0, 'Return the native root before notifying observers');
    await Promise.resolve();
    assert.equal(h.shadowEvents.length, 1);
    assert.equal(h.shadowEvents[0].detail, undefined, 'The event must contain no DOM or identity payload');
    assert.equal(h.nativeRequests.length, 0);
});

await check('Closed roots remain closed, unexposed and unannounced', async () => {
    const h = harness(); h.setting(true);
    const host = new h.Element();
    const options = { mode: 'closed' };
    const root = host.attachShadow(options);
    assert.equal(root.mode, 'closed');
    assert.equal(options.mode, 'closed');
    assert.equal(host.shadowRoot, null);
    await Promise.resolve();
    assert.equal(h.shadowEvents.length, 0);
    assert.equal(h.events.length, 0);
});

await check('Native attachShadow failures and invalid receivers preserve their original exceptions', async () => {
    const h = harness(); h.setting(true);
    const host = new h.Element();
    const failure = new TypeError('native failure'); host.shadowError = failure;
    assert.throws(() => host.attachShadow({ mode: 'open' }), error => error === failure);
    assert.throws(() => h.Element.prototype.attachShadow.call(null, { mode: 'open' }), TypeError);
    await Promise.resolve();
    assert.equal(h.shadowEvents.length, 0);
});

await check('Open-root discovery notifications coalesce and respect Chat enable state', async () => {
    const h = harness();
    new h.Element().attachShadow({ mode: 'open' });
    await Promise.resolve(); assert.equal(h.shadowEvents.length, 0);
    h.setting(true);
    new h.Element().attachShadow({ mode: 'open' });
    new h.Element().attachShadow({ mode: 'open' });
    await Promise.resolve(); assert.equal(h.shadowEvents.length, 1);
    new h.Element().attachShadow({ mode: 'open' }); h.setting(false);
    await Promise.resolve(); assert.equal(h.shadowEvents.length, 1);
});

await check('Chat identity collection defaults off without affecting the native fetch result', async () => {
    const h = harness();
    const response = await h.reply(h.start());
    assert.equal(response.status, 200);
    assert.equal(h.nativeRequests.length, 1);
    assert.equal(h.chats().length, 0);
});

await check('Native fetch captures public IDs independently of disabled profile enrichment', async () => {
    const h = harness(); h.setting(true);
    await h.reply(h.start());
    assert.equal(h.chats().length, 1);
    assert.deepEqual(h.chats()[0].detail, { viewer: 'id:111', users: [{ u: 'example', i: '222' }] });
    assert.equal(h.events.filter(event => event.type !== 'x-posed-chat-users').length, 0);
    assert.equal(h.nativeRequests.length, 1, 'The observer must not request identities itself');
    assert.ok(!JSON.stringify(h.events).includes('DO_NOT_RELAY'));
});

const publicUserHeaders = { authorization: 'Bearer FAKE_TEST_AUTHORIZATION', 'x-csrf-token': 'FAKE_TEST_CSRF' };

await check('Direct Chat native fetch reuses normal init or Request headers without putting them in identities', async () => {
    for (const useRequest of [false, true]) {
        const h = harness(); h.setting(true);
        const input = useRequest ? new Request(endpoint, { headers: publicUserHeaders }) : endpoint;
        await h.reply(h.start(input, useRequest ? undefined : { headers: publicUserHeaders }));
        const captures = h.events.filter(event => event.type === 'x-posed-headers-captured');
        assert.equal(captures.length, 1);
        assert.deepEqual(captures[0].detail.headers, publicUserHeaders);
        assert.equal(h.nativeRequests.length, 1);
        assert.ok(!JSON.stringify(h.chats()).includes('FAKE_TEST'));
    }
});

await check('The native public-user header capture honors effective fetch init overrides', async () => {
    const h = harness(); h.setting(true);
    const input = new Request(endpoint, { headers: publicUserHeaders });
    await h.reply(h.start(input, { headers: { authorization: 'incomplete_override' } }));
    assert.equal(h.events.filter(event => event.type === 'x-posed-headers-captured').length, 0,
        'A Request header overridden by init is not a credential used for the request');
});

await check('Cold Chat header capture requires an enabled, verified GET operation and both auth headers', async () => {
    const scenarios = [
        { url: endpoint.replace('GetUsersByIdsForXChat', 'GetMessagesForXChat') },
        { url: endpoint.replace('api.x.com', 'api.x.com.evil.test') },
        { url: endpoint, method: 'POST' },
        { url: endpoint, enabled: false },
        { url: endpoint, viewer: '' },
        { url: endpoint, headers: { authorization: publicUserHeaders.authorization } },
        { url: endpoint, headers: { 'x-csrf-token': publicUserHeaders['x-csrf-token'] } }
    ];
    for (const scenario of scenarios) {
        const h = harness(); h.setting(scenario.enabled !== false);
        if (scenario.viewer !== undefined) h.document.cookie = scenario.viewer;
        await h.reply(h.start(scenario.url, { method: scenario.method || 'GET',
            headers: scenario.headers || publicUserHeaders }), responseFor(), { url: scenario.url });
        assert.equal(h.events.filter(event => event.type === 'x-posed-headers-captured').length, 0);
    }
});

await check('XHR reuses normal public-user auth headers but ignores private chat operations', async () => {
    for (const allowed of [true, false]) {
        const h = harness(); h.setting(true);
        const url = allowed ? endpoint : endpoint.replace('GetUsersByIdsForXChat', 'GetMessagesForXChat');
        const xhr = new h.XHR(); xhr.open('GET', url);
        for (const [name, value] of Object.entries(publicUserHeaders)) xhr.setRequestHeader(name, value);
        xhr.send(); xhr.finish(responseFor());
        const captures = h.events.filter(event => event.type === 'x-posed-headers-captured');
        assert.equal(captures.length, allowed ? 1 : 0);
        if (allowed) assert.deepEqual(captures[0].detail.headers, publicUserHeaders);
        assert.ok(!JSON.stringify(h.chats()).includes('FAKE_TEST'));
        assert.equal(h.nativeRequests.length, 0);
    }
});

await check('JSON tap and fetch fallback together emit each response only once', async () => {
    const h = harness(); h.setting(true);
    const response = await h.reply(h.start());
    await response.json(); await response.json();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(h.chats().length, 1);
});

await check('Enabling ordinary profile enrichment never routes chat permissions through profile harvesting', async () => {
    const h = harness(); h.setting(true); h.setting(true, 'x-posed-set-enrichment');
    await h.reply(h.start());
    const xhr = new h.XHR(); xhr.open('GET', endpoint); xhr.send(); xhr.finish(responseFor());
    assert.equal(h.chats().length, 2);
    assert.equal(h.events.filter(event => event.type !== 'x-posed-chat-users').length, 0);
});

await check('Fetch fallback works when X does not use Response.json', async () => {
    const h = harness(); h.setting(true);
    const response = await h.reply(h.start(), responseFor(), { read: false });
    assert.ok((await response.text()).includes('get_member_results'));
    assert.equal(h.chats().length, 1);
});

await check('Only the observed HTTPS public-user endpoint is captured', async () => {
    for (const url of [endpoint.replace('api.x.com', 'api.x.com.evil.test'),
        endpoint.replace('GetUsersByIdsForXChat', 'GetMessagesForXChat'),
        endpoint.replace('https:', 'http:'), endpoint.replace('api.x.com/graphql', 'x.com/i/api/graphql')]) {
        const h = harness(); h.setting(true);
        await h.reply(h.start(url), responseFor(), { url });
        assert.equal(h.chats().length, 0, url);
        assert.equal(h.nativeRequests.length, 1);
    }
});

await check('Failed responses, redirected operations and changed query paths are ignored', async () => {
    for (const options of [{ status: 401 }, { status: 429 }, { status: 500 },
        { url: endpoint.replace('GetUsersByIdsForXChat', 'GetMessagesForXChat') },
        { url: endpoint.replace('query-id', 'other-query') }]) {
        const h = harness(); h.setting(true);
        await h.reply(h.start(), responseFor(), options);
        assert.equal(h.chats().length, 0);
    }
});

await check('A disabled/re-enabled generation rejects its earlier pending response', async () => {
    const h = harness(); h.setting(true);
    const stale = h.start(); h.setting(false); h.setting(true);
    await h.reply(stale);
    assert.equal(h.chats().length, 0);
    await h.reply(h.start());
    assert.equal(h.chats().length, 1);
});

await check('A response started while disabled cannot be adopted by enabling later', async () => {
    const h = harness(); const stale = h.start(); h.setting(true);
    await h.reply(stale);
    assert.equal(h.chats().length, 0);
});

await check('Viewer changes reject earlier replies and new requests capture the new viewer', async () => {
    const h = harness(); h.setting(true); const stale = h.start();
    h.document.cookie = 'twid=u%3D333';
    await h.reply(stale);
    assert.equal(h.chats().length, 0);
    await h.reply(h.start());
    assert.equal(h.chats()[0].detail.viewer, 'id:333');
});

await check('An observed A-to-B-to-A switch cannot resurrect an A-generation response', async () => {
    const h = harness(); h.setting(true); const oldA = h.start();
    h.document.cookie = 'twid=u%3D333'; const pendingB = h.start();
    h.document.cookie = 'twid=u%3D111';
    await h.reply(oldA); await h.reply(pendingB);
    assert.equal(h.chats().length, 0);
    await h.reply(h.start());
    assert.equal(h.chats()[0].detail.viewer, 'id:111');
});

await check('Unknown viewers and unsupported request methods are not harvested', async () => {
    const h = harness(); h.setting(true); h.document.cookie = '';
    await h.reply(h.start());
    assert.equal(h.chats().length, 0);
    h.document.cookie = 'twid=u%3D111';
    await h.reply(h.start(endpoint, { method: 'POST' }));
    assert.equal(h.chats().length, 0);
});

await check('XHR JSON and text responses use the same narrow public identity relay', async () => {
    for (const responseType of ['json', '', 'text']) {
        const h = harness(); h.setting(true);
        const xhr = new h.XHR(); xhr.open('GET', endpoint); xhr.send();
        xhr.finish(responseFor(), { responseType });
        assert.equal(h.chats().length, 1);
        assert.deepEqual(h.chats()[0].detail.users, [{ u: 'example', i: '222' }]);
        assert.equal(h.nativeRequests.length, 0);
    }
});

await check('XHR failures, oversized text, reused requests and disabled generations remain silent', async () => {
    for (const options of [{ status: 403 }, { responseType: 'text', text: 'x'.repeat(8 * 1024 * 1024 + 1) },
        { responseType: 'blob' }]) {
        const h = harness(); h.setting(true);
        const xhr = new h.XHR(); xhr.open('GET', endpoint); xhr.send(); xhr.finish(responseFor(), options);
        assert.equal(h.chats().length, 0);
    }
    const h = harness(); h.setting(true);
    const stale = new h.XHR(); stale.open('GET', endpoint); stale.send();
    h.setting(false); h.setting(true); stale.finish(responseFor());
    assert.equal(h.chats().length, 0);
    const reused = new h.XHR(); reused.open('GET', endpoint); reused.send();
    reused.open('GET', 'https://api.x.com/graphql/query-id/GetMessagesForXChat'); reused.send();
    reused.finish(responseFor());
    assert.equal(h.chats().length, 0);
    const otherViewer = new h.XHR(); otherViewer.open('GET', endpoint); otherViewer.send();
    h.document.cookie = 'twid=u%3D333'; otherViewer.finish(responseFor());
    assert.equal(h.chats().length, 0);
});

await check('Public identities are emitted in bounded batches without private response fields', async () => {
    const h = harness(); h.setting(true);
    const data = responseFor();
    data.data.get_member_results.results = Array.from({ length: 257 }, (_, index) =>
        responseFor(String(10000 + index), `person_${index}`).data.get_member_results.results[0]);
    await h.reply(h.start(), data);
    assert.deepEqual(h.chats().map(event => event.detail.users.length), [100, 100, 57]);
    assert.equal(h.chats().flatMap(event => event.detail.users).length, 257);
    assert.ok(!JSON.stringify(h.events).includes('DO_NOT_RELAY'));
    assert.equal(h.nativeRequests.length, 1);
});

console.log(`${groups} chat network checks passed. No live requests or browser sessions were used.`);
