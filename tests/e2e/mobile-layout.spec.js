'use strict';

/*
 * Phone layout and the squad-import examples.
 *
 * Public visitors mostly arrive on a phone, in Arabic or French as often as in
 * English. This proves that:
 *   * the page itself never scrolls sideways on a phone, on every tab and in
 *     both writing directions (only the standings table scrolls, inside its own
 *     card, which is intended);
 *   * the import dialog offers a real, filled .xlsx example per language, served
 *     by the site (no Excel, no backend call), and the blank CSV template and the
 *     example both follow the language on screen.
 */

const fs = require('fs');
const { test, expect } = require('@playwright/test');
const SquadImport = require('../../js/squad-import.js');

test.use({ acceptDownloads: true });

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

test('the import dialog downloads templates and examples in the chosen language', async ({ page }) => {
  await page.goto('/?env=prod');
  await expect(page.locator('#standings-table-body tr').first()).toBeVisible();

  // The dialog itself is admin-only (covered elsewhere); open it directly so this
  // test can focus on the two downloads and the files behind them.
  await page.evaluate(() => {
    BACKEND_READY = true;
    currentRole = 'admin';
    updateAuthUI();
    openSquadImport(appState.teams[0].id);
  });
  await expect(page.locator('#modal-squad')).toBeVisible();

  const exampleButton = page.locator('#modal-squad [data-action="squad-example"]');
  const templateButton = page.locator('#modal-squad [data-action="squad-template"]');
  await expect(exampleButton).toHaveCount(1);
  await expect(templateButton).toHaveCount(1);

  // Each language: translated label, its own files, real bytes behind them.
  const languages = [
    ['en', 'Download filled example (Excel)'],
    ['fr', 'Télécharger un exemple rempli (Excel)'],
    ['ar', 'تنزيل مثال معبأ (Excel)']
  ];
  for (const [lang, label] of languages) {
    if (lang !== 'en') {
      await page.locator('#language-select').selectOption(lang);
      await expect(page.locator('html')).toHaveAttribute('lang', lang);
    }
    await expect(exampleButton).toContainText(label);

    const [example] = await Promise.all([
      page.waitForEvent('download'),
      exampleButton.click()
    ]);
    expect(example.suggestedFilename()).toBe(`kickoff_squad_example_${lang}.xlsx`);
    const exampleBytes = fs.readFileSync(await example.path());
    expect(exampleBytes.subarray(0, 2).toString('latin1')).toBe('PK');
    expect(exampleBytes.length).toBeGreaterThan(1000);

    // The blank template is generated at click time, so it can never be stale.
    const [template] = await Promise.all([
      page.waitForEvent('download'),
      templateButton.click()
    ]);
    expect(template.suggestedFilename()).toBe(`kickoff_squad_template_${lang}.csv`);
    const templateText = fs.readFileSync(await template.path(), 'utf8').replace(/^\uFEFF/, '');
    expect(templateText).toBe(SquadImport.template(lang).text.replace(/^\uFEFF/, ''));
  }

  // The site serves the same example files to anyone browsing the repository.
  for (const lang of ['en', 'fr', 'ar']) {
    const response = await page.request.get(`examples/squad-example-${lang}.xlsx`);
    expect(response.status()).toBe(200);
    expect((await response.body()).subarray(0, 2).toString('latin1')).toBe('PK');
  }
});
