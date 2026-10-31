'use strict';

/*
 * Roadmap G, stage 1: the "Add to calendar" export.
 *
 * The browser builds an RFC 5545 file from what the fixtures view is showing
 * and hands it to the download manager, for the whole division or for one club.
 * No network is involved, so this runs without a hosted project. It proves
 * that:
 *   * a public visitor gets the toolbar button and the per-team button;
 *   * the file is a well-formed VCALENDAR with one VEVENT per dated fixture;
 *   * a fixture without a time becomes an all-day event, a fixture without a
 *     date is skipped and mentioned in the toast, and a finished result shows
 *     its score;
 *   * the round/status filters narrow the exported set exactly like the screen,
 *     and a filter with no dated fixture downloads nothing.
 */

const fs = require('fs');
const { test, expect } = require('@playwright/test');

const SEASON = {
  id: 's1', name: '2026 Season', startDate: '2026-08-01', endDate: '2027-05-31', isActive: true
};

const TEAMS = [
  { id: 't1', name: 'Spartan FC', code: 'SFC', color: '#3b82f6', divisionId: 'd1' },
  { id: 't2', name: 'Titan United', code: 'TTN', color: '#10b981', divisionId: 'd1' },
  { id: 't3', name: 'Atlas SC', code: 'ATL', color: '#f59e0b', divisionId: 'd1' }
];

const MATCHES = [
  {
    id: 'm1', seasonId: 's1', divisionId: 'd1', round: 1, homeId: 't1', awayId: 't2',
    homeScore: 0, awayScore: 0, status: 'SCHEDULED', datetime: '2026-11-07T15:30',
    venue: 'Stade de Ghardaia', scorersText: '', eventsCounted: true
  },
  {
    id: 'm2', seasonId: 's1', divisionId: 'd1', round: 2, homeId: 't3', awayId: 't1',
    homeScore: 0, awayScore: 0, status: 'SCHEDULED', datetime: '2026-11-08',
    venue: '', scorersText: '', eventsCounted: true
  },
  {
    id: 'm4', seasonId: 's1', divisionId: 'd1', round: 3, homeId: 't1', awayId: 't3',
    homeScore: 2, awayScore: 1, status: 'FINISHED', datetime: '2026-10-20T15:00',
    venue: '', scorersText: 'Spartan FC: A. Player (12), B. Player (77)', eventsCounted: true
  },
  {
    id: 'm5', seasonId: 's1', divisionId: 'd1', round: 4, homeId: 't2', awayId: 't3',
    homeScore: 0, awayScore: 0, status: 'SCHEDULED', datetime: '2026-11-15T14:00',
    venue: '', scorersText: '', eventsCounted: true
  },
  {
    id: 'm3', seasonId: 's1', divisionId: 'd1', round: 5, homeId: 't2', awayId: 't3',
    homeScore: 0, awayScore: 0, status: 'SCHEDULED', datetime: '',
    venue: '', scorersText: '', eventsCounted: true
  }
];

const eventCount = text => text.split('\r\n').filter(line => line === 'BEGIN:VEVENT').length;

/** Load the app, replace its state with the fixtures above, open the tab. */
async function boot(page, tab) {
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));

  await page.goto('/?env=prod');
  await expect(page.locator('#standings-table-body tr').first()).toBeVisible();
  await page.waitForFunction(() => typeof idleWatcherInstalled !== 'undefined' && idleWatcherInstalled === true);

  await page.evaluate(({ season, teams, matches }) => {
    appState.seasons = [season];
    appState.seasonsReady = true;
    appState.activeSeasonId = season.id;
    appState.viewSeasonId = season.id;

    appState.divisions = [
      { id: 'd1', name: 'Division 1', sortOrder: 1 },
      { id: 'd2', name: 'Division 2', sortOrder: 2 }
    ];
    appState.divisionsReady = true;
    appState.viewDivisionId = 'd1';

    appState.teams = teams;
    appState.players = [];
    appState.matches = matches;

    // A real refresh would replace the injected fixtures from the network.
    refreshData = async () => {};

    renderApp();
  }, { season: SEASON, teams: TEAMS, matches: MATCHES });

  await page.locator(`#nav-${tab || 'fixtures'}`).click();
  await expect(page.locator(`#view-${tab || 'fixtures'}`)).toBeVisible();

  return pageErrors;
}

/** Click something that downloads and return its filename and text. */
async function downloadFrom(page, selector) {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator(selector).click()
  ]);
  const path = await download.path();
  return {
    filename: download.suggestedFilename(),
    text: fs.readFileSync(path, 'utf8')
  };
}

test('a visitor downloads every dated fixture of the viewed division', async ({ page }) => {
  const pageErrors = await boot(page);

  // The toolbar button is public: no admin role was set in this test.
  const button = page.locator('[data-action="export-calendar"]');
  await expect(button).toBeVisible();
  await expect(button).toContainText('Add to calendar');

  const { filename, text } = await downloadFrom(page, '[data-action="export-calendar"]');

  expect(filename).toBe('mzab_league_2026_Season_Group_1.ics');

  // RFC 5545 basics: CRLF everywhere, one calendar, one event per dated match.
  expect(text.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
  expect(text.endsWith('END:VCALENDAR\r\n')).toBe(true);
  expect(/[^\r]\n/.test(text)).toBe(false);
  expect(text).toContain('\r\nVERSION:2.0\r\n');
  expect(text).toContain('\r\nX-WR-CALNAME:Mzab League — 2026 Season — Group 1\r\n');
  expect(eventCount(text)).toBe(4);

  // Timed fixture: floating local time, fixed two-hour duration, venue kept.
  expect(text).toContain('\r\nUID:match-m1@mzab-league.github.io\r\n');
  expect(text).toContain('\r\nDTSTART:20261107T153000\r\n');
  expect(text).toContain('\r\nDURATION:PT120M\r\n');
  expect(text).toContain('\r\nSUMMARY:Spartan FC vs Titan United\r\n');
  expect(text).toContain('\r\nLOCATION:Stade de Ghardaia\r\n');
  expect(text).not.toContain('DTSTART:20261107T153000Z');

  // Date-only fixture: all-day event with an exclusive end.
  expect(text).toContain('\r\nDTSTART;VALUE=DATE:20261108\r\n');
  expect(text).toContain('\r\nDTEND;VALUE=DATE:20261109\r\n');

  // Finished fixture: the score is what a supporter wants to see.
  expect(text).toContain('\r\nSUMMARY:Spartan FC 2–1 Atlas SC\r\n');

  // The undated fixture is reported instead of being written.
  expect(text).not.toContain('UID:match-m3@');
  await expect(page.locator('#toast')).toHaveText('Calendar file ready. Fixtures without a date were skipped.');

  expect(pageErrors).toEqual([]);
});

test('the status filter narrows the file to the fixtures on screen', async ({ page }) => {
  await boot(page);

  await page.locator('#filter-status').selectOption('SCHEDULED');
  await expect(page.locator('#filter-round')).toHaveValue('ALL');

  const { text } = await downloadFrom(page, '[data-action="export-calendar"]');

  // m1, m2 and m5 are upcoming; the finished m4 and the undated m3 are out.
  expect(eventCount(text)).toBe(3);
  expect(text).toContain('UID:match-m1@');
  expect(text).toContain('UID:match-m2@');
  expect(text).toContain('UID:match-m5@');
  expect(text).not.toContain('UID:match-m4@');
  expect(text).not.toContain('UID:match-m3@');

  // The undated upcoming fixture still matches the filter, so it is skipped
  // and mentioned; only the three dated ones reach the file.
  await expect(page.locator('#toast')).toHaveText('Calendar file ready. Fixtures without a date were skipped.');
});

test('a team card exports only that club fixtures', async ({ page }) => {
  await boot(page, 'teams');

  const teamButton = page.locator('[data-action="export-team-calendar"][data-team="t1"]');
  await expect(teamButton).toBeVisible();
  await expect(teamButton).toHaveAttribute(
    'aria-label',
    'Add Spartan FC fixtures to your calendar'
  );

  const { filename, text } = await downloadFrom(page, '[data-action="export-team-calendar"][data-team="t1"]');

  expect(filename).toBe('mzab_league_2026_Season_Spartan_FC.ics');
  expect(eventCount(text)).toBe(3);
  expect(text).toContain('UID:match-m1@');
  expect(text).toContain('UID:match-m2@');
  expect(text).toContain('UID:match-m4@');
  expect(text).not.toContain('UID:match-m5@');
  expect(text).not.toContain('UID:match-m3@');
  expect(text).toContain('\r\nX-WR-CALNAME:Mzab League — 2026 Season — Spartan FC\r\n');

  // The undated fixture belongs to two other clubs, so nothing is skipped.
  await expect(page.locator('#toast')).toHaveText('Calendar file ready.');
});

test('a filter with no dated fixture downloads nothing and says why', async ({ page }) => {
  await boot(page);

  let downloads = 0;
  page.on('download', () => { downloads += 1; });

  // Round 5 holds only the undated fixture.
  await page.locator('#filter-round').selectOption('5');
  await page.locator('[data-action="export-calendar"]').click();

  await expect(page.locator('#toast')).toHaveText('No dated fixtures to add yet.');
  expect(downloads).toBe(0);
});
