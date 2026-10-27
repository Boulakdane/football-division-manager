#!/usr/bin/env node
/*
 * SQL tests for roadmap item K: Division 1 and Division 2.
 *
 * Runs in its own in-memory PGlite database and proves that:
 *   * divisions are seeded, publicly readable and not client-writable;
 *   * existing clubs default to Division 1 and a team always has one division;
 *   * save_match() derives the division from the teams and refuses a
 *     cross-division or changed-division fixture;
 *   * a fixture keeps the division it was played in when its team moves;
 *   * set_team_division() is admin-only, audited, and refuses a club with a
 *     fixture in the active season;
 *   * v_match_results / v_standings expose one table per division, and an
 *     archived season follows the division actually played;
 *   * replace_all_data() keeps divisions, rejects unknown ones, defaults old
 *     backups to Division 1, and restores history even after a club moved;
 *   * divisions-migration.sql is re-runnable and preserves every row.
 *
 * Usage: npm run test:divisions
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

async function run() {
  const db = new PGlite();
  const exec = sql => db.exec(sql);
  const q = async (sql, params) => (await db.query(sql, params)).rows;

  const asRole = async (role, uid, fn) => {
    await exec(`set test.uid = '${uid}'`);
    await exec(`set role ${role}`);
    try {
      return await fn();
    } finally {
      await exec('reset role');
      await exec(`set test.uid = ''`);
    }
  };
  const asAdmin = fn => asRole('authenticated', ADMIN_ID, fn);
  const asViewer = fn => asRole('authenticated', VIEWER_ID, fn);
  const asAnon = fn => asRole('anon', '', fn);

  const expectError = async (fn, pattern) => {
    let error = null;
    try {
      await fn();
    } catch (err) {
      error = err;
    }
    assert(error, 'expected an error');
    assert(pattern.test(String(error.message || error)), `unexpected error: ${error.message || error}`);
  };

  const saveMatch = match => asAdmin(() => q('select public.save_match($1::jsonb)', [JSON.stringify(match)]));
  const moveTeam = (teamId, divisionId) => asAdmin(() =>
    q('select public.set_team_division($1, $2)', [teamId, divisionId])
  );
  const standingRows = (seasonId, divisionId) => q(
    `select team_id, played, points, position, division_id
     from public.v_standings
     where season_id = $1 and division_id = $2
     order by position, team_id`,
    [seasonId, divisionId]
  );

  try {
    await mockAuth(db);
    await exec(fs.readFileSync(path.join(ROOT, 'supabase/schema.sql'), 'utf8'));
    await exec(`
      insert into auth.users (id, email) values
        ('${ADMIN_ID}', 'admin@test.local'),
        ('${VIEWER_ID}', 'viewer@test.local')
    `);
    await exec(`update public.profiles set role = 'admin' where id = '${ADMIN_ID}'`);

    // ------------------------------------------------------------
    // 1. Seeded, readable, maintainer-only divisions
    // ------------------------------------------------------------
    const divisions = await q('select id, name, sort_order from public.divisions order by sort_order');
    assert.deepStrictEqual(divisions.map(row => row.id), ['d1', 'd2'], 'both tiers must be seeded');
    assert.deepStrictEqual(divisions.map(row => row.sort_order), [1, 2]);

    const anonDivisions = await asAnon(() => q('select id from public.divisions order by id'));
    assert.deepStrictEqual(anonDivisions.map(row => row.id), ['d1', 'd2'], 'anon may read divisions');

    for (const actor of [asAnon, asViewer, asAdmin]) {
      await expectError(
        () => actor(() => q("insert into public.divisions (id, name, sort_order) values ('d3', 'Division 3', 3)")),
        /permission denied|row-level security/i
      );
    }
    console.log('OK divisions are seeded, publicly readable and not client-writable');

    // ------------------------------------------------------------
    // 2. Teams default to Division 1; the foreign key is the boundary
    // ------------------------------------------------------------
    assert.deepStrictEqual(
      (await q("select division_id from public.teams where id = 't1'"))[0].division_id,
      'd1',
      'existing clubs stay in Division 1'
    );

    await expectError(
      () => q("insert into public.teams (id, name, code, color, division_id) values ('tx', 'Unknown', 'UNK', '#123456', 'd9')"),
      /teams_division_id_fkey/
    );

    await exec(`
      insert into public.teams (id, name, code, color, division_id) values
        ('t7', 'Falcons', 'FAL', '#0ea5e9', 'd2'),
        ('t8', 'Comets',  'COM', '#a855f7', 'd2'),
        ('t9', 'Rovers',  'ROV', '#f97316', 'd2'),
        ('t10', 'Wolves', 'WOL', '#14b8a6', 'd2');
      insert into public.seasons (id, name, is_active) values ('s2', 'Archived', false);
    `);
    console.log('OK a team has one division and unknown divisions are rejected');

    // ------------------------------------------------------------
    // 3. Fixtures are stamped with their division
    // ------------------------------------------------------------
    await exec(`
      insert into public.matches
        (id, season_id, division_id, round, home_id, away_id, home_score, away_score, status)
      values
        ('m_d2',     's1', 'd2', 1, 't7', 't8',  2, 0, 'FINISHED'),
        ('m_d2_old', 's2', 'd2', 1, 't9', 't10', 1, 1, 'FINISHED'),
        ('m_d1_old', 's2', 'd1', 1, 't1', 't2',  3, 0, 'FINISHED');
    `);

    // A direct insert that omits the division falls back to the column default
    // (d1) and must be rejected for Division 2 clubs.
    await expectError(
      () => q("insert into public.matches (id, season_id, round, home_id, away_id) values ('m_nodiv', 's1', 2, 't7', 't8')"),
      /fixture division must be the division of both teams/
    );

    // A cross-division fixture is rejected even with an explicit division.
    await expectError(
      () => q("insert into public.matches (id, season_id, division_id, round, home_id, away_id) values ('m_mixed', 's1', 'd1', 2, 't1', 't7')"),
      /same division/
    );

    // The division of an existing fixture is immutable.
    await expectError(
      () => q("update public.matches set division_id = 'd1' where id = 'm_d2'"),
      /cannot be moved to another division/
    );

    // Ordinary score edits still work.
    await q("update public.matches set home_score = 3 where id = 'm_d2'");
    assert.strictEqual(
      (await q("select division_id, home_score from public.matches where id = 'm_d2'"))[0].home_score,
      3
    );
    console.log('OK a fixture is stamped with one division and cannot change it');

    // ------------------------------------------------------------
    // 4. save_match() derives and validates the division
    // ------------------------------------------------------------
    await saveMatch({
      id: 'm_saved_d2',
      season_id: 's1',
      round: 2,
      home_id: 't7',
      away_id: 't8',
      status: 'SCHEDULED'
    });
    assert.strictEqual(
      (await q("select division_id from public.matches where id = 'm_saved_d2'"))[0].division_id,
      'd2',
      'an omitted division is derived from the home team'
    );

    await expectError(
      () => saveMatch({
        id: 'm_bad_div',
        season_id: 's1',
        division_id: 'd1',
        round: 2,
        home_id: 't7',
        away_id: 't8',
        status: 'SCHEDULED'
      }),
      /fixture division must be the division of both teams/
    );

    await expectError(
      () => saveMatch({
        id: 'm_cross',
        season_id: 's1',
        round: 2,
        home_id: 't1',
        away_id: 't7',
        status: 'SCHEDULED'
      }),
      /same division/
    );

    await expectError(
      () => saveMatch({
        id: 'm_d2',
        season_id: 's1',
        division_id: 'd1',
        round: 1,
        home_id: 't7',
        away_id: 't8',
        status: 'FINISHED'
      }),
      /same division|division of both teams|cannot be moved/
    );

    assert.strictEqual(
      (await q("select count(*)::int n from public.audit_log where entity = 'matches' and entity_id = 'm_saved_d2' and action = 'INSERT'"))[0].n,
      1,
      'saving a Division 2 fixture is audited'
    );
    console.log('OK save_match derives the division and rejects inconsistent fixtures');

    // ------------------------------------------------------------
    // 5. Moving a club between seasons
    // ------------------------------------------------------------
    await expectError(
      () => asViewer(() => q("select public.set_team_division('t9', 'd1')")),
      /Only admins/
    );
    await expectError(
      () => asAnon(() => q("select public.set_team_division('t9', 'd1')")),
      /permission denied|Only admins/
    );
    await expectError(() => moveTeam('t9', 'd9'), /Unknown division/);
    await expectError(() => moveTeam('missing', 'd1'), /not found/);

    // t1 has fixtures in the active season, so it cannot move.
    await expectError(() => moveTeam('t1', 'd2'), /active season cannot change division/);

    // A direct REST update is guarded the same way.
    await expectError(
      () => asAdmin(() => q("update public.teams set division_id = 'd2' where id = 't1'")),
      /active season cannot change division/
    );

    // t9 only played in the archived season, so the move is allowed and the
    // old fixture keeps Division 2.
    await moveTeam('t9', 'd1');
    assert.strictEqual(
      (await q("select division_id from public.teams where id = 't9'"))[0].division_id,
      'd1'
    );
    assert.strictEqual(
      (await q("select division_id from public.matches where id = 'm_d2_old'"))[0].division_id,
      'd2',
      'the archive keeps the division the fixture was played in'
    );
    assert.strictEqual(
      (await q("select count(*)::int n from public.audit_log where entity = 'teams' and entity_id = 't9' and action = 'UPDATE'"))[0].n >= 1,
      true,
      'a division move is audited'
    );

    // Moving back is equally fine while the club still has no active fixture.
    await moveTeam('t9', 'd2');
    console.log('OK set_team_division is admin-only, guarded and audited');

    // ------------------------------------------------------------
    // 6. One table per division, in active and archived seasons
    // ------------------------------------------------------------
    const d2Table = await standingRows('s1', 'd2');
    assert.deepStrictEqual(
      d2Table.map(row => row.team_id).sort(),
      ['t10', 't7', 't8', 't9'],
      'the active Division 2 table lists only its current clubs'
    );
    assert.deepStrictEqual(
      d2Table.filter(row => row.team_id === 't7').map(row => [row.played, row.points, row.position]),
      [[1, 3, 1]],
      'Division 2 points come from Division 2 fixtures only'
    );

    const d1Table = await standingRows('s1', 'd1');
    assert(!d1Table.some(row => row.team_id === 't7'), 'Division 2 clubs never appear in Division 1');
    assert(d1Table.some(row => row.team_id === 't1'), 'Division 1 keeps its seeded clubs');

    // The archived season follows the division actually played, even after a
    // club moves: t9 played in Division 2 and still appears there.
    const archivedD2 = await standingRows('s2', 'd2');
    assert.deepStrictEqual(
      archivedD2.map(row => row.team_id).sort(),
      ['t10', 't9'],
      'an archived table lists the clubs that played in that division'
    );
    assert.strictEqual(
      archivedD2.find(row => row.team_id === 't9').points,
      1,
      'the archived draw is counted'
    );
    const archivedD1 = await standingRows('s2', 'd1');
    assert(!archivedD1.some(row => row.team_id === 't9'), 'the moved club does not leak into the old archive table');

    const results = await q("select match_id, division_id from public.v_match_results order by match_id");
    assert(results.every(row => row.division_id === 'd1' || row.division_id === 'd2'));
    assert.strictEqual(
      results.find(row => row.match_id === 'm_d2').division_id,
      'd2',
      'v_match_results exposes the match division'
    );
    console.log('OK v_match_results and v_standings are scoped per division');

    // ------------------------------------------------------------
    // 7. Full import keeps the division, and old backups default to d1
    // ------------------------------------------------------------
    const players = await q("select id from public.players where team_id in ('t1', 't7') order by id");
    assert(players.length, 'seed players must exist before the import');

    const payload = {
      seasons: [{ id: 's1', name: '2026 Season', is_active: true }],
      teams: [
        { id: 't1', name: 'Spartan FC', code: 'SFC', color: '#3b82f6', division_id: 'd1' },
        { id: 't7', name: 'Falcons', code: 'FAL', color: '#0ea5e9', division_id: 'd2' }
      ],
      players: [
        { id: 'p1', team_id: 't1', name: 'David Silva', pos: 'MID', num: 10, goals: 0, yellow: 0, red: 0 },
        { id: 'p7', team_id: 't7', name: 'Falcon Nine', pos: 'FWD', num: 9, goals: 0, yellow: 0, red: 0 }
      ],
      matches: [
        { id: 'm1', season_id: 's1', division_id: 'd1', round: 1, home_id: 't1', away_id: 't2', status: 'SCHEDULED' },
        { id: 'm7', season_id: 's1', division_id: 'd2', round: 1, home_id: 't7', away_id: 't8', status: 'SCHEDULED' }
      ],
      match_events: []
    };
    // The payload above references t2/t8, so give them rows as well.
    payload.teams.push(
      { id: 't2', name: 'Titan United', code: 'TTN', color: '#10b981' },
      { id: 't8', name: 'Comets', code: 'COM', color: '#a855f7', division_id: 'd2' }
    );

    await asAdmin(() => q('select public.replace_all_data($1::jsonb)', [JSON.stringify(payload)]));
    assert.strictEqual(
      (await q("select division_id from public.teams where id = 't7'"))[0].division_id,
      'd2',
      'the import keeps an explicit team division'
    );
    assert.strictEqual(
      (await q("select division_id from public.teams where id = 't2'"))[0].division_id,
      'd1',
      'an older team row without a division defaults to Division 1'
    );
    assert.strictEqual(
      (await q("select division_id from public.matches where id = 'm7'"))[0].division_id,
      'd2'
    );
    assert.strictEqual(
      (await q("select count(*)::int n from public.divisions"))[0].n,
      2,
      'a full import never deletes the seeded divisions'
    );

    await expectError(
      () => asAdmin(() => q('select public.replace_all_data($1::jsonb)', [JSON.stringify({
        ...payload,
        teams: [{ id: 't1', name: 'Spartan FC', code: 'SFC', color: '#3b82f6', division_id: 'd9' }]
      })])),
      /known division/
    );
    await expectError(
      () => asAdmin(() => q('select public.replace_all_data($1::jsonb)', [JSON.stringify({
        ...payload,
        matches: [{ id: 'm1', season_id: 's1', division_id: 'd9', round: 1, home_id: 't1', away_id: 't2', status: 'SCHEDULED' }]
      })])),
      /known division/
    );

    // A club that moved after a season still has fixtures in the division it
    // played. A restore must keep that division even though the two clubs are
    // now registered in different tiers, exactly like the archived table does.
    const historic = {
      seasons: [
        { id: 's1', name: '2027 Season', is_active: true },
        { id: 's2', name: '2026 Season', is_active: false }
      ],
      teams: [
        { id: 't1', name: 'Spartan FC', code: 'SFC', color: '#3b82f6', division_id: 'd1' },
        { id: 't7', name: 'Falcons', code: 'FAL', color: '#0ea5e9', division_id: 'd2' }
      ],
      players: [],
      matches: [
        { id: 'm_hist', season_id: 's2', division_id: 'd2', round: 1, home_id: 't1', away_id: 't7', home_score: 2, away_score: 1, status: 'FINISHED' }
      ],
      match_events: []
    };
    await asAdmin(() => q('select public.replace_all_data($1::jsonb)', [JSON.stringify(historic)]));
    assert.strictEqual(
      (await q("select division_id from public.matches where id = 'm_hist'"))[0].division_id,
      'd2',
      'a restore keeps the division the fixture was played in'
    );
    const restoredArchive = await standingRows('s2', 'd2');
    assert.deepStrictEqual(
      restoredArchive.map(row => row.team_id).sort(),
      ['t1', 't7'],
      'the restored archive table follows the fixture division, not current registrations'
    );
    assert.strictEqual(
      restoredArchive.find(row => row.team_id === 't1').points,
      3,
      'the restored result is counted for the club that has since moved'
    );

    // The guard is re-armed after the import: an ordinary cross-division insert
    // through REST is still refused.
    await expectError(
      () => q("insert into public.matches (id, season_id, division_id, round, home_id, away_id) values ('m_after_import', 's1', 'd2', 2, 't1', 't7')"),
      /same division/
    );
    console.log('OK replace_all_data keeps divisions, restores fixture history and refuses unknown tiers');

    // ------------------------------------------------------------
    // 8. The migration is re-runnable
    // ------------------------------------------------------------
    // divisions-migration.sql was written before task L, when v_player_stats had
    // no name_ar column. Restore that shape first so this re-run reflects the
    // real order (K, then L); the task L migration recreates the view afterwards.
    await exec('drop view if exists public.v_player_stats');
    await exec(`
      create view public.v_player_stats
      with (security_invoker = true) as
      select p.id as player_id,
             p.team_id,
             p.name,
             p.pos,
             p.num,
             p.is_active,
             p.legacy_goals,
             p.legacy_yellow,
             p.legacy_red,
             coalesce(e.goals, 0) as event_goals,
             coalesce(e.yellow, 0) as event_yellow,
             coalesce(e.red, 0) as event_red,
             p.legacy_goals + coalesce(e.goals, 0) as goals,
             p.legacy_yellow + coalesce(e.yellow, 0) as yellow,
             p.legacy_red + coalesce(e.red, 0) as red,
             t.division_id
      from public.players p
      join public.teams t
        on t.id = p.team_id
       and t.deleted_at is null
      left join public.v_player_event_totals e on e.player_id = p.id;
    `);
    const migration = fs.readFileSync(path.join(ROOT, 'supabase/divisions-migration.sql'), 'utf8');
    await exec(migration);
    await exec(migration);

    assert.strictEqual((await q('select count(*)::int n from public.divisions'))[0].n, 2, 'no duplicate tiers');
    assert.strictEqual(
      (await q("select division_id from public.teams where id = 't7'"))[0].division_id,
      'd2',
      'a migration re-run preserves team registrations'
    );
    assert.strictEqual(
      (await q("select division_id from public.matches where id = 'm_hist'"))[0].division_id,
      'd2',
      'a migration re-run preserves fixture history'
    );
    assert.strictEqual(
      (await q("select count(*)::int n from public.v_standings where division_id = 'd2'"))[0].n > 0,
      true,
      'the views survive a re-run'
    );
    console.log('OK divisions-migration.sql is re-runnable');

    console.log('\nAll division tests passed.');
  } finally {
    await db.close();
  }
}

run().catch(error => {
  console.error('\nDivision tests failed:', error);
  process.exit(1);
});
