/** Profile/context races using the production client; no browser session or network. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { parseAst } from 'rollup/parseAst';
import { createProfileClient, mergeProfileSnapshot, resolveProfileContext } from '../src/shared/profile-client.js';
import { FILTER_SOURCES } from '../src/shared/filter-registry.js';
import { DEFAULT_SETTINGS, MESSAGE_TYPES, normalizeAccountId } from '../src/shared/constants.js';
import { PROFILE_MESSAGES } from '../src/shared/profiles.js';
import { createSnapshotTracker } from '../src/shared/state-sync.js';
import { ProfileStore } from '../src/background/profile-store.js';

const clone = value => JSON.parse(JSON.stringify(value));
const catalog = [{ id: 'default', name: 'Default' }, { id: 'work', name: 'Work' }, { id: 'personal', name: 'Personal' }];
function snapshot(revision = 0, { globalRevision = 0, country = 'India', settings = {}, filters = {} } = {}) {
    return { revision, globalRevision, settings: { ...DEFAULT_SETTINGS, ...settings },
        filters: { ...Object.fromEntries(FILTER_SOURCES.map(source => [source.field, []])), blockedCountries: [country], ...filters } };
}
function response(accountId, profileId, data = snapshot(), profiles = catalog) {
    return { success: true, accountId, profileId, profiles: clone(profiles), snapshot: clone(data) };
}
function harness(options = {}) {
    const requests = [], paints = [], contexts = [];
    const client = createProfileClient({
        transport: message => new Promise((resolve, reject) => requests.push({ message: clone(message), resolve, reject })),
        onSnapshot: (data, state) => paints.push({ data: clone(data), accountId: state.accountId, profileId: state.profileId }),
        onContextChange: state => contexts.push({ ...state }),
        ...options
    });
    const latest = () => requests.at(-1);
    async function initialize(accountId = '111', profileId, data = snapshot()) {
        const pending = client.initialize({ accountId, ...(profileId ? { profileId } : {}) });
        latest().resolve(response(accountId, profileId || 'default', data));
        await pending;
    }
    return { client, requests, latest, paints, contexts, initialize };
}
const tick = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
let groups = 0;
async function check(name, run) { await run(); groups++; console.log(`PASS ${name}`); }

await check('Each X account resolves its own selection; unknown content remains pinned to Default', async () => {
    const h = harness();
    await h.initialize('111');
    const selection = h.client.select('work');
    assert.deepEqual(h.latest().message.profileContext, { accountId: '111', profileId: 'default' });
    h.latest().resolve(response('111', 'work', snapshot(1)));
    await selection;
    const switched = h.client.bindAccount('222');
    assert.deepEqual(h.latest().message.profileContext, { accountId: '222' });
    assert.equal(h.client.state.snapshot, null, 'Clear A synchronously, before loading B');
    h.latest().resolve(response('222', 'personal', snapshot(2, { country: 'France' })));
    await switched;
    assert.equal(h.client.state.profileId, 'personal');
    const unknown = h.client.bindAccount(null);
    assert.deepEqual(h.latest().message.profileContext, { accountId: null, profileId: 'default' });
    h.latest().resolve(response(null, 'default', snapshot(2)));
    await unknown;
    h.client.accept({ type: PROFILE_MESSAGES.PROFILE_CATALOG_UPDATED, profiles: catalog,
        accounts: { 111: 'work', 222: 'personal' }, editorProfileId: 'personal', revision: 3 });
    assert.equal(h.client.state.profileId, 'default');
    assert.equal(h.client.state.pending, false);
});

await check('Late account loads cannot paint or restore the previous viewer', async () => {
    const h = harness();
    const a = h.client.initialize({ accountId: '111' });
    const oldRequest = h.latest();
    const b = h.client.bindAccount('222');
    const newRequest = h.latest();
    newRequest.resolve(response('222', 'personal', snapshot(2)));
    await b;
    oldRequest.resolve(response('111', 'work', snapshot(1)));
    assert.equal((await a).code, 'CANCELLED');
    assert.deepEqual(h.paints.map(item => item.accountId), ['222']);
    const failed = h.client.bindAccount('333');
    h.latest().reject(new Error('Storage unavailable'));
    await assert.rejects(failed, /Storage unavailable/);
    assert.equal(h.client.state.accountId, '333');
    assert.equal(h.client.state.ready, false);
    assert.equal(h.client.state.snapshot, null, 'A failed B→C load must never reinstate B filters on C');
    const retry = h.client.bindAccount('333');
    h.latest().resolve(response('333', 'work', snapshot(3)));
    await retry;
    assert.equal(h.client.state.ready, true);
});

await check('A failed manual selection restores only this account’s last complete snapshot', async () => {
    const h = harness();
    await h.initialize('111', 'work', snapshot(4));
    const pending = h.client.select('personal');
    h.latest().resolve({ success: false, error: 'Disk full' });
    await assert.rejects(pending, /Disk full/);
    assert.equal(h.client.state.accountId, '111');
    assert.equal(h.client.state.profileId, 'work');
    assert.equal(h.client.state.snapshot.revision, 4);
    assert.equal(h.client.state.ready, true);
});

await check('Identity polling does not invalidate its own pending account load', async () => {
    const h = harness();
    const pending = h.client.bindAccount('111');
    const generation = h.client.state.generation;
    await h.client.bindAccount('111');
    await h.client.bindAccount('111');
    assert.equal(h.requests.length, 1);
    assert.equal(h.client.state.generation, generation);
    h.latest().resolve(response('111', 'work'));
    await pending;
    assert.equal(h.client.state.ready, true);
});

await check('Global preferences and profile rules have independent revision fences', async () => {
    const old = snapshot(8, { globalRevision: 2, country: 'India', settings: { showFlags: true, highlightBlockedTweets: false } });
    const global = mergeProfileSnapshot(old, snapshot(7, { globalRevision: 3, country: 'France',
        settings: { showFlags: false, highlightBlockedTweets: true } }));
    assert.equal(global.settings.showFlags, false);
    assert.equal(global.settings.highlightBlockedTweets, false);
    assert.deepEqual(global.filters.blockedCountries, ['India']);
    const local = mergeProfileSnapshot(global, snapshot(9, { globalRevision: 1, country: 'Italy',
        settings: { showFlags: true, highlightBlockedTweets: true } }));
    assert.equal(local.settings.showFlags, false);
    assert.equal(local.settings.highlightBlockedTweets, true);
    assert.deepEqual(local.filters.blockedCountries, ['Italy']);
    assert.equal(local.revision, 9);
    assert.equal(local.globalRevision, 3);
    assert.equal(mergeProfileSnapshot(local, snapshot(8, { globalRevision: 2 })), null);
    assert.equal(mergeProfileSnapshot(null, { ...old, filters: {} }), null);
});

await check('Config acknowledgements publish full transactions and return the newest accepted winner', async () => {
    const h = harness();
    await h.initialize('111', 'work', snapshot(4));
    const pending = h.client.send({ type: MESSAGE_TYPES.SET_BLOCKED_COUNTRIES,
        payload: { action: 'add', country: 'France' } });
    const mutation = h.latest();
    h.client.accept({ type: PROFILE_MESSAGES.PROFILE_STATE_UPDATED, profileId: 'work',
        snapshot: snapshot(6, { globalRevision: 2, country: 'Italy', filters: { blockedAccounts: ['999'] } }) });
    mutation.resolve({ success: true, profileId: 'work', data: ['France'], revision: 5, globalRevision: 1,
        snapshot: snapshot(5, { globalRevision: 1, country: 'France', filters: { blockedAccounts: ['777'] } }) });
    const result = await pending;
    assert.deepEqual(result.data, ['Italy']);
    assert.deepEqual(h.client.state.snapshot.filters.blockedAccounts, ['999']);
    assert.equal(result.revision, 6);
    assert.equal(result.globalRevision, 2);
    const paints = h.paints.length;
    h.client.accept({ type: PROFILE_MESSAGES.PROFILE_STATE_UPDATED, profileId: 'personal', snapshot: snapshot(100) });
    h.client.accept({ type: MESSAGE_TYPES.BLOCKED_COUNTRIES_UPDATED, profileId: 'work', payload: ['France'], revision: 100 });
    h.client.accept({ type: MESSAGE_TYPES.SETTINGS_UPDATED, payload: { enabled: false }, revision: 100 });
    assert.equal(h.paints.length, paints, 'Foreign and legacy broadcasts cannot replace a complete profile snapshot');
});

await check('A newer single config acknowledgement cannot strand unrelated older lists', async () => {
    const h = harness();
    await h.initialize('111', 'work', snapshot(1));
    const pending = h.client.send({ type: MESSAGE_TYPES.SET_SETTINGS, payload: { highlightBlockedTweets: true } });
    h.latest().resolve({ success: true, profileId: 'work', data: { ...DEFAULT_SETTINGS, highlightBlockedTweets: true },
        revision: 3, globalRevision: 0, snapshot: snapshot(3, { country: 'Italy',
            settings: { highlightBlockedTweets: true }, filters: { blockedAccounts: ['999'] } }) });
    await pending;
    assert.deepEqual(h.client.state.snapshot.filters.blockedCountries, ['Italy']);
    assert.deepEqual(h.client.state.snapshot.filters.blockedAccounts, ['999']);
    assert.equal(h.client.state.snapshot.settings.highlightBlockedTweets, true);
});

await check('Queued quick actions retain their captured profile and stale replies cannot repaint another profile', async () => {
    const h = harness();
    await h.initialize('111', 'work', snapshot(1));
    const oldContext = { accountId: '111', profileId: 'work' };
    const write = h.client.send({ type: MESSAGE_TYPES.SET_BLOCKED_COUNTRIES,
        payload: { action: 'add', country: 'France' }, profileContext: oldContext });
    const oldWrite = h.latest();
    const selected = h.client.select('personal');
    h.latest().resolve(response('111', 'personal', snapshot(2, { country: 'Germany' })));
    await selected;
    oldWrite.resolve({ success: true, profileId: 'work', data: ['France'], revision: 3, globalRevision: 0,
        snapshot: snapshot(3, { country: 'France' }) });
    assert.equal((await write).code, 'CANCELLED');
    assert.deepEqual(oldWrite.message.profileContext, oldContext);
    assert.deepEqual(h.client.state.snapshot.filters.blockedCountries, ['Germany']);
    const queued = h.client.send({ type: MESSAGE_TYPES.SET_BLOCKED_ACCOUNTS,
        payload: { action: 'add', accountId: '999' }, profileContext: oldContext });
    assert.deepEqual(h.latest().message.profileContext, oldContext, 'A deferred old action must never be redirected to Personal');
    h.latest().resolve({ success: true, profileId: 'work', data: ['999'], revision: 4, globalRevision: 0 });
    assert.equal((await queued).code, 'CANCELLED');
});

await check('A cookie switch detected at write time cancels the write before transport', async () => {
    let viewer = '111';
    const h = harness({ getAccountId: () => viewer });
    await h.initialize('111', 'work');
    viewer = '222';
    const pending = h.client.send({ type: MESSAGE_TYPES.SET_BLOCKED_ACCOUNTS, payload: { action: 'add', accountId: '999' } });
    assert.equal(h.latest().message.type, PROFILE_MESSAGES.GET_PROFILE_CONTEXT);
    assert.deepEqual(h.latest().message.profileContext, { accountId: '222' });
    h.latest().resolve(response('222', 'personal', snapshot(1)));
    assert.equal((await pending).code, 'CANCELLED');
    assert.equal(h.requests.filter(item => item.message.type === MESSAGE_TYPES.SET_BLOCKED_ACCOUNTS).length, 0);
});

await check('A cookie switch between dispatch and response/broadcast cannot paint the former viewer', async () => {
    let viewer = '111';
    const h = harness({ getAccountId: () => viewer });
    const loading = h.client.initialize({ accountId: '111' });
    const oldLoad = h.latest();
    viewer = '222';
    oldLoad.resolve(response('111', 'work', snapshot(1)));
    assert.equal((await loading).code, 'CANCELLED');
    assert.equal(h.paints.length, 0);
    assert.deepEqual(h.latest().message.profileContext, { accountId: '222' });
    h.latest().resolve(response('222', 'personal', snapshot(2)));
    await tick();
    assert.equal(h.client.state.profileId, 'personal');
    viewer = '333';
    h.client.accept({ type: PROFILE_MESSAGES.PROFILE_STATE_UPDATED, profileId: 'personal', snapshot: snapshot(3) });
    assert.equal(h.client.state.accountId, '333');
    assert.equal(h.client.state.snapshot, null);
    assert.deepEqual(h.paints.map(item => item.accountId), ['222']);
    h.latest().resolve(response('333', 'default', snapshot(3)));
    await tick();
});

await check('Catalog bindings follow this account, including URL-seeded editors, without undoing a newer selection', async () => {
    const h = harness();
    await h.initialize('111', undefined, snapshot(1));
    h.client.accept({ type: PROFILE_MESSAGES.PROFILE_CATALOG_UPDATED, profiles: catalog,
        accounts: { 111: 'work', 222: 'personal' }, revision: 2 });
    assert.equal(h.latest().message.profileContext.profileId, 'work');
    h.latest().resolve(response('111', 'work', snapshot(2)));
    await tick();
    const selection = h.client.select('personal');
    h.latest().resolve(response('111', 'personal', snapshot(3)));
    await selection;
    assert.equal(h.client.state.profileId, 'personal');
    assert.equal(h.client.state.pending, false, 'Catalog names from the acknowledgement cannot promote stale account bindings');
    h.client.accept({ type: PROFILE_MESSAGES.PROFILE_CATALOG_UPDATED, profiles: catalog,
        accounts: { 111: 'personal' }, revision: 3 });
    assert.equal(h.client.state.pending, false);
    await h.initialize('111', 'work', snapshot(4));
    h.client.accept({ type: PROFILE_MESSAGES.PROFILE_CATALOG_UPDATED, profiles: catalog,
        accounts: { 111: 'personal' }, revision: 5 });
    assert.equal(h.latest().message.profileContext.profileId, 'personal', 'A URL profile seeds the editor but cannot pin it against this account’s next selection');
    h.latest().resolve(response('111', 'personal', snapshot(5)));
    await tick();
    assert.equal(h.client.state.profileId, 'personal');
    h.client.accept({ type: PROFILE_MESSAGES.PROFILE_CATALOG_UPDATED, profiles: catalog,
        accounts: { 111: 'personal', 222: 'work' }, editorProfileId: 'work', revision: 6 });
    assert.equal(h.client.state.profileId, 'personal', 'Another account and the global editor cannot retarget this account');
    assert.equal(h.client.state.pending, false);
});

await check('A newer remote selection wins over an older in-flight local selection response', async () => {
    for (const accountId of ['111', null]) {
        const h = harness({ followEditorSelection: true });
        await h.initialize(accountId, 'default', snapshot(1));
        const selecting = h.client.select('work');
        const older = h.latest();
        h.client.accept({ type: PROFILE_MESSAGES.PROFILE_CATALOG_UPDATED, profiles: catalog,
            accounts: { 111: 'personal' }, editorProfileId: 'personal', revision: 3 });
        older.resolve(response(accountId, 'work', snapshot(2)));
        await selecting;
        assert.equal(h.latest().message.profileContext.profileId, 'personal');
        h.latest().resolve(response(accountId, 'personal', snapshot(3)));
        await tick();
        assert.equal(h.client.state.profileId, 'personal');
        assert.equal(h.client.state.ready, true);
    }
});

await check('Newer rule data and catalog names cannot mask an older still-current selection change', async () => {
    for (const accountId of ['111', null]) {
        const h = harness({ followEditorSelection: true });
        await h.initialize(accountId, 'work', snapshot(1));
        h.client.accept({ type: PROFILE_MESSAGES.PROFILE_STATE_UPDATED, profileId: 'work', snapshot: snapshot(3) });
        h.client.accept({ type: PROFILE_MESSAGES.PROFILE_CATALOG_UPDATED, profiles: catalog,
            accounts: { 111: 'default' }, editorProfileId: 'default', revision: 2 });
        assert.equal(h.latest().message.profileContext.profileId, 'default',
            'A later rule write does not invalidate the earlier profile selection');
        h.latest().resolve(response(accountId, 'default', snapshot(5)));
        await tick();
        assert.equal(h.client.state.profileId, 'default');
        assert.equal(h.client.state.snapshot.revision, 5);
        h.client.accept({ type: PROFILE_MESSAGES.PROFILE_CATALOG_UPDATED, profiles: catalog,
            accounts: { 111: 'personal' }, editorProfileId: 'personal', revision: 4 });
        assert.equal(h.latest().message.profileContext.profileId, 'personal',
            'A catalog-driven GET retains its selection fence even when its returned data/catalog names are newer');
        h.latest().resolve(response(accountId, 'personal', snapshot(6)));
        await tick();
        assert.equal(h.client.state.profileId, 'personal');
        h.client.accept({ type: PROFILE_MESSAGES.PROFILE_CATALOG_UPDATED, profiles: catalog,
            accounts: { 111: 'work' }, editorProfileId: 'work', revision: 2 });
        assert.equal(h.client.state.profileId, 'personal', 'An older delayed binding cannot undo the newer selection');
        assert.equal(h.client.state.pending, false);
    }
});

await check('Popup and Options selections synchronize both ways through the real profile store while other accounts stay independent', async () => {
    const data = {};
    const storage = { get: async key => Object.hasOwn(data, key) ? { [key]: clone(data[key]) } : {},
        set: async update => Object.assign(data, clone(update)) };
    const ids = ['work', 'personal'];
    const store = new ProfileStore(storage, { getSettings: () => DEFAULT_SETTINGS,
        getFilters: () => Object.fromEntries(FILTER_SOURCES.map(source => [source.field, []])), createId: () => ids.shift() });
    await store.load();
    await store.create('111', 'Work');
    await store.create('222', 'Personal');
    await store.select('111', 'default');
    const clients = [];
    const transport = async message => {
        const captured = message.profileContext;
        const context = store.context(captured.accountId, captured.profileId || null);
        if (message.type === PROFILE_MESSAGES.SELECT_PROFILE) {
            await store.select(context.accountId, message.payload.profileId);
            for (const client of clients) client.accept({ type: PROFILE_MESSAGES.PROFILE_CATALOG_UPDATED, ...store.catalog() });
            return store.response({ accountId: context.accountId, profileId: message.payload.profileId });
        }
        assert.equal(message.type, PROFILE_MESSAGES.GET_PROFILE_CONTEXT);
        return store.response(context);
    };
    function makeClient(followEditorSelection = true) {
        const client = createProfileClient({ transport, followEditorSelection });
        clients.push(client);
        return client;
    }
    const options = makeClient(), popup = makeClient(), otherAccount = makeClient();
    const editorOptions = makeClient(), editorPopup = makeClient(), unknownContent = makeClient(false);
    await options.initialize({ accountId: '111', profileId: 'default' });
    await popup.initialize({ accountId: '111' });
    await otherAccount.initialize({ accountId: '222' });
    await editorOptions.initialize({ accountId: null, profileId: 'default' });
    await editorPopup.initialize({ accountId: null });
    await unknownContent.initialize({ accountId: null, profileId: 'default' });

    await popup.select('work');
    await tick();
    assert.equal(options.state.profileId, 'work', 'Popup → existing Options must update the same account');
    assert.equal(otherAccount.state.profileId, 'personal');
    await options.select('personal');
    await tick();
    assert.equal(popup.state.profileId, 'personal', 'Options → existing popup must update the same account');
    assert.equal(store.context('111').profileId, 'personal');
    assert.equal(otherAccount.state.profileId, 'personal');

    await editorPopup.select('work');
    await tick();
    assert.equal(editorOptions.state.profileId, 'work', 'Unbound popup → existing unbound Options follows editor selection');
    await editorOptions.select('default');
    await tick();
    assert.equal(editorPopup.state.profileId, 'default', 'Unbound Options → existing unbound popup follows editor selection');
    assert.equal(options.state.profileId, 'personal', 'Unbound editor changes cannot retarget a known-account Options tab');
    assert.equal(popup.state.profileId, 'personal');
    assert.equal(otherAccount.state.profileId, 'personal');
    assert.equal(unknownContent.state.profileId, 'default', 'Content without a known viewer never follows the global editor');
    for (const client of clients) client.dispose();
});

await check('Newer rename broadcasts survive old in-flight context and metadata acknowledgements', async () => {
    const h = harness();
    const pending = h.client.initialize({ accountId: '111', profileId: 'work' });
    const freshNames = catalog.map(item => item.id === 'work' ? { ...item, name: 'Security' } : item);
    h.client.accept({ type: PROFILE_MESSAGES.PROFILE_CATALOG_UPDATED, profiles: freshNames,
        accounts: { 111: 'work' }, revision: 8 });
    h.latest().resolve(response('111', 'work', snapshot(7)));
    await pending;
    assert.equal(h.client.state.profiles.find(item => item.id === 'work').name, 'Security');
    const rename = h.client.rename('work', 'Office');
    const request = h.latest();
    const newestNames = catalog.map(item => item.id === 'work' ? { ...item, name: 'Newest' } : item);
    h.client.accept({ type: PROFILE_MESSAGES.PROFILE_CATALOG_UPDATED, profiles: newestNames,
        accounts: { 111: 'work' }, revision: 10 });
    request.resolve(response('111', 'work', snapshot(9)));
    await rename;
    assert.equal(h.client.state.profiles.find(item => item.id === 'work').name, 'Newest');
});

await check('Unbound editor selection stays local after initialization; deletion falls back to Default', async () => {
    const h = harness();
    const pending = h.client.initialize({ accountId: null });
    assert.deepEqual(h.latest().message.profileContext, { accountId: null });
    h.latest().resolve(response(null, 'work', snapshot(1)));
    await pending;
    h.client.accept({ type: PROFILE_MESSAGES.PROFILE_CATALOG_UPDATED, profiles: catalog,
        accounts: { 222: 'personal' }, editorProfileId: 'personal', revision: 2 });
    assert.equal(h.client.state.profileId, 'work');
    assert.equal(h.client.state.pending, false);
    h.client.accept({ type: PROFILE_MESSAGES.PROFILE_CATALOG_UPDATED,
        profiles: catalog.filter(item => item.id !== 'work'), accounts: {}, editorProfileId: 'personal', revision: 3 });
    assert.equal(h.latest().message.profileContext.profileId, 'default');
    h.latest().resolve(response(null, 'default', snapshot(3), catalog.filter(item => item.id !== 'work')));
    await tick();
    assert.equal(h.client.state.profileId, 'default');
    assert.equal(h.client.state.ready, true);
});

await check('Successful full-backup import remains successful when its catalog removes the selected profile', async () => {
    const h = harness();
    await h.initialize('111', 'work', snapshot(1));
    const pending = h.client.send({ type: MESSAGE_TYPES.IMPORT_DATA, payload: {} });
    const importing = h.latest();
    h.client.accept({ type: PROFILE_MESSAGES.PROFILE_CATALOG_UPDATED,
        profiles: [catalog[0]], accounts: { 111: 'default' }, revision: 2 });
    h.latest().resolve(response('111', 'default', snapshot(2), [catalog[0]]));
    await tick();
    importing.resolve({ success: true, skippedCache: 0 });
    assert.equal((await pending).success, true);
    assert.equal(h.client.state.profileId, 'default');
});

await check('Disposed documents cannot repaint or submit later metadata actions', async () => {
    const h = harness();
    const pending = h.client.initialize({ accountId: '111' });
    h.client.dispose();
    h.latest().resolve(response('111', 'work'));
    assert.equal((await pending).code, 'CANCELLED');
    assert.equal(h.paints.length, 0);
    assert.equal((await h.client.rename('work', 'Later')).code, 'CANCELLED');
    assert.equal(h.requests.length, 1);
});

await check('Popup and options resolve only local tab context and preserve unknown content’s Default', async () => {
    const calls = [];
    const api = { tabs: { query: async query => { calls.push(query); return [{ id: 7, url: 'https://x.com/home' }]; },
        sendMessage: async (id, message) => { calls.push({ id, message }); return { success: true, accountId: '111', profileId: 'work' }; } } };
    assert.deepEqual(await resolveProfileContext(api, { href: 'moz-extension://test/options.html?accountId=222&profileId=personal' }),
        { accountId: '222' });
    assert.equal(calls.length, 0);
    assert.deepEqual(await resolveProfileContext(api, { href: 'moz-extension://test/popup.html' }), { accountId: '111' });
    api.tabs.sendMessage = async () => ({ success: true, accountId: null, profileId: 'default' });
    assert.deepEqual(await resolveProfileContext(api, { href: 'moz-extension://test/popup.html' }), { accountId: null, profileId: 'default' });
    api.tabs.query = async () => [];
    assert.deepEqual(await resolveProfileContext(api, { href: 'moz-extension://test/options.html?profileId=work%0A' }), { accountId: null });
});

await check('Popup opened over this extension’s Options inherits that account and ignores stale URL profiles', async () => {
    let activeUrl = 'chrome-extension://ours/options/options.html?accountId=111&profileId=default';
    let messages = 0;
    const api = { runtime: { getURL: path => `chrome-extension://ours/${path}` },
        tabs: { query: async () => [{ id: 7, url: activeUrl }], sendMessage: async () => { messages++; return null; } } };
    const popup = { href: 'chrome-extension://ours/popup/popup.html' };
    assert.deepEqual(await resolveProfileContext(api, popup), { accountId: '111' });
    assert.equal(messages, 0, 'Own Options needs no X content-script message or identity request');
    activeUrl = 'chrome-extension://ours/options/options.html?profileId=work';
    assert.deepEqual(await resolveProfileContext(api, popup), { accountId: null, profileId: 'work' });
    activeUrl = 'chrome-extension://other/options/options.html?accountId=222&profileId=personal';
    assert.deepEqual(await resolveProfileContext(api, popup), { accountId: null }, 'Another extension’s Options cannot supply an account');
    activeUrl = 'chrome-extension://ours/options/options.html/extra?accountId=222';
    assert.deepEqual(await resolveProfileContext(api, popup), { accountId: null }, 'Require the exact Options path');
    activeUrl = 'https://example.test/options/options.html?accountId=222';
    assert.deepEqual(await resolveProfileContext(api, popup), { accountId: null });
});

await check('An active Options tab without URL permission resolves only its own targeted extension view', async () => {
    const requests = [];
    let views = [{ location: { href: 'chrome-extension://ours/options/options.html?accountId=111&profileId=default' } }];
    let tab = { id: 17 };
    const api = { runtime: { getURL: path => `chrome-extension://ours/${path}` },
        tabs: { query: async () => [tab], sendMessage: async () => { throw new Error('Never message an extension view as X content'); } },
        extension: { getViews: query => { requests.push(query); return views; } } };
    const popup = { href: 'chrome-extension://ours/popup/popup.html' };
    assert.deepEqual(await resolveProfileContext(api, popup), { accountId: '111' });
    assert.deepEqual(requests, [{ type: 'tab', tabId: 17 }], 'Request only the active tab, never all extension views');
    views = [{ location: { href: 'chrome-extension://ours/options/options.html?profileId=work' } }];
    assert.deepEqual(await resolveProfileContext(api, popup), { accountId: null, profileId: 'work' });
    for (const href of ['chrome-extension://other/options/options.html?accountId=222',
        'chrome-extension://ours/options/options.html/extra?accountId=222',
        'chrome-extension://ours/popup/popup.html?accountId=222',
        'https://x.com/home?accountId=222']) {
        views = [{ location: { href } }];
        assert.deepEqual(await resolveProfileContext(api, popup), { accountId: null }, `Reject unrelated view ${href}`);
    }
    views = [{ get location() { throw new Error('Closing view'); } }];
    assert.deepEqual(await resolveProfileContext(api, popup), { accountId: null });
    api.extension.getViews = () => { throw new Error('API unavailable'); };
    assert.deepEqual(await resolveProfileContext(api, popup), { accountId: null });
    api.extension.getViews = query => { requests.push(query); return views; };
    tab = { id: 17, url: 'https://example.test/' };
    const count = requests.length;
    assert.deepEqual(await resolveProfileContext(api, popup), { accountId: null });
    assert.equal(requests.length, count, 'Do not inspect extension views when the active tab URL is already known');
});

// Exercise the real content transaction functions without a browser/DOM fixture.
const content = fs.readFileSync(new URL('../src/content/content-script.js', import.meta.url), 'utf8');
const nodes = parseAst(content).body;
const functions = ['currentFilters', 'currentAccountId', 'beginProfileContextChange', 'applyProfileSnapshot'];
const production = nodes.filter(node => node.type === 'FunctionDeclaration' && functions.includes(node.id.name))
    .map(node => content.slice(node.start, node.end)).join('\n');
assert.equal(functions.length, nodes.filter(node => node.type === 'FunctionDeclaration' && functions.includes(node.id.name)).length);

await check('Content switches reset private viewer state and apply every filter before DOM consumers run', async () => {
    const observations = [], events = [];
    const tracker = createSnapshotTracker();
    const publicRecord = { location: 'France' };
    const userInfoCache = new Map([['readable', publicRecord], ['inaccessible', null]]);
    const sandbox = { FILTER_SOURCES, MESSAGE_TYPES, normalizeAccountId, stateSnapshots: tracker,
        userInfoCache,
        readFollowingViewer: () => 'id:111',
        hovercard: { resetProfileContext: () => events.push('hover-reset'), syncFilters: () => observe('hover') },
        clearFollowing: () => events.push('following-clear'), clearPostRelations: () => events.push('relations-clear'),
        getCsrfToken: () => 'new-csrf', window: { dispatchEvent: event => events.push(event.type) },
        CustomEvent: class { constructor(type) { this.type = type; } },
        resetProcessedElements: () => observe('reset'), syncEnrichmentSetting: () => observe('enrichment'),
        syncFollowingSetting: () => observe('following'), syncPostRelationsSetting: () => observe('relations'),
        syncSidebarSettings: () => observe('sidebar'), syncModalProfile: () => observe('modal'),
        updateBlockedTweets: () => observe('verdicts'), clearProfiles: () => events.push('public-enrichment-clear'),
        reprocessRowsMissingAffiliation: () => observe('affiliation'),
        removeSidebarLink: () => {}, injectSidebarLink: () => {}, getBlockingState: () => ({}), sendMessage: () => {},
        debug: () => {}, document: { body: null }
    };
    const context = vm.createContext(sandbox);
    function observe(kind) {
        observations.push(JSON.parse(vm.runInContext(`JSON.stringify({kind:${JSON.stringify(kind)},settings,ready:settingsLoaded,
            countries:[...filterSets.blockedCountries],accounts:[...filterSets.blockedAccounts]})`, context)));
    }
    vm.runInContext(`let settings={...${JSON.stringify(DEFAULT_SETTINGS)}};let settingsLoaded=true,isEnabled=true,debugMode=false;
        let isCleanedUp=false,appliedProfileContext={accountId:'111',profileId:'work'},csrfToken=null;
        let chatBadges={refresh:()=>{}};let memoizedScanPageFn=null;
        const filterSets=Object.fromEntries(FILTER_SOURCES.map(source=>[source.field,new Set()]));
        ${production}`, context);
    assert.equal(vm.runInContext('currentAccountId()', context), '111');
    vm.runInContext("beginProfileContextChange({accountId:'222',profileId:'personal'})", context);
    assert.ok(events.includes('x-posed-reset-headers'));
    assert.ok(events.includes('following-clear'));
    assert.ok(events.includes('relations-clear'));
    assert.ok(events.includes('hover-reset'));
    assert.equal(userInfoCache.has('inaccessible'), false);
    assert.equal(userInfoCache.get('readable'), publicRecord);
    assert.equal(events.includes('public-enrichment-clear'), false);
    assert.ok(observations.every(item => !item.ready && item.settings.enabled === false && !item.countries.length && !item.accounts.length));
    observations.length = 0;
    sandbox.nextSnapshot = snapshot(1, { country: 'France', filters: { blockedAccounts: ['999'] }, settings: { highlightBlockedTweets: true } });
    vm.runInContext("applyProfileSnapshot(nextSnapshot,{accountId:'222',profileId:'personal'})", context);
    assert.ok(observations.length > 4);
    assert.ok(observations.every(item => item.ready && item.settings.highlightBlockedTweets &&
        item.countries.join() === 'France' && item.accounts.join() === '999'), 'No consumer sees half a transaction');
    assert.equal(Object.keys(tracker.snapshot()).length, FILTER_SOURCES.length + 1);
    events.length = 0;
    vm.runInContext("beginProfileContextChange({accountId:'222',profileId:'work'})", context);
    assert.equal(events.includes('x-posed-reset-headers'), false, 'A profile-only selection does not invalidate the same viewer’s credentials');
});

console.log(`\n${groups} profile client/context checks passed.`);
