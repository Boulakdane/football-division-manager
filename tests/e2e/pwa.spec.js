'use strict';

/*
 * Installable app (PWA): manifest, icons, service worker, install button and
 * offline shell.
 *
 * The suite keeps Playwright's default of allowing service workers; the mocks in
 * the other specs are all cross-origin (Supabase), which the worker passes
 * through untouched. The explicit `allow` here keeps these tests honest if that
 * default ever changes.
 */
const { test, expect } = require('@playwright/test');

test.use({ serviceWorkers: 'allow' });

/** Resolve once the worker is active and controlling this page. */
async function waitForController(page) {
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
}

test('manifest, icons and service worker make the app installable', async ({ page }) => {
  await page.goto('/');

  const response = await page.request.get('/manifest.webmanifest');
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toContain('application/manifest+json');

  const manifest = await response.json();
  expect(manifest.name).toContain('BSGST');
  expect(manifest.display).toBe('standalone');
  expect(manifest.start_url).toBe('./');
  expect(manifest.icons.some(icon => icon.sizes === '192x192' && icon.purpose === 'any')).toBe(true);
  expect(manifest.icons.some(icon => icon.sizes === '512x512' && icon.purpose === 'any')).toBe(true);
  expect(manifest.icons.some(icon => icon.purpose === 'maskable')).toBe(true);

  // Every declared icon must actually be served, at the declared size.
  for (const icon of manifest.icons) {
    const iconResponse = await page.request.get('/' + icon.src);
    expect(iconResponse.status(), icon.src).toBe(200);
    expect(iconResponse.headers()['content-type']).toBe('image/png');
    const bytes = await iconResponse.body();
    expect(bytes.subarray(0, 8).toString('hex'), icon.src).toBe('89504e470d0a1a0a');
    const size = bytes.readUInt32BE(16) + 'x' + bytes.readUInt32BE(20);
    expect(size, icon.src).toBe(icon.sizes);
  }

  await waitForController(page);

  const cached = await page.evaluate(async () => {
    const names = await caches.keys();
    const cache = await caches.open(names.find(name => name.startsWith('kickoff-shell')));
    const requests = await cache.keys();
    return {
      paths: requests.map(request => new URL(request.url).pathname),
      // Anything not served from this origin (Supabase REST/Auth) would be a
      // privacy problem: a shared device could replay another user's response.
      foreign: requests
        .map(request => new URL(request.url).origin)
        .filter(origin => origin !== window.location.origin)
    };
  });
  expect(cached.paths.some(path => path.endsWith('/index.html'))).toBe(true);
  expect(cached.paths.some(path => path.endsWith('/js/app.js'))).toBe(true);
  expect(cached.paths.some(path => path.endsWith('/icons/icon-512.png'))).toBe(true);

  // Supabase/auth traffic must never be cached in the shared shell cache.
  expect(cached.foreign).toEqual([]);

  await expect(page.locator('#btn-install-app')).toBeVisible();
  await expect(page.locator('footer [data-action="install-app"]')).toBeVisible();

  // The header button is icon-only, so the tooltip and the accessible name
  // carry the translated label.
  for (const lang of ['fr', 'ar', 'en']) {
    await page.locator('#language-select').selectOption(lang);
    const label = await page.evaluate(() => t('installApp'));
    await expect(page.locator('#btn-install-app')).toHaveAttribute('title', label);
    await expect(page.locator('#btn-install-app')).toHaveAttribute('aria-label', label);
  }
});

test('the button replays the deferred browser prompt', async ({ page }) => {
  await page.goto('/');

  await page.evaluate(() => {
    const event = new Event('beforeinstallprompt');
    event.prompt = () => { window.__prompted = true; };
    event.userChoice = Promise.resolve({ outcome: 'accepted' });
    window.dispatchEvent(event);
  });

  await page.locator('#btn-install-app').click();
  expect(await page.evaluate(() => window.__prompted === true)).toBe(true);

  // Accepting the prompt means the app now runs as an installed window.
  await expect(page.locator('#btn-install-app')).toBeHidden();
});

test('without a browser prompt the button explains how to install', async ({ page }) => {
  // Swallow the real event so the hint path is deterministic.
  await page.addInitScript(() => {
    window.addEventListener('beforeinstallprompt', event => event.stopImmediatePropagation(), true);
  });
  await page.goto('/');

  const hint = await page.evaluate(() => t('installAppHint'));
  const footer = page.locator('footer [data-action="install-app"]');
  await expect(footer).toBeVisible();
  await footer.click();

  await expect(page.locator('#toast')).toBeVisible();
  await expect(page.locator('#toast')).toHaveText(hint);
});

test('offline reload still shows the app shell and warns that data is missing', async ({ page, context }) => {
  await page.goto('/');
  await waitForController(page);

  await context.setOffline(true);
  try {
    await page.reload({ waitUntil: 'domcontentloaded' });

    // The cached shell renders: header, navigation and the install action are
    // all present without a network.
    await expect(page.locator('#nav-standings')).toBeVisible();
    await expect(page.locator('#btn-install-app')).toBeVisible();

    // Live league data is not cached, so the app says so instead of showing
    // an empty table as if it were the real standings.
    await expect(page.locator('#data-error')).toBeVisible();
    await expect(page.locator('#data-error-text')).not.toBeEmpty();
  } finally {
    await context.setOffline(false);
  }
});
