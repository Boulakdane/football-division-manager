'use strict';

/*
 * Phone layout and the squad-import examples.
 *
 * Public visitors mostly arrive on a phone, in Arabic or French as often as in
 * English. This proves that:
 *   * the page itself never scrolls sideways on a phone, on every tab and in
 *     both writing directions (only the standings table scrolls, inside its own
 *     card, which is intended);
 *   * the import dialog links a real, filled .xlsx example that is served by the
 *     site (no Excel, no backend call) and that the label is translated.
 */

const { test, expect } = require('@playwright/test');

/** Elements sticking out of the viewport, ignoring content of a scroll container. */
function overflowReport() {
  const viewport = document.documentElement.clientWidth;
  const inScroller = el => {
    for (let parent = el.parentElement; parent; parent = parent.parentElement) {
      if (/(auto|scroll)/.test(getComputedStyle(parent).overflowX)) return true;
    }
    return false;
  };
  const offenders = [];
  document.querySelectorAll('body *').forEach(el => {
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || el.closest('.hidden')) return;
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    if (rect.right > viewport + 1 && !inScroller(el)) {
      offenders.push({
        tag: el.tagName.toLowerCase(),
        id: el.id || '',
        text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40),
        right: Math.round(rect.right)
      });
    }
  });
  return {
    viewport,
    scrollWidth: document.documentElement.scrollWidth,
    offenders: offenders.slice(0, 5)
  };
}

test('the page does not scroll sideways on a phone', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));

  for (const width of [320, 375]) {
    await page.setViewportSize({ width, height: 812 });

    for (const lang of ['en', 'ar']) {
      await page.goto('/?env=prod');
      await expect(page.locator('#standings-table-body tr').first()).toBeVisible();
      if (lang !== 'en') {
        await page.locator('#language-select').selectOption(lang);
        await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
      }

      for (const tab of ['standings', 'fixtures', 'teams']) {
        await page.locator(`#mob-nav-${tab}`).click();
        await expect(page.locator(`#view-${tab}`)).toBeVisible();

        const report = await page.evaluate(overflowReport);
        expect(
          report.scrollWidth,
          `${width}px ${lang} ${tab}: page is ${report.scrollWidth}px wide, ${JSON.stringify(report.offenders)}`
        ).toBeLessThanOrEqual(report.viewport);
      }
    }
  }

  expect(pageErrors).toEqual([]);
});

test('the import dialog offers a downloadable filled example', async ({ page }) => {
  await page.goto('/?env=prod');
  await expect(page.locator('#standings-table-body tr').first()).toBeVisible();

  const link = page.locator('#modal-squad a[href="examples/squad-example.xlsx"]');
  await expect(link).toHaveCount(1);
  await expect(link).toContainText('Download filled example (Excel)');

  // Same file the site serves to a visitor: a real zip, not an HTML error page.
  const response = await page.request.get('examples/squad-example.xlsx');
  expect(response.status()).toBe(200);
  const body = await response.body();
  expect(body.subarray(0, 2).toString('latin1')).toBe('PK');
  expect(body.length).toBeGreaterThan(1000);

  // The label follows the chosen language like every other string.
  await page.locator('#language-select').selectOption('fr');
  await expect(link).toContainText('Télécharger un exemple rempli (Excel)');
  await page.locator('#language-select').selectOption('ar');
  await expect(link).toContainText('تنزيل مثال معبأ (Excel)');
});
