'use strict';

const { test, expect } = require('@playwright/test');

test('public pages load, languages switch and the admin login opens', async ({ page }) => {
  const consoleErrors = [];
  const pageErrors = [];

  page.on('console', message => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', error => pageErrors.push(error.message));

  // Never send real recovery email from CI. Capture the request instead and
  // return GoTrue responses so both the success and failure UI paths can be
  // asserted without contacting the mail service.
  let resetRequest = null;
  let failRecovery = false;
  const authRequests = [];
  page.on('request', request => {
    if (request.url().includes('/auth/v1/')) authRequests.push(`${request.method()} ${request.url()}`);
  });
  await page.route('**/auth/v1/recover*', async route => {
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'POST, OPTIONS',
          'access-control-allow-headers': '*'
        }
      });
      return;
    }
    resetRequest = {
      method: route.request().method(),
      url: route.request().url(),
      body: route.request().postDataJSON()
    };
    await route.fulfill({
      status: failRecovery ? 500 : 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: failRecovery ? '{"message":"temporary failure"}' : '{}'
    });
  });

  // Force the production configuration so CI proves the same public read path
  // visitors use, rather than whatever happens to be in the development project.
  await page.goto('/?env=prod');

  await expect(page.locator('#standings-table-body tr').first()).toBeVisible();
  await expect(page.locator('#data-error')).toBeHidden();
  expect(await page.locator('#standings-table-body tr').count()).toBeGreaterThan(0);

  await page.locator('#nav-fixtures').click();
  await expect(page.locator('#view-fixtures')).toBeVisible();
  await expect(page.locator('#fixtures-container > *').first()).toBeVisible();
  expect(await page.locator('#fixtures-container > *').count()).toBeGreaterThan(0);

  await page.locator('#nav-teams').click();
  await expect(page.locator('#view-teams')).toBeVisible();
  await expect(page.locator('#teams-container > *').first()).toBeVisible();
  expect(await page.locator('#teams-container > *').count()).toBeGreaterThan(0);

  const language = page.locator('#language-select');
  await language.selectOption('fr');
  await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  await expect(page.locator('#nav-standings')).toContainText('Classement');

  await language.selectOption('ar');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  const arabicLabel = (await page.locator('#nav-standings').innerText()).trim();
  expect(arabicLabel).not.toBe('Classement');
  expect(arabicLabel.length).toBeGreaterThan(0);

  await language.selectOption('en');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');

  await page.locator('#btn-admin-login').click();
  await expect(page.locator('#modal-login')).toBeVisible();
  await expect(page.locator('#login-email')).toBeVisible();
  await expect(page.locator('#login-password')).toBeVisible();
  await expect(page.locator('#form-login button[type="submit"]')).toBeVisible();

  // Account recovery is reachable from the login dialog without sending mail.
  await page.locator('[data-action="forgot-password"]').click();
  await expect(page.locator('#reset-request-panel')).toBeVisible();
  await expect(page.locator('#login-panel')).toBeHidden();
  await expect(page.locator('#auth-modal-title')).toHaveText('Reset your password');
  await expect(page.locator('#reset-email')).toBeVisible();
  await expect(page.locator('#form-reset-request button[type="submit"]')).toBeVisible();

  await page.locator('#reset-email').fill('e2e-reset@example.com');
  await page.locator('#form-reset-request button[type="submit"]').click();
  await expect(page.locator('#reset-success')).toContainText('If an account exists');
  expect(resetRequest, authRequests.join('\n')).not.toBeNull();
  expect(resetRequest.method).toBe('POST');
  expect(resetRequest.url).toContain('/auth/v1/recover');
  expect(new URL(resetRequest.url).searchParams.get('redirect_to')).toBe('http://127.0.0.1:8765/?env=prod');
  expect(resetRequest.body.email).toBe('e2e-reset@example.com');

  // A server failure is surfaced as a retry message, not a fake success.
  failRecovery = true;
  await page.locator('#form-reset-request button[type="submit"]').click();
  await expect(page.locator('#reset-error')).toContainText('Could not send the reset email');
  await expect(page.locator('#reset-success')).toBeHidden();

  await page.locator('[data-action="reset-back"]').click();
  await expect(page.locator('#login-panel')).toBeVisible();
  await expect(page.locator('#reset-request-panel')).toBeHidden();

  await page.locator('#modal-login button[data-action="close-modal"]').first().click();
  await expect(page.locator('#modal-login')).toBeHidden();

  expect(pageErrors, 'uncaught page errors').toEqual([]);
  // The mocked recovery failure intentionally returns HTTP 500; Chromium logs
  // that network response as a console error even though the app handled it.
  const unexpectedConsoleErrors = consoleErrors.filter(
    message => !message.includes('status of 500')
  );
  expect(unexpectedConsoleErrors, 'unexpected console errors').toEqual([]);
});

test('a scorer sees the badge and only their live fixtures, and admins manage roles', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));

  await page.goto('/?env=prod');
  await expect(page.locator('#standings-table-body tr').first()).toBeVisible();
  await page.waitForFunction(() => typeof idleWatcherInstalled !== 'undefined' && idleWatcherInstalled === true);

  // Fake a signed-in scorer on a live fixture they are assigned to. No real
  // session or write is created; every RPC below is stubbed.
  await page.evaluate(() => {
    window.__roleCalls = [];
    window.__officialCalls = [];
    currentUser = { id: 'e2e-scorer', email: 'scorer@example.com' };
    currentRole = 'scorer';
    const match = appState.matches.find(m => m.seasonId === appState.activeSeasonId) || appState.matches[0];
    window.__liveMatchId = match.id;
    // Keep the active season, the viewed season and the fixture in agreement.
    appState.activeSeasonId = match.seasonId;
    appState.viewSeasonId = match.seasonId;
    appState.eventsReady = true;
    match.status = 'LIVE';
    match.eventsCounted = true;
    appState.matchOfficials = [{ matchId: match.id, userId: 'e2e-scorer' }];
    updateAuthUI();
    switchTab('fixtures');
    renderApp();
  });

  await expect(page.locator('#role-badge')).toHaveText('Scorer');
  await expect(page.locator('#role-badge')).toBeVisible();
  expect(await page.evaluate(() => isScorer())).toBe(true);
  expect(await page.evaluate(() => isAdmin())).toBe(false);

  // Only the assigned fixture gets the button.
  const buttons = page.locator('[data-action="live-entry"]');
  await expect(buttons.first()).toBeVisible();
  expect(await buttons.count()).toBe(1);
  // Admin-only controls stay in the DOM but are hidden for a scorer.
  await expect(page.locator('#fixtures-container [data-action="edit-match"]').first()).toBeHidden();

  await buttons.first().click();
  const liveModal = page.locator('#modal-live');
  await expect(liveModal).toBeVisible();
  await expect(page.locator('#live-entry-player')).toBeVisible();
  await expect(page.locator('#live-entry-type option')).toHaveCount(3);
  await page.locator('#modal-live [data-action="close-modal"]').first().click();
  await expect(liveModal).toBeHidden();

  // The admin-only dialog is reachable and drives the two management RPCs.
  await page.evaluate(() => {
    currentUser = { id: 'e2e-admin', email: 'admin@example.com' };
    currentRole = 'admin';
    updateAuthUI();
    dbListUsers = async () => ([
      { id: 'e2e-admin', email: 'admin@example.com', role: 'admin' },
      { id: 'e2e-scorer', email: 'scorer@example.com', role: 'scorer' }
    ]);
    dbSetUserRole = async (id, role) => { window.__roleCalls.push([id, role]); };
    dbSetMatchOfficials = async (id, users) => { window.__officialCalls.push([id, users]); };
    refreshData = async () => {};
    openUsersModal();
  });

  const usersModal = page.locator('#modal-users');
  await expect(usersModal).toBeVisible();
  await expect(usersModal).toContainText('scorer@example.com');
  await expect(page.locator('#users-body select[data-change="user-role"]')).toHaveCount(2);

  await page.locator('#users-body [data-change="toggle-official"]').first().check();
  await page.locator('#users-body [data-action="save-officials"]').click();
  await expect.poll(() => page.evaluate(() => window.__officialCalls.length)).toBe(1);
  expect(await page.evaluate(() => window.__officialCalls[0][0])).toBe(await page.evaluate(() => window.__liveMatchId));
  expect(await page.evaluate(() => window.__officialCalls[0][1])).toEqual(['e2e-scorer']);

  // The scorer is still listed, so the role select can demote them.
  await page.locator('#users-body select[data-change="user-role"]').nth(1).selectOption('viewer');
  expect(await page.evaluate(() => window.__roleCalls)).toEqual([['e2e-scorer', 'viewer']]);

  expect(pageErrors, 'uncaught page errors').toEqual([]);
});

test('sign out everywhere confirms, uses the global scope and handles failure', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));

  await page.goto('/?env=prod');
  await expect(page.locator('#standings-table-body tr').first()).toBeVisible();
  // initAuth() runs alongside the first render; wait for its idle watcher so a
  // late applySession(null) cannot overwrite the fake state below.
  await page.waitForFunction(() => typeof idleWatcherInstalled !== 'undefined' && idleWatcherInstalled === true);

  // This is a UI-level test with a mocked auth call: it never creates a real
  // session or revokes any account. Fake admin state is enough to open the
  // admin-only control.
  await page.evaluate(() => {
    window.__logoutAllScopes = [];
    currentUser = { id: 'e2e-user', email: 'e2e@example.com' };
    currentRole = 'admin';
    updateAuthUI();
    db.auth.signOut = async options => {
      window.__logoutAllScopes.push(options && options.scope);
      return { error: null };
    };
    openLogoutAllModal();
  });

  const modal = page.locator('#modal-logout-all');
  await expect(modal).toBeVisible();
  await expect(modal).toContainText('Sign out everywhere?');

  // Cancel leaves the current state untouched.
  await page.locator('#modal-logout-all [data-action="close-modal"]').last().click();
  await expect(modal).toBeHidden();
  expect(await page.evaluate(() => isSignedIn())).toBe(true);

  // Confirm calls global revocation, clears local state and returns to login.
  await page.evaluate(() => openLogoutAllModal());
  await page.locator('[data-action="logout-all-confirm"]').click();
  await expect(page.locator('#modal-login')).toBeVisible();
  await expect(page.locator('#login-success')).toContainText('Signed out on all devices');
  expect(await page.evaluate(() => window.__logoutAllScopes)).toEqual(['global']);
  expect(await page.evaluate(() => isSignedIn())).toBe(false);

  // A failed global call keeps the session and surfaces the retry message.
  await page.evaluate(() => {
    closeAllModals();
    currentUser = { id: 'e2e-user', email: 'e2e@example.com' };
    currentRole = 'admin';
    updateAuthUI();
    db.auth.signOut = async () => ({ error: { message: 'temporary failure' } });
    openLogoutAllModal();
  });
  await page.locator('[data-action="logout-all-confirm"]').click();
  await expect(modal).toBeVisible();
  await expect(page.locator('#logout-all-error')).toContainText('Could not sign out all devices');
  expect(await page.evaluate(() => isSignedIn())).toBe(true);

  expect(pageErrors, 'uncaught page errors').toEqual([]);
});
