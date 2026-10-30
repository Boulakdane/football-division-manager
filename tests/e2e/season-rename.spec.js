'use strict';

/*
 * Admins can rename a season, including an archived one, so a season can carry
 * the name of the person it is dedicated to.
 *
 * The REST calls are answered locally, so this runs without a hosted project.
 * It proves that:
 *   * the Rename button is admin-only and only appears when a season is viewed;
 *   * the dialog is pre-filled with the current name and sends exactly the
 *     PATCH a real Supabase project would receive (no other column, no fixture
 *     write);
 *   * the new name appears in the switcher for the active season and for an
 *     archived one.
 */

const { test, expect } = require('@playwright/test');

const SEASONS = [
  {
    id: 's1', name: '2026 Season', start_date: '2026-08-01', end_date: '2027-05-31',
    is_active: true, created_at: '2026-08-01T00:00:00.000Z'
  },
  {
    id: 's2', name: 'Old Cup', start_date: '2025-08-01', end_date: '2026-05-31',
    is_active: false, created_at: '2025-08-01T00:00:00.000Z'
  }
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

/** Serve the tables in memory and apply PATCH to seasons like PostgREST does. */
async function mockData(page, tables, patches) {
  await page.route('**/rest/v1/**', async route => {
    const request = route.request();
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: CORS_HEADERS });
      return;
    }

    const url = new URL(request.url());
    const table = url.pathname.split('/rest/v1/')[1] || '';
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

    if (request.method() === 'PATCH') {
      const body = request.postDataJSON();
      const id = String(url.searchParams.get('id') || '').replace(/^eq\./, '');
      const row = rows.find(candidate => candidate.id === id);
      if (!row) {
        await route.fulfill({
          status: 200,
          headers: jsonHeaders({ 'content-range': '*/0' }),
          body: '[]'
        });
        return;
      }
      Object.assign(row, body);
      patches.push({ table, id, body });
      await route.fulfill({
        status: 200,
        headers: jsonHeaders({ 'content-range': `0-0/1` }),
        body: JSON.stringify([row])
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

test('an admin renames a season, including an archived one', async ({ page }) => {
  const patches = [];
  await mockData(page, {
    seasons: SEASONS,
    teams: [
      { id: 't1', name: 'Spartan FC', name_ar: null, icon: null, code: 'SFC', color: '#3b82f6', division_id: 'd1' },
      { id: 't2', name: 'Titan United', name_ar: null, icon: null, code: 'TTN', color: '#10b981', division_id: 'd1' }
    ],
    players: [],
    v_player_stats: [],
    matches: [],
    match_events: [],
    match_officials: [],
    player_profiles: [],
    divisions: [
      { id: 'd1', name: 'Division 1', sort_order: 1 },
      { id: 'd2', name: 'Division 2', sort_order: 2 }
    ]
  }, patches);

  await page.goto('/?env=dev');
  await expect(page.locator('#standings-table-body tr').first()).toBeVisible();
  await page.waitForFunction(() => typeof idleWatcherInstalled !== 'undefined' && idleWatcherInstalled === true);

  // A visitor never gets the control.
  await expect(page.locator('#btn-rename-season')).toBeHidden();

  await page.evaluate(() => {
    BACKEND_READY = true;
    currentRole = 'admin';
    updateAuthUI();
    renderApp();
  });
  await expect(page.locator('#btn-rename-season')).toBeVisible();

  // ---- active season ---------------------------------------------------
  await page.locator('#btn-rename-season').click();
  await expect(page.locator('#modal-season-rename')).toBeVisible();
  await expect(page.locator('#season-rename-name')).toHaveValue('2026 Season');

  await page.locator('#season-rename-name').fill('Saison 2026 — dédiée à Cheikh A.');
  await page.locator('#form-season-rename button[type="submit"]').click();

  await expect(page.locator('#modal-season-rename')).toBeHidden();
  await expect(page.locator('#toast')).toHaveText('Season renamed.');
  await expect(page.locator('#season-select option[value="s1"]')).toContainText('Saison 2026 — dédiée à Cheikh A.');

  // Only the name column is written: no fixture, no activation change.
  expect(patches).toEqual([{ table: 'seasons', id: 's1', body: { name: 'Saison 2026 — dédiée à Cheikh A.' } }]);
  expect(await page.evaluate(() => appState.activeSeasonId)).toBe('s1');

  // ---- archived season: dedicating a past edition ----------------------
  await page.locator('#season-select').selectOption('s2');
  await expect(page.locator('#season-status')).toHaveText('Archived');
  await expect(page.locator('#btn-rename-season')).toBeVisible();

  await page.locator('#btn-rename-season').click();
  await expect(page.locator('#season-rename-name')).toHaveValue('Old Cup');
  await page.locator('#season-rename-name').fill('Coupe 2025 — dédiée à Si M.');
  await page.locator('#form-season-rename button[type="submit"]').click();

  await expect(page.locator('#modal-season-rename')).toBeHidden();
  await expect(page.locator('#season-select option[value="s2"]')).toContainText('Coupe 2025 — dédiée à Si M.');
  expect(patches[patches.length - 1]).toEqual({ table: 'seasons', id: 's2', body: { name: 'Coupe 2025 — dédiée à Si M.' } });

  // The archived season stays archived and its fixtures stay read-only.
  expect(await page.evaluate(() => appState.viewSeasonId)).toBe('s2');
  expect(await page.evaluate(() => document.body.classList.contains('season-readonly'))).toBe(true);
});
