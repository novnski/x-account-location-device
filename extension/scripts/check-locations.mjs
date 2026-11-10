/** Location policy, persistence and portable settings; no network or X account. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { COUNTRY_LIST, DEFAULT_SETTINGS, STORAGE_KEYS } from '../src/shared/constants.js';
import { EUROPE_US_COUNTRIES, classifyAccountLocation, locationFocusReason } from '../src/shared/location-focus.js';
import { profileSettings } from '../src/shared/profiles.js';
import { prepareBackupImport } from '../src/shared/backup.js';

test('European countries, EU labels, territories and US aliases are allowed', () => {
    for (const location of [...EUROPE_US_COUNTRIES, ' Europe ', 'European Union', 'Eastern Europe (Non-EU)',
        'USA', 'United States of America', 'UK', 'Czechia']) {
        assert.equal(classifyAccountLocation(location), 'allowed', location);
    }
    assert.equal(new Set(EUROPE_US_COUNTRIES).size, EUROPE_US_COUNTRIES.length);
    for (const country of EUROPE_US_COUNTRIES) assert.ok(COUNTRY_LIST.includes(country), country);
    assert.ok(EUROPE_US_COUNTRIES.includes('cyprus'));
    assert.ok(EUROPE_US_COUNTRIES.includes('russia'));
});

test('Countries and regions outside the allowlist match', () => {
    for (const location of ['India', 'Nigeria', 'Japan', 'Canada', 'Australia', 'Turkey', 'Georgia',
        'South Asia', 'Africa', 'Asia', 'West Asia', 'South America', 'Antarctica']) {
        // West Asia contains Cyprus, so that broad label is ambiguous.
        assert.equal(classifyAccountLocation(location), location === 'West Asia' || location === 'Asia' ? 'unknown' : 'outside', location);
    }
});

test('Broad regions crossing the allowlist and unfamiliar labels remain unknown', () => {
    for (const location of ['North America', 'West Asia', 'Asia', '', 'Unknown', 'Mars', 'London', null, undefined, 17]) {
        assert.equal(classifyAccountLocation(location), 'unknown', String(location));
    }
});

test('Filtering is opt-in and uses account location independently of device country', () => {
    const indian = { location: 'India', device: 'United States App Store' };
    assert.equal(locationFocusReason(indian, DEFAULT_SETTINGS), '');
    const enabled = { ...DEFAULT_SETTINGS, europeUsOnly: true, flagFromDevice: true };
    assert.equal(locationFocusReason(indian, enabled), 'locationFocus');
    assert.equal(locationFocusReason({ location: 'Germany', device: 'India App Store' }, enabled), '');
});

test('Unknown filtering waits for resolved evidence and never blocks pending requests', () => {
    const enabled = { ...DEFAULT_SETTINGS, europeUsOnly: true };
    assert.equal(locationFocusReason({ location: null }, enabled), '');
    enabled.hideUnknownLocations = true;
    assert.equal(locationFocusReason(null, enabled, false), '');
    assert.equal(locationFocusReason(undefined, enabled), '');
    assert.equal(locationFocusReason({ location: 'India' }, enabled, false), '');
    assert.equal(locationFocusReason(null, enabled, true), 'unknownLocation');
    assert.equal(locationFocusReason({ location: 'North America' }, enabled), 'unknownLocation');
    assert.equal(locationFocusReason({ location: null }, enabled), 'unknownLocation');
    enabled.europeUsOnly = false;
    assert.equal(locationFocusReason(null, enabled, true), '');
});

test('Profile settings and backups preserve both controls and reject malformed values', () => {
    const controls = { europeUsOnly: true, hideUnknownLocations: true };
    const profile = profileSettings(controls);
    assert.equal(profile.europeUsOnly, true);
    assert.equal(profile.hideUnknownLocations, true);
    assert.equal(profileSettings({}).europeUsOnly, false, 'Existing profiles do not silently enable the mode');
    assert.equal(profileSettings({ europeUsOnly: 'true' }, { strict: false }).europeUsOnly, false);
    assert.deepEqual(prepareBackupImport({ settings: controls }).settings, controls);
    assert.deepEqual(prepareBackupImport({ settings: { enabled: true } }).settings, { enabled: true });
    for (const key of Object.keys(controls)) {
        for (const value of ['true', 1, null, {}]) {
            assert.throws(() => profileSettings({ [key]: value }), TypeError);
            assert.throws(() => prepareBackupImport({ settings: { [key]: value } }), TypeError);
        }
    }
});

test('Settings persist across restart, sanitize old data and recover after a failed write', async () => {
    const memory = new Map();
    let fail = false;
    globalThis.browser = { storage: { local: {
        async get(keys) { return Object.fromEntries(keys.filter(key => memory.has(key)).map(key => [key, structuredClone(memory.get(key))])); },
        async set(values) {
            if (fail) { fail = false; throw new Error('Synthetic write failure'); }
            for (const [key, value] of Object.entries(values)) memory.set(key, structuredClone(value));
        }
    } } };
    const { SettingsStorage } = await import('../src/shared/storage.js');
    const store = new SettingsStorage();
    await store.load();
    await store.set({ europeUsOnly: true, hideUnknownLocations: true });
    const restarted = new SettingsStorage();
    await restarted.load();
    assert.equal(restarted.get('europeUsOnly'), true);
    assert.equal(restarted.get('hideUnknownLocations'), true);
    await assert.rejects(restarted.set({ europeUsOnly: 'yes' }), TypeError);
    assert.equal(restarted.get('europeUsOnly'), true);
    fail = true;
    await assert.rejects(restarted.set({ europeUsOnly: false }), /Synthetic write failure/);
    assert.equal(restarted.get('europeUsOnly'), true);
    await restarted.set({ europeUsOnly: false });
    assert.equal(restarted.get('europeUsOnly'), false);
    memory.set(STORAGE_KEYS.SETTINGS, { europeUsOnly: 'false', hideUnknownLocations: {} });
    const sanitized = new SettingsStorage();
    await sanitized.load();
    assert.equal(sanitized.get('europeUsOnly'), false);
    assert.equal(sanitized.get('hideUnknownLocations'), false);
});
