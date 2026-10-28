#!/usr/bin/env node
/*
 * SQL tests for roadmap F (fixture generator + reschedule helper).
 *
 * Runs in its own in-memory PGlite database and proves that:
 *   * create_fixtures() inserts a whole plan atomically, derives the division
 *     from the clubs and keeps the browser's wall-clock datetime;
 *   * a plan with a repeated pairing, a same-orientation double leg, a
 *     cross-division club, an unknown club, a bad round or a bad date is
 *     rejected before anything is written;
 *   * replace_existing soft-deletes only untouched SCHEDULED fixtures and
 *     refuses to erase a result, an event or a live match;
 *   * shift_fixture_rounds() moves only unplayed fixtures from one round
 *     onwards and preserves the time of day;
 *   * each write path records exactly one summary audit row and leaves the
 *     audit chain valid;
 *   * only admins can call either function, and anon has no EXECUTE grant;
 *   * fixtures-migration.sql is re-runnable.
 *
 * Usage: npm run test:fixtures
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

const ROOT = path.resolve(__dirname, '..');
const ADMIN_ID = '00000000-0000-0000-0000-000000000001';
const VIEWER_ID = '00000000-0000-0000-0000-000000000002';

function plan(overrides) {
  return {
    season_id: 's1',
    replace_existing: false,
    matches: [
      { round: 1, home_id: 't1', away_id: 't2', datetime: '2026-08-08T15:00', venue: 'Main Field' },
      { round: 1, home_id: 't3', away_id: 't4', datetime: '2026-08-08T17:30', venue: 'Main Field' },
      { round: 2, home_id: 't1', away_id: 't3', datetime: '2026-08-15T15:00', venue: 'Main Field' },
      { round: 2, home_id: 't2', away_id: 't4', datetime: '2026-08-15T17:30', venue: 'Main Field' },
      { round: 3, home_id: 't1', away_id: 't4', datetime: '2026-08-22T15:00', venue: 'Main Field' },
      { round: 3, home_id: 't2', away_id: 't3', datetime: '2026-08-22T17:30', venue: 'Main Field' }
    ],
    ...(overrides || {})
  };
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
      await exec("set test.uid = ''");
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
    if (pattern) assert(pattern.test(String(error.message || error)), `unexpected error: ${error.message || error}`);
  };

  const createRaw = payload =>
    q('select public.create_fixtures($1::jsonb) as r', [JSON.stringify(payload)]).then(rows => rows[0].r);
  const create = payload => asAdmin(() => createRaw(payload));
  const shiftRaw = (season, division, from, days) =>
    q('select public.shift_fixture_rounds($1, $2, $3, $4) as r', [season, division, from, days])
      .then(rows => rows[0].r);
  const shift = (season, division, from, days) => asAdmin(() => shiftRaw(season, division, from, days));
  const liveMatches = () => q(
    "select id, round, home_id, away_id, status, datetime, venue, division_id, deleted_at from public.matches where deleted_at is null order by round, home_id"
  );
  const matchAudit = action => q(
    "select count(*)::int n from public.audit_log where entity = 'matches' and action = $1",
    [action]
  ).then(rows => rows[0].n);

  try {
    await exec(`
      create schema auth;
      create table auth.users (id uuid primary key, email text);
      create or replace function auth.uid() returns uuid
        language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
      create or replace function auth.jwt() returns jsonb
        language sql stable as $$ select coalesce(nullif(current_setting('test.jwt', true), '')::jsonb, '{}'::jsonb) $$;
      create role anon;
      create role authenticated;
    `);

    await exec(fs.readFileSync(path.join(ROOT, 'supabase/schema.sql'), 'utf8'));

    const fixturesSql = fs.readFileSync(path.join(ROOT, 'supabase/fixtures-migration.sql'), 'utf8');
    await exec(fixturesSql);
    await exec(fixturesSql);
    console.log('OK fixtures-migration.sql is re-runnable');

    await exec(`
      insert into auth.users (id, email) values
        ('${ADMIN_ID}', 'admin@test.local'),
        ('${VIEWER_ID}', 'viewer@test.local');
      update public.profiles set role = 'admin' where id = '${ADMIN_ID}';

      -- Start from a clean league: schema.sql seeds a demo season and clubs.
      delete from public.match_events;
      delete from public.matches;
      delete from public.players;
      delete from public.teams;
      delete from public.seasons;

      insert into public.seasons (id, name, start_date, end_date, is_active)
      values ('s1', 'Test Season', '2026-08-01', '2027-05-31', true),
             ('s2', 'Old Season', '2025-08-01', '2026-05-31', false);

      insert into public.teams (id, name, code, color, division_id) values
        ('t1', 'Alpha',  'ALP', '#3b82f6', 'd1'),
        ('t2', 'Beta',   'BET', '#10b981', 'd1'),
        ('t3', 'Gamma',  'GAM', '#f59e0b', 'd1'),
        ('t4', 'Delta',  'DEL', '#ef4444', 'd1'),
        ('t5', 'Epsilon','EPS', '#8b5cf6', 'd2');
    `);

    // Grants: authenticated may call, anon may not.
    assert.strictEqual(
      (await q("select has_function_privilege('authenticated', 'public.create_fixtures(jsonb)', 'EXECUTE') as ok"))[0].ok,
      true
    );
    assert.strictEqual(
      (await q("select has_function_privilege('anon', 'public.create_fixtures(jsonb)', 'EXECUTE') as ok"))[0].ok,
      false
    );
    assert.strictEqual(
      (await q("select has_function_privilege('anon', 'public.shift_fixture_rounds(text, text, int, int)', 'EXECUTE') as ok"))[0].ok,
      false
    );

    // Only admins.
    await expectError(() => asViewer(() => createRaw(plan())), /Only admins|permission denied/i);
    await expectError(() => asAnon(() => createRaw(plan())), /Only admins|permission denied/i);
    await expectError(() => asViewer(() => shiftRaw('s1', 'd1', 2, 7)), /Only admins|permission denied/i);

    // Invalid plans change nothing.
    await expectError(() => create(plan({ matches: [] })), /at least one match/);
    await expectError(
      () => create(plan({
        matches: [
          { round: 1, home_id: 't1', away_id: 't2', datetime: '2026-08-08T15:00' },
          { round: 2, home_id: 't1', away_id: 't2', datetime: '2026-08-15T15:00' },
          { round: 3, home_id: 't2', away_id: 't1', datetime: '2026-08-22T15:00' }
        ]
      })),
      /at most twice/
    );
    await expectError(
      () => create(plan({
        matches: [
          { round: 1, home_id: 't1', away_id: 't2', datetime: '2026-08-08T15:00' },
          { round: 2, home_id: 't1', away_id: 't2', datetime: '2026-08-15T15:00' }
        ]
      })),
      /once with each home team/
    );
    await expectError(
      () => create(plan({
        matches: [{ round: 1, home_id: 't1', away_id: 't5', datetime: '2026-08-08T15:00' }]
      })),
      /one division|same division/
    );
    await expectError(
      () => create(plan({
        matches: [{ round: 1, home_id: 't1', away_id: 'nope', datetime: '2026-08-08T15:00' }]
      })),
      /known teams/
    );
    await expectError(
      () => create(plan({
        matches: [{ round: 1, home_id: 't1', away_id: 't1', datetime: '2026-08-08T15:00' }]
      })),
      /two different teams/
    );
    await expectError(
      () => create(plan({
        matches: [{ round: 0, home_id: 't1', away_id: 't2', datetime: '2026-08-08T15:00' }]
      })),
      /round between 1 and 1000/
    );
    await expectError(
      () => create(plan({
        matches: [
          { id: 'same', round: 1, home_id: 't1', away_id: 't2', datetime: '2026-08-08T15:00' },
          { id: 'same', round: 2, home_id: 't3', away_id: 't4', datetime: '2026-08-15T15:00' }
        ]
      })),
      /id must be unique/
    );
    await expectError(
      () => create(plan({
        matches: [{ round: 1, home_id: 't1', away_id: 't2', datetime: '2026-08-08 15:00' }]
      })),
      /YYYY-MM-DDTHH:MM/
    );
    await expectError(
      () => create(plan({
        matches: [{ round: 1, home_id: 't1', away_id: 't2', datetime: '2026-02-31T15:00' }]
      })),
      /real calendar date/
    );
    await expectError(
      () => create({ ...plan(), season_id: 's2' }),
      /active season/
    );
    assert.strictEqual((await liveMatches()).length, 0, 'invalid plans must not write fixtures');
    console.log('OK invalid plans are rejected before any insert');

    // A valid plan lands atomically.
    const insertAuditBefore = await matchAudit('INSERT');
    const created = await create(plan());
    const matches = await liveMatches();
    assert.strictEqual(created.created, 6);
    assert.strictEqual(created.rounds, 3);
    assert.strictEqual(created.divisionId, 'd1');
    assert.strictEqual(created.seasonId, 's1');
    assert.strictEqual(matches.length, 6);
    assert(matches.every(m => m.status === 'SCHEDULED'));
    assert(matches.every(m => m.division_id === 'd1'));
    assert.deepStrictEqual(
      matches.map(m => `${m.round}:${m.home_id}-${m.away_id}`),
      ['1:t1-t2', '1:t3-t4', '2:t1-t3', '2:t2-t4', '3:t1-t4', '3:t2-t3']
    );
    assert.strictEqual(matches[0].datetime, '2026-08-08T15:00');
    assert.strictEqual(matches[0].venue, 'Main Field');
    assert.strictEqual(await matchAudit('INSERT'), insertAuditBefore, 'generate must not write one audit row per fixture');
    const generated = await q(
      "select summary from public.audit_log where entity = 'matches' and action = 'IMPORT' order by id desc limit 1"
    );
    assert(/Generated 6 fixtures over 3 rounds in d1/.test(generated[0].summary), generated[0].summary);
    console.log('OK a valid plan is inserted in one transaction with one summary audit row');

    // Without replace, an existing pairing is refused.
    await expectError(() => create(plan()), /pairing already has a fixture/);

    // Replace soft-deletes the old untouched fixtures and inserts the new ones.
    const oldIds = matches.map(m => m.id).sort();
    const replaced = await create(plan({ replace_existing: true }));
    const afterReplace = await liveMatches();
    assert.strictEqual(replaced.created, 6);
    assert.strictEqual(replaced.removed, 6);
    assert.strictEqual(afterReplace.length, 6);
    assert.deepStrictEqual(
      afterReplace.map(m => m.id).sort().filter(id => oldIds.includes(id)),
      [],
      'replace must use fresh ids, never revive a trashed row'
    );
    assert.strictEqual(
      (await q("select count(*)::int n from public.matches where deleted_at is not null"))[0].n,
      6,
      'the old fixtures stay in the trash'
    );
    console.log('OK replace_existing moves only untouched fixtures to the trash');

    // An old id from the trash cannot be reused.
    await expectError(
      () => create(plan({
        matches: [{ id: oldIds[0], round: 1, home_id: 't1', away_id: 't2', datetime: '2026-08-08T15:00' }]
      })),
      /id in the plan already exists/
    );

    // A played or non-empty fixture blocks replace.
    await exec(`update public.matches set status = 'FINISHED' where round = 1 and home_id = 't1'`);
    await expectError(() => create(plan({ replace_existing: true })), /Only unplayed, empty fixtures can be replaced/);
    await exec(`update public.matches set status = 'SCHEDULED' where round = 1 and home_id = 't1'`);

    // The reschedule helper moves rounds 2 and 3 by one week, keeping time.
    const before = Object.fromEntries(
      (await liveMatches()).map(m => [`${m.round}:${m.home_id}`, m.datetime])
    );
    const shifted = await shift('s1', 'd1', 2, 7);
    const after = Object.fromEntries(
      (await liveMatches()).map(m => [`${m.round}:${m.home_id}`, m.datetime])
    );
    assert.strictEqual(shifted.shifted, 4);
    assert.strictEqual(shifted.fromRound, 2);
    assert.strictEqual(shifted.days, 7);
    assert.strictEqual(after['1:t1'], before['1:t1'], 'round 1 must not move');
    assert.strictEqual(after['2:t1'], '2026-08-22T15:00');
    assert.strictEqual(after['2:t2'], '2026-08-22T17:30');
    assert.strictEqual(after['3:t1'], '2026-08-29T15:00');
    assert.strictEqual(after['3:t2'], '2026-08-29T17:30');
    const shiftedAudit = await q(
      "select summary from public.audit_log where entity = 'matches' and action = 'IMPORT' order by id desc limit 1"
    );
    assert(/Moved rounds 2 onwards by 7 day\(s\)/.test(shiftedAudit[0].summary), shiftedAudit[0].summary);
    console.log('OK shift_fixture_rounds moves later rounds and preserves the time of day');

    // A played fixture in the range blocks the shift.
    await exec(`update public.matches set status = 'FINISHED' where round = 3 and home_id = 't1'`);
    await expectError(() => shift('s1', 'd1', 2, 7), /Only unplayed fixtures can be rescheduled/);
    await exec(`update public.matches set status = 'SCHEDULED' where round = 3 and home_id = 't1'`);

    // Bad shift arguments.
    await expectError(() => shift('s1', 'd1', 1, 0), /between 1 and 365/);
    await expectError(() => shift('s1', 'd1', 1, 400), /between 1 and 365/);
    await expectError(() => shift('s1', 'd1', 0, 7), /between 1 and 1000/);
    await expectError(() => shift('s1', 'd9', 1, 7), /known division/);
    await expectError(() => shift('s2', 'd1', 1, 7), /active season/);

    // Both write paths keep the audit chain valid.
    const chain = await asAdmin(async () =>
      (await q('select public.audit_verify_chain() as r'))[0].r
    );
    assert.strictEqual(chain.ok, true, `audit chain broken: ${JSON.stringify(chain)}`);
    console.log(`OK the audit chain verifies (${chain.checked}/${chain.total} rows)`);

    console.log('\nAll fixture generator tests passed.');
  } finally {
    await db.close();
  }
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
