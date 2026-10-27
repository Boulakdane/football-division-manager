#!/usr/bin/env node
/*
 * SQL tests for task L: optional Arabic names, licence number and birth date.
 *
 * Runs in its own in-memory PGlite database and proves that:
 *   * teams.name_ar / players.name_ar are optional but length-checked, and the
 *     Latin name is still required;
 *   * licence numbers live in public.player_profiles, trimmed and unique, and
 *     birth dates stay inside 1900-01-01 .. 2100-12-31;
 *   * a profile row is removed when its player is deleted;
 *   * v_player_stats exposes name_ar and never the personal columns;
 *   * add_players() and replace_all_data() carry all three fields, keep their
 *     validation, and leave nothing behind when a row is rejected;
 *   * the profile table is admin-only: anon has no grant and a non-admin
 *     authenticated user reads no rows;
 *   * arabic-names-and-license-migration.sql upgrades a pre-L database, keeps
 *     every row, and is re-runnable.
 *
 * Usage: npm run test:profile-fields
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
      language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
    create or replace function auth.jwt() returns jsonb
      language sql stable as $$ select coalesce(nullif(current_setting('test.jwt', true), '')::jsonb, '{}'::jsonb) $$;
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
  const day = value => {
    if (!value) return null;
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    return String(value).slice(0, 10);
  };
  const count = async (sql, params) => (await q(sql, params))[0].n;

  try {
    await mockAuth(db);
    await exec(fs.readFileSync(path.join(ROOT, 'supabase/schema.sql'), 'utf8'));
    await exec(`insert into auth.users (id, email) values ('${ADMIN_ID}', 'admin@test.local'), ('${VIEWER_ID}', 'viewer@test.local')`);
    await exec(`update public.profiles set role = 'admin' where id = '${ADMIN_ID}'`);

    const team = (await q('select id, name from public.teams where deleted_at is null order by id limit 1'))[0];
    const team2 = (await q('select id from public.teams where deleted_at is null and id <> $1 order by id limit 1', [team.id]))[0].id;
    const seedPlayers = await q('select id from public.players order by id limit 3');
    assert(seedPlayers.length >= 3, 'the seed must provide players');

    // ------------------------------------------------------------
    // 1. Optional Arabic names
    // ------------------------------------------------------------
    const nameArColumns = await q(`
      select table_name, is_nullable
      from information_schema.columns
      where table_schema = 'public' and column_name = 'name_ar'
        and table_name in ('teams', 'players')
      order by table_name
    `);
    assert.strictEqual(nameArColumns.length, 2, 'both tables carry name_ar');
    assert(nameArColumns.every(row => row.is_nullable === 'YES'), 'the Arabic name is optional');

    await exec(`update public.teams set name_ar = 'فريق النجوم' where id = '${team.id}'`);
    await exec(`update public.players set name_ar = '  محمد   العربي  ' where id = '${seedPlayers[0].id}'`);
    const stored = (await q('select name_ar from public.players where id = $1', [seedPlayers[0].id]))[0];
    assert.strictEqual(stored.name_ar, '  محمد   العربي  ', 'a plain update is stored verbatim; the app normalises');

    await expectError(
      () => exec(`update public.teams set name_ar = '' where id = '${team.id}'`),
      /kickoff_teams_name_ar_length/
    );
    await expectError(
      () => exec(`update public.players set name_ar = '${'x'.repeat(101)}' where id = '${seedPlayers[0].id}'`),
      /kickoff_players_name_ar_length/
    );
    await expectError(
      () => exec("insert into public.teams (id, name, name_ar) values ('t_no_name_ar', '', null)"),
      /kickoff_teams_name_length/
    );
    console.log('OK Arabic names are optional, length-checked and never replace the Latin name');

    // ------------------------------------------------------------
    // 2. Profile table: constraints, uniqueness, cascade
    // ------------------------------------------------------------
    const profileColumns = await q(`
      select column_name
      from information_schema.columns
      where table_schema = 'public' and table_name = 'players'
        and column_name in ('license_id', 'birth_date')
    `);
    assert.strictEqual(profileColumns.length, 0, 'personal columns must not live on the public players table');

    await exec(`insert into public.player_profiles (player_id, license_id, birth_date) values ('${seedPlayers[0].id}', ' ab-12 ', '2000-05-04')`);
    await expectError(
      () => exec(`insert into public.player_profiles (player_id, license_id) values ('${seedPlayers[1].id}', 'AB-12')`),
      /kickoff_player_profiles_license_key/
    );
    await exec(`insert into public.player_profiles (player_id, license_id) values ('${seedPlayers[1].id}', null)`);
    await exec(`insert into public.player_profiles (player_id) values ('${seedPlayers[2].id}')`);
    assert.strictEqual(
      await count('select count(*)::int n from public.player_profiles where license_id is null'),
      2,
      'two players may both have no licence number'
    );

    await expectError(
      () => exec(`update public.player_profiles set birth_date = '1899-12-31' where player_id = '${seedPlayers[0].id}'`),
      /kickoff_player_profiles_birth_date_range/
    );
    await expectError(
      () => exec(`update public.player_profiles set birth_date = '2101-01-01' where player_id = '${seedPlayers[0].id}'`),
      /kickoff_player_profiles_birth_date_range/
    );
    await exec(`update public.player_profiles set birth_date = '2100-12-31' where player_id = '${seedPlayers[0].id}'`);
    await exec(`update public.player_profiles set birth_date = null where player_id = '${seedPlayers[0].id}'`);

    await exec(`insert into public.players (id, team_id, name) values ('p_cascade', '${team.id}', 'Cascade Test')`);
    await exec("insert into public.player_profiles (player_id, license_id) values ('p_cascade', 'CASCADE-1')");
    await exec("delete from public.players where id = 'p_cascade'");
    assert.strictEqual(
      await count("select count(*)::int n from public.player_profiles where player_id = 'p_cascade'"),
      0,
      'deleting a player removes the profile row'
    );
    console.log('OK licence numbers are trimmed/unique and birth dates are bounded; profiles cascade');

    // ------------------------------------------------------------
    // 3. v_player_stats: name_ar visible, personal columns not
    // ------------------------------------------------------------
    const viewColumns = (await q(`
      select column_name
      from information_schema.columns
      where table_schema = 'public' and table_name = 'v_player_stats'
    `)).map(row => row.column_name);
    assert(viewColumns.includes('name_ar'), 'the view exposes the Arabic name');
    assert(!viewColumns.includes('license_id'), 'the view must not expose the licence number');
    assert(!viewColumns.includes('birth_date'), 'the view must not expose the birth date');
    const viewRow = (await q('select name_ar from public.v_player_stats where player_id = $1', [seedPlayers[0].id]))[0];
    assert.strictEqual(viewRow.name_ar, '  محمد   العربي  ');
    console.log('OK v_player_stats carries the Arabic name but no personal data');

    // ------------------------------------------------------------
    // 4. add_players() carries all three fields
    // ------------------------------------------------------------
    const add = (teamId, players) => q('select public.add_players($1, $2::jsonb) as n', [teamId, JSON.stringify(players)]);
    const added = await asAdmin(() => add(team.id, [
      { name: 'Bilal Haddad', name_ar: '  بلال   حداد ', license_id: ' LIC-100 ', birth_date: '2001-09-14' },
      { name: 'Sami Nouri', name_ar: 'سامي نوري' },
      { name: 'Omar Farouk' }
    ]));
    assert.strictEqual(added[0].n, 3);
    const bilal = (await q("select id, name, name_ar from public.players where name = 'Bilal Haddad'"))[0];
    assert.strictEqual(bilal.name_ar, 'بلال حداد', 'add_players collapses Arabic whitespace');
    const bilalProfile = (await q('select license_id, birth_date from public.player_profiles where player_id = $1', [bilal.id]))[0];
    assert.strictEqual(bilalProfile.license_id, 'LIC-100', 'the licence number is trimmed');
    assert.strictEqual(day(bilalProfile.birth_date), '2001-09-14');
    const sami = (await q("select id, name_ar from public.players where name = 'Sami Nouri'"))[0];
    assert.strictEqual(sami.name_ar, 'سامي نوري');
    assert.strictEqual(
      await count('select count(*)::int n from public.player_profiles where player_id = $1', [sami.id]),
      0,
      'a player without licence or birth date keeps no profile row'
    );
    const omar = (await q("select id from public.players where name = 'Omar Farouk'"))[0];
    assert.strictEqual(await count('select count(*)::int n from public.player_profiles where player_id = $1', [omar.id]), 0);

    const before = await count('select count(*)::int n from public.players');
    const bad = async (players, pattern, label) => {
      await asAdmin(() => expectError(() => add(team.id, players), pattern));
      assert.strictEqual(await count('select count(*)::int n from public.players'), before, `${label}: nothing may be inserted`);
    };
    await bad([{ name: 'Dup Licence A', license_id: 'lic-100' }], /belongs to another player/, 'licence already used');
    await bad([{ name: 'Dup Licence B', license_id: 'NEW-1' }, { name: 'Dup Licence C', license_id: ' new-1 ' }], /appears more than once/, 'licence repeated in the file');
    await bad([{ name: 'Future Kid', birth_date: '2999-01-01' }], /birth date/, 'future birth date');
    await bad([{ name: 'Old Kid', birth_date: '1899-12-31' }], /birth date/, 'birth date before 1900');
    await bad([{ name: 'Bad Date', birth_date: '14/09/2001' }], /YYYY-MM-DD/, 'non-ISO birth date');
    await bad([{ name: 'Long Licence', license_id: 'x'.repeat(51) }], /at most 50/, 'licence too long');
    await bad([{ name: 'Long Arabic', name_ar: 'x'.repeat(101) }], /Arabic name/, 'Arabic name too long');
    await asAdmin(() => expectError(() => add('no_such_team', [{ name: 'Ghost', license_id: 'G-1' }]), /Team not found/));
    assert.strictEqual(
      await count("select count(*)::int n from public.player_profiles where license_id in ('NEW-1', 'G-1')"),
      0,
      'a rejected import leaves no profile behind'
    );
    console.log('OK add_players validates and stores the Arabic name, licence and birth date atomically');

    // ------------------------------------------------------------
    // 5. Full backup round trip
    // ------------------------------------------------------------
    const backup = async () => {
      const seasons = await q('select id, name, start_date, end_date, is_active from public.seasons order by id');
      const teams = await q('select id, name, name_ar, code, color, division_id from public.teams order by id');
      const players = await q(`
        select p.id, p.team_id, p.name, p.name_ar, p.pos, p.num,
               p.legacy_goals as goals, p.legacy_yellow as yellow, p.legacy_red as red,
               p.is_active,
               pp.license_id, pp.birth_date
        from public.players p
        left join public.player_profiles pp on pp.player_id = p.id
        order by p.id
      `);
      const matches = await q('select id, season_id, division_id, round, home_id, away_id, home_score, away_score, status from public.matches order by id');
      const events = await q('select id, match_id, team_id, player_id, event_type, minute from public.match_events order by id');
      return {
        seasons: seasons.map(row => ({
          id: row.id, name: row.name, start_date: row.start_date, end_date: row.end_date, is_active: row.is_active
        })),
        teams,
        players: players.map(row => ({
          ...row,
          birth_date: row.birth_date ? day(row.birth_date) : null
        })),
        matches,
        match_events: events
      };
    };

    const snapshot = await backup();
    assert(snapshot.players.some(row => row.name_ar), 'the backup carries name_ar');
    assert(snapshot.players.some(row => row.license_id === 'LIC-100'), 'the backup carries the licence number');

    await asAdmin(() => q('select public.replace_all_data($1::jsonb)', [JSON.stringify(snapshot)]));
    const restoredTeam = (await q('select name_ar from public.teams where id = $1', [team.id]))[0];
    assert.strictEqual(restoredTeam.name_ar, 'فريق النجوم', 'the team Arabic name survives the round trip');
    const restoredBilal = (await q("select id, name_ar from public.players where name = 'Bilal Haddad'"))[0];
    assert.strictEqual(restoredBilal.name_ar, 'بلال حداد');
    const restoredProfile = (await q('select license_id, birth_date from public.player_profiles where player_id = $1', [restoredBilal.id]))[0];
    assert.strictEqual(restoredProfile.license_id, 'LIC-100');
    assert.strictEqual(day(restoredProfile.birth_date), '2001-09-14');
    assert.strictEqual(
      await count('select count(*)::int n from public.player_profiles'),
      snapshot.players.filter(row => row.license_id || row.birth_date).length,
      'only players with personal data keep a profile row after the import'
    );

    const duplicateLicence = await backup();
    duplicateLicence.players[1].license_id = 'lic-100';
    await asAdmin(() => expectError(
      () => q('select public.replace_all_data($1::jsonb)', [JSON.stringify(duplicateLicence)]),
      /Every imported licence number must be unique/
    ));
    assert.strictEqual(
      await count('select count(*)::int n from public.players'),
      snapshot.players.length,
      'a rejected import deletes nothing'
    );

    const badBirthDate = await backup();
    badBirthDate.players[1].birth_date = '14/09/2001';
    await asAdmin(() => expectError(
      () => q('select public.replace_all_data($1::jsonb)', [JSON.stringify(badBirthDate)]),
      /Every imported birth date must use YYYY-MM-DD/
    ));

    const oldBackup = await backup();
    oldBackup.teams = oldBackup.teams.map(({ name_ar, ...rest }) => rest);
    oldBackup.players = oldBackup.players.map(({ name_ar, license_id, birth_date, ...rest }) => rest);
    await asAdmin(() => q('select public.replace_all_data($1::jsonb)', [JSON.stringify(oldBackup)]));
    assert.strictEqual(
      await count('select count(*)::int n from public.player_profiles'),
      0,
      'a pre-L backup imports cleanly and leaves no profile rows'
    );
    assert.strictEqual(
      await count('select count(*)::int n from public.players'),
      oldBackup.players.length,
      'a pre-L backup keeps every player'
    );
    console.log('OK backup round trip keeps all three fields, rejects bad data and accepts old backups');

    // ------------------------------------------------------------
    // 6. Admin-only access
    // ------------------------------------------------------------
    await asAdmin(() => q("insert into public.player_profiles (player_id, license_id) values ($1, 'ADMIN-ONLY')", [seedPlayers[0].id]));
    await asAnon(() => expectError(
      () => q('select * from public.player_profiles'),
      /permission denied/i
    ));
    await asAnon(() => expectError(
      () => q("insert into public.player_profiles (player_id, license_id) values ('${seedPlayers[1].id}', 'ANON')"),
      /permission denied/i
    ));
    const viewerRows = await asViewer(() => q('select * from public.player_profiles'));
    assert.strictEqual(viewerRows.length, 0, 'a signed-in non-admin reads no profile rows');
    await asViewer(() => expectError(
      () => q("insert into public.player_profiles (player_id, license_id) values ('${seedPlayers[2].id}', 'VIEWER')"),
      /row-level security|new row violates/i
    ));
    const adminRows = await asAdmin(() => q('select * from public.player_profiles'));
    assert(adminRows.length > 0, 'an admin reads the profiles');
    assert(adminRows.some(row => row.license_id === 'ADMIN-ONLY'));
    await asAdmin(() => q("insert into public.player_profiles (player_id, license_id) values ($1, 'COLLIDE')", [seedPlayers[1].id]));
    await asAdmin(() => expectError(
      () => q("update public.player_profiles set license_id = 'COLLIDE' where license_id = 'ADMIN-ONLY'"),
      /kickoff_player_profiles_license_key/
    ));
    console.log('OK player_profiles is admin-only (anon denied, viewer filtered, admin allowed)');

    // ------------------------------------------------------------
    // 7. The migration upgrades a pre-L database and is re-runnable
    // ------------------------------------------------------------
    const rowCounts = async () => ({
      teams: await count('select count(*)::int n from public.teams'),
      players: await count('select count(*)::int n from public.players'),
      matches: await count('select count(*)::int n from public.matches')
    });
    const beforeMigration = await rowCounts();

    // Simulate the released schema: no name_ar columns, no profile table and
    // the old v_player_stats output.
    await exec('drop view if exists public.v_player_stats');
    await exec('drop table if exists public.player_profiles');
    await exec('alter table public.players drop column if exists name_ar');
    await exec('alter table public.teams drop column if exists name_ar');
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

    const migration = fs.readFileSync(path.join(ROOT, 'supabase/arabic-names-and-license-migration.sql'), 'utf8');
    await exec(migration);
    assert.deepStrictEqual(await rowCounts(), beforeMigration, 'the migration must not touch league rows');

    const upgradedColumns = await q(`
      select table_name, column_name
      from information_schema.columns
      where table_schema = 'public'
        and ((table_name = 'teams' and column_name = 'name_ar')
          or (table_name = 'players' and column_name = 'name_ar'))
    `);
    assert.strictEqual(upgradedColumns.length, 2, 'the migration adds both Arabic name columns');

    await exec(`update public.teams set name_ar = 'بعد الترحيل' where id = '${team.id}'`);
    await exec(`insert into public.player_profiles (player_id, license_id, birth_date) values ('${seedPlayers[1].id}', 'MIG-1', '1999-01-02')`);

    // Re-run: nothing is duplicated and the data written after the first run is kept.
    await exec(migration);
    await exec(migration);
    assert.deepStrictEqual(await rowCounts(), beforeMigration, 'a migration re-run preserves every row');
    assert.strictEqual(
      (await q('select name_ar from public.teams where id = $1', [team.id]))[0].name_ar,
      'بعد الترحيل',
      'a re-run preserves the Arabic name'
    );
    const migratedProfile = (await q("select license_id, birth_date from public.player_profiles where license_id = 'MIG-1'"))[0];
    assert.strictEqual(migratedProfile.license_id, 'MIG-1');
    assert.strictEqual(day(migratedProfile.birth_date), '1999-01-02');

    const migratedView = (await q(`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'v_player_stats'
    `)).map(row => row.column_name);
    assert(migratedView.includes('name_ar'), 'the migration recreates v_player_stats with name_ar');
    assert(!migratedView.includes('license_id') && !migratedView.includes('birth_date'));
    assert.strictEqual(
      await count('select count(*)::int n from public.player_profiles'),
      1,
      'a re-run does not duplicate profile rows'
    );

    // The upgraded functions still work.
    const afterUpgrade = await asAdmin(() => add(team.id, [
      { name: 'After Migration', name_ar: 'بعد الترحيل', license_id: 'MIG-2', birth_date: '2002-02-02' }
    ]));
    assert.strictEqual(afterUpgrade[0].n, 1);
    const afterRow = (await q("select id from public.players where name = 'After Migration'"))[0];
    const afterProfile = (await q('select license_id, birth_date from public.player_profiles where player_id = $1', [afterRow.id]))[0];
    assert.strictEqual(afterProfile.license_id, 'MIG-2');
    assert.strictEqual(day(afterProfile.birth_date), '2002-02-02');
    console.log('OK arabic-names-and-license-migration.sql upgrades a pre-L database and is re-runnable');

    console.log('\nAll profile-field tests passed.');
  } finally {
    await db.close();
  }
}

run().catch(error => {
  console.error('profile-field tests failed:', error);
  process.exit(1);
});
