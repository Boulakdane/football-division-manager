'use strict';

const { test, expect } = require('@playwright/test');

test('public pages load, languages switch and the admin login opens', async ({ page }) => {
  const consoleErrors = [];
  const pageErrors = [];

  page.on('console', message => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', error => pageErrors.push(error.message));

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
  await page.locator('#modal-login button[data-action="close-modal"]').first().click();
  await expect(page.locator('#modal-login')).toBeHidden();

  expect(pageErrors, 'uncaught page errors').toEqual([]);
  expect(consoleErrors, 'console errors').toEqual([]);
});
