/** Badges for X Chat's virtualized inbox, one-to-one header and message requests. */
import { CHAT_LIMITS, chatPeerId, profileHandleFromUrl } from '../shared/chat-data.js';
import { normalizeAccountId } from '../shared/constants.js';
import { readFollowingViewer } from '../shared/following-data.js';

const CHAT_ROWS = '[data-testid^="dm-conversation-item-"], [data-testid^="dm-message-request-item-"], [data-testid="dm-conversation-header"]';
const OWN_UI = '.x-chat-badge-mount, #x-posed-hovercard';
const validHandle = value => typeof value === 'string' && value.length > 0 && value.length <= 15 && !/[^a-zA-Z0-9_]/.test(value);

/** Never interpret an @mention in the message preview as its author. */
export function inboxHandle(description, displayName) {
    if (typeof description !== 'string' || description.length > 8192 || !displayName) return null;
    const prefix = `${displayName}, @`;
    if (!description.startsWith(prefix)) return null;
    const match = /^([a-zA-Z0-9_]{1,15}), /.exec(description.slice(prefix.length));
    return match ? match[1].toLowerCase() : null;
}

/** All identity evidence belongs to this native row, never a neighboring chat. */
function describe(root, viewer, identities) {
    const header = root.getAttribute('data-testid') === 'dm-conversation-header';
    const link = header ? root.querySelector('[data-testid="dm-conversation-username"]')?.closest('a[href]') :
        root.matches('a[href]') ? root : root.querySelector('a[href]');
    if (!link || !root.contains(link)) return null;
    const nameLine = header ? link.querySelector('[data-testid="dm-conversation-username"]') :
        link.querySelector('[data-inbox-row] .font-chirp')?.parentElement?.parentElement;
    const name = header ? nameLine?.querySelector('.font-chirp') : link.querySelector('[data-inbox-row] .font-chirp');
    const displayName = name?.textContent?.trim();
    if (!name || !nameLine || !displayName || displayName.length > 4096) return null;
    const href = link.getAttribute('href');
    const viewerId = viewer?.startsWith('id:') ? viewer.slice(3) : null;
    const peerId = header ? chatPeerId(globalThis.location?.pathname, viewerId) : chatPeerId(href, viewerId);
    // A chat row must be a proven one-to-one conversation. Group identifiers and
    // rows from another signed-in account cannot borrow a participant's flag.
    if (!header && !peerId) return null;
    const handle = header ? profileHandleFromUrl(href) :
        identities.get(peerId) || inboxHandle(root.getAttribute('aria-description'), displayName);
    if (!handle) return null;
    const owner = root.matches('a') ? root.parentElement : root;
    if (!owner || owner.closest('a[href]')) return null;
    return { root, owner, name, nameLine, displayName, screenName: handle, peerId };
}

/**
 * The content session supplies its existing cached lookup and badge renderer.
 * Chat data stays in memory, and no message text enters a lookup or cache.
 */
export function createChatBadges({ getSettings, getViewer = readFollowingViewer, getKnownInfo = () => null,
    lookupInfo, renderBadge, updateBadge = () => false, replaceAnchor = () => {}, isNewer = () => false,
    prepareRoot = () => {} }) {
    const identities = new Map();
    const handles = new Map();
    const entries = new Map();
    const observed = new Set();
    const pending = new Map();
    const retries = new Map();
    let viewer = getViewer();
    let started = false;
    let disposed = false;
    let enabled = false;
    let frame = null;
    const scopes = new Map();
    let resize = null;
    let visibility = null;
    let generation = 0;
    let appearance = '';

    function allowed() {
        const settings = getSettings();
        return settings?.enabled === true && (settings.showFlags !== false || settings.showDevices !== false);
    }

    function remove(entry) {
        resize?.unobserve(entry.nameLine);
        resize?.unobserve(entry.mount);
        const badge = entry.mount.querySelector('.x-info-badge');
        if (badge) replaceAnchor(badge, null);
        entry.mount.remove();
        entry.nameLine.classList.remove('x-chat-name-line');
        entry.nameLine.style.removeProperty('--x-chat-badge-space');
        entry.owner.classList.remove('x-chat-badge-owner');
        delete entry.owner.dataset.xChatHandle;
        entries.delete(entry.root);
    }

    function clear() {
        for (const entry of [...entries.values()]) remove(entry);
    }

    function schedule() {
        if (!started || disposed || frame !== null) return;
        frame = requestAnimationFrame(() => { frame = null; scan(); });
    }

    function discover(node = document) {
        if (disposed) return;
        if (node.shadowRoot) watchRoot(node.shadowRoot);
        for (const element of node.querySelectorAll?.('*') || []) {
            if (element.shadowRoot) watchRoot(element.shadowRoot);
        }
    }

    function releaseRoot(root, scope) {
        scope.observer.disconnect();
        root.removeEventListener('scroll', schedule, true);
        scope.cleanupStyles?.();
        scopes.delete(root);
    }

    function watchRoot(root) {
        if (scopes.has(root) || scopes.size >= 30 || disposed) return;
        const scope = { ready: root === document, preparing: false, cleanupStyles: null, observer: null };
        scope.observer = new MutationObserver(mutations => {
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (node.nodeType === 1 && !node.closest?.(OWN_UI)) discover(node);
                }
            }
            if (mutations.some(mutation => !mutation.target.closest?.(OWN_UI) &&
                (mutation.target.closest?.(CHAT_ROWS) || [...mutation.addedNodes, ...mutation.removedNodes]
                    .some(node => node.nodeType === 1 && (node.matches(CHAT_ROWS) || node.querySelector(CHAT_ROWS)))))) {
                schedule();
            }
        });
        scopes.set(root, scope);
        scope.observer.observe(root === document ? document.body : root, {
            childList: true, characterData: true, subtree: true, attributes: true,
            attributeFilter: ['href', 'aria-description', 'data-testid']
        });
        // Scroll events do not cross a shadow boundary, even in capture phase.
        root.addEventListener('scroll', schedule, true);
        discover(root);
        schedule();
    }

    function shadowRootReady() {
        for (const root of scopes.keys()) discover(root);
        schedule();
    }

    function remember(users) {
        if (disposed || !allowed() || getViewer() !== viewer || !Array.isArray(users)) return;
        let changed = false;
        for (const user of users.slice(0, CHAT_LIMITS.MAX_USERS_PER_RESPONSE)) {
            const id = normalizeAccountId(user?.i);
            if (!id || !validHandle(user.u)) continue;
            const handle = user.u.toLowerCase();
            const previousHandle = identities.get(id);
            const previousId = handles.get(handle);
            if (previousHandle === handle && previousId === id) continue;
            changed = true;
            if (previousHandle && previousHandle !== handle) handles.delete(previousHandle);
            if (previousId && previousId !== id) identities.delete(previousId);
            identities.delete(id);
            identities.set(id, handle);
            handles.set(handle, id);
            if (identities.size > CHAT_LIMITS.MAX_ENTRIES) {
                const oldest = identities.keys().next().value;
                handles.delete(identities.get(oldest));
                identities.delete(oldest);
            }
        }
        if (changed) schedule();
    }

    function position(entry) {
        if (!entry.mount.isConnected || !entry.nameLine.isConnected) return;
        const width = Math.ceil(entry.mount.getBoundingClientRect().width);
        if (!width) return;
        const space = `${width + 6}px`;
        if (entry.nameLine.style.getPropertyValue('--x-chat-badge-space') !== space) {
            entry.nameLine.style.setProperty('--x-chat-badge-space', space);
        }
        const box = entry.owner.getBoundingClientRect();
        const line = entry.nameLine.getBoundingClientRect();
        const left = `${line.right - box.left - width}px`;
        const top = `${line.top - box.top + line.height / 2}px`;
        if (entry.mount.style.left !== left) entry.mount.style.left = left;
        if (entry.mount.style.top !== top) entry.mount.style.top = top;
    }

    function current(entry) {
        const next = describe(entry.root, viewer, identities);
        return !disposed && allowed() && getViewer() === viewer && entry.root.isConnected &&
            entries.get(entry.root) === entry && next?.screenName === entry.screenName &&
            next.peerId === entry.peerId && next.name === entry.name && next.nameLine === entry.nameLine &&
            next.displayName === entry.displayName;
    }

    function paint(entry, info) {
        if (!info || typeof info !== 'object' || !current(entry)) return;
        const latest = getKnownInfo(entry.screenName);
        if (latest && isNewer(latest, info)) info = latest;
        const id = normalizeAccountId(info.meta?.restId);
        if (id && entry.peerId && id !== entry.peerId) return;
        if (id) remember([{ u: entry.screenName, i: id }]);
        const badge = entry.mount.querySelector('.x-info-badge');
        if (!badge || !updateBadge(badge, entry.screenName, info)) {
            entry.mount.replaceChildren();
            renderBadge({ ...entry, info, settings: getSettings() });
            const replacement = entry.mount.querySelector('.x-info-badge');
            if (badge) replaceAnchor(badge, replacement);
        }
        position(entry);
    }

    function resolve(entry) {
        const known = getKnownInfo(entry.screenName);
        if (known) { paint(entry, known); return; }
        if ((retries.get(entry.screenName) || 0) > Date.now()) return;
        let promise = pending.get(entry.screenName);
        if (!promise) {
            if (pending.size >= 32) return;
            const startedGeneration = generation;
            promise = Promise.resolve().then(() => lookupInfo(entry.screenName)).then(info => {
                if (generation !== startedGeneration) return null;
                if (!info) {
                    retries.delete(entry.screenName);
                    retries.set(entry.screenName, Date.now() + 60000);
                    if (retries.size > CHAT_LIMITS.MAX_ENTRIES) retries.delete(retries.keys().next().value);
                }
                return info;
            }).catch(() => {
                if (generation === startedGeneration) {
                    retries.set(entry.screenName, Date.now() + 60000);
                    if (retries.size > CHAT_LIMITS.MAX_ENTRIES) retries.delete(retries.keys().next().value);
                }
                return null;
            }).finally(() => {
                if (pending.get(entry.screenName) === promise) {
                    pending.delete(entry.screenName);
                    schedule();
                }
            });
            pending.set(entry.screenName, promise);
        }
        // Every row owns its continuation. A virtual row changed while awaiting
        // this shared lookup cannot display the previous person's information.
        if (entry.promise === promise) return;
        entry.promise = promise;
        promise.then(info => {
            if (entry.promise === promise) { entry.promise = null; paint(entry, info); }
        });
    }

    function isVisible(root) {
        if (!root.isConnected || !root.getClientRects().length) return false;
        const box = root.getBoundingClientRect();
        return box.bottom > 0 && box.top < innerHeight && box.right > 0 && box.left < innerWidth;
    }

    function scan() {
        if (disposed || !enabled || !document.body) return;
        const nextViewer = getViewer();
        if (nextViewer !== viewer) {
            clear(); identities.clear(); handles.clear(); retries.clear(); pending.clear();
            viewer = nextViewer; generation++;
        }
        for (const entry of [...entries.values()]) {
            if (!current(entry)) remove(entry);
        }
        const roots = new Set();
        for (const [root, scope] of scopes) {
            if (root !== document && !root.host.isConnected) { releaseRoot(root, scope); continue; }
            const rows = Array.from(root.querySelectorAll(CHAT_ROWS));
            if (!rows.length) continue;
            if (!scope.ready) {
                if (!scope.preparing) {
                    scope.preparing = true;
                    Promise.resolve().then(() => prepareRoot(root)).then(cleanup => {
                        if (disposed || !scopes.has(root)) { cleanup?.(); return; }
                        scope.cleanupStyles = cleanup;
                        scope.ready = true;
                        schedule();
                    }).catch(error => console.warn('X-Posed: Could not prepare Chat styles:', error?.message));
                }
                continue;
            }
            for (const row of rows) {
                if (roots.size >= CHAT_LIMITS.MAX_ENTRIES) break;
                roots.add(row);
            }
        }
        for (const root of observed) {
            if (!roots.has(root)) { visibility?.unobserve(root); observed.delete(root); }
        }
        for (const root of roots) {
            if (!observed.has(root)) { visibility?.observe(root); observed.add(root); }
            if (!isVisible(root)) continue;
            let entry = entries.get(root);
            if (!entry) {
                const description = describe(root, viewer, identities);
                if (!description) continue;
                const mount = document.createElement('span');
                mount.className = 'x-chat-badge-mount';
                description.owner.classList.add('x-chat-badge-owner');
                description.owner.dataset.xChatHandle = description.screenName;
                description.nameLine.classList.add('x-chat-name-line');
                description.owner.append(mount);
                entry = { ...description, mount, promise: null };
                entries.set(root, entry);
                resize?.observe(entry.nameLine);
                resize?.observe(mount);
            }
            resolve(entry);
            position(entry);
        }
    }

    function refresh() {
        if (disposed) return;
        const nextEnabled = allowed();
        const settings = getSettings();
        const nextAppearance = JSON.stringify(['showFlags', 'flagFromDevice', 'showDevices', 'showVpnIndicator',
            'showInfoIcon', 'hovercardTrigger', 'badgeSize', 'showBadgeBackground'].map(key => settings?.[key]));
        if (nextEnabled !== enabled) {
            generation++;
            enabled = nextEnabled;
            clear(); pending.clear(); retries.clear();
            if (!enabled) { identities.clear(); handles.clear(); }
        }
        if (appearance !== nextAppearance) { clear(); appearance = nextAppearance; }
        window.dispatchEvent(new CustomEvent('x-posed-set-chat', { detail: JSON.stringify({ enabled }) }));
        if (started && enabled) {
            for (const root of scopes.keys()) discover(root);
        }
        schedule();
    }

    function onUsers(event) {
        if (!allowed() || typeof event.detail !== 'string' || event.detail.length > CHAT_LIMITS.MAX_RELAY_LENGTH) return;
        try {
            const data = JSON.parse(event.detail);
            if (data.viewer === viewer && viewer === getViewer() && Array.isArray(data.users) &&
                data.users.length <= CHAT_LIMITS.MAX_BATCH_ENTRIES) remember(data.users);
        } catch { /* Ignore malformed page events. */ }
    }

    function retry() {
        retries.clear();
        schedule();
    }

    function start() {
        if (started || disposed) return;
        started = true;
        if (typeof ResizeObserver === 'function') {
            resize = new ResizeObserver(() => {
                for (const entry of entries.values()) position(entry);
            });
        }
        if (typeof IntersectionObserver === 'function') visibility = new IntersectionObserver(schedule);
        watchRoot(document);
        window.addEventListener('x-posed-chat-users', onUsers);
        window.addEventListener('x-posed-page-ready', refresh);
        window.addEventListener('x-posed-shadow-root-ready', shadowRootReady);
        window.addEventListener('resize', schedule);
        refresh();
    }

    function dispose() {
        if (disposed) return;
        disposed = true; generation++;
        window.dispatchEvent(new CustomEvent('x-posed-set-chat', { detail: '{"enabled":false}' }));
        for (const [root, scope] of scopes) releaseRoot(root, scope);
        resize?.disconnect(); visibility?.disconnect();
        if (frame !== null) cancelAnimationFrame(frame);
        window.removeEventListener('x-posed-chat-users', onUsers);
        window.removeEventListener('x-posed-page-ready', refresh);
        window.removeEventListener('x-posed-shadow-root-ready', shadowRootReady);
        window.removeEventListener('resize', schedule);
        clear(); identities.clear(); handles.clear(); pending.clear(); retries.clear(); observed.clear();
    }

    return { start, refresh, remember, retry, dispose };
}
