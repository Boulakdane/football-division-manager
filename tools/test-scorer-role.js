#!/usr/bin/env node
/*
 * SQL tests for roadmap item B: the scorer role and match officials.
 *
 * Runs in its own in-memory PGlite database. It proves that:
 *   * schema.sql installs the scorer enum value, is_scorer() and
 *     match_officials with own-row/admin RLS;
 *   * only admins can change roles or assign officials, and every change is
 *     audited with the acting admin;
 *   * a scorer can add a goal/card only to an assigned fixture that is LIVE
 *     or scheduled today in the active season;
 *   * the first event on a today fixture starts it, and a goal moves the score;
 *   * a scorer can undo an event for 15 minutes; an admin has no window and
 *     bypasses the assignment check but still needs a live/today fixture;
 *   * direct writes to match_events and match_officials stay denied;
 *   * scorer-role-migration.sql is re-runnable and keeps the same guarantees.
 *
 * Usage: npm run test:scorer-role
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

const ROOT = path.resolve(__dirname, '..');
const ADMIN_ID = '00000000-0000-0000-0000-000000000001';
const VIEWER_ID = '00000000-0000-0000-0000-000000000002';
const SCORER_ID = '00000000-0000-0000-0000-000000000003';
const SCORER2_ID = '00000000-0000-0000-0000-000000000004';

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
  const asScorer = fn => asRole('authenticated', SCORER_ID, fn);
  const asScorer2 = fn => asRole('authenticated', SCORER2_ID, fn);
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

  const matchRow = async id => (await q('select * from public.matches where id = $1', [id]))[0];
  const officialCount = async () => (await q('select count(*)::int n from public.match_officials'))[0].n;

  try {
    await mockAuth(db);
    await exec(fs.readFileSync(path.join(ROOT, 'supabase/schema.sql'), 'utf8'));

    // Auth users get a viewer profile through the schema trigger.
    await exec(`
      insert into auth.users (id, email) values
        ('${ADMIN_ID}', 'admin@test.local'),
        ('${VIEWER_ID}', 'viewer@test.local'),
        ('${SCORER_ID}', 'scorer@test.local'),
        ('${SCORER2_ID}', 'scorer2@test.local')
    `);
    await exec(`update public.profiles set role = 'admin' where id = '${ADMIN_ID}'`);

    // Custom fixtures: the seeded dates are fixed, so "today" is generated.
    await exec(`
      insert into public.seasons (id, name, is_active)
      values ('s2', 'Archive', false);

      insert into public.matches
        (id, season_id, round, home_id, away_id, home_score, away_score, status, datetime, venue, events_counted)
      values
        ('m_live',     's1', 4, 't1', 't2', 0, 0, 'LIVE',      to_char(current_date, 'YYYY-MM-DD') || 'T18:00', 'Test', true),
        ('m_live2',    's1', 4, 't5', 't6', 0, 0, 'LIVE',      to_char(current_date, 'YYYY-MM-DD') || 'T18:00', 'Test', true),
        ('m_today',    's1', 4, 't3', 't4', 0, 0, 'SCHEDULED', to_char(current_date, 'YYYY-MM-DD') || 'T19:00', 'Test', true),
        ('m_tomorrow', 's1', 4, 't5', 't6', 0, 0, 'SCHEDULED', to_char(current_date + 1, 'YYYY-MM-DD') || 'T19:00', 'Test', true),
        ('m_finished', 's1', 4, 't2', 't3', 2, 1, 'FINISHED',  to_char(current_date, 'YYYY-MM-DD') || 'T15:00', 'Test', true),
        ('m_old',      's1', 4, 't5', 't6', 0, 0, 'LIVE',      to_char(current_date, 'YYYY-MM-DD') || 'T18:00', 'Test', false),
        ('m_archived', 's2', 1, 't1', 't2', 0, 0, 'LIVE',      to_char(current_date, 'YYYY-MM-DD') || 'T18:00', 'Test', true)
    `);

    // ------------------------------------------------------------
    // 1. Enum, helper and role management
    // ------------------------------------------------------------
    const enumValues = (await q(`
      select unnest(enum_range(null::public.app_role))::text as role
    `)).map(row => row.role);
    assert(enumValues.includes('scorer'), 'app_role must include scorer');

    assert.strictEqual(
      (await asScorer(() => q('select public.is_scorer() as ok')))[0].ok,
      false,
      'a viewer profile is not a scorer yet'
    );

    await asAdmin(async () => {
      await q(`select public.set_user_role('${SCORER_ID}', 'scorer')`);
      await q(`select public.set_user_role('${SCORER2_ID}', 'scorer')`);
    });

    assert.strictEqual((await asScorer(() => q('select public.is_scorer() as ok')))[0].ok, true);
    assert.strictEqual((await asScorer2(() => q('select public.is_scorer() as ok')))[0].ok, true);
    assert.strictEqual((await asViewer(() => q('select public.is_scorer() as ok')))[0].ok, false);
    assert.strictEqual((await asAdmin(() => q('select public.is_scorer() as ok')))[0].ok, false);

    const users = await asAdmin(() => q('select id, email, role from public.list_users() order by email'));
    assert.strictEqual(users.length, 4, 'list_users should return every profile');
    assert.deepStrictEqual(
      users.map(user => user.role),
      ['admin', 'scorer', 'scorer', 'viewer'],
      'roles should be listed for the admin'
    );

    await expectError(
      () => asViewer(() => q('select * from public.list_users()')),
      /Only admins/
    );
    await expectError(
      () => asScorer(() => q(`select public.set_user_role('${VIEWER_ID}', 'scorer')`)),
      /Only admins/
    );
    await expectError(
      () => asAdmin(() => q(`select public.set_user_role('${VIEWER_ID}', 'coach')`)),
      /Unknown role/
    );
    await expectError(
      () => asAdmin(() => q(`select public.set_user_role('${ADMIN_ID}', 'viewer')`)),
      /own admin role/
    );
    await expectError(
      () => asAnon(() => q(`select public.record_live_event('m_live', 't1', 'p1', 'goal', 10)`)),
      /permission denied/
    );

    // ------------------------------------------------------------
    // 2. Match officials: admin-only, scorer accounts only, own-row RLS
    // ------------------------------------------------------------
    await expectError(
      () => asScorer(() => q(`select public.set_match_officials('m_live', array['${SCORER_ID}']::uuid[])`)),
      /Only admins/
    );
    await expectError(
      () => asAdmin(() => q(`select public.set_match_officials('m_live', array['${VIEWER_ID}']::uuid[])`)),
      /Only scorer accounts/
    );
    await expectError(
      () => asAdmin(() => q(`select public.set_match_officials('m_archived', array['${SCORER_ID}']::uuid[])`)),
      /active season/
    );

    await asAdmin(async () => {
      await q(`select public.set_match_officials('m_live', array['${SCORER_ID}']::uuid[])`);
      await q(`select public.set_match_officials('m_today', array['${SCORER_ID}']::uuid[])`);
    });

    const scorerRows = await asScorer(() => q('select match_id, user_id from public.match_officials order by match_id'));
    assert.deepStrictEqual(
      scorerRows.map(row => row.match_id),
      ['m_live', 'm_today'],
      'a scorer sees only their own assignments'
    );
    assert.strictEqual(await asScorer2(() => officialCount()), 0, 'another scorer sees no assignments');
    assert.strictEqual(await asViewer(() => officialCount()), 0, 'a viewer sees no assignments');
    assert.strictEqual(await asAnon(() => officialCount()), 0, 'anonymous visitors see no assignments');
    assert.strictEqual(await asAdmin(() => officialCount()), 2, 'an admin sees every assignment');

    // Replacing the list is idempotent and removes the missing official.
    await asAdmin(() => q(`select public.set_match_officials('m_live', array['${SCORER_ID}', '${SCORER2_ID}']::uuid[])`));
    assert.strictEqual(await asAdmin(() => officialCount()), 3);
    await asAdmin(() => q(`select public.set_match_officials('m_live', array['${SCORER_ID}', '${SCORER2_ID}']::uuid[])`));
    assert.strictEqual(await asAdmin(() => officialCount()), 3, 'repeating the same list adds no rows');
    await asAdmin(() => q(`select public.set_match_officials('m_live', array['${SCORER_ID}']::uuid[])`));
    assert.strictEqual(await asAdmin(() => officialCount()), 2, 'the dropped official is removed');

    const officialAudit = await q(`
      select action, entity, entity_id, actor_id, season_id
      from public.audit_log
      where entity = 'match_officials'
      order by id
    `);
    assert(officialAudit.length >= 4, 'every added and removed official is audited');
    assert(officialAudit.some(row => row.action === 'INSERT' && row.entity_id === 'm_live'));
    assert(officialAudit.some(row => row.action === 'DELETE' && row.entity_id === 'm_live'));
    assert(officialAudit.every(row => String(row.actor_id) === ADMIN_ID), 'the acting admin is recorded');
    assert(officialAudit.every(row => row.season_id === 's1' || row.season_id === null));

    await expectError(
      () => asScorer(() => q(`insert into public.match_officials (match_id, user_id) values ('m_live', '${VIEWER_ID}')`)),
      /permission denied/
    );
    await expectError(
      () => asScorer(() => q(`insert into public.match_events (id, match_id, team_id, player_id, event_type, minute)
                             values ('e_direct', 'm_live', 't1', 'p1', 'goal', 1)`)),
      /permission denied/
    );

    // ------------------------------------------------------------
    // 3. Scorer live entry: assigned LIVE fixture, score and audit
    // ------------------------------------------------------------
    const eventId = (await asScorer(() =>
      q(`select public.record_live_event('m_live', 't1', 'p1', 'goal', 10) as id`)
    ))[0].id;
    assert(/^e_/.test(eventId), 'record_live_event returns an event id');

    let live = await matchRow('m_live');
    assert.strictEqual(live.home_score, 1, 'a goal moves the home score');
    assert.strictEqual(live.away_score, 0);
    assert.strictEqual(live.status, 'LIVE');

    const storedEvent = await q('select * from public.match_events where id = $1', [eventId]);
    assert.strictEqual(storedEvent.length, 1, 'the event row is stored');
    assert.strictEqual(storedEvent[0].event_type, 'goal');

    const eventAudit = await q(`
      select actor_id from public.audit_log
      where entity = 'match_events' and entity_id = $1
      order by id desc limit 1
    `, [eventId]);
    assert.strictEqual(String(eventAudit[0].actor_id), SCORER_ID, 'the scorer is the audit actor');

    await asScorer(() => q(`select public.record_live_event('m_live', 't2', 'p3', 'yellow', 12)`));
    assert.strictEqual((await q(`select count(*)::int n from public.match_events where match_id = 'm_live'`))[0].n, 2);

    await asScorer(() => q(`select public.remove_live_event('${eventId}')`));
    live = await matchRow('m_live');
    assert.strictEqual(live.home_score, 0, 'undoing a goal decrements the score');
    assert.strictEqual((await q('select * from public.match_events where id = $1', [eventId])).length, 0);

    // ------------------------------------------------------------
    // 4. A today fixture starts on the first event
    // ------------------------------------------------------------
    await asScorer(() => q(`select public.record_live_event('m_today', 't3', 'p4', 'goal', 5)`));
    const today = await matchRow('m_today');
    assert.strictEqual(today.status, 'LIVE', 'the first event starts a today fixture');
    assert.strictEqual(today.home_score, 1);
    assert.strictEqual(today.away_score, 0);

    // ------------------------------------------------------------
    // 5. Every scorer guard rejects the wrong match, player or payload
    // ------------------------------------------------------------
    await expectError(
      () => asScorer(() => q(`select public.record_live_event('m_live2', 't5', 'p6', 'goal', 10)`)),
      /not assigned/
    );
    await expectError(
      () => asScorer(() => q(`select public.record_live_event('m_tomorrow', 't5', 'p6', 'goal', 10)`)),
      /live match or a fixture scheduled today/
    );
    await expectError(
      () => asScorer(() => q(`select public.record_live_event('m_finished', 't2', 'p3', 'goal', 10)`)),
      /live match or a fixture scheduled today/
    );
    await expectError(
      () => asScorer(() => q(`select public.record_live_event('m_old', 't5', 'p6', 'goal', 10)`)),
      /predates match events/
    );
    await expectError(
      () => asScorer(() => q(`select public.record_live_event('m_archived', 't1', 'p1', 'goal', 10)`)),
      /active season/
    );
    await expectError(
      () => asScorer(() => q(`select public.record_live_event('m_live', 't3', 'p4', 'goal', 10)`)),
      /does not belong/
    );
    await expectError(
      () => asScorer(() => q(`select public.record_live_event('m_live', 't1', 'p1', 'penalty', 10)`)),
      /Invalid event type/
    );
    await expectError(
      () => asScorer(() => q(`select public.record_live_event('m_live', 't1', 'p1', 'goal', 131)`)),
      /between 1 and 130/
    );
    await expectError(
      () => asViewer(() => q(`select public.record_live_event('m_live', 't1', 'p1', 'goal', 10)`)),
      /Only admins and scorers/
    );

    // ------------------------------------------------------------
    // 6. Undo window: 15 minutes for scorers, none for admins
    // ------------------------------------------------------------
    await exec(`
      insert into public.match_events
        (id, match_id, team_id, player_id, event_type, minute, created_at)
      values
        ('e_old_undo', 'm_live', 't1', 'p2', 'goal', 20, now() - interval '20 minutes');
      update public.matches set home_score = 1 where id = 'm_live';
    `);

    await expectError(
      () => asScorer(() => q(`select public.remove_live_event('e_old_undo')`)),
      /undo window/
    );
    await asAdmin(() => q(`select public.remove_live_event('e_old_undo')`));
    assert.strictEqual((await matchRow('m_live')).home_score, 0, 'the admin undo reverses the score');

    // ------------------------------------------------------------
    // 7. Admin live entry bypasses assignment but not the match gate
    // ------------------------------------------------------------
    await asAdmin(() => q(`select public.record_live_event('m_live2', 't5', 'p6', 'goal', 22)`));
    const live2 = await matchRow('m_live2');
    assert.strictEqual(live2.home_score, 1, 'an admin can score an unassigned fixture');
    assert.strictEqual(live2.status, 'LIVE');

    await expectError(
      () => asAdmin(() => q(`select public.record_live_event('m_tomorrow', 't5', 'p6', 'goal', 10)`)),
      /live match or a fixture scheduled today/
    );
    await expectError(
      () => asAdmin(() => q(`select public.record_live_event('m_old', 't5', 'p6', 'goal', 10)`)),
      /predates match events/
    );
    await expectError(
      () => asAdmin(() => q(`select public.record_live_event('m_archived', 't1', 'p1', 'goal', 10)`)),
      /active season/
    );
    await expectError(
      () => asAdmin(() => q(`select public.record_live_event('m_live2', 't1', 'p1', 'goal', 10)`)),
      /does not belong/
    );

    // ------------------------------------------------------------
    // 8. Role changes are audited and take effect immediately
    // ------------------------------------------------------------
    await asAdmin(() => q(`select public.set_user_role('${VIEWER_ID}', 'scorer')`));
    assert.strictEqual((await asViewer(() => q('select public.is_scorer() as ok')))[0].ok, true);

    const roleAudit = await q(`
      select action, entity, entity_id, actor_id, before, after
      from public.audit_log
      where entity = 'profiles' and entity_id = '${VIEWER_ID}'
      order by id desc limit 1
    `);
    assert.strictEqual(roleAudit.length, 1, 'the role change is audited');
    assert.strictEqual(roleAudit[0].action, 'SECURITY');
    assert.strictEqual(String(roleAudit[0].actor_id), ADMIN_ID);
    assert.deepStrictEqual(roleAudit[0].before, { role: 'viewer' });
    assert.deepStrictEqual(roleAudit[0].after, { role: 'scorer' });

    await asAdmin(() => q(`select public.set_user_role('${VIEWER_ID}', 'viewer')`));
    await asAdmin(() => q(`select public.set_user_role('${SCORER2_ID}', 'viewer')`));
    assert.strictEqual((await asScorer2(() => q('select public.is_scorer() as ok')))[0].ok, false);
    await expectError(
      () => asScorer2(() => q(`select public.record_live_event('m_live2', 't5', 'p6', 'goal', 10)`)),
      /Only admins and scorers/
    );

    // ------------------------------------------------------------
    // 9. The migration is re-runnable and keeps every guarantee
    // ------------------------------------------------------------
    const migration = fs.readFileSync(path.join(ROOT, 'supabase/scorer-role-migration.sql'), 'utf8');
    await exec(migration);
    await exec(migration);

    const policyCount = (await q(`
      select count(*)::int n from pg_policies
      where schemaname = 'public' and tablename = 'match_officials'
    `))[0].n;
    assert.strictEqual(policyCount, 2, 'the migration keeps the two officials policies');
    assert.strictEqual(await asAdmin(() => officialCount()), 2, 'assignments survive a migration re-run');
    assert.strictEqual((await asAdmin(() => q('select count(*)::int n from public.list_users()')))[0].n, 4);

    await asScorer(() => q(`select public.record_live_event('m_today', 't4', 'p5', 'yellow', 61)`));
    const afterMigration = await q(`
      select count(*)::int n from public.match_events
      where match_id = 'm_today' and team_id = 't4' and event_type = 'yellow' and minute = 61
    `);
    assert.strictEqual(afterMigration[0].n, 1, 'scorers can still enter events after the migration re-run');
    assert.strictEqual((await asScorer(() => q('select public.is_scorer() as ok')))[0].ok, true);

    console.log('OK scorer enum, helper and admin-only role management');
    console.log('OK match_officials RLS, assignment rules and audit trail');
    console.log('OK scorer live entry, score update, today gate and undo window');
    console.log('OK admin bypass, direct-write denial and migration re-run');
    console.log('All scorer-role tests passed.');
  } finally {
    await db.close();
  }
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
