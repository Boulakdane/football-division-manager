'use strict';

/**
 * First-visit language: Arabic is the default, the document starts in RTL, and
 * a choice made in the switcher is remembered on the next visit.
 */
const { test, expect } = require('@playwright/test');

test('a first visit opens in Arabic and remembers another choice', async ({ page }) => {
  // The suite seeds kickoff_lang=en so existing English copy keeps matching.
  // Clearing it once reproduces a visitor who has never chosen a language,
  // while the session flag keeps the stored choice alive after a reload.
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('e2e-lang-cleared')) {
      localStorage.removeItem('kickoff_lang');
      sessionStorage.setItem('e2e-lang-cleared', '1');
    }
  });

  await page.goto('/');

  await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('#language-select')).toHaveValue('ar');

  const arabicLabel = (await page.evaluate(() => t('tabStandings'))).trim();
  expect(arabicLabel).not.toBe('Standings');
  await expect(page.locator('#nav-standings')).toContainText(arabicLabel);

  // Choosing French persists and survives a reload.
  await page.locator('#language-select').selectOption('fr');
  await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  expect(await page.evaluate(() => localStorage.getItem('kickoff_lang'))).toBe('fr');

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
  await expect(page.locator('#language-select')).toHaveValue('fr');
});
