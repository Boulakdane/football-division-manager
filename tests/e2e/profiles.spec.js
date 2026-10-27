'use strict';

/*
 * Task L: optional Arabic names are shown next to the Latin ones, and the
 * licence number and birth date stay out of reach for visitors.
 *
 * The REST calls are answered locally, so this runs without a hosted project
 * and without the task L migration being applied to development or production.
 */

const { test, expect } = require('@playwright/test');

const TEAMS = [
  { id: 't1', name: 'Spartan FC', name_ar: 'سبارتان', code: 'SFC', color: '#3b82f6', division_id: 'd1' },
  { id: 't2', name: 'Titan United', name_ar: null, code: 'TTN', color: '#10b981', division_id: 'd1' }
];

const PLAYERS = [
  {
    id: 'p1', team_id: 't1', name: 'David Silva', name_ar: 'ديفيد سيلفا', pos: 'MID', num: 10,
    legacy_goals: 5, legacy_yellow: 1, legacy_red: 0, is_active: true
  },
  {
    id: 'p2', team_id: 't1', name: 'Carlos Ramos', name_ar: null, pos: 'FWD', num: 9,
    legacy_goals: 7, legacy_yellow: 0, legacy_red: 0, is_active: true
  },
  {
    id: 'p3', team_id: 't2', name: 'Ethan Hunt', name_ar: null, pos: 'FWD', num: 11,
    legacy_goals: 1, legacy_yellow: 0, legacy_red: 0, is_active: true
  }
];

const DERIVED = PLAYERS.map(player => ({
  player_id: player.id,
  team_id: player.team_id,
  name: player.name,
  name_ar: player.name_ar,
  pos: player.pos,
  num: player.num,
  is_active: true,
  legacy_goals: player.legacy_goals,
  legacy_yellow: player.legacy_yellow,
  legacy_red: player.legacy_red,
  event_goals: 0,
  event_yellow: 0,
  event_red: 0,
  goals: player.legacy_goals,
  yellow: player.legacy_yellow,
  red: player.legacy_red,
  division_id: 'd1'
}));

const SEASONS = [
  {
    id: 's1', name: '2026 Season', start_date: '2026-08-01', end_date: '2027-05-31',
    is_active: true, created_at: '2026-08-01T00:00:00.000Z'
  }
];

const MATCHES = [
  {
    id: 'm1', season_id: 's1', division_id: 'd1', round: 1, home_id: 't1', away_id: 't2',
    home_score: 2, away_score: 0, status: 'FINISHED', datetime: '2026-10-03T15:00',
    venue: '', scorers_text: '', events_counted: true
  }
];

const EVENTS = [];

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'access-control-allow-headers': 'apikey, authorization, content-type, prefer, range, x-client-info, accept-profile, content-profile',
  'access-control-expose-headers': 'content-range, content-profile',
  'access-control-max-age': '600'
};

function jsonHeaders(extra) {
  return { ...CORS_HEADERS, 'content-type': 'application/json; charset=utf-8', ...extra };
}

async function mockData(page, tables, requested) {
  await page.route('**/rest/v1/**', async route => {
    const request = route.request();
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: CORS_HEADERS });
      return;
    }

    const url = new URL(request.url());
    const table = url.pathname.split('/rest/v1/')[1] || '';
    requested.push(table);

    const rows = tables[table];
    if (!rows) {
      await route.fulfill({
        status: 404,
        headers: jsonHeaders(),
        body: JSON.stringify({
          code: 'PGRST205',
          details: null,
          hint: null,
          message: `Could not find the table 'public.${table}' in the schema cache`
        })
      });
      return;
    }

    const offset = Number(url.searchParams.get('offset') || 0);
    const limit = Number(url.searchParams.get('limit') || 1000);
    const slice = rows.slice(offset, offset + limit);
    const range = slice.length
      ? `${offset}-${offset + slice.length - 1}/${rows.length}`
      : `*/${rows.length}`;

    await route.fulfill({
      status: 200,
      headers: jsonHeaders({ 'content-range': range }),
      body: JSON.stringify(slice)
    });
  });

  await page.route('**/auth/v1/settings', route =>
    route.fulfill({
      status: 200,
      headers: jsonHeaders(),
      body: JSON.stringify({ disable_signup: true, external: {} })
    })
  );
}

test('Arabic names are shown beside the Latin ones and personal data stays hidden', async ({ page }) => {
  const requested = [];
  await mockData(page, {
    teams: TEAMS,
    players: PLAYERS,
    seasons: SEASONS,
    matches: MATCHES,
    match_events: EVENTS,
    v_player_stats: DERIVED
  }, requested);

  await page.goto('/?env=dev');
  await expect(page.locator('#standings-table-body tr').first()).toBeVisible();
  await expect(page.locator('#data-error')).toBeHidden();

  // English: Latin first, Arabic in brackets. A team without one keeps its
  // Latin name alone.
  const standings = page.locator('#standings-table-body');
  await expect(standings).toContainText('Spartan FC (سبارتان)');
  await expect(standings).toContainText('Titan United');
  // A club without an Arabic name keeps its Latin name alone (the short code is
  // rendered next to it, so compare the whole cell).
  const titanCell = standings.locator('tr', { hasText: 'Titan United' }).locator('td').nth(1);
  const titanText = (await titanCell.innerText()).replace(/\s+/g, ' ').trim();
  expect(titanText).toBe('Titan United (TTN)');

  // Squads view shows both names for the team and for the players.
  await page.locator('#nav-teams').click();
  await expect(page.locator('#view-teams')).toBeVisible();
  await expect(page.locator('#teams-container')).toContainText('Spartan FC (سبارتان)');
  await expect(page.locator('#teams-container')).toContainText('David Silva (ديفيد سيلفا)');
  await expect(page.locator('#teams-container')).toContainText('Carlos Ramos');

  // Arabic UI: Arabic first, Latin in brackets.
  await page.locator('#language-select').selectOption('ar');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await page.locator('#nav-standings').click();
  await expect(page.locator('#standings-table-body')).toContainText('سبارتان (Spartan FC)');

  // Visitors never ask for the admin-only table and never see a licence or a
  // birth date, even though the players payload is fully loaded.
  expect(requested).not.toContain('player_profiles');
  const body = await page.locator('body').innerText();
  expect(body).not.toContain('LIC-1001');
  expect(body).not.toContain('1986-01-08');
});
