#!/usr/bin/env node
/*
 * SQL tests for roadmap item A, stage 1: derived player and team totals.
 *
 * Runs in its own in-memory PGlite database. It proves that:
 *   * schema.sql alone installs the legacy offsets and the views;
 *   * the views equal the stored player totals on a fresh install;
 *   * v_standings mirrors calculateStandings() (points, GD, GF, wins, name);
 *   * v_player_stats follows every total-changing RPC, and stays hidden for
 *     trashed teams;
 *   * add_players(), set_player_totals() and replace_all_data() seed the
 *     legacy offset correctly;
 *   * derive-totals-migration.sql upgrades an existing project and is
 *     re-runnable, including with events_counted = false rows;
 *   * anon can read the views but cannot call the new RPC.
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
  const stored = async playerId => (await q(
    'select goals, yellow, red, legacy_goals, legacy_yellow, legacy_red from public.players where id = $1',
    [playerId]
  ))[0];
  const assertSame = async (playerId, label) => {
    const v = await totals(playerId);
    const s = await stored(playerId);
    assert.deepStrictEqual(
      { goals: v.goals, yellow: v.yellow, red: v.red },
      { goals: s.goals, yellow: s.yellow, red: s.red },
      `${label || playerId}: views and stored totals disagree`
    );
  };

  try {
    await mockAuth(db);
    await exec(fs.readFileSync(path.join(ROOT, 'supabase/schema.sql'), 'utf8'));
    await makeAdmin(db);
    await exec(`set test.uid = '${ADMIN_ID}'`);

    // ------------------------------------------------------------
    // Fresh install: the seed rows are consistent
    // ------------------------------------------------------------
    const seedMismatch = await q(`
      select count(*)::int n
      from public.players p
      join public.v_player_stats v on v.player_id = p.id
      where v.goals <> p.goals or v.yellow <> p.yellow or v.red <> p.red
    `);
    assert.strictEqual(seedMismatch[0].n, 0, 'fresh seed views should equal stored totals');
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
    console.log('OK fresh schema.sql seeds legacy offsets and v_player_stats equals stored totals');

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
    await assertSame('p1');
    await assertSame('p2');
    assert.strictEqual((await totals('p2')).event_goals, 1, 'removing one goal event lowers event_goals');
    assert.strictEqual((await stored('p2')).goals, 6, 'the stored total follows the removal too');

    await asAdmin(async () => {
      await q(`select public.save_match(
        '{"id":"m_live","season_id":"s1","round":80,"home_id":"t1","away_id":"t2","status":"LIVE","home_score":2,"away_score":1}'::jsonb,
        null
      )`);
    });
    await assertSame('p1');
    assert.strictEqual((await stored('p1')).goals, 5, 'a score-only save does not touch player totals');

    await asAdmin(() => q("select public.delete_match('m1')"));
    await assertSame('p1');
    await assertSame('p2');
    assert.strictEqual((await totals('p1')).event_goals, 0, 'a trashed fixture stops contributing events');

    await asAdmin(() => q("select public.restore_match('m1')"));
    await assertSame('p1');
    await assertSame('p2');
    assert.strictEqual((await totals('p2')).event_goals, 1, 'restoring brings the event back');

    await asAdmin(() => q("select public.delete_team('t1')"));
    const p1Hidden = await q("select 1 from public.v_player_stats where player_id = 'p1'");
    assert.strictEqual(p1Hidden.length, 0, 'a trashed team hides its players from the view');
    await assertSame('p3');
    await asAdmin(() => q("select public.restore_team('t1')"));
    await assertSame('p1');
    await assertSame('p2');
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
    // Upgrade path: an existing project with legacy flags
    // ------------------------------------------------------------
    const legacy = new PGlite();
    try {
      await mockAuth(legacy);
      await legacy.exec(fs.readFileSync(path.join(ROOT, 'supabase/schema.sql'), 'utf8'));
      await makeAdmin(legacy);
      const lq = async (sql, params) => (await legacy.query(sql, params)).rows;
      const lexec = sql => legacy.exec(sql);

      // p8 already has three legacy goals and no events. Add two fixtures:
      // one counted with two goals + a yellow, one uncounted with one goal.
      await lexec(`
        insert into public.players (id, team_id, name, pos, num, goals, yellow, red)
          values ('plegacy', 't6', 'Legacy Player', 'FWD', 20, 10, 2, 1);
        insert into public.matches (id, season_id, round, home_id, away_id, home_score, away_score, status, events_counted)
          values ('m_legacy_counted', 's1', 70, 't6', 't1', 2, 0, 'FINISHED', true),
                 ('m_legacy_uncounted', 's1', 71, 't6', 't1', 1, 0, 'FINISHED', false);
        insert into public.match_events (id, match_id, team_id, player_id, event_type, minute) values
          ('e_legacy_1', 'm_legacy_counted', 't6', 'plegacy', 'goal', 10),
          ('e_legacy_2', 'm_legacy_counted', 't6', 'plegacy', 'goal', 20),
          ('e_legacy_3', 'm_legacy_counted', 't6', 'plegacy', 'yellow', 30),
          ('e_legacy_4', 'm_legacy_uncounted', 't6', 'plegacy', 'goal', 40);
      `);

      // A project that only ran the older migrations has no legacy columns.
      await lexec('drop view public.v_standings, public.v_match_results, public.v_player_stats, public.v_player_event_totals');
      await lexec('alter table public.players drop column legacy_goals, drop column legacy_yellow, drop column legacy_red');

      const migration = fs.readFileSync(path.join(ROOT, 'supabase/derive-totals-migration.sql'), 'utf8');
      await lexec(migration);
      await lexec(migration);

      const migrated = (await lq("select goals, legacy_goals, event_goals from public.v_player_stats where player_id = 'plegacy'"))[0];
      assert.deepStrictEqual(
        [migrated.goals, migrated.event_goals, migrated.legacy_goals],
        [10, 2, 8],
        'only counted events are taken out of the stored total'
      );

      // X4 repairs an upcoming fixture: it moves the event into the totals
      // and flips events_counted. The view must move by exactly the same
      // amount.
      await lexec(`
        update public.matches set status = 'SCHEDULED' where id = 'm_legacy_uncounted';
      `);
      await lexec(fs.readFileSync(path.join(ROOT, 'supabase/scheduled-match-events-migration.sql'), 'utf8'));
      const afterRepair = (await lq("select goals, legacy_goals, event_goals from public.v_player_stats where player_id = 'plegacy'"))[0];
      assert.deepStrictEqual(
        [afterRepair.goals, afterRepair.event_goals, afterRepair.legacy_goals],
        [11, 3, 8],
        'the X4 repair must keep the view equal to the stored total'
      );
      const storedAfter = (await lq("select goals from public.players where id = 'plegacy'"))[0];
      assert.strictEqual(storedAfter.goals, afterRepair.goals);

      // The migration is still safe to re-run after the flag changed.
      await lexec(migration);
      const afterRerun = (await lq("select goals, legacy_goals from public.v_player_stats where player_id = 'plegacy'"))[0];
      assert.deepStrictEqual([afterRerun.goals, afterRerun.legacy_goals], [11, 8]);
      console.log('OK upgrade migration backfills legacy totals and survives X4 plus a re-run');
    } finally {
      await legacy.close();
    }

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
      'an import with an uncounted fixture must keep the stored total while counting only the visible event'
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
