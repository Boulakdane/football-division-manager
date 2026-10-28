#!/usr/bin/env node
/*
 * SQL tests for roadmap H (merge import with a diff preview).
 *
 * Runs in its own in-memory PGlite database and proves that:
 *   * import_preview() reports per-table added/changed/removed rows and writes
 *     nothing;
 *   * import_merge() upserts by id, keeps rows that are not in the backup, and
 *     restores the imported player totals through the legacy offset;
 *   * the idempotency key + checksum make a retry a no-op, while reusing a key
 *     for a different payload is rejected;
 *   * remove_missing = true soft-deletes missing seasons/teams/matches,
 *     deactivates missing players and removes extra events of imported
 *     fixtures, never touching rows the backup still references;
 *   * only admins can preview, merge or read import_runs;
 *   * replace_all_data() still works for disaster recovery;
 *   * NULL and '' are the same "no value" for the match text fields, so a
 *     browser export does not look changed and a merge never stores '';
 *   * merge-import-migration.sql upgrades a pre-H database and is re-runnable.
 *
 * Usage: npm run test:merge-import
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');
const { toDbPayload } = require('./backup-map');

const ROOT = path.resolve(__dirname, '..');
const ADMIN_ID = '00000000-0000-0000-0000-000000000001';
const VIEWER_ID = '00000000-0000-0000-0000-000000000002';

async function mockAuth(db) {
  await db.exec(`
    create schema auth;
    create table auth.users (id uuid primary key, email text);
    create or replace function auth.uid() returns uuid
      language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
    create or replace function auth.jwt() returns jsonb
      language sql stable as $$ select coalesce(nullif(current_setting('test.jwt', true), '')::jsonb, '{}'::jsonb) $$;
    create role anon;
    create role authenticated;
  `);
}

function backup(overrides) {
  const data = {
    seasons: [
      { id: 's1', name: '2026 Season', startDate: '2026-08-01', endDate: '2027-05-31', isActive: true },
      { id: 's2', name: '2025 Season', startDate: '2025-08-01', endDate: '2026-05-31', isActive: false }
    ],
    teams: [
      { id: 't1', name: 'Spartan FC', code: 'SFC', color: '#3b82f6', divisionId: 'd1' },
      { id: 't2', name: 'Titan United', code: 'TTN', color: '#10b981', divisionId: 'd1' },
      { id: 't3', name: 'Phoenix Rovers', code: 'PHX', color: '#f59e0b', divisionId: 'd2' }
    ],
    players: [
      { id: 'p1', teamId: 't1', name: 'David Silva', pos: 'MID', num: 10, goals: 1, yellow: 0, red: 0 },
      { id: 'p2', teamId: 't2', name: 'Ethan Hunt', pos: 'FWD', num: 11, goals: 1, yellow: 0, red: 0 },
      { id: 'p3', teamId: 't3', name: 'Leo Mendes', pos: 'MID', num: 8, goals: 0, yellow: 0, red: 0 }
    ],
    matches: [
      {
        id: 'm1', seasonId: 's1', divisionId: 'd1', round: 1, homeId: 't1', awayId: 't2',
        homeScore: 2, awayScore: 1, status: 'FINISHED', datetime: '2026-10-03T15:00',
        venue: 'Main Field', scorersText: ''
      }
    ],
    matchEvents: [
      { id: 'e1', matchId: 'm1', teamId: 't1', playerId: 'p1', type: 'goal', minute: 10 },
      { id: 'e2', matchId: 'm1', teamId: 't2', playerId: 'p2', type: 'goal', minute: 20 }
    ]
  };
  return { ...data, ...(overrides || {}) };
}

async function run() {
  const db = new PGlite();
  const exec = sql => db.exec(sql);
  const q = async (sql, params) => (await db.query(sql, params)).rows;
  const asRole = async (role, uid, fn) => {
    await exec(`set test.uid = '${uid}'`);
    await exec(`set role ${role}`);
    try { return await fn(); } finally { await exec('reset role'); await exec("set test.uid = ''"); }
  };
  const asAdmin = fn => asRole('authenticated', ADMIN_ID, fn);
  const asViewer = fn => asRole('authenticated', VIEWER_ID, fn);
  const asAnon = fn => asRole('anon', '', fn);
  const expectError = async (fn, pattern) => {
    let error = null;
    try { await fn(); } catch (err) { error = err; }
    assert(error, 'expected an error');
    assert(pattern.test(String(error.message || error)), `unexpected error: ${error.message || error}`);
  };

  const payloadOf = data => JSON.stringify(toDbPayload(data));
  // tools/backup-map.js normalises '' to null, but the browser's
  // buildAtomicImportPayload() sends mapMatch()'s '' values unchanged.
  // Reproduce that payload so the test covers a real hosted round trip.
  const browserPayload = data => {
    const payload = JSON.parse(payloadOf(data));
    const byId = new Map((data.matches || []).map(match => [match.id, match]));
    for (const row of payload.matches) {
      const match = byId.get(row.id) || {};
      row.datetime = match.datetime == null ? '' : match.datetime;
      row.venue = match.venue == null ? '' : match.venue;
      row.scorers_text = match.scorersText == null ? '' : match.scorersText;
    }
    return JSON.stringify(payload);
  };
  const preview = (data, removeMissing = false) => asAdmin(async () =>
    (await q('select public.import_preview($1::jsonb, $2) as r', [payloadOf(data), removeMissing]))[0].r
  );
  const merge = (data, key, removeMissing = false, checksum = null) => asAdmin(async () =>
    (await q(
      'select public.import_merge($1::jsonb, $2, $3, $4) as r',
      [payloadOf(data), key, removeMissing, checksum]
    ))[0].r
  );
  const replace = data => asAdmin(async () =>
    exec(`select public.replace_all_data('${payloadOf(data).replace(/'/g, "''")}'::jsonb)`)
  );
  const previewJson = json => asAdmin(async () =>
    (await q('select public.import_preview($1::jsonb, false) as r', [json]))[0].r
  );
  const mergeJson = (json, key) => asAdmin(async () =>
    (await q('select public.import_merge($1::jsonb, $2, false, null) as r', [json, key]))[0].r
  );

  try {
    await mockAuth(db);
    await exec(fs.readFileSync(path.join(ROOT, 'supabase/schema.sql'), 'utf8'));
    await exec(`insert into auth.users (id, email) values ('${ADMIN_ID}', 'admin@test.local'), ('${VIEWER_ID}', 'viewer@test.local')`);
    await exec(`update public.profiles set role = 'admin' where id = '${ADMIN_ID}'`);
    await exec(`update public.profiles set role = 'viewer' where id = '${VIEWER_ID}'`);

    // A known starting point, independent of the sample season.
    await replace(backup());

    // ------------------------------------------------------------
    // 1. A preview of the same backup reports no changes and writes nothing
    // ------------------------------------------------------------
    const before = await q(`
      select
        (select count(*)::int from public.seasons) as seasons,
        (select count(*)::int from public.teams) as teams,
        (select count(*)::int from public.players) as players,
        (select count(*)::int from public.matches) as matches,
        (select count(*)::int from public.match_events) as events,
        (select count(*)::int from public.import_runs) as runs
    `);
    const same = await preview(backup());
    assert.strictEqual(same.ok, true);
    assert.strictEqual(same.checksum.length, 64, 'the preview returns a SHA-256 checksum');
    assert.strictEqual(same.removeMissing, false);
    for (const table of ['seasons', 'teams', 'players', 'matches', 'events']) {
      assert(same.tables[table], `the preview includes ${table}`);
      assert.strictEqual(same.tables[table].added, 0, `${table} has no additions`);
      assert.strictEqual(same.tables[table].changed, 0, `${table} has no changes`);
      assert.strictEqual(same.tables[table].removed, 0, `${table} has no removals`);
    }
    assert.deepStrictEqual(
      { added: same.totals.added, changed: same.totals.changed, removed: same.totals.removed },
      { added: 0, changed: 0, removed: 0 }
    );
    const after = await q(`
      select
        (select count(*)::int from public.seasons) as seasons,
        (select count(*)::int from public.teams) as teams,
        (select count(*)::int from public.players) as players,
        (select count(*)::int from public.matches) as matches,
        (select count(*)::int from public.match_events) as events,
        (select count(*)::int from public.import_runs) as runs
    `);
    assert.deepStrictEqual(after[0], before[0], 'a preview writes nothing');
    console.log('OK import_preview reports a no-op and writes nothing');

    // ------------------------------------------------------------
    // 2. Merging the same backup is a no-op, and the same key replays
    // ------------------------------------------------------------
    const firstKey = 'test-merge-key-0001';
    const first = await merge(backup(), firstKey);
    assert.strictEqual(first.replayed, false);
    assert.strictEqual(first.totals.added, 0);
    assert.strictEqual(first.totals.changed, 0);
    assert.strictEqual((await q('select count(*)::int as n from public.import_runs'))[0].n, 1);

    const replay = await merge(backup(), firstKey);
    assert.strictEqual(replay.replayed, true, 'the retry returns the stored result');
    assert.strictEqual(replay.runId, first.runId);
    assert.strictEqual((await q('select count(*)::int as n from public.import_runs'))[0].n, 1);
    assert.strictEqual(
      (await q("select count(*)::int as n from public.audit_log where action = 'IMPORT' and entity = 'merge'"))[0].n,
      1,
      'one IMPORT audit row is written, not one per record'
    );
    console.log('OK import_merge is a no-op on the same backup and an idempotent retry');

    // ------------------------------------------------------------
    // 3. A changed backup previews per-table additions and changes
    // ------------------------------------------------------------
    const nextData = backup({
      teams: [
        { id: 't1', name: 'Spartan FC II', code: 'SFC', color: '#3b82f6', divisionId: 'd1' },
        { id: 't2', name: 'Titan United', code: 'TTN', color: '#10b981', divisionId: 'd1' },
        { id: 't4', name: 'Atlas Warriors', code: 'ATL', color: '#8b5cf6', divisionId: 'd1' }
      ],
      players: [
        { id: 'p1', teamId: 't1', name: 'David Silva', pos: 'MID', num: 10, goals: 3, yellow: 0, red: 0 },
        { id: 'p2', teamId: 't2', name: 'Ethan Hunt', pos: 'FWD', num: 11, goals: 1, yellow: 0, red: 0 },
        { id: 'p4', teamId: 't4', name: 'Omar Belaid', pos: 'FWD', num: 7, goals: 0, yellow: 0, red: 0 }
      ],
      matches: [
        backup().matches[0],
        {
          id: 'm2', seasonId: 's1', divisionId: 'd1', round: 2, homeId: 't2', awayId: 't4',
          homeScore: 0, awayScore: 1, status: 'FINISHED', datetime: '2026-10-10T15:00',
          venue: 'United Arena', scorersText: ''
        }
      ],
      matchEvents: [
        { id: 'e1', matchId: 'm1', teamId: 't1', playerId: 'p1', type: 'goal', minute: 10 },
        { id: 'e2', matchId: 'm1', teamId: 't2', playerId: 'p2', type: 'goal', minute: 20 },
        { id: 'e3', matchId: 'm1', teamId: 't1', playerId: 'p1', type: 'goal', minute: 30 },
        { id: 'e4', matchId: 'm2', teamId: 't4', playerId: 'p4', type: 'goal', minute: 55 }
      ]
    });

    const diff = await preview(nextData);
    assert.strictEqual(diff.tables.teams.added, 1, 't4 is added');
    assert.strictEqual(diff.tables.teams.changed, 1, 't1 is renamed');
    assert.strictEqual(diff.tables.teams.removed, 0, 't3 is kept when remove_missing is off');
    assert.strictEqual(diff.tables.players.added, 1, 'p4 is added');
    assert.strictEqual(diff.tables.players.changed, 1, 'p1 totals changed');
    assert.strictEqual(diff.tables.players.removed, 0, 'p3 is kept when remove_missing is off');
    assert.strictEqual(diff.tables.matches.added, 1, 'm2 is added');
    assert.strictEqual(diff.tables.matches.changed, 0, 'm1 is unchanged');
    assert.strictEqual(diff.tables.events.added, 2, 'e3 and e4 are added');
    assert.strictEqual(diff.tables.events.changed, 0);
    assert(diff.tables.teams.changedItems.some(item => item.id === 't1'), 'the changed team is listed');
    assert.strictEqual(
      (await q("select name from public.teams where id = 't1'"))[0].name,
      'Spartan FC',
      'the preview did not rename the team'
    );
    assert.strictEqual(
      (await q("select legacy_goals from public.players where id = 'p1'"))[0].legacy_goals,
      0,
      'the preview did not change a total'
    );
    console.log('OK import_preview reports per-table additions, changes and entity labels');

    // ------------------------------------------------------------
    // 4. Merging keeps existing rows and restores the imported totals
    // ------------------------------------------------------------
    const applied = await merge(nextData, 'test-merge-key-0002', false, diff.checksum);
    assert.strictEqual(applied.replayed, false);
    assert.strictEqual((await q("select name from public.teams where id = 't1'"))[0].name, 'Spartan FC II');
    assert.strictEqual((await q("select count(*)::int as n from public.teams where id = 't3'"))[0].n, 1, 't3 is kept');
    assert.strictEqual((await q("select count(*)::int as n from public.players where id = 'p3'"))[0].n, 1, 'p3 is kept');
    assert.strictEqual((await q("select count(*)::int as n from public.matches where id = 'm2'"))[0].n, 1, 'm2 is added');
    const totals = await q(`
      select p.id, p.legacy_goals, s.goals
      from public.players p
      join public.v_player_stats s on s.player_id = p.id
      where p.id in ('p1', 'p2', 'p4')
      order by p.id
    `);
    assert.deepStrictEqual(
      totals.map(row => [row.id, row.goals]),
      [['p1', 3], ['p2', 1], ['p4', 1]],
      'v_player_stats shows the backup totals'
    );
    assert.strictEqual(totals[0].legacy_goals, 1, 'the legacy offset excludes the counted events');
    console.log('OK import_merge upserts by id, keeps the other rows and restores totals');

    // ------------------------------------------------------------
    // 5. Reusing a key for another payload is rejected
    // ------------------------------------------------------------
    const other = backup({
      teams: backup().teams.map(team => team.id === 't1' ? { ...team, name: 'Spartan FC III' } : team)
    });
    await expectError(
      () => merge(other, 'test-merge-key-0002', false, null),
      /already used for a different backup/i
    );
    await expectError(
      () => merge(nextData, 'test-merge-key-0003', false, '0'.repeat(64)),
      /changed after the preview/i
    );
    console.log('OK a reused key or a stale preview checksum is rejected');

    // ------------------------------------------------------------
    // 6. remove_missing soft-deletes or archives, with reference guards
    // ------------------------------------------------------------
    // A stale event on an imported fixture is extra data the backup no longer has.
    await exec(`
      insert into public.match_events (id, match_id, team_id, player_id, event_type, minute)
      values ('e9', 'm1', 't1', 'p1', 'yellow', 40)
    `);

    const removes = await preview(nextData, true);
    assert.strictEqual(removes.removeMissing, true);
    assert.strictEqual(removes.tables.teams.removed, 1, 't3 is removable');
    assert.strictEqual(removes.tables.players.removed, 1, 'p3 is removable');
    assert.strictEqual(removes.tables.events.removed, 1, 'e9 is removable');
    assert.strictEqual(removes.tables.seasons.removed, 0, 's2 stays: a fixture still uses it');

    const removed = await merge(nextData, 'test-merge-key-0004', true);
    assert.strictEqual(removed.replayed, false);
    assert((await q("select deleted_at from public.teams where id = 't3'"))[0].deleted_at, 't3 is soft-deleted');
    assert.strictEqual((await q("select is_active from public.players where id = 'p3'"))[0].is_active, false, 'p3 is archived');
    assert.strictEqual((await q("select count(*)::int as n from public.match_events where id = 'e9'"))[0].n, 0, 'e9 is removed');
    assert.strictEqual((await q("select count(*)::int as n from public.match_events where match_id = 'm1'"))[0].n, 3, 'the imported event list is exact');
    assert.strictEqual((await q("select count(*)::int as n from public.teams where id = 't1'"))[0].n, 1, 'an imported team stays');
    console.log('OK remove_missing soft-deletes, archives and syncs imported events');

    // ------------------------------------------------------------
    // 7. Only admins can preview, merge or read import_runs
    // ------------------------------------------------------------
    await expectError(
      () => asAnon(async () => q('select public.import_preview($1::jsonb, false)', [payloadOf(nextData)])),
      /permission denied|Only admins/i
    );
    await expectError(
      () => asViewer(async () => q('select public.import_preview($1::jsonb, false)', [payloadOf(nextData)])),
      /Only admins/i
    );
    await expectError(
      () => asViewer(async () => q('select * from public.import_runs')),
      /permission denied/i
    );
    await expectError(
      () => asAnon(async () => q("select public.import_merge($1::jsonb, 'test-merge-key-0009', false, null)", [payloadOf(nextData)])),
      /permission denied/i
    );
    console.log('OK only admins can preview, merge or read import_runs');

    // ------------------------------------------------------------
    // 8. Validation rejects references and values that a merge cannot apply
    // ------------------------------------------------------------
    await expectError(
      () => preview(backup({ teams: [{ id: 't1', name: 'Bad division', divisionId: 'd9', code: 'X', color: '#111111' }] })),
      /known division/i
    );
    await expectError(
      () => preview(backup({ players: [
        { id: 'p1', teamId: 't1', name: 'A', pos: 'MID', num: 1, goals: 0, licenseId: 'AB-1' },
        { id: 'p2', teamId: 't2', name: 'B', pos: 'MID', num: 2, goals: 0, licenseId: 'ab-1' }
      ] })),
      /licence number must be unique/i
    );
    await expectError(
      () => preview(backup({ matchEvents: [
        { id: 'e1', matchId: 'm1', teamId: 't1', playerId: 'p2', type: 'goal', minute: 10 }
      ] })),
      /player from its team/i
    );
    await expectError(
      () => preview(backup({ seasons: [
        { id: 's1', name: 'One', isActive: true },
        { id: 's2', name: 'Two', isActive: true }
      ] })),
      /exactly one active season/i
    );
    console.log('OK validation rejects bad divisions, licences, events and active seasons');

    // ------------------------------------------------------------
    // 9. replace_all_data still works for disaster recovery
    // ------------------------------------------------------------
    await replace(backup());
    assert.strictEqual((await q("select count(*)::int as n from public.teams"))[0].n, 3);
    assert.strictEqual((await q("select count(*)::int as n from public.match_events"))[0].n, 2);
    assert.strictEqual((await q("select name from public.teams where id = 't1'"))[0].name, 'Spartan FC');
    console.log('OK replace_all_data still restores the full dataset');

    // ------------------------------------------------------------
    // 10. The migration upgrades a pre-H database and is re-runnable
    // ------------------------------------------------------------
    await exec('drop function public.import_merge(jsonb, text, boolean, text)');
    await exec('drop function public.import_preview(jsonb, boolean)');
    await exec('drop function public.import_diff_rows(jsonb, jsonb, int)');
    await exec('drop function public.validate_import_payload(jsonb)');
    await exec('drop function public.import_checksum(jsonb, boolean)');
    await exec('drop table public.import_runs');

    const migration = fs.readFileSync(path.join(ROOT, 'supabase/merge-import-migration.sql'), 'utf8');
    await exec(migration);
    await exec(migration);

    const functions = await q(`
      select proname from pg_proc
      where proname in ('import_preview', 'import_merge', 'import_checksum', 'validate_import_payload', 'import_diff_rows')
      order by proname
    `);
    assert.strictEqual(functions.length, 5, 'the migration restores every function');
    assert((await q("select 1 from pg_class where relname = 'import_runs'"))[0], 'the migration restores the table');
    const afterMigration = await preview(backup());
    assert.strictEqual(afterMigration.ok, true);
    console.log('OK merge-import-migration.sql upgrades a pre-H database and is re-runnable');

    // ------------------------------------------------------------
    // 11. NULL and '' mean the same thing for the match text fields
    // ------------------------------------------------------------
    // mapMatch() turns a NULL column into '' and buildAtomicImportPayload()
    // sends it back unchanged. Before this regression test, a browser export
    // of fixtures without scorers looked "changed" and the merge wrote ''
    // into columns that held NULL.
    const blankMatches = backup({
      matches: [{ ...backup().matches[0], datetime: '', venue: '', scorersText: '' }]
    });
    const blankPayload = browserPayload(blankMatches);

    await exec("update public.matches set datetime = null, venue = null, scorers_text = null where id = 'm1'");
    const nullPreview = await previewJson(blankPayload);
    assert.strictEqual(nullPreview.tables.matches.changed, 0, 'NULL compares equal to an empty string');
    assert.strictEqual(nullPreview.totals.changed, 0);

    await exec("update public.matches set scorers_text = '' where id = 'm1'");
    const emptyPreview = await previewJson(blankPayload);
    assert.strictEqual(emptyPreview.tables.matches.changed, 0, 'an empty string compares equal to NULL');

    const blankMerge = await mergeJson(blankPayload, 'test-merge-key-0010');
    assert.strictEqual(blankMerge.replayed, false);
    assert.strictEqual(blankMerge.totals.changed, 0);
    assert.deepStrictEqual(
      (await q("select datetime, venue, scorers_text from public.matches where id = 'm1'"))[0],
      { datetime: null, venue: null, scorers_text: null },
      'a merge stores NULL instead of writing an empty string'
    );
    console.log('OK NULL and an empty string are the same match value in preview and merge');

    console.log('\nAll merge import checks passed');
  } finally {
    await db.close();
  }
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
