#!/usr/bin/env node
/*
 * SQL tests for roadmap item A, stage 3: totals live only in the views.
 *
 * Runs in its own in-memory PGlite database. It proves that:
 *   * schema.sql installs legacy offsets, the views and no stored totals;
 *   * v_player_stats follows every total-changing RPC, and stays hidden for
 *     trashed teams;
 *   * add_players(), set_player_totals() and replace_all_data() seed the
 *     legacy offset correctly;
 *   * v_standings mirrors calculateStandings() (points, GD, GF, wins, name);
 *   * the stage-1 migration refuses to run once the stored columns are gone;
 *   * anon can read the views but cannot call the admin RPC.
 *
 * The upgrade path (pre-A project -> derive -> drop) lives in
 * tools/test-drop-totals.js.
 *
 * Usage: npm run test:derived-stats
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

const ROOT = path.resolve(__dirname, '..');
const ADMIN_ID = '00000000-0000-0000-0000-000000000001';
const VIEWER_ID = '00000000-0000-0000-0000-000000000002';

async function mockAuth(db) {
  await db.exec(`
    create schema auth;
    create table auth.users (id uuid primary key, email text);
    create or replace function auth.uid() returns uuid
      language sql stable
      as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
    create or replace function auth.jwt() returns jsonb
      language sql stable
      as $$ select coalesce(nullif(current_setting('test.jwt', true), '')::jsonb, '{}'::jsonb) $$;
    create role anon;
    create role authenticated;
  `);
}

async function makeAdmin(db) {
  await db.exec(`insert into auth.users (id, email) values ('${ADMIN_ID}', 'admin@test.local'), ('${VIEWER_ID}', 'viewer@test.local')`);
  await db.exec(`update public.profiles set role = 'admin' where id = '${ADMIN_ID}'`);
}

async function run() {
  const db = new PGlite();
  const exec = sql => db.exec(sql);
  const q = async (sql, params) => (await db.query(sql, params)).rows;
  const asRole = async (role, uid, fn) => {
    await exec(`set test.uid = '${uid}'`);
    await exec(`set role ${role}`);
    try { return await fn(); } finally { await exec('reset role'); }
  };
  const asAdmin = fn => asRole('authenticated', ADMIN_ID, fn);
  const asAnon = fn => asRole('anon', '', fn);
  const asViewer = fn => asRole('authenticated', VIEWER_ID, fn);
  const expectError = async (fn, pattern) => {
    let error = null;
    try { await fn(); } catch (err) { error = err; }
    assert(error, 'expected an error');
    assert(pattern.test(String(error.message || error)), `unexpected error: ${error.message || error}`);
  };
  const totals = async playerId => {
    const rows = await q(
      `select goals, yellow, red, legacy_goals, legacy_yellow, legacy_red,
              event_goals, event_yellow, event_red
         from public.v_player_stats where player_id = $1`,
      [playerId]
    );
    assert.strictEqual(rows.length, 1, `missing v_player_stats row for ${playerId}`);
    return rows[0];
  };

  try {
    await mockAuth(db);
    await exec(fs.readFileSync(path.join(ROOT, 'supabase/schema.sql'), 'utf8'));
    await makeAdmin(db);
    await exec(`set test.uid = '${ADMIN_ID}'`);

    // ------------------------------------------------------------
    // Fresh install: no stored totals, only the view
    // ------------------------------------------------------------
    const storedColumns = await q(`
      select column_name
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'players'
        and column_name in ('goals', 'yellow', 'red')
    `);
    assert.strictEqual(storedColumns.length, 0, 'schema.sql must not create stored totals');

    const inconsistent = await q(`
      select count(*)::int n
      from public.v_player_stats v
      where v.goals <> v.legacy_goals + v.event_goals
         or v.yellow <> v.legacy_yellow + v.event_yellow
         or v.red <> v.legacy_red + v.event_red
    `);
    assert.strictEqual(inconsistent[0].n, 0, 'every total must be legacy + counted events');

    const seedCount = await q('select count(*)::int n from public.v_player_stats');
    assert.strictEqual(seedCount[0].n, 9, 'all nine visible seed players should have stats');

    const p2 = await totals('p2');
    assert.strictEqual(p2.goals, 7);
    assert.strictEqual(p2.event_goals, 2, 'p2 has two counted goals in m1');
    assert.strictEqual(p2.legacy_goals, 5, 'the rest of p2 goals are legacy');
    const p5 = await totals('p5');
    assert.strictEqual(p5.red, 1);
    assert.strictEqual(p5.event_red, 0, 'the seed red is legacy');
    assert.strictEqual(p5.legacy_red, 1);
    await expectError(
      () => q("insert into public.players (id, team_id, name, pos, num, legacy_goals) values ('pneglegacy', 't1', 'Negative Legacy', 'FWD', 10, -1)"),
      /kickoff_players_legacy_totals_range/
    );
    console.log('OK fresh schema.sql has no stored totals and a consistent v_player_stats');

    // ------------------------------------------------------------
    // v_standings mirrors calculateStandings()
    // ------------------------------------------------------------
    const table = await q(`
      select team_id, team_name, position, played, won, drawn, lost,
             goals_for, goals_against, goal_difference, points, form
      from public.v_standings
      where season_id = 's1'
      order by position
    `);
    assert.strictEqual(table.length, 6, 'the active season lists every club');
    assert.deepStrictEqual(
      table.map(r => r.team_id),
      ['t5', 't3', 't1', 't4', 't6', 't2'],
      'standings order should be points, GD, GF, wins, name'
    );
    const byTeam = Object.fromEntries(table.map(r => [r.team_id, r]));
    assert.deepStrictEqual(
      [byTeam.t5.played, byTeam.t5.won, byTeam.t5.drawn, byTeam.t5.lost, byTeam.t5.goals_for, byTeam.t5.goals_against, byTeam.t5.goal_difference, byTeam.t5.points],
      [2, 1, 1, 0, 3, 2, 1, 4]
    );
    assert.deepStrictEqual(byTeam.t5.form, ['W', 'D'], 'form is the last five results in date order');
    assert.deepStrictEqual(byTeam.t3.form, ['D', 'W']);
    assert.deepStrictEqual(
      [byTeam.t2.played, byTeam.t2.goals_for, byTeam.t2.goals_against, byTeam.t2.points],
      [2, 1, 4, 0]
    );
    assert.strictEqual(byTeam.t1.position, 3);
    console.log('OK v_standings matches the standings calculation');

    // Archived seasons only list clubs that played in them.
    await exec(`
      insert into public.seasons (id, name, is_active) values ('s0', 'Archived', false);
      insert into public.matches (id, season_id, round, home_id, away_id, home_score, away_score, status)
        values ('m_arch', 's0', 1, 't1', 't2', 1, 0, 'FINISHED');
    `);
    const archived = await q("select team_id, points from public.v_standings where season_id = 's0' order by position");
    assert.deepStrictEqual(archived.map(r => r.team_id), ['t1', 't2'], 'archived table should omit clubs that did not play');
    assert.deepStrictEqual(archived.map(r => r.points), [3, 0]);
    console.log('OK archived v_standings only lists participating clubs');

    // ------------------------------------------------------------
    // The views follow every write path
    // ------------------------------------------------------------
    await asAdmin(async () => {
      await q(`select public.replace_match_events('m1',
        '[{"id":"e_v1","teamId":"t1","playerId":"p1","type":"goal","minute":10},
          {"id":"e_v2","teamId":"t1","playerId":"p2","type":"goal","minute":20}]'::jsonb)`);
    });
    assert.strictEqual((await totals('p2')).event_goals, 1, 'replacing events removes the old goal');
    assert.strictEqual((await totals('p2')).goals, 6, 'the view total follows the removal');
    assert.strictEqual((await totals('p1')).event_goals, 1, 'the new goal is counted');
    assert.strictEqual((await totals('p1')).goals, 5, 'p1 keeps its seeded total (one goal replaced another)');

    await asAdmin(async () => {
      await q(`select public.save_match(
        '{"id":"m_live","season_id":"s1","round":80,"home_id":"t1","away_id":"t2","status":"LIVE","home_score":2,"away_score":1}'::jsonb,
        null
      )`);
    });
    assert.strictEqual((await totals('p1')).goals, 5, 'a score-only save does not touch player totals');

    await asAdmin(() => q("select public.delete_match('m1')"));
    assert.strictEqual((await totals('p1')).event_goals, 0, 'a trashed fixture stops contributing events');
    assert.strictEqual((await totals('p1')).goals, 4, 'the trashed fixture no longer adds to the total');
    assert.strictEqual((await totals('p2')).goals, 5);

    await asAdmin(() => q("select public.restore_match('m1')"));
    assert.strictEqual((await totals('p2')).event_goals, 1, 'restoring brings the event back');
    assert.strictEqual((await totals('p2')).goals, 6);
    assert.strictEqual((await totals('p1')).goals, 5);

    await asAdmin(() => q("select public.delete_team('t1')"));
    const p1Hidden = await q("select 1 from public.v_player_stats where player_id = 'p1'");
    assert.strictEqual(p1Hidden.length, 0, 'a trashed team hides its players from the view');
    assert.strictEqual((await totals('p3')).goals, 3, 'other clubs keep their totals');
    await asAdmin(() => q("select public.restore_team('t1')"));
    assert.strictEqual((await totals('p1')).goals, 5, 'restoring the team brings the totals back');
    console.log('OK v_player_stats follows event, match and team RPCs');

    // ------------------------------------------------------------
    // add_players() and set_player_totals()
    // ------------------------------------------------------------
    await asAdmin(() => q(
      `select public.add_players('t5', '[{"name":"Derived Forward","pos":"FWD","num":19,"goals":4,"yellow":2,"red":1}]'::jsonb)`
    ));
    const added = (await q("select id from public.players where name = 'Derived Forward'"))[0];
    const addedTotals = await totals(added.id);
    assert.deepStrictEqual(
      [addedTotals.goals, addedTotals.yellow, addedTotals.red, addedTotals.legacy_goals],
      [4, 2, 1, 4],
      'imported totals become the legacy offset'
    );

    await asAdmin(() => q("select public.set_player_totals($1, 6, 3, 2)", [added.id]));
    const changed = await totals(added.id);
    assert.deepStrictEqual(
      [changed.goals, changed.yellow, changed.red, changed.legacy_goals],
      [6, 3, 2, 6],
      'manual totals move the legacy offset'
    );

    await asAdmin(() => expectError(
      () => q("select public.set_player_totals('p2', 0, 0, 0)"),
      /goal events; the total cannot be lower/
    ));
    await asAdmin(() => expectError(
      () => q("select public.set_player_totals($1, -1, 0, 0)", [added.id]),
      /0 or more/
    ));
    await asAnon(() => expectError(
      () => q("select public.set_player_totals($1, 1, 0, 0)", [added.id]),
      /permission denied|not authorized|42501/i
    ));
    await asViewer(() => expectError(
      () => q("select public.set_player_totals($1, 1, 0, 0)", [added.id]),
      /Only admins/
    ));
    console.log('OK add_players and set_player_totals keep the view consistent');

    // ------------------------------------------------------------
    // The stage-1 migration is closed once the columns are gone
    // ------------------------------------------------------------
    const migration = fs.readFileSync(path.join(ROOT, 'supabase/derive-totals-migration.sql'), 'utf8');
    await expectError(() => exec(migration), /already run drop-stored-totals-migration/);
    console.log('OK derive-totals-migration.sql refuses to run after the drop');

    // ------------------------------------------------------------
    // Full import round trip
    // ------------------------------------------------------------
    const importPayload = JSON.stringify({
      seasons: [{ id: 's1', name: '2026 Season', is_active: true }],
      teams: [
        { id: 't1', name: 'Spartan FC', code: 'SFC', color: '#3b82f6' },
        { id: 't2x', name: 'Import FC', code: 'IMP', color: '#10b981' }
      ],
      players: [
        { id: 'p1', team_id: 't1', name: 'David Silva', pos: 'MID', num: 10, goals: 5, yellow: 1, red: 0 },
        { id: 'p2', team_id: 't1', name: 'Carlos Ramos', pos: 'FWD', num: 9, goals: 0, yellow: 0, red: 0 }
      ],
      matches: [
        { id: 'm1', season_id: 's1', round: 1, home_id: 't1', away_id: 't2x', home_score: 1, away_score: 0, status: 'FINISHED', events_counted: true },
        { id: 'm2', season_id: 's1', round: 2, home_id: 't1', away_id: 't2x', home_score: 1, away_score: 0, status: 'FINISHED', events_counted: false }
      ],
      match_events: [
        { id: 'e1', match_id: 'm1', team_id: 't1', player_id: 'p1', event_type: 'goal', minute: 10 },
        { id: 'e2', match_id: 'm2', team_id: 't1', player_id: 'p1', event_type: 'goal', minute: 20 },
        { id: 'e3', match_id: 'm1', team_id: 't1', player_id: 'p1', event_type: 'yellow', minute: 30 }
      ]
    });
    await asAdmin(() => q('select public.replace_all_data($1::jsonb)', [importPayload]));
    const imported = await totals('p1');
    assert.deepStrictEqual(
      [imported.goals, imported.yellow, imported.red, imported.event_goals, imported.legacy_goals],
      [5, 1, 0, 1, 4],
      'an import with an uncounted fixture must keep the imported total while counting only the visible event'
    );
    const importedP2 = await totals('p2');
    assert.deepStrictEqual([importedP2.goals, importedP2.legacy_goals], [0, 0]);
    console.log('OK replace_all_data seeds legacy offsets from the imported totals');

    // ------------------------------------------------------------
    // Public read + grant surface
    // ------------------------------------------------------------
    const anonRead = await asAnon(async () => ({
      stats: (await q('select count(*)::int n from public.v_player_stats'))[0].n,
      standings: (await q('select count(*)::int n from public.v_standings'))[0].n,
      results: (await q('select count(*)::int n from public.v_match_results'))[0].n
    }));
    assert.strictEqual(anonRead.stats, 2, 'anon reads v_player_stats through RLS');
    assert.strictEqual(anonRead.standings, 2, 'anon reads v_standings');
    assert.strictEqual(anonRead.results, 2, 'anon reads v_match_results');
    console.log('OK anon can read the derived views');

    console.log('All derived-total tests passed.');
  } finally {
    await db.close();
  }
}

run().catch(error => {
  console.error('Derived-total tests failed:', error);
  process.exit(1);
});
