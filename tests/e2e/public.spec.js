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
