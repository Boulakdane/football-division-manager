#!/usr/bin/env node
/*
 * SQL tests for roadmap item A, stage 3: dropping the stored player totals.
 *
 * Runs in its own in-memory PGlite database. It rebuilds a project that
 * predates roadmap A (stored players.goals / yellow / red, no legacy offsets,
 * no views), then proves that:
 *   * derive-totals-migration.sql upgrades it and is re-runnable;
 *   * the X4 scheduled-fixture repair stays consistent with the view;
 *   * drop-stored-totals-migration.sql keeps every displayed total exactly;
 *   * the drop is safe to re-run and refuses the stage-1 file afterwards;
 *   * after the drop, events, save/delete/restore match, delete/restore team,
 *     add_players() and set_player_totals() all keep v_player_stats correct;
 *   * anon can read the view but cannot call the admin RPC.
 *
 * Usage: npm run test:drop-totals
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
  const currentTotals = () => q(
    `select player_id, goals, yellow, red, legacy_goals, legacy_yellow, legacy_red,
            event_goals, event_yellow, event_red
       from public.v_player_stats
      order by player_id`
  );

  try {
    await mockAuth(db);
    await exec(fs.readFileSync(path.join(ROOT, 'supabase/schema.sql'), 'utf8'));
    await makeAdmin(db);
    await exec(`set test.uid = '${ADMIN_ID}'`);

    // ------------------------------------------------------------
    // 1. Rebuild a project that predates roadmap A
    // ------------------------------------------------------------
    // schema.sql is the post-drop shape. Add the stored totals back (seeded
    // from the view) and remove the roadmap A objects, so the upgrade path is
    // exercised for real.
    await exec(`
      alter table public.players
        add column goals int not null default 0,
        add column yellow int not null default 0,
        add column red int not null default 0;
      update public.players p
         set goals = coalesce(v.goals, 0),
             yellow = coalesce(v.yellow, 0),
             red = coalesce(v.red, 0)
        from public.v_player_stats v
       where v.player_id = p.id;
      alter table public.players
        add constraint kickoff_players_totals_range
        check (goals >= 0 and yellow >= 0 and red >= 0);
      drop view public.v_standings;
      drop view public.v_match_results;
      drop view public.v_player_stats;
      drop view public.v_player_event_totals;
      alter table public.players
        drop column legacy_goals,
        drop column legacy_yellow,
        drop column legacy_red;
      drop function if exists public.set_player_totals(text, int, int, int);
    `);

    // A player whose typed total already includes history, plus one counted
    // fixture and one upcoming fixture whose event was kept out of the total.
    await exec(`
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

    // ------------------------------------------------------------
    // 2. Stage 1 upgrades the old project
    // ------------------------------------------------------------
    const deriveSql = fs.readFileSync(path.join(ROOT, 'supabase/derive-totals-migration.sql'), 'utf8');
    await exec(deriveSql);
    await exec(deriveSql);  // re-runnable

    const migrated = await totals('plegacy');
    assert.deepStrictEqual(
      [migrated.goals, migrated.yellow, migrated.red, migrated.event_goals, migrated.legacy_goals],
      [10, 2, 1, 2, 8],
      'only counted events are taken out of the stored total'
    );

    // X4 repairs an upcoming fixture: the event moves into the totals and the
    // flag flips. The view must move by exactly the same amount.
    await exec(`update public.matches set status = 'SCHEDULED' where id = 'm_legacy_uncounted'`);
    await exec(fs.readFileSync(path.join(ROOT, 'supabase/scheduled-match-events-migration.sql'), 'utf8'));
    const repaired = await totals('plegacy');
    assert.deepStrictEqual(
      [repaired.goals, repaired.event_goals, repaired.legacy_goals],
      [11, 3, 8],
      'the X4 repair keeps the view equal to the stored total'
    );
    assert.strictEqual(
      (await q("select goals from public.players where id = 'plegacy'"))[0].goals,
      11,
      'the stored total moved with the repair'
    );
    await exec(deriveSql);  // still safe after the flag changed
    assert.deepStrictEqual(
      [ (await totals('plegacy')).goals, (await totals('plegacy')).legacy_goals ],
      [11, 8]
    );

    // The pre-A maintenance migrations can still be re-run while the stored
    // columns exist. This is exactly why the drop comes last.
    const addPlayersSql = fs.readFileSync(path.join(ROOT, 'supabase/add-players-migration.sql'), 'utf8');
    await exec(addPlayersSql);
    await exec(addPlayersSql);
    console.log('OK stage 1 upgrades a pre-A project, survives X4 and a re-run');

    // ------------------------------------------------------------
    // 3. Stage 3 drops the stored columns without moving a total
    // ------------------------------------------------------------
    const beforeDrop = await currentTotals();
    const legacyBeforeDrop = await q(
      'select id, legacy_goals, legacy_yellow, legacy_red from public.players order by id'
    );

    const dropSql = fs.readFileSync(path.join(ROOT, 'supabase/drop-stored-totals-migration.sql'), 'utf8');
    await exec(dropSql);
    await exec(dropSql);  // safe to re-run: the backfill is skipped

    const storedColumns = await q(`
      select column_name
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'players'
        and column_name in ('goals', 'yellow', 'red')
    `);
    assert.strictEqual(storedColumns.length, 0, 'players.goals / yellow / red should be gone');
    assert.deepStrictEqual(await currentTotals(), beforeDrop, 'the drop must not move any total');
    assert.deepStrictEqual(
      await q('select id, legacy_goals, legacy_yellow, legacy_red from public.players order by id'),
      legacyBeforeDrop,
      'the drop must not move the legacy offset'
    );
    assert.strictEqual((await totals('plegacy')).goals, 11, 'the repaired total survived the drop');
    assert.strictEqual((await totals('p2')).goals, 7, 'seed totals survived the drop');
    assert.strictEqual((await totals('p5')).red, 1, 'seed cards survived the drop');

    // The stage-1 file now refuses to run: its functions write the dropped
    // columns.
    await expectError(() => exec(deriveSql), /already run drop-stored-totals-migration/);
    console.log('OK stage 3 keeps every total exactly, is re-runnable and closes stage 1');

    // ------------------------------------------------------------
    // 4. Post-drop write paths keep v_player_stats correct
    // ------------------------------------------------------------
    // Replacing events moves the view by exactly the event delta.
    assert.strictEqual((await totals('p1')).goals, 5);
    await asAdmin(() => q(
      `select public.replace_match_events('m7',
        '[{"id":"e_drop_goal","teamId":"t1","playerId":"p1","type":"goal","minute":23}]'::jsonb)`
    ));
    assert.deepStrictEqual(
      [ (await totals('p1')).goals, (await totals('p1')).event_goals ],
      [6, 2],
      'a new event raises the view total'
    );

    // A score-only save is not a totals write.
    await asAdmin(() => q(
      `select public.save_match(
        '{"id":"m7","season_id":"s1","round":3,"home_id":"t1","away_id":"t3","status":"LIVE","home_score":1,"away_score":0}'::jsonb,
        null
      )`
    ));
    assert.strictEqual((await totals('p1')).goals, 6, 'save_match does not touch player totals');

    // Trashing and restoring the fixture hides and re-adds the event.
    await asAdmin(() => q("select public.delete_match('m7')"));
    assert.strictEqual((await totals('p1')).goals, 5, 'a trashed fixture stops contributing');
    await asAdmin(() => q("select public.restore_match('m7')"));
    assert.strictEqual((await totals('p1')).goals, 6, 'restoring the fixture brings it back');
    await asAdmin(() => q("select public.replace_match_events('m7', '[]'::jsonb)"));
    assert.strictEqual((await totals('p1')).goals, 5, 'clearing the events restores the legacy total');

    // A trashed team hides its players from the view, and the restore brings
    // the same totals back.
    await asAdmin(() => q("select public.delete_team('t6')"));
    assert.strictEqual((await q("select 1 from public.v_player_stats where player_id = 'plegacy'")).length, 0);
    await asAdmin(() => q("select public.restore_team('t6')"));
    assert.strictEqual((await totals('plegacy')).goals, 11, 'restoring the team restores the totals');

    // add_players() and set_player_totals() move the legacy offset only.
    await asAdmin(() => q(
      `select public.add_players('t5', '[{"name":"Drop Forward","pos":"FWD","num":21,"goals":2,"yellow":1,"red":0}]'::jsonb)`
    ));
    const dropped = (await q("select id from public.players where name = 'Drop Forward'"))[0];
    const added = await totals(dropped.id);
    assert.deepStrictEqual(
      [added.goals, added.yellow, added.red, added.legacy_goals],
      [2, 1, 0, 2]
    );
    await asAdmin(() => q("select public.set_player_totals($1, 4, 3, 1)", [dropped.id]));
    const changed = await totals(dropped.id);
    assert.deepStrictEqual(
      [changed.goals, changed.yellow, changed.red, changed.legacy_goals],
      [4, 3, 1, 4]
    );
    await asAdmin(() => expectError(
      () => q("select public.set_player_totals('p1', 0, 0, 0)"),
      /goal events; the total cannot be lower/
    ));
    console.log('OK post-drop RPCs keep v_player_stats correct');

    // ------------------------------------------------------------
    // 5. Permissions
    // ------------------------------------------------------------
    const anonTotals = await asAnon(() =>
      q("select goals from public.v_player_stats where player_id = 'p2'")
    );
    assert.strictEqual(anonTotals[0].goals, 7, 'anon reads the view through RLS');
    await asAnon(() => expectError(
      () => q("select public.set_player_totals('p2', 1, 0, 0)"),
      /permission denied|not authorized|42501/i
    ));
    await asViewer(() => expectError(
      () => q("select public.set_player_totals('p2', 1, 0, 0)"),
      /Only admins/
    ));
    console.log('OK anon reads the view and only admins can change totals');

    console.log('All drop-stored-totals tests passed.');
  } finally {
    await db.close();
  }
}

run().catch(error => {
  console.error('Drop-stored-totals tests failed:', error);
  process.exit(1);
});
