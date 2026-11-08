/** One document's selected filter profile; never a browser-global active profile. */
import { MESSAGE_TYPES, normalizeAccountId } from './constants.js';
import { FILTER_SOURCES } from './filter-registry.js';
import { PROFILE_MESSAGES, PROFILE_SETTING_KEYS, DEFAULT_PROFILE_ID, isProfileId } from './profiles.js';

const profileSettings = new Set(PROFILE_SETTING_KEYS);
const filterMessages = new Map(FILTER_SOURCES.flatMap(source => [[source.get, source], [source.set, source], [source.update, source]]));
const cancelled = () => ({ success: false, code: 'CANCELLED', error: 'The selected profile changed.' });
const validId = isProfileId;
const clone = value => JSON.parse(JSON.stringify(value));

function catalog(value) {
    if (!Array.isArray(value) || value.length > 100) return null;
    const seen = new Set();
    const result = [];
    for (const item of value) {
        if (!item || !validId(item.id) || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 100 || seen.has(item.id)) return null;
        seen.add(item.id);
        result.push({ id: item.id, name: item.name });
    }
    return result;
}

function snapshot(value) {
    if (!value || typeof value !== 'object' || !value.settings || typeof value.settings !== 'object' ||
        Array.isArray(value.settings) || !value.filters || typeof value.filters !== 'object' ||
        !Number.isSafeInteger(value.revision) || value.revision < 0 ||
        !Number.isSafeInteger(value.globalRevision) || value.globalRevision < 0) return null;
    for (const source of FILTER_SOURCES) {
        const values = value.filters[source.field];
        if (!Array.isArray(values) || values.some(item => typeof item !== 'string')) return null;
    }
    return clone(value);
}

/** Preserve independently newer global preferences and profile rules. */
export function mergeProfileSnapshot(previous, incoming) {
    const next = snapshot(incoming);
    if (!next) return null;
    if (!previous) return next;
    const acceptProfile = next.revision >= previous.revision;
    const acceptGlobal = next.globalRevision >= previous.globalRevision;
    if (!acceptProfile && !acceptGlobal) return null;
    const settings = { ...previous.settings };
    for (const [key, value] of Object.entries(next.settings)) {
        if (profileSettings.has(key) ? acceptProfile : acceptGlobal) settings[key] = value;
    }
    return {
        settings,
        filters: acceptProfile ? next.filters : previous.filters,
        revision: Math.max(previous.revision, next.revision),
        globalRevision: Math.max(previous.globalRevision, next.globalRevision)
    };
}

export function createProfileClient({ transport, onSnapshot = () => {}, onCatalog = () => {}, onContextChange = () => {}, getAccountId = null,
    followEditorSelection = false }) {
    let accountId = null;
    let profileId = null;
    let profiles = [];
    let current = null;
    let ready = false;
    let pending = false;
    let disposed = false;
    let generation = 0;
    let catalogRevision = -1;
    let bindings = null;
    let bindingsRevision = -1;
    let editorProfileId = null;
    let editorRevision = -1;
    let selectionRevision = -1;
    const listeners = new Set();

    const state = () => ({ accountId, profileId, profiles, snapshot: current, ready, pending, generation });
    function notify() { for (const listener of listeners) listener(state()); }
    function context() { return { accountId, profileId }; }
    function isCurrent(captured, epoch) {
        return !disposed && epoch === generation && captured.accountId === accountId && captured.profileId === profileId;
    }
    function syncViewer() {
        if (!getAccountId) return false;
        const liveAccount = normalizeAccountId(getAccountId()) || null;
        if (liveAccount === accountId) return false;
        void bindAccount(liveAccount).catch(() => {});
        return true;
    }
    function publish(next) {
        const merged = mergeProfileSnapshot(current, next);
        if (!merged) return false;
        if (current && JSON.stringify(current) === JSON.stringify(merged)) return true;
        current = merged;
        onSnapshot(current, state());
        notify();
        return true;
    }
    function applyCatalog(value, revision) {
        const next = catalog(value);
        if (!next || (Number.isSafeInteger(revision) && revision < catalogRevision)) return false;
        profiles = next;
        if (Number.isSafeInteger(revision)) catalogRevision = revision;
        onCatalog(state());
        notify();
        return true;
    }
    function reconcile() {
        if (!ready || pending || disposed) return;
        const selectedExists = profiles.some(item => item.id === profileId);
        const binding = accountId ? bindings?.[accountId] || DEFAULT_PROFILE_ID : editorProfileId;
        const bindingRevision = accountId ? bindingsRevision : editorRevision;
        // A URL supplies the initial editor, not a permanent account override.
        // Only extension pages opt into the shared unbound editor selection;
        // content with an unknown viewer keeps its explicitly chosen profile.
        const followsSelection = accountId !== null || followEditorSelection;
        const removed = !selectedExists && catalogRevision >= selectionRevision;
        const desired = removed ? DEFAULT_PROFILE_ID :
            followsSelection && bindingRevision >= selectionRevision ? binding : profileId;
        if (validId(desired) && desired !== profileId && profiles.some(item => item.id === desired)) {
            // A rule write can have a newer ledger revision than this selection.
            // Retain the selection's own fence when its GET returns newer data.
            void change(PROFILE_MESSAGES.GET_PROFILE_CONTEXT, null, accountId, desired,
                removed ? catalogRevision : bindingRevision).catch(() => {});
        }
    }

    async function change(type, payload, nextAccount, requestedProfile, selectedAt = null) {
        if (disposed) return cancelled();
        if (type !== PROFILE_MESSAGES.GET_PROFILE_CONTEXT && getAccountId) {
            const liveAccount = normalizeAccountId(getAccountId()) || null;
            if (liveAccount !== accountId) { await bindAccount(liveAccount); return cancelled(); }
        }
        const previous = state();
        const previousSelectionRevision = selectionRevision;
        const captured = context();
        accountId = normalizeAccountId(nextAccount) || null;
        if (accountId !== previous.accountId) selectionRevision = -1;
        profileId = validId(requestedProfile) ? requestedProfile : null;
        current = null;
        ready = false;
        pending = true;
        const epoch = ++generation;
        onContextChange(state());
        notify();
        try {
            const response = await transport({ type, ...(payload ? { payload } : {}), profileContext:
                type === PROFILE_MESSAGES.GET_PROFILE_CONTEXT ? { accountId, ...(profileId ? { profileId } : {}) } : captured });
            if (disposed || epoch !== generation) return cancelled();
            if (syncViewer()) return cancelled();
            const next = snapshot(response?.snapshot);
            const nextCatalog = catalog(response?.profiles);
            if (!response?.success || !validId(response.profileId) || !next || !nextCatalog ||
                (normalizeAccountId(response.accountId) || null) !== accountId) {
                throw new Error(response?.error || 'Could not load the selected profile.');
            }
            profileId = response.profileId;
            selectionRevision = selectedAt ?? next.revision;
            ready = true;
            pending = false;
            applyCatalog(nextCatalog, next.revision);
            publish(next);
            reconcile();
            return response;
        } catch (error) {
            if (disposed || epoch !== generation) return cancelled();
            // A failed selection can restore this account's previous profile. A
            // failed identity change must never restore a different viewer's rules.
            if (accountId === previous.accountId) {
                selectionRevision = previousSelectionRevision;
                profileId = previous.profileId;
                current = previous.snapshot;
                ready = previous.ready;
            }
            pending = false;
            if (current) onSnapshot(current, state());
            notify();
            reconcile();
            throw error;
        }
    }

    function initialize(options = {}) {
        const nextAccount = Object.hasOwn(options, 'accountId') ? options.accountId : accountId;
        return change(PROFILE_MESSAGES.GET_PROFILE_CONTEXT, null, nextAccount, options.profileId);
    }

    function bindAccount(nextAccount) {
        const normalized = normalizeAccountId(nextAccount) || null;
        if (pending && normalized === accountId) return Promise.resolve(cancelled());
        if (ready && normalized === accountId) return Promise.resolve({ success: true, ...state() });
        return initialize({ accountId: normalized, ...(normalized ? {} : { profileId: DEFAULT_PROFILE_ID }) });
    }

    function acceptData(type, response) {
        if (!response?.success || response.profileId !== profileId || !current) return;
        const incoming = clone(current);
        incoming.revision = response.revision;
        incoming.globalRevision = response.globalRevision ?? current.globalRevision;
        if (type === MESSAGE_TYPES.GET_SETTINGS || type === MESSAGE_TYPES.SET_SETTINGS) {
            if (!response.data || typeof response.data !== 'object' || Array.isArray(response.data)) return;
            incoming.settings = response.data;
            if (Array.isArray(response.blockedRegions)) incoming.filters.blockedRegions = response.blockedRegions;
        } else {
            const source = filterMessages.get(type);
            if (!source || !Array.isArray(response.data)) return;
            incoming.filters[source.field] = response.data;
        }
        publish(incoming);
    }

    async function send(message) {
        if (disposed) return cancelled();
        const supplied = message.profileContext;
        if (!supplied && getAccountId) {
            const liveAccount = normalizeAccountId(getAccountId()) || null;
            if (liveAccount !== accountId) { await bindAccount(liveAccount); return cancelled(); }
        }
        const captured = supplied ? { accountId: normalizeAccountId(supplied.accountId) || null, profileId: supplied.profileId } : context();
        const epoch = generation;
        if (!captured.profileId || (!ready && !supplied)) {
            if (filterMessages.has(message.type) || [MESSAGE_TYPES.GET_SETTINGS, MESSAGE_TYPES.SET_SETTINGS,
                MESSAGE_TYPES.IMPORT_DATA].includes(message.type)) return cancelled();
            return transport({ ...message, profileContext: { accountId: captured.accountId, profileId: DEFAULT_PROFILE_ID } });
        }
        const response = await transport({ ...message, profileContext: captured });
        syncViewer();
        // Restoring a backup may deliberately remove the selected profile. Its
        // committed success is still useful to the importing page after a switch.
        if (!isCurrent(captured, epoch)) {
            return message.type === MESSAGE_TYPES.IMPORT_DATA && response?.success ? response : cancelled();
        }
        if (response?.success && response.snapshot && response.profileId === profileId) publish(response.snapshot);
        else acceptData(message.type, response);
        if (response?.success && current && (filterMessages.has(message.type) ||
            message.type === MESSAGE_TYPES.GET_SETTINGS || message.type === MESSAGE_TYPES.SET_SETTINGS)) {
            const source = filterMessages.get(message.type);
            return { ...response, data: source ? current.filters[source.field] : current.settings,
                revision: current.revision, globalRevision: current.globalRevision,
                ...(Array.isArray(response.blockedRegions) ? {
                    blockedRegions: current.filters.blockedRegions, regionsRevision: current.revision
                } : {}) };
        }
        return response;
    }

    async function metadata(type, payload) {
        if (disposed) return cancelled();
        if (getAccountId) {
            const liveAccount = normalizeAccountId(getAccountId()) || null;
            if (liveAccount !== accountId) { await bindAccount(liveAccount); return cancelled(); }
        }
        const captured = context();
        const epoch = generation;
        const response = await transport({ type, payload, profileContext: captured });
        syncViewer();
        if (!isCurrent(captured, epoch)) return cancelled();
        if (!response?.success) throw new Error(response?.error || 'Could not save the profile.');
        if (response.profiles) applyCatalog(response.profiles, response.snapshot?.revision ?? response.revision);
        if (response.profileId !== profileId) return initialize({ accountId, profileId: response.profileId });
        if (response.snapshot) publish(response.snapshot);
        return response;
    }

    function accept(message) {
        if (disposed || !message || typeof message !== 'object') return false;
        if (message.type === PROFILE_MESSAGES.PROFILE_CATALOG_UPDATED) {
            if (catalog(message.profiles) && Number.isSafeInteger(message.revision) && message.revision >= 0) {
                applyCatalog(message.profiles, message.revision);
                // Catalog names and remembered selections are independent of
                // newer data/metadata replies received by this document.
                if (message.revision >= bindingsRevision && message.accounts &&
                    typeof message.accounts === 'object' && !Array.isArray(message.accounts)) {
                    bindings = { ...message.accounts };
                    bindingsRevision = message.revision;
                }
                if (message.revision >= editorRevision && validId(message.editorProfileId)) {
                    editorProfileId = message.editorProfileId;
                    editorRevision = message.revision;
                }
                reconcile();
            }
            return true;
        }
        if (message.type === PROFILE_MESSAGES.PROFILE_STATE_UPDATED) {
            if (syncViewer()) return true;
            if (ready && message.profileId === profileId) publish(message.snapshot);
            return true;
        }
        if (message.type === MESSAGE_TYPES.SETTINGS_UPDATED || filterMessages.has(message.type)) {
            // Full snapshots make settings + every list one transaction. The
            // legacy per-list broadcasts cannot safely advance that revision.
            return true;
        }
        return false;
    }

    return {
        get state() { return state(); }, initialize, bindAccount, send, accept,
        select: id => id === profileId ? Promise.resolve({ success: true, ...state() }) :
            change(PROFILE_MESSAGES.SELECT_PROFILE, { profileId: id }, accountId, id),
        create: name => change(PROFILE_MESSAGES.CREATE_PROFILE, { name }, accountId, null),
        rename: (id, name) => metadata(PROFILE_MESSAGES.RENAME_PROFILE, { profileId: id, name }),
        remove: id => metadata(PROFILE_MESSAGES.DELETE_PROFILE, { profileId: id }),
        subscribe(listener) { listeners.add(listener); listener(state()); return () => listeners.delete(listener); },
        dispose() { disposed = true; generation++; listeners.clear(); }
    };
}

function urlProfileContext(url) {
    const accountId = normalizeAccountId(url.searchParams.get('accountId')) || null;
    // A saved URL may contain yesterday's profile. Resolve a known account's
    // current binding in the existing GET instead of reopening that stale choice.
    if (accountId) return { accountId };
    const profileId = url.searchParams.get('profileId');
    return validId(profileId) ? { accountId: null, profileId } : null;
}

/** Extension pages use the originating X account or active extension editor. */
export async function resolveProfileContext(api, location = globalThis.location) {
    try {
        const context = urlProfileContext(new URL(location?.href || 'https://extension.invalid/'));
        if (context) return context;
    } catch { /* Use the active X tab when there is no explicit options context. */ }
    try {
        const tabs = await api.tabs.query({ active: true, currentWindow: true });
        const optionsUrl = api.runtime?.getURL?.('options/options.html');
        const optionsPage = optionsUrl ? new URL(optionsUrl) : null;
        const isOptionsPage = url => optionsPage && url.protocol === optionsPage.protocol &&
            url.host === optionsPage.host && url.pathname === optionsPage.pathname;
        for (const tab of tabs) {
            if (!Number.isInteger(tab.id)) continue;
            if (!tab.url && optionsPage) {
                // Without the tabs permission, an active extension tab can lack
                // its URL. Read only our extension views in that exact active
                // tab; never infer identity from another open Options page.
                let views;
                try { views = await api.extension?.getViews?.({ type: 'tab', tabId: tab.id }); } catch { continue; }
                for (const view of Array.isArray(views) ? views : []) {
                    try {
                        const url = new URL(view.location.href);
                        if (isOptionsPage(url)) return urlProfileContext(url) || { accountId: null };
                    } catch { /* A closing/inaccessible view cannot supply context. */ }
                }
                continue;
            }
            let url;
            try { url = new URL(tab.url); } catch { continue; }
            if (isOptionsPage(url)) {
                return urlProfileContext(url) || { accountId: null };
            }
            if (/^https?:\/\/(?:[^/.]+\.)?(?:x|twitter)\.com\//i.test(tab.url)) {
                const response = await api.tabs.sendMessage(tab.id, { type: PROFILE_MESSAGES.GET_PROFILE_CONTEXT });
                if (response?.success) {
                    const accountId = normalizeAccountId(response.accountId) || null;
                    return { accountId, ...(!accountId && validId(response.profileId) ? { profileId: response.profileId } : {}) };
                }
            }
        }
    } catch { /* No X tab or content listener is a normal extension-page context. */ }
    return { accountId: null };
}

export const resolveActiveProfileContext = resolveProfileContext;
