/** Run the real MAIN-world lookup bridge with synthetic page sessions; no network. */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { rollup } from 'rollup';

const bundle = await rollup({ input: fileURLToPath(new URL('../src/content/page-script.js', import.meta.url)) });
const { output } = await bundle.generate({ format: 'iife' });
await bundle.close();
const source = output[0].code;
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const account = { data: { user_result_by_screen_name: { result: {
    rest_id: '222', core: { screen_name: 'sample', name: 'Sample' },
    about_profile: { account_based_in: 'Switzerland', source: 'Web', username_changes: { count: 2 } },
    verification_info: { reason: { verified_since_msec: '1700000000000' } },
    verification: { verified: true, verified_type: 'Business' }
} } } };

function harness() {
    const listeners = new Map(), requests = [], results = [];
    class CustomEvent {
        constructor(type, init = {}) { this.type = type; this.detail = init.detail; }
    }
    class XMLHttpRequest {
        open() {}
        setRequestHeader() {}
        send() {}
    }
    const window = {
        addEventListener(type, listener) {
            const list = listeners.get(type) || [];
            list.push(listener); listeners.set(type, list);
        },
        dispatchEvent(event) { for (const listener of listeners.get(event.type) || []) listener(event); },
        fetch(input, init) { return new Promise(resolve => requests.push({ input, init, resolve })); }
    };
    const document = { cookie: 'twid=u%3D111', querySelector: () => null };
    const event = (type, detail) => window.dispatchEvent(new CustomEvent(type, { detail: JSON.stringify(detail) }));
    window.addEventListener('x-posed-fetch-user-info-result', event => results.push(JSON.parse(event.detail)));
    vm.runInNewContext(source, { window, document, location: new URL('https://x.com/home'),
        CustomEvent, XMLHttpRequest, Response, Headers, URL, console, performance, setTimeout, clearTimeout,
        AbortController, fetch: window.fetch });
    const lookup = (id, options = {}) => event('x-posed-fetch-user-info', {
        id, screenName: 'sample', viewer: 'id:111', ...options
    });
    async function capture(token = 'synthetic-session-a') {
        const pending = window.fetch('https://x.com/i/api/graphql/synthetic/HomeTimeline', {
            headers: { authorization: token, 'x-csrf-token': 'synthetic-csrf' }
        });
        requests.at(-1).resolve(new Response('{}'));
        await pending;
        requests.length = 0;
    }
    async function reply(request, body = account, status = 200) {
        request.resolve(new Response(JSON.stringify(body), { status }));
        await tick(); await tick();
    }
    return { window, document, requests, results, event, lookup, capture, reply };
}

let groups = 0;
async function check(name, run) { await run(); groups++; console.log(`PASS ${name}`); }

await check('Full metadata is obtained in the original account lookup without a second request', async () => {
    const h = harness(); await h.capture();
    h.lookup('full', { fullMetadata: true });
    await tick();
    assert.equal(h.requests.length, 1);
    const request = h.requests[0];
    assert.equal(request.init.credentials, 'include');
    assert.equal(request.init.headers.authorization, 'synthetic-session-a');
    await h.reply(request);
    assert.equal(h.results[0].success, true);
    assert.equal(h.results[0].data.meta.verifiedType, 'business');
    assert.equal(h.results[0].data.meta.verifiedSinceMsec, 1700000000000);
    assert.equal(h.requests.length, 1);
});

await check('Cold Chat uses only its own page cookie without waiting for another native request', async () => {
    for (const token of ['synthetic-account-a', 'synthetic-account-b']) {
        const h = harness(); h.document.cookie += `; ct0=${token}`;
        h.lookup('cold', { fullMetadata: true }); await tick();
        assert.equal(h.requests.length, 1, 'No bootstrap/header-discovery request');
        const request = h.requests[0];
        assert.equal(request.init.headers['x-csrf-token'], token);
        assert.match(request.init.headers.authorization, /^Bearer /);
        await h.reply(request);
        assert.equal(h.results[0].success, true);
        assert.equal(h.results[0].data.meta.verifiedType, 'business');
    }
});

await check('Legacy page callers retain a lean projection unless explicitly requesting full metadata', async () => {
    for (const fullMetadata of [undefined, false, 'true']) {
        const h = harness(); await h.capture();
        h.lookup('basic', { fullMetadata }); await tick();
        await h.reply(h.requests[0]);
        assert.equal(h.results[0].data.location, 'Switzerland');
        assert.equal(h.results[0].data.meta.restId, '222');
        assert.equal(Object.hasOwn(h.results[0].data.meta, 'verifiedSinceMsec'), false);
    }
});

await check('Concurrent same-viewer full lookups share one request and return both caller IDs', async () => {
    const h = harness(); await h.capture();
    h.lookup('one', { fullMetadata: true }); h.lookup('two', { fullMetadata: true });
    await tick(); assert.equal(h.requests.length, 1);
    await h.reply(h.requests[0]);
    assert.deepEqual(h.results.map(result => result.id).sort(), ['one', 'two']);
    assert.ok(h.results.every(result => result.success));
});

await check('Wrong-viewer requests are cancelled before making a request', async () => {
    const h = harness(); await h.capture();
    h.lookup('wrong', { viewer: 'id:333', fullMetadata: true }); await tick();
    assert.equal(h.results[0].code, 'CANCELLED');
    assert.equal(h.requests.length, 0);
});

await check('An account switch discards its pending reply and clears prior page credentials', async () => {
    const h = harness(); await h.capture();
    h.lookup('old', { fullMetadata: true }); await tick();
    h.document.cookie = 'twid=u%3D333';
    h.event('x-posed-reset-headers', {});
    await h.reply(h.requests[0]);
    assert.equal(h.results[0].code, 'CANCELLED');
    h.lookup('new', { viewer: 'id:333', fullMetadata: true }); await tick();
    assert.equal(h.results[1].code, 'NO_HEADERS');
    assert.equal(h.requests.length, 1);
});

await check('A same-viewer reset cannot resurrect an earlier account generation', async () => {
    const h = harness(); await h.capture();
    h.lookup('old', { fullMetadata: true }); await tick();
    h.event('x-posed-reset-headers', {});
    await h.reply(h.requests[0]);
    assert.equal(h.results[0].code, 'CANCELLED');
});

await check('Missing authentication and invalid handles do not initiate a lookup', async () => {
    const h = harness(); h.lookup('no-auth'); await tick();
    assert.equal(h.results[0].code, 'NO_HEADERS');
    await h.capture();
    h.lookup('invalid', { screenName: 'sample\n' }); await tick();
    assert.equal(h.results[1].code, 'NOT_FOUND');
    assert.equal(h.requests.length, 0);
});

await check('Another account response cannot be attributed to the requested account', async () => {
    const h = harness(); await h.capture();
    h.lookup('mismatch', { fullMetadata: true }); await tick();
    const body = structuredClone(account);
    body.data.user_result_by_screen_name.result.core.screen_name = 'someone_else';
    await h.reply(h.requests[0], body);
    assert.equal(h.results[0].success, false);
    assert.ok(!h.results[0].data);
});

console.log(`${groups} profile lookup checks passed. No live requests were used.`);
