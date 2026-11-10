/** Account-location filtering, independent of the optional app-store flag source. */
import { COUNTRY_LIST, REGION_LIST, canonicalCountry } from './constants.js';
import { getRegionCountries } from './region-membership.js';

// Keep upstream's geographic coverage, plus Cyprus (an EU member).
export const EUROPE_US_COUNTRIES = Object.freeze([
    ...new Set([...getRegionCountries('europe'), 'cyprus', 'united states'])
].sort());
const allowedCountries = new Set(EUROPE_US_COUNTRIES);
const knownCountries = new Set(COUNTRY_LIST);
const regionKeys = new Set(REGION_LIST.map(region => region.key));

/** Mixed regions cannot establish which side of the allowlist an account is on. */
export function classifyAccountLocation(value) {
    const country = canonicalCountry(value);
    if (!country) return 'unknown';
    if (allowedCountries.has(country) || country === 'europe' || country === 'european union') return 'allowed';
    if (regionKeys.has(country)) {
        const members = getRegionCountries(country);
        const allowed = members.filter(member => allowedCountries.has(member)).length;
        if (allowed === members.length && members.length > 0) return 'allowed';
        return allowed > 0 ? 'unknown' : 'outside';
    }
    return knownCountries.has(country) ? 'outside' : 'unknown';
}

/** Unresolved requests must remain visible so they can finish or retry. */
export function locationFocusReason(info, settings, resolved = Boolean(info)) {
    if (settings.europeUsOnly !== true || !resolved) return '';
    const classification = classifyAccountLocation(info?.location);
    if (classification === 'outside') return 'locationFocus';
    return classification === 'unknown' && settings.hideUnknownLocations === true ? 'unknownLocation' : '';
}
