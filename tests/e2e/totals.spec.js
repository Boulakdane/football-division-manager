'use strict';

/*
 * Roadmap A: player totals come from the database, not from the browser.
 *
 * Both tests answer the Supabase REST calls locally, so they prove the
 * frontend contract without depending on a hosted project:
 *   1. with supabase/derive-totals-migration.sql applied, the page shows the
 *      totals from v_player_stats, and the development-only dual-run check
 *      warns that they differ from the stored columns;
 *   2. on a project without the migration, the page never asks for the view
 *      and keeps showing the stored totals, with a clean console.
 */

const { test, expect } = require('@playwright/test');

const PLAYERS_LEGACY = [
  {
    id: 'p1', team_id: 't1', name: 'David Silva', pos: 'MID', num: 10,
    goals: 6, yellow: 1, red: 0, is_active: true,
    // The columns added by derive-totals-migration.sql: the view adds the
    // one counted goal event on top, so the stored total is the same.
    legacy_goals: 5, legacy_yellow: 1, legacy_red: 0
  },
  {
    id: 'p2', team_id: 't1', name: 'Carlos Ramos', pos: 'FWD', num: 9,
    goals: 0, yellow: 0, red: 0, is_active: true,
    legacy_goals: 0, legacy_yellow: 0, legacy_red: 0
  }
];

const DERIVED = [
  {
    player_id: 'p1', team_id: 't1', name: 'David Silva', pos: 'MID', num: 10,
    is_active: true, legacy_goals: 5, legacy_yellow: 1, legacy_red: 0,
    event_goals: 2, event_yellow: 0, event_red: 0,
    goals: 7, yellow: 1, red: 0
  },
  {
    player_id: 'p2', team_id: 't1', name: 'Carlos Ramos', pos: 'FWD', num: 9,
    is_active: true, legacy_goals: 0, legacy_yellow: 0, legacy_red: 0,
    event_goals: 0, event_yellow: 0, event_red: 0,
    goals: 0, yellow: 0, red: 0
  }
];

const TEAMS = [
  { id: 't1', name: 'Spartan FC', code: 'SFC', color: '#3b82f6' },
  { id: 't2', name: 'Titan United', code: 'TTN', color: '#10b981' }
];

const SEASONS = [
  {
    id: 's1', name: '2026 Season', start_date: '2026-08-01', end_date: '2027-05-31',
    is_active: true, created_at: '2026-08-01T00:00:00.000Z'
  }
];

const MATCHES = [
  {
    id: 'm1', season_id: 's1', round: 1, home_id: 't1', away_id: 't2',
    home_score: 2, away_score: 0, status: 'FINISHED', datetime: '2026-10-03T15:00',
    venue: '', scorers_text: '', events_counted: true
  }
];

const EVENTS = [
  { id: 'e1', match_id: 'm1', team_id: 't1', player_id: 'p1', event_type: 'goal', minute: 10 },
  { id: 'e2', match_id: 'm1', team_id: 't1', player_id: 'p1', event_type: 'goal', minute: 55 }
];

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

/**
 * Answer every REST call from the given tables. Unknown tables get the same
 * PGRST205 answer the real project gives when a migration is missing.
 */
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

/** Collect console output and uncaught errors while the page loads. */
function watchConsole(page) {
  const messages = [];
  const errors = [];
  page.on('console', message => messages.push({ type: message.type(), text: message.text() }));
  page.on('pageerror', error => errors.push(error.message));
  return { messages, errors };
}

const table = (players, extra = {}) => ({
  players,
  teams: TEAMS,
  seasons: SEASONS,
  matches: MATCHES,
  match_events: EVENTS,
  ...extra
});

test('derived totals win when v_player_stats exists, and the dual-run check warns', async ({ page }) => {
  const requested = [];
  const { messages, errors } = watchConsole(page);
  await mockData(page, table(PLAYERS_LEGACY, { v_player_stats: DERIVED }), requested);

  await page.goto('/?env=dev');

  // The view says 7 (5 legacy + 2 events); the stored column still says 6.
  await expect(page.locator('#stat-top-scorer')).toHaveText('David Silva (7)');
  await expect(page.locator('#top-scorers-list')).toContainText('David Silva');
  await expect(page.locator('#data-error')).toBeHidden();
  expect(requested).toContain('v_player_stats');

  // Development only: the stored column and the view disagree, so the page
  // says so instead of hiding a migration bug.
  const warnings = messages.filter(message => message.type === 'warning');
  expect(warnings.map(message => message.text).join('\n')).toContain('disagree with v_player_stats');
  expect(errors, 'uncaught page errors').toEqual([]);
  expect(messages.filter(message => message.type === 'error'), 'console errors').toEqual([]);
});

test('stored totals are still used, and no view is requested, before the migration', async ({ page }) => {
  const requested = [];
  const { messages, errors } = watchConsole(page);

  // No legacy_* columns and no v_player_stats: this is today's hosted project.
  const legacyPlayers = PLAYERS_LEGACY.map(({ legacy_goals, legacy_yellow, legacy_red, ...row }) => row);
  await mockData(page, table(legacyPlayers), requested);

  await page.goto('/?env=dev');

  await expect(page.locator('#stat-top-scorer')).toHaveText('David Silva (6)');
  await expect(page.locator('#data-error')).toBeHidden();
  expect(requested).not.toContain('v_player_stats');
  expect(errors, 'uncaught page errors').toEqual([]);
  expect(messages.filter(message => message.type === 'error'), 'console errors').toEqual([]);
  expect(messages.filter(message => message.type === 'warning'), 'console warnings').toEqual([]);
});
