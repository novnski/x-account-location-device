/** Profile persistence, scope and transport checks. No X calls or browser sessions. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { rollup } from 'rollup';
import { parseAst } from 'rollup/parseAst';
import { ProfileStore } from '../src/background/profile-store.js';
import { DEFAULT_SETTINGS, MESSAGE_TYPES, STORAGE_KEYS } from '../src/shared/constants.js';
import { FILTER_SOURCES } from '../src/shared/filter-registry.js';
import {
    PROFILE_MESSAGES, PROFILE_STORAGE_KEY, PROFILE_SETTING_KEYS, DEFAULT_PROFILE_ID,
    profileSettings, normalizeProfilesBackup
} from '../src/shared/profiles.js';
import { BACKUP_FORMAT, prepareBackupImport } from '../src/shared/backup.js';
import { createProfileClient } from '../src/shared/profile-client.js';

const A = '2097352012367015936', B = '389229444';
let checks = 0;
async function check(name, run) { await run(); checks++; console.log(`PASS ${name}`); }
function environment() {
    const memory = new Map(), writes = [];
    let fail = false, serial = 0, globalRevision = 2;
    let globals = { ...DEFAULT_SETTINGS, badgeSize: 'large', highlightBlockedTweets: true, minPosts: 50000 };
    const legacyFilters = Object.fromEntries(FILTER_SOURCES.map(({ field }) => [field, []]));
    legacyFilters.blockedCountries = ['USA'];
    legacyFilters.allowedUsers = ['Reader'];
    const storage = {
        async get(key) { return memory.has(key) ? { [key]: structuredClone(memory.get(key)) } : {}; },
        async set(value) {
            if (fail) { fail = false; throw new Error('Injected persistence failure'); }
            writes.push(structuredClone(value));
            for (const [key, entry] of Object.entries(value)) memory.set(key, structuredClone(entry));
        }
    };
    const options = { getSettings: () => globals, getFilters: () => legacyFilters,
        getGlobalRevision: () => globalRevision, createId: () => `p${++serial}` };
    const store = new ProfileStore(storage, options);
    return { store, storage, memory, writes, legacyFilters,
        fail: () => { fail = true; }, reload: () => new ProfileStore(storage, options),
        setGlobals: patch => { globals = { ...globals, ...patch }; globalRevision++; } };
}
const source = field => FILTER_SOURCES.find(item => item.field === field);

await check('Migration preserves current rules in Default without copying cache, display settings or credentials', async () => {
    const env = environment(); await env.store.load();
    const response = env.store.response({ accountId: A, profileId: 'default' });
    assert.deepEqual(response.snapshot.filters.blockedCountries, ['united states']);
    assert.deepEqual(response.snapshot.filters.allowedUsers, ['reader']);
    assert.equal(response.snapshot.settings.badgeSize, 'large');
    assert.equal(response.snapshot.settings.highlightBlockedTweets, true);
    assert.equal(response.snapshot.settings.minPosts, 50000);
    const stored = env.memory.get(PROFILE_STORAGE_KEY);
    assert.deepEqual(Object.keys(env.writes[0]), [PROFILE_STORAGE_KEY]);
    assert.equal(Object.hasOwn(stored.profiles[0].settings, 'badgeSize'), false);
    assert.equal(Object.hasOwn(stored, 'cache'), false);
    assert.equal(Object.hasOwn(stored, 'headers'), false);
    const reload = env.reload(); await reload.load();
    assert.deepEqual(reload.export(), env.store.export());
    assert.equal(env.writes.length, 1, 'An existing valid profile record is not rewritten on restart');
});

await check('A failed initial migration cannot erase legacy values or expose unpersisted state', async () => {
    const env = environment(); env.fail();
    await assert.rejects(env.store.load(), /Injected/);
    assert.equal(env.store.state, null);
    assert.deepEqual(env.legacyFilters.blockedCountries, ['USA']);
    await env.store.load();
    assert.equal(env.store.catalog().profiles[0].id, DEFAULT_PROFILE_ID);
});

await check('Named profiles start clean and every account can remember any saved selection', async () => {
    const env = environment(); await env.store.load();
    const work = await env.store.create(A, ' Work ');
    const japan = await env.store.create(B, 'Japan');
    assert.equal(env.store.context(A).profileId, work);
    assert.equal(env.store.context(B).profileId, japan);
    assert.equal(env.store.snapshot({ accountId: A, profileId: work }).settings.highlightBlockedTweets, false);
    assert.ok(Object.values(env.store.snapshot({ accountId: A, profileId: work }).filters).every(values => values.length === 0));
    await env.store.select(A, japan);
    assert.equal(env.store.context(A).profileId, japan);
    assert.equal(env.store.context(B).profileId, japan);
    const reload = env.reload(); await reload.load();
    assert.equal(reload.context(A).profileId, japan);
    assert.equal(reload.context(B).profileId, japan);
});

await check('Profile edits affect their captured setup only, including Always Show and filtering behavior', async () => {
    const env = environment(); await env.store.load();
    const work = await env.store.create(A, 'Work');
    const ctx = { accountId: A, profileId: work };
    await env.store.updateFilter(ctx, source('blockedCountries'), { action: 'add', value: 'Japan' });
    await env.store.updateFilter(ctx, source('allowedUsers'), { action: 'add', value: '@ALICE' });
    await env.store.updateSettings(ctx, { alwaysShowFollowing: true, minHandleDigits: 5 });
    assert.deepEqual(env.store.snapshot(ctx).filters.blockedCountries, ['japan']);
    assert.deepEqual(env.store.snapshot(ctx).filters.allowedUsers, ['alice']);
    assert.equal(env.store.snapshot(ctx).settings.alwaysShowFollowing, true);
    assert.deepEqual(env.store.snapshot({ accountId: null, profileId: 'default' }).filters.blockedCountries, ['united states']);
    assert.equal(env.store.snapshot({ accountId: null, profileId: 'default' }).settings.minHandleDigits, 0);
    assert.deepEqual(env.legacyFilters.blockedCountries, ['USA']);
});

await check('Delayed edits stay attached to their captured profile after an account selects another', async () => {
    const env = environment(); await env.store.load();
    const first = await env.store.create(A, 'First');
    const second = await env.store.create(B, 'Second');
    const captured = { accountId: A, profileId: first };
    await env.store.select(A, second);
    await env.store.updateFilter(captured, source('blockedAccounts'), { action: 'add', value: B });
    assert.deepEqual(env.store.snapshot(captured).filters.blockedAccounts, [B]);
    assert.deepEqual(env.store.snapshot({ accountId: A, profileId: second }).filters.blockedAccounts, []);
});

await check('Global appearance changes reach every profile while filtering preferences remain independent', async () => {
    const env = environment(); await env.store.load();
    const work = await env.store.create(A, 'Work');
    const before = env.store.snapshot({ accountId: A, profileId: work });
    env.setGlobals({ badgeSize: 'small', highlightBlockedTweets: true });
    const after = env.store.snapshot({ accountId: A, profileId: work });
    assert.equal(after.settings.badgeSize, 'small');
    assert.equal(after.settings.highlightBlockedTweets, false);
    assert.equal(after.revision, before.revision);
    assert.ok(after.globalRevision > before.globalRevision);
});

await check('Failure leaves account selection and profile contents unchanged; queued edits recover', async () => {
    const env = environment(); await env.store.load();
    const work = await env.store.create(A, 'Work');
    const before = env.store.export();
    env.fail();
    await assert.rejects(env.store.select(B, work), /Injected/);
    assert.deepEqual(env.store.export(), before);
    const ctx = { accountId: A, profileId: work };
    env.fail();
    const failed = env.store.updateFilter(ctx, source('blockedCountries'), { action: 'add', value: 'Japan' });
    const recovered = env.store.updateFilter(ctx, source('blockedCountries'), { action: 'add', value: 'France' });
    await assert.rejects(failed, /Injected/); await recovered;
    assert.deepEqual(env.store.snapshot(ctx).filters.blockedCountries, ['france']);
});

await check('Concurrent edits serialize without losing rules and revisions stay monotonic', async () => {
    const env = environment(); await env.store.load();
    const ctx = { accountId: null, profileId: 'default' };
    const before = env.store.snapshot(ctx).revision;
    await Promise.all(['Japan', 'France', 'India'].map(value => env.store.updateFilter(ctx, source('blockedCountries'), { action: 'add', value })));
    assert.deepEqual(new Set(env.store.snapshot(ctx).filters.blockedCountries), new Set(['united states', 'japan', 'france', 'india']));
    assert.equal(env.store.snapshot(ctx).revision, before + 3);
});

await check('Region activation and selected countries commit together and invalid edits change nothing', async () => {
    const env = environment(); await env.store.load();
    const ctx = { accountId: null, profileId: 'default' };
    await env.store.updateRegion(ctx, { region: 'South Asia', countries: ['India'], activate: true });
    assert.deepEqual(env.store.snapshot(ctx).settings.regionCountrySelections['south asia'], ['india']);
    assert.deepEqual(env.store.snapshot(ctx).filters.blockedRegions, ['south asia']);
    const before = env.store.export(); env.fail();
    await assert.rejects(env.store.updateRegion(ctx, { region: 'South Asia', countries: ['Pakistan'], activate: true }), /Injected/);
    assert.deepEqual(env.store.export(), before);
    assert.throws(() => env.store.updateRegion(ctx, { region: 'not a region', countries: null, activate: true }));
});

await check('Names, immutable IDs and malformed rules are validated before writes', async () => {
    const env = environment(); await env.store.load();
    await env.store.create(A, 'Work'); const count = env.writes.length;
    for (const name of ['', ' ', 'x'.repeat(41), 'bad\nname', 'work']) await assert.rejects(env.store.create(A, name));
    for (const id of [A + '\n', Number(A), '@alice', '__proto__', '0']) assert.throws(() => env.store.context(id));
    assert.throws(() => env.store.context(A, 'missing'));
    assert.throws(() => env.store.updateFilter({ accountId: A, profileId: 'default' }, source('blockedAccounts'), { action: 'add', value: Number(B) }));
    assert.throws(() => env.store.updateFilter({ accountId: A, profileId: 'default' }, source('blockedCountries'), { action: 'set', values: null }),
        'Malformed null lists must not silently clear existing rules');
    assert.throws(() => env.store.updateSettings({ accountId: A, profileId: 'default' }, { minHandleDigits: 16 }));
    assert.equal(env.writes.length, count);
});

await check('Deleting a shared setup reassigns its accounts while Default remains available', async () => {
    const env = environment(); await env.store.load();
    const work = await env.store.create(A, 'Work'); await env.store.select(B, work);
    await env.store.rename({ accountId: A, profileId: work }, 'Research');
    assert.equal(env.store.catalog().profiles.find(profile => profile.id === work).name, 'Research');
    await env.store.remove({ accountId: A, profileId: work });
    assert.equal(env.store.context(A).profileId, 'default');
    assert.equal(env.store.context(B).profileId, 'default');
    assert.throws(() => env.store.remove({ accountId: null, profileId: 'default' }));
});

await check('Backup round trips include profiles and assignments without credentials; invalid restore cannot write', async () => {
    const env = environment(); await env.store.load();
    const work = await env.store.create(A, 'Work');
    await env.store.updateFilter({ accountId: A, profileId: work }, source('blockedAccounts'), { action: 'add', value: B });
    const backup = prepareBackupImport({ profiles: env.store.export() });
    const other = environment(); await other.store.load(); await other.store.restore(backup.profiles);
    assert.deepEqual(other.store.export(), env.store.export());
    const bad = structuredClone(backup.profiles); bad.accounts[A] = 'missing';
    assert.throws(() => normalizeProfilesBackup(bad));
    assert.throws(() => prepareBackupImport({ profiles: bad }));
    const malformed = structuredClone(backup.profiles); malformed.profiles[0].filters.blockedCountries = null;
    assert.throws(() => prepareBackupImport({ profiles: malformed }));
    assert.ok(!JSON.stringify(backup).includes('authorization'));
});

await check('Legacy partial backups merge only supplied fields into the selected profile', async () => {
    const env = environment(); await env.store.load();
    const work = await env.store.create(A, 'Work');
    const ctx = { accountId: A, profileId: work };
    await env.store.updateFilter(ctx, source('allowedUsers'), { action: 'add', value: 'alice' });
    await env.store.importProfile(ctx, { settings: { minPosts: 999 }, filters: { blockedCountries: ['Japan'] } });
    assert.deepEqual(env.store.snapshot(ctx).filters.allowedUsers, ['alice']);
    assert.deepEqual(env.store.snapshot(ctx).filters.blockedCountries, ['japan']);
    assert.equal(env.store.snapshot(ctx).settings.minPosts, 999);
    assert.equal(env.store.snapshot({ accountId: null, profileId: 'default' }).settings.minPosts, 50000);
});

await check('The production message router tags scoped replies, isolates edits and requests page-session authentication', async () => {
    const env = environment(); await env.store.load();
    const work = await env.store.create(A, 'Work');
    const text = fs.readFileSync(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');
    const nodes = parseAst(text).body;
    const names = ['profileContext', 'publishProfileCatalog', 'publishProfileState', 'publishAllProfileStates', 'handleProfileMessage'];
    const production = names.map(name => {
        const node = nodes.find(node => node.type === 'FunctionDeclaration' && node.id.name === name);
        assert.ok(node); return text.slice(node.start, node.end);
    }).join('\n');
    const broadcasts = [], fetches = [], tabCreates = [];
    const context = vm.createContext({
        profileStore: env.store, PROFILE_MESSAGES, PROFILE_SETTING_KEYS, MESSAGE_TYPES, FILTER_SOURCES, profileSettings, prepareBackupImport,
        broadcastToAll: message => broadcasts.push(message),
        settings: { revision: 2, async set(patch) { env.setGlobals(patch); this.revision++; } },
        browserAPI: { tabs: { create: data => tabCreates.push(data) }, runtime: { getURL: file => 'extension://' + file } }, URLSearchParams,
        handleFetchUserInfo: args => { fetches.push(args); return { success: false, code: 'PAGE_CONTEXT_REQUIRED' }; },
        handleFetchHovercardInfo: args => { fetches.push(args); return { success: false, code: 'PAGE_CONTEXT_REQUIRED' }; }
    });
    vm.runInContext(production + '\nglobalThis.route = handleProfileMessage;', context);
    const request = (type, payload = {}, profileId = work) => context.route({ type, payload, profileContext: { accountId: A, profileId } });
    const countries = source('blockedCountries');
    const reply = await request(countries.set, { action: 'add', country: 'Japan' });
    assert.equal(reply.profileId, work); assert.deepEqual([...reply.data], ['japan']);
    assert.deepEqual(reply.snapshot.filters, env.store.snapshot({ accountId: A, profileId: work }).filters,
        'A single-list acknowledgement carries the full committed snapshot so it cannot advance stale sibling-list fences');
    const read = await request(countries.get);
    assert.ok(read.snapshot && read.snapshot.revision === read.revision);
    const recovered = await request(PROFILE_MESSAGES.GET_PROFILE_CONTEXT, {}, 'deleted-profile');
    assert.equal(recovered.profileId, work, 'A stale options bookmark recovers to this account\'s remembered selection');
    await assert.rejects(request(countries.set, { action: 'clear' }, 'deleted-profile'),
        error => error.code === 'PROFILE_NOT_FOUND', 'A stale write must never clear the fallback profile');
    assert.ok(broadcasts.some(message => message.type === PROFILE_MESSAGES.PROFILE_STATE_UPDATED && message.profileId === work));
    const global = await request(MESSAGE_TYPES.SET_SETTINGS, { showFlags: false });
    assert.equal(global.snapshot.settings.showFlags, false);
    assert.ok((await request(MESSAGE_TYPES.GET_SETTINGS)).snapshot);
    assert.equal(broadcasts.at(-1).length, 2, 'A global display change reaches every saved profile');
    await request(MESSAGE_TYPES.FETCH_USER_INFO, { screenName: 'alice' });
    await request(MESSAGE_TYPES.FETCH_HOVERCARD_INFO, { screenName: 'alice' });
    assert.ok(fetches.every(args => args.pageContextRequired === true));
    await request(MESSAGE_TYPES.OPEN_OPTIONS_PAGE);
    assert.ok(tabCreates[0].url.includes('accountId=' + A) && tabCreates[0].url.includes('profileId=' + work));
});

// Bundle the actual worker and exercise its exported handleMessage, storage
// singletons, initializer and production routers together in fresh VM instances.
const workerBundle = await rollup({ input: fileURLToPath(new URL('../src/background/service-worker.js', import.meta.url)) });
const { output } = await workerBundle.generate({ format: 'iife', name: 'WorkerUnderTest' });
await workerBundle.close();
function workerHarness(memory = {}) {
    let context;
    const broadcasts = [];
    const fromJSON = value => vm.runInContext(`JSON.parse(${JSON.stringify(JSON.stringify(value))})`, context);
    const event = { addListener() {} };
    const browser = {
        storage: { local: {
            async get(keys) {
                const wanted = keys == null ? Object.keys(memory) : Array.isArray(keys) ? keys : [keys];
                return fromJSON(Object.fromEntries(wanted.filter(key => Object.hasOwn(memory, key)).map(key => [key, memory[key]])));
            },
            async set(values) { Object.assign(memory, structuredClone(values)); },
            async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete memory[key]; }
        }, onChanged: event },
        runtime: { onMessage: event, onInstalled: event, onStartup: event, onSuspend: event,
            getManifest: () => ({ version: '4.3.0' }), getURL: path => 'extension://' + path,
            async sendMessage(message) { broadcasts.push(structuredClone(message)); } },
        tabs: { async query() { return []; }, async create() {}, async sendMessage() {} }
    };
    context = vm.createContext({ browser, URL, URLSearchParams, TextEncoder, crypto: webcrypto,
        console: { log() {}, warn() {}, error() {}, debug() {} }, setInterval: () => 1, clearInterval() {},
        setTimeout, clearTimeout, fetch: () => { throw new Error('Worker regression tests must never fetch.'); } });
    vm.runInContext(output[0].code, context);
    return { memory, broadcasts, send: message => context.WorkerUnderTest.handleMessage(fromJSON(message)),
        request: (type, payload = {}, profileId = 'default', accountId = A) =>
            context.WorkerUnderTest.handleMessage(fromJSON({ type, payload, profileContext: { accountId, profileId } })) };
}

await check('The actual worker returns complete snapshots for scoped settings and successive list edits', async () => {
    const h = workerHarness();
    const profile = await h.request(PROFILE_MESSAGES.CREATE_PROFILE, { name: 'Research' });
    assert.equal(profile.success, true);
    const id = profile.profileId;
    const countries = source('blockedCountries'), accounts = source('blockedAccounts');
    await h.request(countries.set, { action: 'add', country: 'Japan' }, id);
    await h.request(accounts.set, { action: 'add', accountId: B }, id);
    const settings = await h.request(MESSAGE_TYPES.SET_SETTINGS, { minPosts: 42, highlightBlockedTweets: true }, id);
    assert.equal(settings.success, true);
    assert.equal(settings.snapshot.settings.minPosts, 42);
    assert.deepEqual([...settings.snapshot.filters.blockedCountries], ['japan']);
    assert.deepEqual([...settings.snapshot.filters.blockedAccounts], [B]);
    const read = await h.request(countries.get, {}, id);
    assert.equal(read.snapshot.revision, settings.snapshot.revision);
    assert.deepEqual([...read.snapshot.filters.blockedAccounts], [B], 'A list read cannot attach an incomplete state to the latest ledger revision');
    const other = await h.request(MESSAGE_TYPES.GET_SETTINGS, {}, 'default', B);
    assert.equal(other.snapshot.settings.minPosts, DEFAULT_SETTINGS.minPosts);
    assert.deepEqual([...other.snapshot.filters.blockedCountries], []);
});

await check('The actual worker retains global revision ordering across a background restart', async () => {
    const h = workerHarness();
    const first = await h.request(MESSAGE_TYPES.SET_SETTINGS, { showFlags: false });
    const key = `${STORAGE_KEYS.SETTINGS}_revision`;
    assert.equal(h.memory[key], first.globalRevision);
    const restarted = workerHarness(h.memory);
    const restored = await restarted.request(MESSAGE_TYPES.GET_SETTINGS);
    assert.equal(restored.data.showFlags, false);
    assert.equal(restored.globalRevision, first.globalRevision);
    const next = await restarted.request(MESSAGE_TYPES.SET_SETTINGS, { showFlags: true });
    assert.ok(next.globalRevision > first.globalRevision);
    assert.equal(next.snapshot.settings.showFlags, true);
    assert.equal(next.snapshot.globalRevision, next.globalRevision);
});

await check('The actual worker recovers stale deleted-profile reads and rejects their writes without altering another profile', async () => {
    const h = workerHarness();
    const created = await h.request(PROFILE_MESSAGES.CREATE_PROFILE, { name: 'Temporary' });
    const id = created.profileId;
    await h.request(PROFILE_MESSAGES.DELETE_PROFILE, { profileId: id }, id);
    const recovered = await h.request(PROFILE_MESSAGES.GET_PROFILE_CONTEXT, {}, id);
    assert.equal(recovered.success, true); assert.equal(recovered.profileId, 'default');
    const stale = await h.request(source('blockedCountries').set, { action: 'add', country: 'India' }, id);
    assert.equal(stale.success, false); assert.equal(stale.code, 'PROFILE_NOT_FOUND');
    const fallback = await h.request(source('blockedCountries').get);
    assert.deepEqual([...fallback.data], []);
    assert.equal(fallback.snapshot.revision, recovered.snapshot.revision, 'A stale write cannot commit a fallback-profile edit');
});

await check('Options export and import round trip every named profile, every rule category and account selections', async () => {
    const original = workerHarness();
    const rules = { countries: 'Japan', regions: 'South Asia', accounts: B, tags: 'Security', bioTags: 'Research',
        links: 'example.com', pcf: 'Government', languages: 'en', affiliations: 'ExampleOrg', allowedUsers: 'Reader' };
    for (const [accountId, name] of [[A, 'Research'], [B, 'Personal']]) {
        const created = await original.request(PROFILE_MESSAGES.CREATE_PROFILE, { name }, 'default', accountId);
        assert.equal(created.success, true);
        for (const source of FILTER_SOURCES) {
            const result = await original.request(source.set, { action: 'add', [source.valueKey]: rules[source.kind] }, created.profileId, accountId);
            assert.equal(result.success, true, `${name}: ${source.field}`);
        }
        const settings = Object.fromEntries(PROFILE_SETTING_KEYS.filter(key => typeof DEFAULT_SETTINGS[key] === 'boolean')
            .map(key => [key, accountId === A ? !DEFAULT_SETTINGS[key] : DEFAULT_SETTINGS[key]]));
        Object.assign(settings, { minFollowing: accountId === A ? 12 : 34, minPosts: accountId === A ? 56 : 78,
            minHandleDigits: 3, minDisplayNameDigits: 2, regionCountrySelections: { 'south asia': ['india'] } });
        assert.equal((await original.request(MESSAGE_TYPES.SET_SETTINGS, settings, created.profileId, accountId)).success, true);
    }
    await original.request(MESSAGE_TYPES.SET_SETTINGS, { showFlags: false });
    const options = fs.readFileSync(new URL('../src/options/options.js', import.meta.url), 'utf8');
    const functions = ['exportBackup', 'handleImportFile', 'loadConfiguration'];
    const production = parseAst(options).body.filter(node => node.type === 'FunctionDeclaration' && functions.includes(node.id.name))
        .map(node => options.slice(node.start, node.end)).join('\n');
    const transport = h => async message => JSON.parse(JSON.stringify(await h.send(message)));
    const exporter = createProfileClient({ transport: transport(original) });
    await exporter.initialize({ accountId: A });
    let exported;
    const status = { style: {} }, host = { setAttribute() {}, removeAttribute() {} };
    const elements = { btnExportCache: {}, importStatus: status, optBadgeSize: {} };
    const sandbox = vm.createContext({ profileClient: exporter, elements, FILTER_SOURCES, PROFILE_MESSAGES, MESSAGE_TYPES,
        BACKUP_FORMAT, VERSION: '4.3.0',
        // Browser modules share one realm; adapt VM JSON objects to the helper's
        // Node realm so its plain-object validation represents that environment.
        prepareBackupImport: data => prepareBackupImport(JSON.parse(JSON.stringify(data))), Blob, console,
        document: { getElementById: () => host, createElement: () => ({ click() {} }) },
        URL: { createObjectURL: blob => { exported = blob; return 'blob:test'; }, revokeObjectURL() {} },
        setTimeout: () => 1, showSaveStatus() {}, confirm: () => true,
        LISTS: FILTER_SOURCES.map(source => ({ ...source, label: source.field })), TOGGLES: [],
        mountBlockingEditor() {}, applyPendingReleaseNavigation() {},
        loadCacheStats: async () => {}, loadStatistics: async () => {}, loadTheme: async () => {}, loadCloudCacheStatus: async () => {} });
    vm.runInContext(`let configurationRequest=0,blockingEditor={},settingsLoaded=true;${production}`, sandbox);
    await vm.runInContext('exportBackup()', sandbox);
    assert.ok(exported, 'The real Options export handler must produce a downloadable backup');
    const text = await exported.text(), backup = JSON.parse(text);
    const expected = JSON.parse(JSON.stringify((await original.request(PROFILE_MESSAGES.EXPORT_PROFILES)).data));
    assert.deepEqual(backup.profiles, expected);
    assert.equal(backup.profiles.profiles.length, 3);
    assert.equal(backup.profiles.accounts[A], exporter.state.profileId);
    assert.equal(backup.settings.showFlags, false);
    assert.ok(!text.includes('authorization') && !text.includes('x-csrf-token'));

    const restored = workerHarness();
    const extra = await restored.request(PROFILE_MESSAGES.CREATE_PROFILE, { name: 'Will be replaced' });
    const importer = createProfileClient({ transport: transport(restored) });
    await importer.initialize({ accountId: A, profileId: extra.profileId });
    sandbox.profileClient = importer;
    sandbox.file = { text: async () => text };
    await vm.runInContext('handleImportFile(file)', sandbox);
    assert.ok(status.textContent.startsWith('Backup imported.'), status.textContent);
    const actual = JSON.parse(JSON.stringify((await restored.request(PROFILE_MESSAGES.EXPORT_PROFILES)).data));
    assert.deepEqual(actual, expected, 'Names, IDs, all rules, per-profile behavior and account assignments survive the real import route');
    assert.equal(importer.state.ready, true);
    assert.equal(importer.state.profileId, backup.profiles.accounts[A], 'The Options reload recovers when its pinned profile was removed by the backup');
    assert.equal((await restored.request(MESSAGE_TYPES.GET_SETTINGS)).data.showFlags, false);
    const revisions = [...Object.keys(backup.profiles)].filter(key => /revision/i.test(key));
    assert.deepEqual(revisions, [], 'Internal ordering counters are not portable account configuration');
    const legacyExpected = structuredClone(expected);
    const selected = legacyExpected.profiles.find(profile => profile.id === importer.state.profileId);
    selected.settings.minPosts = 123;
    selected.filters.blockedCountries = ['germany'];
    sandbox.file = { text: async () => JSON.stringify({ version: '4.2.0', exportFormat: '2.4',
        settings: { minPosts: 123 }, blockedCountries: ['Germany'] }) };
    await vm.runInContext('handleImportFile(file)', sandbox);
    assert.ok(status.textContent.startsWith('Backup imported.'), status.textContent);
    const legacyActual = JSON.parse(JSON.stringify((await restored.request(PROFILE_MESSAGES.EXPORT_PROFILES)).data));
    assert.deepEqual(legacyActual, legacyExpected,
        'An older Options backup replaces only its supplied selected-profile fields, preserving sibling profiles and omitted rules');
});

console.log(`${checks} profile backend regression groups passed. No network requests made.`);
