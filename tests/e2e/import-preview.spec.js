'use strict';

/*
 * Roadmap H: the import dialog previews a backup before writing, merges it in
 * one transaction with an idempotency key, and keeps replace-all behind a typed
 * confirmation.
 *
 * The REST calls are answered locally, so this runs without a hosted project
 * and before supabase/merge-import-migration.sql is applied. It proves that:
 *   * the dialog opens from the admin data menu and writes nothing before the
 *     preview has loaded;
 *   * the per-table diff is rendered and re-fetched when "remove missing rows"
 *     is toggled;
 *   * the merge sends the preview checksum and a fresh idempotency key, shows
 *     the applied counts, and reports an idempotent replay instead of applying
 *     twice;
 *   * replace-all stays disabled until REPLACE is typed, and is only sent after
 *     that confirmation;
 *   * a missing merge-import migration is reported inside the dialog.
 */

const { test, expect } = require('@playwright/test');

test.use({ acceptDownloads: true });

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'access-control-allow-headers': '*'
};

const CHECKSUM = 'a'.repeat(64);
const CHECKSUM_REMOVE = 'b'.repeat(64);

const TEAMS = [
  { id: 't1', name: 'Spartan FC', name_ar: null, icon: null, code: 'SFC', color: '#3b82f6', division_id: 'd1' },
  { id: 't2', name: 'Titan United', name_ar: null, icon: null, code: 'TTN', color: '#10b981', division_id: 'd1' }
];

const PLAYERS = [
  {
    id: 'p1', team_id: 't1', name: 'David Silva', name_ar: null, pos: 'MID', num: 10,
    legacy_goals: 1, legacy_yellow: 0, legacy_red: 0, is_active: true
  },
  {
    id: 'p2', team_id: 't2', name: 'Ethan Hunt', name_ar: null, pos: 'FWD', num: 11,
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
  legacy_yellow: 0,
  legacy_red: 0,
  event_goals: 0,
  event_yellow: 0,
  event_red: 0,
  goals: player.legacy_goals,
  yellow: 0,
  red: 0,
  division_id: 'd1'
}));

const SEASONS = [
  { id: 's1', name: '2026 Season', start_date: null, end_date: null, is_active: true, created_at: '2026-01-01T00:00:00Z' }
];

const MATCHES = [
  {
    id: 'm1', season_id: 's1', division_id: 'd1', round: 1, home_id: 't1', away_id: 't2',
    home_score: 1, away_score: 1, status: 'FINISHED', datetime: '2026-10-03T15:00',
    venue: 'Main Field', scorers_text: '', events_counted: true
  }
];

const EVENTS = [
  { id: 'e1', match_id: 'm1', team_id: 't1', player_id: 'p1', event_type: 'goal', minute: 10 },
  { id: 'e2', match_id: 'm1', team_id: 't2', player_id: 'p2', event_type: 'goal', minute: 20 }
];

const DIVISIONS = [
  { id: 'd1', name: 'Division 1', sort_order: 1 },
  { id: 'd2', name: 'Division 2', sort_order: 2 }
];

const BACKUP = {
  seasons: [{ id: 's1', name: '2026 Season', startDate: '', endDate: '', isActive: true }],
  teams: [
    { id: 't1', name: 'Spartan FC II', code: 'SFC', color: '#3b82f6', divisionId: 'd1' },
    { id: 't2', name: 'Titan United', code: 'TTN', color: '#10b981', divisionId: 'd1' },
    { id: 't3', name: 'Atlas Warriors', code: 'ATL', color: '#8b5cf6', divisionId: 'd2' }
  ],
  players: [
    { id: 'p1', teamId: 't1', name: 'David Silva', pos: 'MID', num: 10, goals: 3, yellow: 0, red: 0 },
    { id: 'p2', teamId: 't2', name: 'Ethan Hunt', pos: 'FWD', num: 11, goals: 1, yellow: 0, red: 0 },
    { id: 'p3', teamId: 't3', name: 'Omar Belaid', pos: 'FWD', num: 7, goals: 0, yellow: 0, red: 0 }
  ],
  matches: [
    {
      id: 'm1', seasonId: 's1', divisionId: 'd1', round: 1, homeId: 't1', awayId: 't2',
      homeScore: 1, awayScore: 1, status: 'FINISHED', datetime: '2026-10-03T15:00',
      venue: 'Main Field', scorersText: '', eventsCounted: true
    }
  ],
  matchEvents: [
    { id: 'e1', matchId: 'm1', teamId: 't1', playerId: 'p1', type: 'goal', minute: 10 },
    { id: 'e2', matchId: 'm1', teamId: 't2', playerId: 'p2', type: 'goal', minute: 20 }
  ]
};

function entity(added, changed, removed, unchanged, items) {
  return {
    added,
    changed,
    removed,
    unchanged,
    addedItems: (items && items.added) || [],
    changedItems: (items && items.changed) || [],
    removedItems: (items && items.removed) || []
  };
}

function previewResult(removeMissing) {
  const teams = removeMissing
    ? entity(1, 1, 1, 0, {
        added: [{ id: 't3', label: 'Atlas Warriors' }],
        changed: [{ id: 't1', label: 'Spartan FC II' }],
        removed: [{ id: 't9', label: 'Phoenix Rovers' }]
      })
    : entity(1, 1, 0, 1, {
        added: [{ id: 't3', label: 'Atlas Warriors' }],
        changed: [{ id: 't1', label: 'Spartan FC II' }]
      });
  const players = removeMissing
    ? entity(1, 1, 1, 0, {
        added: [{ id: 'p3', label: 'Omar Belaid' }],
        changed: [{ id: 'p1', label: 'David Silva' }],
        removed: [{ id: 'p9', label: 'Leo Mendes' }]
      })
    : entity(1, 1, 0, 1, {
        added: [{ id: 'p3', label: 'Omar Belaid' }],
        changed: [{ id: 'p1', label: 'David Silva' }]
      });
  const events = removeMissing
    ? entity(0, 0, 1, 2, { removed: [{ id: 'e9', label: "yellow 40'" }] })
    : entity(0, 0, 0, 2);
  const tables = {
    seasons: entity(0, 0, 0, 1),
    teams,
    players,
    matches: entity(0, 0, 0, 1),
    events
  };
  const totals = Object.values(tables).reduce((sum, table) => ({
    added: sum.added + table.added,
    changed: sum.changed + table.changed,
    removed: sum.removed + table.removed,
    unchanged: sum.unchanged + table.unchanged
  }), { added: 0, changed: 0, removed: 0, unchanged: 0 });

  return {
    ok: true,
    removeMissing: Boolean(removeMissing),
    checksum: removeMissing ? CHECKSUM_REMOVE : CHECKSUM,
    tables,
    totals
  };
}

async function mockBackend(page, state) {
  await page.route('**/rest/v1/**', async route => {
    const request = route.request();
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: CORS_HEADERS });
      return;
    }

    const url = new URL(request.url());
    const path = url.pathname.split('/rest/v1/')[1] || '';

    if (path === 'rpc/import_preview') {
      const body = request.postDataJSON() || {};
      state.previewCalls.push(body);
      state.lastPreviewRemove = Boolean(body.p_remove_missing);
      if (state.previewError) {
        await route.fulfill({
          status: 404,
          headers: { ...CORS_HEADERS, 'content-type': 'application/json; charset=utf-8' },
          body: JSON.stringify({
            code: 'PGRST202',
            details: null,
            hint: null,
            message: 'Could not find the function public.import_preview(p_data, p_remove_missing) in the schema cache'
          })
        });
        return;
      }
      await route.fulfill({
        status: 200,
        headers: { ...CORS_HEADERS, 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify(previewResult(state.lastPreviewRemove))
      });
      return;
    }

    if (path === 'rpc/import_merge') {
      const body = request.postDataJSON() || {};
      state.mergeCalls.push(body);
      const replayed = state.replayNext === true;
      state.replayNext = false;
      await route.fulfill({
        status: 200,
        headers: { ...CORS_HEADERS, 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          ...previewResult(Boolean(state.lastPreviewRemove)),
          replayed,
          runId: 42,
          appliedAt: '2026-10-28T12:00:00Z'
        })
      });
      return;
    }

    if (path === 'rpc/replace_all_data') {
      state.replaceCalls.push(request.postDataJSON());
      await route.fulfill({ status: 204, headers: CORS_HEADERS });
      return;
    }

    const tables = {
      teams: TEAMS,
      players: PLAYERS,
      v_player_stats: DERIVED,
      matches: MATCHES,
      seasons: SEASONS,
      match_events: EVENTS,
      divisions: DIVISIONS,
      match_officials: [],
      player_profiles: []
    };
    const rows = tables[path];
    if (!rows) {
      await route.fulfill({
        status: 404,
        headers: { ...CORS_HEADERS, 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          code: 'PGRST205',
          details: null,
          hint: null,
          message: `Could not find the table 'public.${path}' in the schema cache`
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
      headers: {
        ...CORS_HEADERS,
        'content-type': 'application/json; charset=utf-8',
        'content-range': range
      },
      body: JSON.stringify(slice)
    });
  });

  await page.route('**/auth/v1/settings', route =>
    route.fulfill({
      status: 200,
      headers: { ...CORS_HEADERS, 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ disable_signup: true, external: {} })
    })
  );
}

test('the import dialog previews, merges idempotently and gates replace-all', async ({ page }) => {
  const state = {
    previewCalls: [],
    mergeCalls: [],
    replaceCalls: [],
    lastPreviewRemove: false,
    replayNext: false,
    previewError: false
  };
  const dialogs = [];
  page.on('dialog', dialog => {
    dialogs.push(dialog.message());
    dialog.dismiss();
  });

  await mockBackend(page, state);
  await page.goto('/?env=dev');
  await expect(page.locator('#standings-table-body tr').first()).toBeVisible();
  // initAuth() runs alongside the first render; wait for its idle watcher so a
  // late refresh cannot clear the injected admin role.
  await page.waitForFunction(() => typeof idleWatcherInstalled !== 'undefined' && idleWatcherInstalled === true);

  await page.evaluate(() => {
    currentRole = 'admin';
    updateAuthUI();
    renderApp();
  });
  await page.locator('[data-action="data-menu"]').click();
  await page.locator('[data-action="import-open"]').click();
  await expect(page.locator('#modal-import')).toBeVisible();
  await expect(page.locator('#import-preview')).toBeHidden();
  await expect(page.locator('#import-apply')).toBeDisabled();

  // Choosing a file only asks for a preview; nothing is written.
  await page.locator('#import-merge-file').setInputFiles({
    name: 'backup.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(BACKUP))
  });
  await expect(page.locator('#import-preview')).toBeVisible();
  await expect(page.locator('#import-summary')).toContainText('2 added, 2 changed, 0 removed');
  await expect(page.locator('#import-diff-body')).toContainText('Clubs');
  await expect(page.locator('#import-diff-details')).toContainText('Atlas Warriors');
  await expect(page.locator('#import-checksum')).toContainText(CHECKSUM);
  await expect(page.locator('#import-apply')).toBeEnabled();
  expect(state.previewCalls).toHaveLength(1);
  expect(state.previewCalls[0].p_remove_missing).toBe(false);
  expect(state.mergeCalls).toHaveLength(0);

  // Toggling "remove missing rows" previews again with the new flag.
  await page.locator('#import-remove-missing').check();
  await expect(page.locator('#import-summary')).toContainText('3 removed');
  await expect(page.locator('#import-checksum')).toContainText(CHECKSUM_REMOVE);
  expect(state.previewCalls).toHaveLength(2);
  expect(state.previewCalls[1].p_remove_missing).toBe(true);

  // Applying sends the preview checksum and an idempotency key.
  await page.locator('#import-apply').click();
  await expect(page.locator('#modal-import')).toBeHidden();
  await expect(page.locator('#toast')).toContainText('Backup merged: 2 added, 2 changed, 3 removed');
  expect(state.mergeCalls).toHaveLength(1);
  expect(state.mergeCalls[0].p_remove_missing).toBe(true);
  expect(state.mergeCalls[0].p_expected_checksum).toBe(CHECKSUM_REMOVE);
  expect(state.mergeCalls[0].p_idempotency_key.length).toBeGreaterThanOrEqual(8);
  const firstKey = state.mergeCalls[0].p_idempotency_key;
  expect(firstKey).toMatch(/^import-/);

  // A retry with the same preview is reported as a replay, not applied twice.
  await page.locator('[data-action="data-menu"]').click();
  await page.locator('[data-action="import-open"]').click();
  await page.locator('#import-merge-file').setInputFiles({
    name: 'backup.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(BACKUP))
  });
  await expect(page.locator('#import-preview')).toBeVisible();
  state.replayNext = true;
  await page.locator('#import-apply').click();
  await expect(page.locator('#toast')).toContainText('already applied');
  expect(state.mergeCalls).toHaveLength(2);
  expect(state.mergeCalls[1].p_idempotency_key).not.toBe(firstKey);
  expect(state.mergeCalls[1].p_expected_checksum).toBe(CHECKSUM);

  // Replace-all stays behind a typed confirmation.
  await page.locator('[data-action="data-menu"]').click();
  await page.locator('[data-action="import-open"]').click();
  await page.locator('#import-merge-file').setInputFiles({
    name: 'backup.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(BACKUP))
  });
  await expect(page.locator('#import-preview')).toBeVisible();
  await page.locator('#import-replace-open').click();
  await expect(page.locator('#import-replace-panel')).toBeVisible();
  // Live rows = changed + unchanged + removed (added rows do not exist yet).
  await expect(page.locator('#import-replace-count')).toContainText('deletes 8 current records');
  await expect(page.locator('#import-replace-confirm')).toBeDisabled();
  await page.locator('#import-replace-word').fill('replace');
  await expect(page.locator('#import-replace-confirm')).toBeDisabled();
  await page.locator('#import-replace-word').fill('REPLACE');
  await expect(page.locator('#import-replace-confirm')).toBeEnabled();
  await page.locator('#import-replace-confirm').click();
  await expect(page.locator('#modal-import')).toBeHidden();
  await expect(page.locator('#toast')).toContainText('All league data was replaced');
  expect(state.replaceCalls).toHaveLength(1);
  expect(state.mergeCalls).toHaveLength(2);

  // A project without the migration explains what to run, inside the dialog.
  state.previewError = true;
  await page.locator('[data-action="data-menu"]').click();
  await page.locator('[data-action="import-open"]').click();
  await page.locator('#import-merge-file').setInputFiles({
    name: 'backup.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(BACKUP))
  });
  await expect(page.locator('#import-error')).toContainText('supabase/merge-import-migration.sql');
  await expect(page.locator('#import-preview')).toBeHidden();
  await expect(page.locator('#import-apply')).toBeDisabled();

  // Disaster recovery still works from the parsed file when the merge RPC is missing.
  await expect(page.locator('#import-replace-open')).toBeVisible();
  await page.locator('#import-replace-open').click();
  await expect(page.locator('#import-replace-panel')).toBeVisible();
  await expect(page.locator('#import-replace-count')).toHaveText('');
  await page.locator('#import-replace-word').fill('REPLACE');
  await page.locator('#import-replace-confirm').click();
  await expect(page.locator('#toast')).toContainText('All league data was replaced');
  expect(state.replaceCalls).toHaveLength(2);

  // The flow never falls back to window.confirm/alert.
  expect(dialogs).toEqual([]);
});
