/** Public X web-client defaults; the CSRF token must come from the requesting session. */
import { BEARER_TOKEN } from './constants.js';

export function generateFallbackHeaders(csrfToken) {
    if (!csrfToken) return null;

    return {
        'authorization': BEARER_TOKEN,
        'x-csrf-token': csrfToken,
        'x-twitter-active-user': 'yes',
        'x-twitter-auth-type': 'OAuth2Session',
        'content-type': 'application/json'
    };
}
