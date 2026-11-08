/** Public chat identity projection only. No messages, permissions or requests. */
import { normalizeAccountId } from './constants.js';

export const CHAT_LIMITS = Object.freeze({
    MAX_ENTRIES: 500,
    MAX_USERS_PER_RESPONSE: 500,
    MAX_BATCH_ENTRIES: 100,
    MAX_RELAY_LENGTH: 65536
});

const RESERVED_PATHS = new Set([
    'home', 'explore', 'notifications', 'messages', 'search', 'settings', 'i', 'compose',
    'chat', 'login', 'logout', 'signup', 'account', 'intent', 'share', 'tos', 'privacy'
]);

function isHandle(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= 15 && !/[^a-zA-Z0-9_]/.test(value);
}

function xUrl(raw, maxLength = 512) {
    if (typeof raw !== 'string' || !raw || raw.length > maxLength || /[\s\\]/.test(raw)) return null;
    // Do not resolve another origin's relative URLs or scheme-relative URLs.
    if (!(raw.startsWith('/') && !raw.startsWith('//')) && !raw.startsWith('https://x.com/')) return null;
    try {
        const parsed = new URL(raw, 'https://x.com');
        return parsed.origin === 'https://x.com' && !parsed.username && !parsed.password ? parsed : null;
    } catch {
        return null;
    }
}

/** Recognize only the observed public-user operation, independent of its query ID. */
export function isChatUsersUrl(raw) {
    if (typeof raw !== 'string' || raw.length > 32768 || /[\s\\]/.test(raw)) return false;
    try {
        const parsed = new URL(raw);
        return parsed.origin === 'https://api.x.com' && !parsed.username && !parsed.password &&
            /^\/graphql\/[a-zA-Z0-9_-]{1,100}\/GetUsersByIdsForXChat(?![\s\S])/.test(parsed.pathname);
    } catch {
        return false;
    }
}

/** An account profile path is identity evidence; app routes and display names are not. */
export function profileHandleFromUrl(raw) {
    const parsed = xUrl(raw);
    const match = parsed && /^\/([a-zA-Z0-9_]{1,15})\/?(?![\s\S])/.exec(parsed.pathname);
    const handle = match?.[1].toLowerCase();
    return handle && !RESERVED_PATHS.has(handle) ? handle : null;
}

/** Select the peer of a verified viewer in a two-person conversation only. */
export function chatPeerId(raw, viewerId) {
    if (!normalizeAccountId(viewerId)) return null;
    const parsed = xUrl(raw);
    const match = parsed && /^\/i\/chat\/(?:requests\/)?([1-9][0-9]{0,19})-([1-9][0-9]{0,19})\/?(?![\s\S])/.exec(parsed.pathname);
    if (!match || match[1] === match[2]) return null;
    if (match[1] === viewerId) return match[2];
    if (match[2] === viewerId) return match[1];
    return null;
}

/**
 * Project only explicit, consistent public ID/handle pairs from X's chat users.
 * Conflicting representations in one response remain unknown, rather than choosing
 * a winner that could attach one person's flag to someone else's recycled row.
 */
export function projectChatIdentities(data) {
    const rows = data?.data?.get_member_results?.results;
    if (!Array.isArray(rows)) return [];
    const identities = [];
    const idHandles = new Map();
    const handleIds = new Map();
    const conflictedIds = new Set();
    const conflictedHandles = new Set();
    for (let index = 0; index < Math.min(rows.length, CHAT_LIMITS.MAX_USERS_PER_RESPONSE); index++) {
        const row = rows[index];
        const user = row?.member_results?.result;
        const id = normalizeAccountId(row?.id);
        const name = user?.core?.screen_name;
        if (row?.status !== 'Found' || user?.__typename !== 'User' || !id ||
            row.member_results?.rest_id !== id || user.rest_id !== id || !isHandle(name)) continue;
        const handle = name.toLowerCase();
        const previousHandle = idHandles.get(id);
        const previousId = handleIds.get(handle);
        if (previousHandle !== undefined && previousHandle !== handle) {
            conflictedIds.add(id);
            conflictedHandles.add(previousHandle);
            conflictedHandles.add(handle);
        }
        if (previousId !== undefined && previousId !== id) {
            conflictedHandles.add(handle);
            conflictedIds.add(previousId);
            conflictedIds.add(id);
        }
        if (previousHandle === handle && previousId === id) continue;
        idHandles.set(id, handle);
        handleIds.set(handle, id);
        identities.push({ u: handle, i: id });
    }
    return identities.filter(identity => !conflictedIds.has(identity.i) && !conflictedHandles.has(identity.u));
}
