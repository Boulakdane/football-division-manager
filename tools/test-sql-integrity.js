#!/usr/bin/env node
/*
 * SQL integrity tests for the league schema.
 *
 * Runs against an in-memory PGlite database (Postgres compiled to WASM), so it
 * needs no Docker daemon or hosted Supabase project. The auth schema and
 * auth.uid() are mocked with a session setting; roles match Supabase's anon
 * and authenticated roles.
 *
 * Usage:
 *   npm run test:sql
 */

'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { PGlite } = require('@electric-sql/pglite');

const ROOT = path.resolve(__dirname, '..');
const ADMIN_ID = '00000000-0000-0000-0000-000000000001';

async function createDatabase() {
  const db = new PGlite();
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
  await db.exec(fs.readFileSync(path.join(ROOT, 'supabase/schema.sql'), 'utf8'));
  await db.exec(`insert into auth.users (id, email) values ('${ADMIN_ID}', 'admin@test.local')`);
  await db.exec(`update public.profiles set role = 'admin' where id = '${ADMIN_ID}'`);
  await db.exec(`set test.uid = '${ADMIN_ID}'`);
  return db;
}

async function run() {
  const db = await createDatabase();
  const q = async (sql, params) => (await db.query(sql, params)).rows;
  const exec = sql => db.exec(sql);
  const asRole = async (role, fn) => {
    await exec(`set role ${role}`);
    try {
      return await fn();
    } finally {
      await exec('reset role');
    }
  };
  const expectError = async (fn, pattern) => {
    let error = null;
    try {
      await fn();
    } catch (err) {
      error = err;
    }
    assert(error, 'expected an error');
    if (pattern) assert(pattern.test(String(error.message || error)), `unexpected error: ${error.message || error}`);
  };

  try {
    // Upgrading an existing project: integrity, audit, then soft delete.
    // Every migration must be safe to re-run.
    await exec(fs.readFileSync(path.join(ROOT, 'supabase/integrity-migration.sql'), 'utf8'));
    await exec(fs.readFileSync(path.join(ROOT, 'supabase/audit-log-migration.sql'), 'utf8'));
    const softDeleteSql = fs.readFileSync(path.join(ROOT, 'supabase/soft-delete-migration.sql'), 'utf8');
    await exec(softDeleteSql);
    await exec(softDeleteSql);
    const mfaSql = fs.readFileSync(path.join(ROOT, 'supabase/mfa-migration.sql'), 'utf8');
    await exec(mfaSql);
    await exec(mfaSql);
    const constraintSql = fs.readFileSync(path.join(ROOT, 'supabase/check-constraints-migration.sql'), 'utf8');
    await exec(constraintSql);
    await exec(constraintSql);

    // Data-quality constraints reject malformed rows even for a direct table
    // write, not just through the UI or an RPC.
    await expectError(
      () => q("insert into public.teams (id, name, code, color) values ('tbadcolor', 'Bad Color', 'BAD', 'red')"),
      /kickoff_teams_color_hex/
    );
    await expectError(
      () => q("insert into public.teams (id, name, code, color) values ('tbadname', '   ', 'BAD', '#123456')"),
      /kickoff_teams_name_length/
    );
    await expectError(
      () => q("insert into public.players (id, team_id, name, pos, num, goals) values ('pbadgoals', 't1', 'Bad Goals', 'FWD', 10, -1)"),
      /kickoff_players_totals_range/
    );
    await expectError(
      () => q("insert into public.players (id, team_id, name, pos, num) values ('pbadnum', 't1', 'Bad Number', 'FWD', -1)"),
      /kickoff_players_num_range/
    );
    await expectError(
      () => q("insert into public.matches (id, season_id, round, home_id, away_id) values ('mbadround', 's1', 0, 't1', 't2')"),
      /kickoff_matches_round_range/
    );
    await expectError(
      () => q("insert into public.matches (id, season_id, round, home_id, away_id) values ('mbadsame', 's1', 1, 't1', 't1')"),
      /kickoff_matches_distinct_teams/
    );
    await expectError(
      () => q("insert into public.seasons (id, name, is_active) values ('sbadname', '   ', false)"),
      /kickoff_seasons_name_length/
    );
    console.log('OK data-quality constraints reject malformed rows');

    // Archived season + isolated team-deletion fixtures.
    await exec(`
      insert into public.seasons (id, name, is_active) values ('s0', 'Archived', false);
      insert into public.matches (id, season_id, round, home_id, away_id, home_score, away_score, status)
        values ('m_arch', 's0', 1, 't1', 't2', 1, 0, 'FINISHED');
      insert into public.match_events (id, match_id, team_id, player_id, event_type, minute)
        values ('e_arch', 'm_arch', 't1', 'p1', 'goal', 9);

      insert into public.teams (id, name, code, color) values
        ('tdel', 'Delete FC', 'DEL', '#111111'),
        ('tkeep', 'Keep FC', 'KEP', '#222222');
      insert into public.players (id, team_id, name, pos, num, goals, yellow, red) values
        ('pdel', 'tdel', 'Delete Player', 'FWD', 9, 0, 0, 0),
        ('pkeep', 'tkeep', 'Keep Player', 'FWD', 10, 0, 0, 0),
        ('pother', 'tkeep', 'Other Player', 'MID', 8, 0, 0, 0),
        ('pextra', 'tkeep', 'Extra Player', 'MID', 7, 0, 0, 0);
      insert into public.matches (id, season_id, round, home_id, away_id, home_score, away_score, status, events_counted)
        values ('m_del', 's1', 9, 'tdel', 'tkeep', 2, 1, 'FINISHED', true);
    `);

    // Archived seasons are read-only through direct table writes.
    const archivedUpdate = await asRole('authenticated', () =>
      q("update public.matches set venue = 'hacked' where id = 'm_arch' returning id")
    );
    assert.strictEqual(archivedUpdate.length, 0, 'archived match update should be blocked');

    const archivedInsert = await asRole('authenticated', () =>
      q("insert into public.matches (id, season_id, round, home_id, away_id) values ('m_arch2', 's0', 2, 't1', 't2') returning id")
        .then(rows => rows, err => err)
    );
    assert(archivedInsert instanceof Error, 'archived match insert should be blocked');
    assert(/row-level security|policy|permission denied/i.test(String(archivedInsert.message)), String(archivedInsert.message));

    await asRole('authenticated', async () => {
      await expectError(
        () => q("select public.replace_match_events('m_arch', '[]'::jsonb)"),
        /active season/
      );
      await expectError(
        () => q("select public.delete_match('m_arch')"),
        /active season/
      );
      await expectError(
        () => q(`select public.save_match('{"id":"m_arch","season_id":"s0","round":1,"home_id":"t1","away_id":"t2"}'::jsonb, null)`),
        /active season/
      );
    });
    console.log('OK archived-season table and RPC guards');

    // Direct destructive writes are denied; totals can only be changed by RPCs.
    const directMatchDelete = await asRole('authenticated', () =>
      q("delete from public.matches where id = 'm_arch' returning id").then(rows => rows, err => err)
    );
    assert(directMatchDelete instanceof Error || directMatchDelete.length === 0, 'direct match delete should be blocked');

    const directTeamDelete = await asRole('authenticated', () =>
      q("delete from public.teams where id = 't3' returning id").then(rows => rows, err => err)
    );
    assert(directTeamDelete instanceof Error || directTeamDelete.length === 0, 'direct team delete should be blocked');

    const directEventInsert = await asRole('authenticated', () =>
      q("insert into public.match_events (id, match_id, team_id, player_id, event_type, minute) values ('e_direct', 'm1', 't1', 'p1', 'goal', 77) returning id")
        .then(rows => rows, err => err)
    );
    assert(directEventInsert instanceof Error, 'direct event insert should be blocked');
    console.log('OK destructive writes are RPC-only');

    // Atomic save: an invalid event must roll back the whole match insert.
    await asRole('authenticated', async () => {
      await expectError(
        () => q(`select public.save_match(
          '{"id":"m_new","season_id":"s1","round":10,"home_id":"tdel","away_id":"tkeep","status":"FINISHED","home_score":1,"away_score":0,"events_counted":true}'::jsonb,
          '[{"id":"e_bad","teamId":"tdel","playerId":"pkeep","type":"goal","minute":12}]'::jsonb
        )`),
        /does not belong/
      );
    });
    assert.strictEqual((await q("select 1 from public.matches where id = 'm_new'")).length, 0, 'failed save left a match behind');

    await asRole('authenticated', async () => {
      await q(`select public.save_match(
        '{"id":"m_new","season_id":"s1","round":10,"home_id":"tdel","away_id":"tkeep","status":"FINISHED","home_score":1,"away_score":0,"events_counted":true}'::jsonb,
        '[{"id":"e_new","teamId":"tdel","playerId":"pdel","type":"goal","minute":12}]'::jsonb
      )`);
    });
    assert.strictEqual((await q("select goals from public.players where id = 'pdel'"))[0].goals, 1);
    assert.strictEqual((await q("select count(*)::int n from public.match_events where match_id = 'm_new'"))[0].n, 1);

    // A null event payload leaves events alone (the LIVE score button path).
    await asRole('authenticated', async () => {
      await q(`select public.save_match(
        '{"id":"m_new","season_id":"s1","round":10,"home_id":"tdel","away_id":"tkeep","status":"FINISHED","home_score":3,"away_score":0,"events_counted":true}'::jsonb,
        null
      )`);
    });
    assert.strictEqual((await q("select count(*)::int n from public.match_events where match_id = 'm_new'"))[0].n, 1);

    // delete_match moves the fixture to the trash and reverses its events.
    await asRole('authenticated', async () => {
      await q("select public.delete_match('m_new')");
    });
    assert.strictEqual((await q("select 1 from public.matches where id = 'm_new' and deleted_at is null")).length, 0);
    const trashedMatch = await q("select deleted_at from public.matches where id = 'm_new'");
    assert.strictEqual(trashedMatch.length, 1, 'trashed match should stay in the database');
    assert(trashedMatch[0].deleted_at, 'trashed match should have deleted_at set');
    assert.strictEqual((await q("select goals from public.players where id = 'pdel'"))[0].goals, 0);
    console.log('OK atomic save + delete_match totals');

    // The same fixture is allowed in a different season but not twice in one season.
    await exec(`
      insert into public.matches (id, season_id, round, home_id, away_id)
        values ('m_old', 's0', 99, 't1', 't2');
    `);
    await asRole('authenticated', async () => {
      await q(`select public.save_match(
        '{"id":"m_cross","season_id":"s1","round":99,"home_id":"t1","away_id":"t2","status":"SCHEDULED"}'::jsonb,
        null
      )`);
    });
    assert.strictEqual((await q("select 1 from public.matches where id = 'm_cross'")).length, 1);
    await asRole('authenticated', async () => {
      await q("select public.delete_match('m_cross')");
    });
    console.log('OK cross-season fixture uniqueness');

    // delete_team: opponent totals are reversed, then the team cascades.
    await asRole('authenticated', async () => {
      await q(`select public.replace_match_events('m_del',
        '[{"id":"e_del1","teamId":"tdel","playerId":"pdel","type":"goal","minute":10},
          {"id":"e_keep1","teamId":"tkeep","playerId":"pkeep","type":"goal","minute":50},
          {"id":"e_keep2","teamId":"tkeep","playerId":"pother","type":"yellow","minute":60}]'::jsonb)`);
    });
    assert.strictEqual((await q("select goals from public.players where id = 'pkeep'"))[0].goals, 1);
    assert.strictEqual((await q("select yellow from public.players where id = 'pother'"))[0].yellow, 1);

    // delete_team: totals are reversed and the club moves to the trash.
    await asRole('authenticated', async () => {
      await q("select public.delete_team('tdel')");
    });
    const trashedTeam = await q("select deleted_at from public.teams where id = 'tdel'");
    assert.strictEqual(trashedTeam.length, 1, 'trashed team should stay in the database');
    assert(trashedTeam[0].deleted_at, 'trashed team should have deleted_at set');
    assert.strictEqual((await q("select 1 from public.teams where id = 'tdel' and deleted_at is null")).length, 0);
    assert.strictEqual((await q("select goals from public.players where id = 'pkeep'"))[0].goals, 0);
    assert.strictEqual((await q("select yellow from public.players where id = 'pother'"))[0].yellow, 0);

    // Its squad, fixtures and events disappear for clients.
    const hidden = await asRole('anon', async () => ({
      team: (await q("select 1 from public.teams where id = 'tdel'")).length,
      players: (await q("select 1 from public.players where team_id = 'tdel'")).length,
      matches: (await q("select 1 from public.matches where home_id = 'tdel' or away_id = 'tdel'")).length,
      events: (await q("select 1 from public.match_events where match_id = 'm_del'")).length
    }));
    assert.deepStrictEqual(hidden, { team: 0, players: 0, matches: 0, events: 0 });

    const trash = await asRole('authenticated', () => q("select public.list_deleted() as trash"));
    assert.strictEqual(trash[0].trash.teams.length, 1);
    assert.strictEqual(trash[0].trash.teams[0].id, 'tdel');
    assert.strictEqual(trash[0].trash.teams[0].playerCount, 1);

    // Restore brings the club, squad and fixtures back and re-applies totals.
    await asRole('authenticated', async () => {
      await q("select public.restore_team('tdel')");
    });
    assert.strictEqual((await q("select 1 from public.teams where id = 'tdel' and deleted_at is null")).length, 1);
    assert.strictEqual((await q("select goals from public.players where id = 'pkeep'"))[0].goals, 1);
    assert.strictEqual((await q("select yellow from public.players where id = 'pother'"))[0].yellow, 1);
    const visibleAgain = await asRole('anon', async () => ({
      players: (await q("select 1 from public.players where team_id = 'tdel'")).length,
      matches: (await q("select 1 from public.matches where home_id = 'tdel' or away_id = 'tdel'")).length,
      events: (await q("select 1 from public.match_events where match_id = 'm_del'")).length
    }));
    assert.deepStrictEqual(visibleAgain, { players: 1, matches: 1, events: 3 });

    // Restoring twice or deleting twice must stay idempotent.
    await asRole('authenticated', async () => {
      await q("select public.restore_team('tdel')");
      await q("select public.delete_team('tdel')");
      await q("select public.delete_team('tdel')");
    });
    assert.strictEqual((await q("select goals from public.players where id = 'pkeep'"))[0].goals, 0);
    await asRole('authenticated', async () => {
      await q("select public.restore_team('tdel')");
    });
    assert.strictEqual((await q("select goals from public.players where id = 'pkeep'"))[0].goals, 1);

    // A trashed fixture frees its slot for a replacement in the same round.
    await asRole('authenticated', async () => {
      await expectError(
        () => q(`select public.save_match(
          '{"id":"m_dup","season_id":"s1","round":9,"home_id":"tdel","away_id":"tkeep","status":"SCHEDULED"}'::jsonb,
          null
        )`),
        /already exists/
      );
      await q("select public.delete_match('m_del')");
      await q(`select public.save_match(
        '{"id":"m_del2","season_id":"s1","round":9,"home_id":"tdel","away_id":"tkeep","status":"SCHEDULED","events_counted":true}'::jsonb,
        null
      )`);
    });
    assert.strictEqual((await q("select 1 from public.matches where id = 'm_del2'")).length, 1);

    // Match-level trash: events and totals are restored exactly.
    await asRole('authenticated', async () => {
      await q(`select public.replace_match_events('m_del2',
        '[{"id":"e_del2","teamId":"tkeep","playerId":"pkeep","type":"goal","minute":30}]'::jsonb)`);
    });
    assert.strictEqual((await q("select goals from public.players where id = 'pkeep'"))[0].goals, 1);
    await asRole('authenticated', async () => {
      await q("select public.delete_match('m_del2')");
    });
    assert.strictEqual((await q("select 1 from public.matches where id = 'm_del2' and deleted_at is null")).length, 0);
    assert.strictEqual((await q("select goals from public.players where id = 'pkeep'"))[0].goals, 0);
    await asRole('authenticated', async () => {
      await q("select public.restore_match('m_del2')");
    });
    assert.strictEqual((await q("select goals from public.players where id = 'pkeep'"))[0].goals, 1);
    console.log('OK safe team deletion + trash restore');

    // Seasons: only empty, inactive seasons can be trashed.
    await asRole('authenticated', async () => {
      await expectError(() => q("select public.delete_season('s1')"), /active season/);
      await expectError(() => q("select public.delete_season('s0')"), /still has fixtures/);
      await q("insert into public.seasons (id, name, is_active) values ('s_trash', 'Old Cup', false)");
      await q("select public.delete_season('s_trash')");
    });
    assert.strictEqual(
      (await q("select 1 from public.seasons where id = 's_trash' and deleted_at is not null")).length,
      1
    );
    assert.strictEqual(
      (await asRole('anon', () => q("select 1 from public.seasons where id = 's_trash'"))).length,
      0
    );
    const seasonTrash = await asRole('authenticated', () => q("select public.list_deleted() as trash"));
    assert.strictEqual(seasonTrash[0].trash.seasons.length, 1);
    await asRole('authenticated', async () => {
      await q("select public.restore_season('s_trash')");
    });
    assert.strictEqual(
      (await q("select 1 from public.seasons where id = 's_trash' and deleted_at is null")).length,
      1
    );
    console.log('OK season trash guards + restore');

    // Players with history cannot be hard-deleted; archive/restore works.
    const blockedDelete = await asRole('authenticated', () =>
      q("delete from public.players where id = 'p3' returning id")
    );
    assert.strictEqual(blockedDelete.length, 0, 'history player delete should be blocked');

    await asRole('authenticated', async () => {
      await q("select public.archive_player('p3')");
    });
    assert.strictEqual((await q("select is_active from public.players where id = 'p3'"))[0].is_active, false);
    await asRole('authenticated', async () => {
      await q("select public.restore_player('p3')");
    });
    assert.strictEqual((await q("select is_active from public.players where id = 'p3'"))[0].is_active, true);

    const hardDelete = await asRole('authenticated', () =>
      q("delete from public.players where id = 'pextra' returning id")
    );
    assert.strictEqual(hardDelete.length, 1, 'player without history should hard-delete');
    console.log('OK player history protection + archive/restore');

    // Archived state survives a full import.
    await exec("update public.players set is_active = false where id = 'p1'");
    const payload = JSON.stringify({
      seasons: [{ id: 's1', name: '2026 Season', is_active: true }],
      teams: [{ id: 't1', name: 'Spartan FC', code: 'SFC', color: '#3b82f6' }],
      players: [{ id: 'p1', team_id: 't1', name: 'David Silva', pos: 'MID', num: 10, goals: 0, yellow: 0, red: 0, is_active: false }],
      matches: [],
      match_events: []
    });
    await asRole('authenticated', async () => {
      await q('select public.replace_all_data($1::jsonb)', [payload]);
    });
    assert.strictEqual((await q("select is_active from public.players where id = 'p1'"))[0].is_active, false);
    console.log('OK full import preserves archive state');

    // Anonymous users cannot call admin RPCs.
    await asRole('anon', async () => {
      await expectError(
        () => q(`select public.save_match('{"id":"m_x","season_id":"s1","round":1,"home_id":"t1","away_id":"t2"}'::jsonb, null)`),
        /permission denied|not authorized|42501/i
      );
      await expectError(() => q("select public.delete_team('t1')"), /permission denied|not authorized|42501/i);
      await expectError(() => q("select public.list_deleted()"), /permission denied|not authorized|42501/i);
      await expectError(() => q("select public.restore_team('tdel')"), /permission denied|not authorized|42501/i);
    });
    console.log('OK anon RPC denial');

    // ------------------------------------------------------------
    // Audit log
    // ------------------------------------------------------------
    const auditSql = fs.readFileSync(path.join(ROOT, 'supabase/audit-log-migration.sql'), 'utf8');
    await exec(auditSql);

    // The migration must be safe to re-run.
    await exec(auditSql);

    await exec('delete from public.audit_log');

    await asRole('authenticated', async () => {
      await q("insert into public.teams (id, name, code, color) values ('taud', 'Audit FC', 'AUD', '#123456')");
      await q("update public.teams set name = 'Audit FC 2' where id = 'taud'");
      await q("select public.delete_team('taud')");
    });

    const auditRows = await q(`
      select action, entity, entity_id, season_id, actor_email, summary, before, after
      from public.audit_log
      order by id
    `);
    assert.strictEqual(auditRows.length, 3, 'expected insert/update/delete audit rows');
    assert.deepStrictEqual(auditRows.map(r => r.action), ['INSERT', 'UPDATE', 'DELETE']);
    assert(auditRows.every(r => r.entity === 'teams' && r.entity_id === 'taud'));
    assert(auditRows.every(r => r.actor_email === 'admin@test.local'), 'actor email should be captured');
    assert.strictEqual(auditRows[0].before, null);
    assert.strictEqual(auditRows[0].after.name, 'Audit FC');
    assert.strictEqual(auditRows[1].before.name, 'Audit FC');
    assert.strictEqual(auditRows[1].after.name, 'Audit FC 2');
    assert.strictEqual(auditRows[2].before.name, 'Audit FC 2');
    assert(auditRows[2].after.deleted_at, 'soft delete keeps the trashed snapshot');

    // Restoring is audited as RESTORE, not as a generic update.
    await asRole('authenticated', async () => {
      await q("select public.restore_team('taud')");
    });
    const restoreAudit = (await q("select action, entity, entity_id from public.audit_log order by id desc limit 1"))[0];
    assert.strictEqual(restoreAudit.action, 'RESTORE');
    assert.strictEqual(restoreAudit.entity, 'teams');
    assert.strictEqual(restoreAudit.entity_id, 'taud');

    // Matches carry their season id so the UI can filter by season.
    await asRole('authenticated', async () => {
      await q("insert into public.teams (id, name, code, color) values ('taud2', 'Audit B', 'AUB', '#222222')");
      await q(`select public.save_match(
        '{"id":"m_audit","season_id":"s1","round":42,"home_id":"t1","away_id":"taud2","status":"SCHEDULED"}'::jsonb,
        null
      )`);
    });
    const matchAudit = await q("select season_id from public.audit_log where entity = 'matches' and entity_id = 'm_audit'");
    assert.strictEqual(matchAudit.length, 1);
    assert.strictEqual(matchAudit[0].season_id, 's1');

    // Admins read through the RPC; anon is rejected and cannot read the table.
    const adminAudit = await asRole('authenticated', () =>
      q("select action, entity_id from public.list_audit_log(50)")
    );
    assert(adminAudit.length >= 4, 'admin should read the audit log');

    await asRole('anon', async () => {
      await expectError(() => q("select * from public.list_audit_log(50)"), /permission denied|not authorized|42501/i);
      await expectError(() => q("select * from public.audit_log"), /permission denied/i);
    });

    // A full import collapses to one IMPORT entry instead of per-row noise.
    const auditCountBefore = (await q("select count(*)::int n from public.audit_log"))[0].n;
    await asRole('authenticated', async () => {
      await q('select public.replace_all_data($1::jsonb)', [payload]);
    });
    const auditCountAfter = (await q("select count(*)::int n from public.audit_log"))[0].n;
    assert.strictEqual(auditCountAfter, auditCountBefore + 1, 'import should add exactly one audit row');
    const importRow = (await q("select action, entity, summary from public.audit_log order by id desc limit 1"))[0];
    assert.strictEqual(importRow.action, 'IMPORT');
    assert.strictEqual(importRow.entity, 'all');
    assert(/1 seasons, 1 teams, 1 players, 0 matches, 0 events/.test(importRow.summary), importRow.summary);

    console.log('OK audit log (triggers, actor, snapshots, admin-only, import summary)');

    // ------------------------------------------------------------
    // Admin MFA / step-up gate
    // ------------------------------------------------------------
    assert.strictEqual((await q("select public.admin_mfa_required() as required"))[0].required, false);

    // Turning the requirement on needs a verified factor (aal2).
    await exec(`set test.jwt = '{"aal":"aal1"}'`);
    await asRole('authenticated', async () => {
      await expectError(
        () => q("select public.set_require_admin_mfa(true)"),
        /Verify your authenticator/
      );
    });

    await exec(`set test.jwt = '{"aal":"aal2"}'`);
    await asRole('authenticated', async () => {
      await q("select public.set_require_admin_mfa(true)");
    });
    assert.strictEqual((await q("select public.admin_mfa_required() as required"))[0].required, true);

    // Password-only (aal1) admin keeps read access but loses every write path.
    await exec(`set test.jwt = '{"aal":"aal1"}'`);
    const aal1Read = await asRole('authenticated', () => q("select count(*)::int n from public.teams"));
    assert(aal1Read[0].n > 0, 'public reads should still work at aal1');
    const aal1Update = await asRole('authenticated', () =>
      q("update public.teams set name = name where id = 't2' returning id")
    );
    assert.strictEqual(aal1Update.length, 0, 'aal1 admin update should be filtered by RLS');
    await asRole('authenticated', async () => {
      await expectError(
        () => q(`select public.save_match('{"id":"m_mfa","season_id":"s1","round":77,"home_id":"t1","away_id":"t2"}'::jsonb, null)`),
        /Only admins/
      );
      await expectError(() => q("select public.list_audit_log(5)"), /Only admins/);
      await expectError(() => q("select public.list_deleted()"), /Only admins/);
    });

    // aal2 restores the ability, and the requirement can be turned off.
    await exec(`set test.jwt = '{"aal":"aal2"}'`);
    await asRole('authenticated', async () => {
      await q("insert into public.teams (id, name, code, color) values ('tmfa', 'MFA FC', 'MFA', '#111111')");
      await q(`select public.save_match('{"id":"m_mfa","season_id":"s1","round":77,"home_id":"t1","away_id":"tmfa"}'::jsonb, null)`);
      await q("select public.delete_match('m_mfa')");
      await q("select public.set_require_admin_mfa(false)");
    });
    assert.strictEqual((await q("select public.admin_mfa_required() as required"))[0].required, false);

    // Non-admins cannot toggle the requirement even at aal2.
    await exec(`update public.profiles set role = 'viewer' where id = '${ADMIN_ID}'`);
    await asRole('authenticated', async () => {
      await expectError(() => q("select public.set_require_admin_mfa(true)"), /Only admins/);
    });
    await exec(`update public.profiles set role = 'admin' where id = '${ADMIN_ID}'`);
    await exec(`set test.jwt = '{}'`);
    console.log('OK admin MFA gate (aal1 blocked, aal2 allowed, step-up required)');

    // ------------------------------------------------------------
    // Fresh install path: schema.sql alone must provide the audit log
    // ------------------------------------------------------------
    const fresh = await createDatabase();
    try {
      const fq = async (sql, params) => (await fresh.query(sql, params)).rows;
      const fexec = sql => fresh.exec(sql);

      assert.strictEqual(
        (await fq('select count(*)::int n from public.audit_log'))[0].n,
        0,
        'seed data must not be audited'
      );
      assert.strictEqual(
        (await fq('select public.admin_mfa_required() as required'))[0].required,
        false,
        'fresh installs keep the MFA requirement off'
      );

      await fexec('set role authenticated');
      await fq("update public.teams set name = 'Spartan FC II' where id = 't1'");
      await fexec('reset role');

      const freshRows = await fq('select action, entity, actor_email, before, after from public.audit_log order by id');
      assert.strictEqual(freshRows.length, 1);
      assert.strictEqual(freshRows[0].action, 'UPDATE');
      assert.strictEqual(freshRows[0].entity, 'teams');
      assert.strictEqual(freshRows[0].before.name, 'Spartan FC');
      assert.strictEqual(freshRows[0].after.name, 'Spartan FC II');
      assert.strictEqual(freshRows[0].actor_email, 'admin@test.local');

      // schema.sql alone also ships soft delete + restore.
      await fexec('set role authenticated');
      await fq("select public.delete_team('t1')");
      await fexec('reset role');
      assert.strictEqual(
        (await fq("select 1 from public.teams where id = 't1' and deleted_at is not null")).length,
        1,
        'fresh schema should soft-delete teams'
      );
      const freshTrash = (await fq("select public.list_deleted() as trash"))[0].trash;
      assert.strictEqual(freshTrash.teams.length, 1);
      assert.strictEqual(freshTrash.teams[0].id, 't1');

      await fexec('set role authenticated');
      await fq("select public.restore_team('t1')");
      await fexec('reset role');
      const freshRestore = (await fq("select action from public.audit_log where entity = 'teams' and entity_id = 't1' order by id desc limit 1"))[0];
      assert.strictEqual(freshRestore.action, 'RESTORE', 'fresh schema label restore in the audit log');

      const freshPayload = JSON.stringify({
        seasons: [{ id: 's1', name: '2026 Season', is_active: true }],
        teams: [],
        players: [],
        matches: [],
        match_events: []
      });
      await fexec('set role authenticated');
      await fq('select public.replace_all_data($1::jsonb)', [freshPayload]);
      await fexec('reset role');

      const freshImport = (await fq("select action, summary from public.audit_log order by id desc limit 1"))[0];
      assert.strictEqual(freshImport.action, 'IMPORT');
      assert(/0 teams, 0 players/.test(freshImport.summary), freshImport.summary);
      console.log('OK fresh schema.sql install includes the audit log');
    } finally {
      await fresh.close();
    }

    console.log('All SQL integrity tests passed.');
  } finally {
    await db.close();
  }
}

run().catch(error => {
  console.error('SQL integrity tests failed:', error);
  process.exit(1);
});
