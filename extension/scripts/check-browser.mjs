/** Load the real MV3 build in an isolated browser against a synthetic X timeline. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const extension = path.join(root, 'dist/chrome');
const artifacts = path.join(root, '.tmp/browser');
await mkdir(artifacts, { recursive: true });
const profile = await mkdtemp(path.join(os.tmpdir(), 'x-posed-browser-'));
const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true, viewport: { width: 1180, height: 920 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
});
const errors = [];
const requests = [];
context.setDefaultTimeout(15000);
await context.setOffline(true);
context.on('request', request => requests.push(request.url()));
context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
const authors = {
    allowed_us: 'United States', allowed_ro: 'Romania', outside: 'India',
    unknown: null, broad: 'North America', quoted_out: 'Japan'
};
function name(handle) {
    return `<div data-testid="User-Name"><a href="/${handle}"><span>${handle}</span></a><a href="/${handle}"><span>@${handle}</span></a></div>`;
}
function post(handle, index, quote = '') {
    return `<article data-testid="tweet" id="post-${handle}">${name(handle)}
        <a href="/${handle}/status/${index}"><time>Today</time></a>
        <div data-testid="tweetText" lang="en">Synthetic test post from ${handle}.</div>${quote}</article>`;
}
const html = `<!doctype html><html><head><meta charset="utf-8"><title>Synthetic X timeline</title>
    <style>body{background:#101014;color:#eee;font:16px sans-serif;margin:24px}article{padding:16px;border:1px solid #444;margin:12px 0}a{color:#bbb}main{max-width:680px}[data-testid=quoteTweet]{border:1px solid #777;padding:12px;margin-top:12px}</style></head>
    <body><nav aria-label="Primary"><a data-testid="AppTabBar_Profile_Link" href="/reader">Profile</a></nav><main>
    ${Object.keys(authors).filter(handle => handle !== 'quoted_out').map((handle, i) => post(handle, i + 1,
        handle === 'allowed_ro' ? `<div data-testid="quoteTweet" role="link" tabindex="0">${name('quoted_out')}<p>Quoted test post.</p></div>` : '')).join('')}
    ${post('pending_user', 99)}</main></body></html>`;
// Fulfill or abort every HTTP request. This test never reaches X or any cache server.
await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.protocol === 'chrome-extension:') return route.continue();
    return url.origin === 'https://x.com' && url.pathname === '/home'
        ? route.fulfill({ contentType: 'text/html', body: html }) : route.abort();
});

try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const id = new URL(worker.url()).host;
    const options = await context.newPage();
    await options.goto(`chrome-extension://${id}/options/options.html`);
    await options.locator('.xp-nav-item[data-target="panel-blocking"]').click();
    await options.getByRole('tab', { name: 'Locations', exact: true }).click();
    const focus = options.getByRole('switch', { name: 'Only keep Europe and the United States', exact: true });
    const unknown = options.getByRole('switch', { name: 'Also filter unknown locations', exact: true });
    await focus.waitFor();
    assert.equal(await focus.isChecked(), false);
    assert.equal(await unknown.isDisabled(), true);
    const seeded = await options.evaluate(async authors => {
        const result = [];
        for (const [screenName, location] of Object.entries(authors)) {
            result.push(await chrome.runtime.sendMessage({ type: 'SET_CACHE', payload: {
                screenName, data: { location, device: 'United States App Store', locationAccurate: true }
            } }));
        }
        return result;
    }, authors);
    assert.ok(seeded.every(result => result.success), 'Test observations accepted by the real background cache');
    const page = await context.newPage();
    await page.goto('https://x.com/home');
    await page.locator('#post-outside [data-x-country="united states"], #post-outside [data-x-country="India"], #post-outside [data-x-country="india"]').waitFor();
    assert.equal(await page.locator('#post-outside').isVisible(), true);
    await focus.check();
    await page.waitForFunction(() => getComputedStyle(document.querySelector('#post-outside')).display === 'none');
    for (const handle of ['allowed_us', 'allowed_ro', 'unknown', 'broad', 'pending_user']) {
        assert.equal(await page.locator(`#post-${handle}`).isVisible(), true, handle);
    }
    await page.locator('[data-testid="quoteTweet"] [data-x-quote-block="hide"]').waitFor({ state: 'attached' });
    assert.equal(await page.locator('#post-allowed_ro').isVisible(), true);
    await unknown.check();
    await page.waitForFunction(() => ['unknown', 'broad'].every(handle =>
        getComputedStyle(document.querySelector(`#post-${handle}`)).display === 'none'));
    assert.equal(await page.locator('#post-pending_user').isVisible(), true, 'Failed/unresolved requests remain visible');
    await focus.uncheck();
    await page.waitForFunction(() => getComputedStyle(document.querySelector('#post-outside')).display !== 'none');
    assert.equal(await page.locator('#post-unknown').isVisible(), true);
    await focus.check();
    await options.getByRole('radio', { name: 'Highlight', exact: true }).check();
    await page.locator('#post-outside.x-tweet-highlighted').waitFor();
    assert.equal(await page.locator('#post-outside').isVisible(), true);
    const cloud = await options.evaluate(async () => chrome.runtime.sendMessage({ type: 'GET_CLOUD_CACHE_STATUS' }));
    assert.equal(cloud.enabled, false, 'Fresh installs do not opt into the community cache');
    await options.waitForFunction(() => !document.querySelector('#save-status')?.classList.contains('visible'));
    await options.screenshot({ path: path.join(artifacts, 'locations-desktop.png'), fullPage: true });
    await options.setViewportSize({ width: 390, height: 844 });
    await options.screenshot({ path: path.join(artifacts, 'locations-mobile.png'), fullPage: true });
    await options.getByRole('tab', { name: 'Behavior', exact: true }).click();
    await options.getByRole('tab', { name: /Locations/ }).click();
    assert.equal(await focus.isChecked(), true, 'Locations can be reopened through keyboard-accessible tabs');
    await options.reload();
    await options.locator('.xp-nav-item[data-target="panel-blocking"]').click();
    assert.equal(await focus.isChecked(), true, 'Preference survives an options-page reload');
    assert.equal(await unknown.isChecked(), true);
    assert.deepEqual(errors, [], 'No browser runtime errors');
    assert.equal(requests.some(url => url.includes('x-posed-cache.xaitax.workers.dev')), false);
    console.log('PASS real Chrome extension: opt-in, account-country filtering, unknowns, failed lookups, quotes, live updates, Highlight, persistence, mobile tabs and cache opt-in.');
    console.log(`Screenshots: ${artifacts}`);
} catch (error) {
    for (const [index, page] of context.pages().entries()) {
        await page.screenshot({ path: path.join(artifacts, `failure-${index}.png`), fullPage: true }).catch(() => {});
    }
    throw new Error(`${error.message}\nBrowser errors: ${JSON.stringify(errors)}`, { cause: error });
} finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
}
