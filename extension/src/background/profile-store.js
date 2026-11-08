/** One serialized, atomic local record for profiles and per-account selections. */
import { FILTER_SOURCES } from '../shared/filter-registry.js';
import { normalizeAccountId, canonicalCountry } from '../shared/constants.js';
import {
    DEFAULT_PROFILE_ID, PROFILE_STORAGE_KEY, PROFILE_LIMITS, isProfileId, profileName,
    profileSettings, profileFilters, normalizeProfileRule, normalizeProfilesBackup
} from '../shared/profiles.js';

const clone = value => JSON.parse(JSON.stringify(value));
const unchanged = (left, right) => JSON.stringify(left) === JSON.stringify(right);

export class ProfileStore {
    constructor(storage, { getSettings, getFilters, getGlobalRevision = () => 0, createId = () => crypto.randomUUID() }) {
        this.storage = storage;
        this.getSettings = getSettings;
        this.getFilters = getFilters;
        this.getGlobalRevision = getGlobalRevision;
        this.createId = createId;
        this.state = null;
        this.queue = Promise.resolve();
        this.loading = null;
    }

    async load() {
        if (this.state) return;
        if (this.loading) return this.loading;
        this.loading = (async () => {
            const stored = (await this.storage.get(PROFILE_STORAGE_KEY))[PROFILE_STORAGE_KEY];
            if (stored !== undefined) {
                const value = normalizeProfilesBackup(stored);
                const revision = stored.revision;
                if (!Number.isSafeInteger(revision) || revision < 0) throw new TypeError('Invalid profile revision.');
                this.state = { ...value, revision };
                return;
            }
            const initial = {
                version: 1, revision: 0, editorProfileId: DEFAULT_PROFILE_ID, accounts: {},
                profiles: [{ id: DEFAULT_PROFILE_ID, name: 'Default',
                    settings: profileSettings(this.getSettings(), { strict: false }),
                    filters: profileFilters(this.getFilters(), { strict: false }) }]
            };
            await this.storage.set({ [PROFILE_STORAGE_KEY]: initial });
            this.state = initial;
        })();
        try { await this.loading; } finally { this.loading = null; }
    }

    async commit(change) {
        await this.load();
        const operation = this.queue.then(async () => {
            const next = clone(this.state);
            change(next);
            if (unchanged(next, this.state)) return false;
            if (this.state.revision >= Number.MAX_SAFE_INTEGER) throw new RangeError('Profile revision limit reached.');
            next.revision = this.state.revision + 1;
            normalizeProfilesBackup(next);
            await this.storage.set({ [PROFILE_STORAGE_KEY]: next });
            this.state = next;
            return true;
        });
        this.queue = operation.catch(() => {});
        return operation;
    }

    context(accountId = null, requestedProfileId = null) {
        if (!this.state) throw new Error('Profiles are not loaded.');
        if (accountId !== null && !normalizeAccountId(accountId)) throw new TypeError('Invalid X account ID.');
        if (requestedProfileId !== null && !isProfileId(requestedProfileId)) throw new TypeError('Invalid profile ID.');
        const id = requestedProfileId || (accountId ? this.state.accounts[accountId] : this.state.editorProfileId) || DEFAULT_PROFILE_ID;
        const profile = this.state.profiles.find(item => item.id === id);
        if (!profile) throw Object.assign(new Error('This profile no longer exists.'), { code: 'PROFILE_NOT_FOUND' });
        return { accountId, profileId: id };
    }

    catalog() {
        return { profiles: this.state.profiles.map(({ id, name }) => ({ id, name })),
            accounts: { ...this.state.accounts }, editorProfileId: this.state.editorProfileId, revision: this.state.revision };
    }

    snapshot(context) {
        const { profileId } = this.context(context.accountId, context.profileId);
        const profile = this.state.profiles.find(item => item.id === profileId);
        return { settings: { ...this.getSettings(), ...clone(profile.settings) }, filters: clone(profile.filters),
            revision: this.state.revision, globalRevision: this.getGlobalRevision() };
    }

    response(context) {
        const resolved = this.context(context.accountId, context.profileId);
        return { success: true, ...resolved, profiles: this.catalog().profiles, snapshot: this.snapshot(resolved) };
    }

    select(accountId, profileId) {
        this.context(accountId, profileId);
        return this.commit(next => {
            if (!next.profiles.some(item => item.id === profileId)) throw new Error('This profile no longer exists.');
            if (accountId) next.accounts[accountId] = profileId;
            next.editorProfileId = profileId;
        });
    }

    async create(accountId, name) {
        this.context(accountId);
        name = profileName(name);
        const id = this.createId();
        if (!isProfileId(id) || id === DEFAULT_PROFILE_ID) throw new TypeError('Could not create a profile ID.');
        await this.commit(next => {
            if (next.profiles.length >= PROFILE_LIMITS.MAX_PROFILES) throw new Error('You can save up to 50 profiles.');
            if (next.profiles.some(item => item.id === id || item.name.toLowerCase() === name.toLowerCase())) {
                throw new Error('A profile with this name already exists.');
            }
            next.profiles.push({ id, name, settings: profileSettings(), filters: profileFilters() });
            if (accountId) next.accounts[accountId] = id;
            next.editorProfileId = id;
        });
        return id;
    }

    rename(context, name) {
        name = profileName(name);
        return this.commit(next => {
            const profile = next.profiles.find(item => item.id === context.profileId);
            if (!profile) throw new Error('This profile no longer exists.');
            if (next.profiles.some(item => item.id !== profile.id && item.name.toLowerCase() === name.toLowerCase())) {
                throw new Error('A profile with this name already exists.');
            }
            profile.name = name;
        });
    }

    remove(context) {
        if (context.profileId === DEFAULT_PROFILE_ID) throw new Error('The Default profile cannot be deleted.');
        return this.commit(next => {
            if (!next.profiles.some(item => item.id === context.profileId)) throw new Error('This profile no longer exists.');
            next.profiles = next.profiles.filter(item => item.id !== context.profileId);
            for (const id of Object.keys(next.accounts)) {
                if (next.accounts[id] === context.profileId) next.accounts[id] = DEFAULT_PROFILE_ID;
            }
            if (next.editorProfileId === context.profileId) next.editorProfileId = DEFAULT_PROFILE_ID;
        });
    }

    updateSettings(context, patch) {
        const update = profileSettings(patch, { partial: true });
        return this.commit(next => {
            const profile = next.profiles.find(item => item.id === context.profileId);
            if (!profile) throw new Error('This profile no longer exists.');
            profile.settings = { ...profile.settings, ...update };
        });
    }

    toggleSetting(context, key) {
        return this.commit(next => {
            const profile = next.profiles.find(item => item.id === context.profileId);
            if (!profile || typeof profile.settings[key] !== 'boolean') throw new TypeError('Invalid profile toggle.');
            profile.settings[key] = !profile.settings[key];
        });
    }

    updateRegion(context, { region, countries, activate = false }) {
        if (typeof activate !== 'boolean' || typeof region !== 'string') throw new TypeError('Invalid region-country update.');
        region = canonicalRegion(region);
        profileSettings({ regionCountrySelections: { [region]: [] } }, { partial: true });
        return this.commit(next => {
            const profile = next.profiles.find(item => item.id === context.profileId);
            if (!profile) throw new Error('This profile no longer exists.');
            const selections = { ...profile.settings.regionCountrySelections };
            if (countries === null) delete selections[region];
            else selections[region] = countries;
            profile.settings = { ...profile.settings, ...profileSettings({ regionCountrySelections: selections }, { partial: true }) };
            if (activate && !profile.filters.blockedRegions.includes(region)) profile.filters.blockedRegions.push(region);
        });
    }

    updateFilter(context, source, { action, value, values }) {
        if (!FILTER_SOURCES.some(item => item.field === source.field)) throw new TypeError('Invalid filter category.');
        const list = action === 'set' ? profileFilters({ [source.field]: values === undefined ? [] : values })[source.field] : null;
        const normalized = ['add', 'remove', 'toggle'].includes(action) ? normalizeProfileRule(source, value) : null;
        if (normalized === '') throw new TypeError('Invalid filter.');
        if (!['set', 'clear', 'add', 'remove', 'toggle'].includes(action)) throw new TypeError('Invalid filter action.');
        return this.commit(next => {
            const profile = next.profiles.find(item => item.id === context.profileId);
            if (!profile) throw new Error('This profile no longer exists.');
            const rules = new Set(profile.filters[source.field]);
            if (action === 'set') profile.filters[source.field] = list;
            else if (action === 'clear') profile.filters[source.field] = [];
            else {
                if (action === 'remove' || (action === 'toggle' && rules.has(normalized))) rules.delete(normalized);
                else rules.add(normalized);
                profile.filters[source.field] = [...rules];
            }
        });
    }

    export() {
        const result = clone(this.state);
        delete result.revision;
        return result;
    }

    importProfile(context, { settings = {}, filters = {} }) {
        const patch = profileSettings(settings, { partial: true });
        const lists = {};
        for (const source of FILTER_SOURCES) {
            if (Object.hasOwn(filters, source.field)) lists[source.field] = profileFilters({ [source.field]: filters[source.field] })[source.field];
        }
        return this.commit(next => {
            const profile = next.profiles.find(item => item.id === context.profileId);
            if (!profile) throw new Error('This profile no longer exists.');
            profile.settings = { ...profile.settings, ...patch };
            profile.filters = { ...profile.filters, ...lists };
        });
    }

    restore(value) {
        const portable = normalizeProfilesBackup(value);
        return this.commit(next => {
            const revision = next.revision;
            Object.assign(next, portable, { revision });
        });
    }
}

function canonicalRegion(value) {
    const source = FILTER_SOURCES.find(item => item.kind === 'regions');
    const region = canonicalCountry(normalizeProfileRule(source, value));
    if (!region) throw new TypeError('A region name is required.');
    return region;
}
