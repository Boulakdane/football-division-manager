'use strict';

const { test, expect } = require('@playwright/test');

/*
 * Roadmap K: a UI-level test with injected state, so it runs before and after
 * the divisions migration is applied to the hosted project. It proves that the
 * fixed switcher scopes the table, fixtures and team cards to one division,
 * and that the selection survives in the URL.
 */
test('the division switcher scopes standings, fixtures and teams', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));

  await page.goto('/?env=prod');
  await expect(page.locator('#standings-table-body tr').first()).toBeVisible();
  // initAuth() runs alongside the first render; wait for its idle watcher so a
  // late refreshData() cannot overwrite the injected division state below.
  await page.waitForFunction(() => typeof idleWatcherInstalled !== 'undefined' && idleWatcherInstalled === true);

  await page.evaluate(() => {
    appState.divisions = [
      { id: 'd1', name: 'Division 1', sortOrder: 1 },
      { id: 'd2', name: 'Division 2', sortOrder: 2 }
    ];
    appState.divisionsReady = true;
    appState.teams = [
      { id: 'e2e-d1a', name: 'E2E Alpha', code: 'ALP', color: '#3b82f6', divisionId: 'd1' },
      { id: 'e2e-d1b', name: 'E2E Beta', code: 'BET', color: '#10b981', divisionId: 'd1' },
      { id: 'e2e-d2a', name: 'E2E Gamma', code: 'GAM', color: '#f59e0b', divisionId: 'd2' },
      { id: 'e2e-d2b', name: 'E2E Delta', code: 'DEL', color: '#ef4444', divisionId: 'd2' }
    ];
    appState.players = [];
    const seasonId = appState.activeSeasonId;
    appState.matches = [
      {
        id: 'e2e-m1', seasonId, divisionId: 'd1', round: 1,
        homeId: 'e2e-d1a', awayId: 'e2e-d1b', homeScore: 2, awayScore: 0,
        status: 'FINISHED', datetime: '2026-10-01T15:00', venue: '', scorersText: '', eventsCounted: true
      },
      {
        id: 'e2e-m2', seasonId, divisionId: 'd2', round: 1,
        homeId: 'e2e-d2a', awayId: 'e2e-d2b', homeScore: 1, awayScore: 1,
        status: 'FINISHED', datetime: '2026-10-01T17:00', venue: '', scorersText: '', eventsCounted: true
      }
    ];
    appState.viewSeasonId = seasonId;
    appState.viewDivisionId = 'd1';
    renderApp();
  });

  await expect(page.locator('#division-switcher')).toBeVisible();
  await expect(page.locator('#division-select option')).toHaveCount(2);
  await expect(page.locator('#standings-table-body')).toContainText('E2E Alpha');
  await expect(page.locator('#standings-table-body')).not.toContainText('E2E Gamma');
  expect(await page.evaluate(() => calculateStandings().map(row => row.team.id).sort()))
    .toEqual(['e2e-d1a', 'e2e-d1b']);

  // The delegated change handler switches the view and stores it in the URL.
  await page.locator('#division-select').selectOption('d2');
  await expect(page.locator('#standings-table-body')).toContainText('E2E Gamma');
  await expect(page.locator('#standings-table-body')).not.toContainText('E2E Alpha');
  expect(await page.evaluate(() => appState.viewDivisionId)).toBe('d2');
  await expect(page).toHaveURL(/division=d2/);

  // Team cards only list the selected tier.
  await page.locator('#nav-teams').click();
  await expect(page.locator('#teams-container')).toContainText('E2E Gamma');
  await expect(page.locator('#teams-container')).not.toContainText('E2E Alpha');
  expect(await page.locator('#teams-container > *').count()).toBe(2);

  // Fixtures are scoped the same way.
  await page.locator('#nav-fixtures').click();
  await expect(page.locator('#fixtures-container')).toContainText('E2E Gamma');
  await expect(page.locator('#fixtures-container')).not.toContainText('E2E Alpha');

  expect(pageErrors, 'uncaught page errors').toEqual([]);
});
