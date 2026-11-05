'use strict';

/**
 * The footer Privacy link opens the in-app summary and links to the full policy.
 * It must work in every language, stay out of the admin flow, and close with Escape.
 */
const { test, expect } = require('@playwright/test');

test('the footer privacy link opens the summary and the full policy', async ({ page }) => {
  await page.goto('/');

  const trigger = page.locator('[data-action="open-privacy"]');
  await expect(trigger).toBeVisible();
  await expect(trigger).toContainText(await page.evaluate(() => t('privacyLink')));

  await trigger.click();
  const modal = page.locator('#modal-privacy');
  await expect(modal).toBeVisible();
  await expect(modal.locator('h3')).toContainText(await page.evaluate(() => t('privacyTitle')));
  await expect(modal).toContainText(await page.evaluate(() => t('privacyPublic')));
  await expect(modal.locator('a')).toHaveAttribute(
    'href',
    'https://github.com/Boulakdane/football-division-manager/blob/main/docs/PRIVACY.md'
  );

  // Escape closes the dialog and returns focus to the footer trigger.
  await page.keyboard.press('Escape');
  await expect(modal).toBeHidden();
  await expect(trigger).toBeFocused();

  // The same content follows the language switcher.
  await page.locator('#language-select').selectOption('ar');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await trigger.click();
  await expect(modal).toBeVisible();
  await expect(modal.locator('h3')).toContainText('الخصوصية والبيانات');
  await expect(modal.locator('a')).toContainText('سياسة الخصوصية');
});
