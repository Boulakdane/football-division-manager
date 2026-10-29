'use strict';

const { test, expect } = require('@playwright/test');

/*
 * Roadmap F: the generator and reschedule dialogs. The database RPCs are
 * stubbed so this runs without a hosted project; what it proves is the
 * browser half: the modal builds a plan from the viewed division, previews it,
 * filters pairings that already exist, saves the exact rows the RPC expects,
 * and previews/applies a round shift.
 */

async function bootAdmin(page) {
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));

  await page.goto('/?env=prod');
  await expect(page.locator('#standings-table-body tr').first()).toBeVisible();
  await page.waitForFunction(() => typeof idleWatcherInstalled !== 'undefined' && idleWatcherInstalled === true);

  await page.evaluate(() => {
    // The dialogs are admin-only and never open in read-only demo mode.
    BACKEND_READY = true;
    currentRole = 'admin';
    updateAuthUI();

    appState.divisions = [{ id: 'd1', name: 'Division 1', sortOrder: 1 }];
    appState.divisionsReady = true;
    appState.teams = [
      { id: 'fx-a', name: 'Alpha', code: 'ALP', color: '#3b82f6', divisionId: 'd1' },
      { id: 'fx-b', name: 'Beta', code: 'BET', color: '#10b981', divisionId: 'd1' },
      { id: 'fx-c', name: 'Gamma', code: 'GAM', color: '#f59e0b', divisionId: 'd1' },
      { id: 'fx-d', name: 'Delta', code: 'DEL', color: '#ef4444', divisionId: 'd1' }
    ];
    appState.players = [];
    appState.matches = [];
    appState.seasonsReady = true;
    appState.activeSeasonId = 'fx-season';
    appState.viewSeasonId = 'fx-season';
    appState.viewDivisionId = 'd1';

    window.__createdPlan = null;
    window.__shiftArgs = null;
    dbCreateFixtures = async plan => {
      window.__createdPlan = plan;
      return {
        created: plan.matches.length,
        removed: 0,
        rounds: new Set(plan.matches.map(match => match.round)).size,
        divisionId: 'd1',
        seasonId: plan.seasonId
      };
    };
    dbShiftFixtureRounds = async (seasonId, divisionId, fromRound, days) => {
      window.__shiftArgs = [seasonId, divisionId, fromRound, days];
      return { shifted: 4, days, fromRound, divisionId };
    };
    // Keep the injected fixtures: a real reload would replace them from the
    // network, which this test does not have.
    refreshData = async () => {};

    renderApp();
    updateAuthUI();
  });

  // The generator buttons live in the fixtures tab.
  await page.locator('#nav-fixtures').click();
  await expect(page.locator('#view-fixtures')).toBeVisible();

  return pageErrors;
}

test('the generator previews a whole plan and saves the RPC payload', async ({ page }) => {
  const pageErrors = await bootAdmin(page);

  await page.locator('[data-action="generate-fixtures"]').click();
  await expect(page.locator('#modal-generate')).toBeVisible();
  await expect(page.locator('#generate-division')).toHaveText('Division 1');

  await page.locator('#generate-start').fill('2026-08-08');
  await page.locator('#generate-times').fill('15:00, 17:30');
  await page.locator('#generate-venues').fill('Main Field');
  await page.locator('#form-generate button[type="submit"]').click();

  await expect(page.locator('#generate-preview')).toBeVisible();
  await expect(page.locator('#generate-summary')).toContainText('6 fixtures');
  await expect(page.locator('#generate-summary')).toContainText('3 rounds');
  await expect(page.locator('#generate-list > div')).toHaveCount(3);
  await expect(page.locator('#generate-save')).toBeEnabled();

  await page.locator('#generate-save').click();
  await expect(page.locator('#modal-generate')).toBeHidden();

  const plan = await page.evaluate(() => window.__createdPlan);
  expect(plan.seasonId).toBe('fx-season');
  expect(plan.replaceExisting).toBe(false);
  expect(plan.matches).toHaveLength(6);
  expect(plan.matches.every(match => match.homeId && match.awayId && match.id === undefined)).toBe(true);
  expect(plan.matches[0]).toMatchObject({ round: 1, datetime: '2026-08-08T15:00', venue: 'Main Field' });

  const pairs = new Set(plan.matches.map(match => [match.homeId, match.awayId].sort().join('|')));
  expect(pairs.size).toBe(6);
  await expect(page.locator('#toast')).toContainText('6 fixtures saved');
  expect(pageErrors).toEqual([]);
});

test('an existing pairing is skipped unless the admin ticks Replace', async ({ page }) => {
  await bootAdmin(page);
  await page.evaluate(() => {
    appState.matches = [{
      id: 'fx-existing', seasonId: 'fx-season', divisionId: 'd1', round: 1,
      homeId: 'fx-a', awayId: 'fx-b', homeScore: 0, awayScore: 0,
      status: 'SCHEDULED', datetime: '2026-08-01T15:00', venue: '', scorersText: '', eventsCounted: true
    }];
    renderApp();
  });

  await page.locator('[data-action="generate-fixtures"]').click();
  await page.locator('#generate-start').fill('2026-08-08');
  await page.locator('#generate-double').check();
  await page.locator('#form-generate button[type="submit"]').click();

  await expect(page.locator('#generate-summary')).toContainText('10 fixtures');
  await expect(page.locator('#generate-skipped')).toContainText('2 fixtures skipped');

  // Ticking Replace keeps both legs and asks the RPC to move the old rows.
  await page.locator('#generate-replace').check();
  await page.locator('#form-generate button[type="submit"]').click();
  await expect(page.locator('#generate-summary')).toContainText('12 fixtures');
  await expect(page.locator('#generate-skipped')).toBeHidden();
});

test('a blackout date moves the matchday and shows a translated warning', async ({ page }) => {
  await bootAdmin(page);
  await page.locator('[data-action="generate-fixtures"]').click();
  await page.locator('#generate-start').fill('2026-08-08');
  await page.locator('#generate-blackout').fill('2026-08-15');
  await page.locator('#form-generate button[type="submit"]').click();

  await expect(page.locator('#generate-warnings')).toBeVisible();
  await expect(page.locator('#generate-warnings')).toContainText('blackout dates');
  await expect(page.locator('#generate-list')).toContainText('Aug 16, 2026');
});

test('the reschedule dialog previews and applies a round shift', async ({ page }) => {
  const pageErrors = await bootAdmin(page);
  await page.evaluate(() => {
    appState.matches = [
      { id: 'fx-1', seasonId: 'fx-season', divisionId: 'd1', round: 1, homeId: 'fx-a', awayId: 'fx-b', homeScore: 1, awayScore: 0, status: 'FINISHED', datetime: '2026-08-01T15:00', venue: '', scorersText: '', eventsCounted: true },
      { id: 'fx-2', seasonId: 'fx-season', divisionId: 'd1', round: 2, homeId: 'fx-a', awayId: 'fx-c', homeScore: 0, awayScore: 0, status: 'SCHEDULED', datetime: '2026-08-08T15:00', venue: '', scorersText: '', eventsCounted: true },
      { id: 'fx-3', seasonId: 'fx-season', divisionId: 'd1', round: 2, homeId: 'fx-b', awayId: 'fx-d', homeScore: 0, awayScore: 0, status: 'SCHEDULED', datetime: '2026-08-08T17:30', venue: '', scorersText: '', eventsCounted: true },
      { id: 'fx-4', seasonId: 'fx-season', divisionId: 'd1', round: 3, homeId: 'fx-a', awayId: 'fx-d', homeScore: 0, awayScore: 0, status: 'SCHEDULED', datetime: '2026-08-15T15:00', venue: '', scorersText: '', eventsCounted: true },
      { id: 'fx-5', seasonId: 'fx-season', divisionId: 'd1', round: 3, homeId: 'fx-b', awayId: 'fx-c', homeScore: 0, awayScore: 0, status: 'SCHEDULED', datetime: '2026-08-15T17:30', venue: '', scorersText: '', eventsCounted: true }
    ];
    renderApp();
  });

  await page.locator('[data-action="shift-fixtures"]').click();
  await expect(page.locator('#modal-shift')).toBeVisible();
  // The first round without a result is round 2.
  await expect(page.locator('#shift-from')).toHaveValue('2');

  await page.locator('#shift-days').fill('7');
  await page.locator('#form-shift button[type="submit"]').click();
  await expect(page.locator('#shift-preview')).toBeVisible();
  await expect(page.locator('#shift-summary')).toContainText('4 fixtures');
  await expect(page.locator('#shift-list')).toContainText('Aug 15');
  await expect(page.locator('#shift-apply')).toBeEnabled();

  await page.locator('#shift-apply').click();
  await expect(page.locator('#modal-shift')).toBeHidden();
  const args = await page.evaluate(() => window.__shiftArgs);
  expect(args).toEqual(['fx-season', 'd1', 2, 7]);
  await expect(page.locator('#toast')).toContainText('4 fixtures rescheduled');
  expect(pageErrors).toEqual([]);
});

test('a played fixture blocks the shift preview', async ({ page }) => {
  await bootAdmin(page);
  await page.evaluate(() => {
    appState.matches = [{
      id: 'fx-played', seasonId: 'fx-season', divisionId: 'd1', round: 3,
      homeId: 'fx-a', awayId: 'fx-b', homeScore: 2, awayScore: 1,
      status: 'FINISHED', datetime: '2026-08-15T15:00', venue: '', scorersText: '', eventsCounted: true
    }];
    renderApp();
  });

  await page.locator('[data-action="shift-fixtures"]').click();
  await page.locator('#shift-from').fill('2');
  await page.locator('#shift-days').fill('7');
  await page.locator('#form-shift button[type="submit"]').click();

  await expect(page.locator('#shift-error')).toBeVisible();
  await expect(page.locator('#shift-error')).toContainText('already started');
  await expect(page.locator('#shift-preview')).toBeHidden();
  await expect(page.locator('#shift-apply')).toBeDisabled();
});
