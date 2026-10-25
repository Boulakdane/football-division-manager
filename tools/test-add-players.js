#!/usr/bin/env node
/*
 * SQL tests for public.add_players() (the "Import squad from Excel" backend).
 *
 * Runs in its own in-memory PGlite database so it cannot disturb
 * tools/test-sql-integrity.js. It loads supabase/schema.sql, checks the happy
 * path, every rejection, atomicity, permissions and the audit entry, and
 * verifies that imported totals land in legacy_* (the only stored part after
 * roadmap A stage 3) so v_player_stats shows them.
 *
 * The pre-drop re-run of supabase/add-players-migration.sql is covered by
 * tools/test-drop-totals.js.
 *
 * Usage: npm run test:add-players
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

const ROOT = path.resolve(__dirname, '..');
const ADMIN_ID = '00000000-0000-0000-0000-000000000001';
const VIEWER_ID = '00000000-0000-0000-0000-000000000002';

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
  const expectError = async (fn, pattern) => {
    let error = null;
    try { await fn(); } catch (err) { error = err; }
    assert(error, 'expected an error');
    assert(pattern.test(String(error.message || error)), `unexpected error: ${error.message || error}`);
  };
  const add = (team, players) => q('select public.add_players($1, $2::jsonb) as n', [team, JSON.stringify(players)]);
  const count = async team => (await q('select count(*)::int n from public.players where team_id = $1', [team]))[0].n;

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
    await exec(`insert into auth.users (id, email) values ('${ADMIN_ID}', 'admin@test.local'), ('${VIEWER_ID}', 'viewer@test.local')`);
    await exec(`update public.profiles set role = 'admin' where id = '${ADMIN_ID}'`);

    const team = (await q("select id, name from public.teams where deleted_at is null order by id limit 1"))[0];
    const other = (await q("select id from public.teams where deleted_at is null and id <> $1 order by id limit 1", [team.id]))[0].id;
    const base = await count(team.id);

    // ---- happy path ----
    const result = await asAdmin(() => add(team.id, [
      { name: '  Amine   Belkacem ', pos: 'gk', num: 1 },
      { name: 'Yacine Mansouri', pos: 'DEF', num: '4', goals: 2, yellow: 1, red: 0 },
      { name: 'Karim Benali' },
      { name: 'محمد العربي', pos: 'MID', num: 6 }
    ]));
    assert.strictEqual(result[0].n, 4);
    assert.strictEqual(await count(team.id), base + 4);
    const rows = await q(`
      select p.id, p.name, p.pos, p.num, p.is_active,
             coalesce(v.goals, 0) as goals,
             coalesce(v.yellow, 0) as yellow,
             coalesce(v.red, 0) as red
      from public.players p
      left join public.v_player_stats v on v.player_id = p.id
      where p.team_id = $1 and p.id like 'p\\_%'
      order by p.name
    `, [team.id]);
    const byName = Object.fromEntries(rows.map(r => [r.name, r]));
    assert.strictEqual(byName['Amine Belkacem'].pos, 'GK', 'name whitespace is collapsed and pos upper-cased');
    assert.strictEqual(byName['Amine Belkacem'].num, 1);
    assert.strictEqual(byName['Yacine Mansouri'].goals, 2);
    assert.strictEqual(byName['Karim Benali'].pos, 'MID', 'pos defaults to MID');
    assert.strictEqual(byName['Karim Benali'].num, 10, 'shirt number defaults to 10');
    assert.strictEqual(byName['Karim Benali'].goals, 0);
    assert(byName['محمد العربي'], 'non-Latin names survive');
    assert(rows.every(r => r.is_active === true && /^p_[0-9a-f]{32}$/.test(r.id)));
    console.log('OK add_players adds a squad with defaults and cleaned names');

    // ---- audit: one summary entry, no per-row noise ----
    const audit = await q("select action, entity, entity_id, summary, actor_email from public.audit_log where entity = 'players' order by id");
    assert.strictEqual(audit.length, 1, 'exactly one audit entry: ' + JSON.stringify(audit));
    assert.strictEqual(audit[0].action, 'IMPORT');
    assert.strictEqual(audit[0].entity_id, team.id);
    assert.strictEqual(audit[0].summary, `Imported 4 players into ${team.name}`);
    assert.strictEqual(audit[0].actor_email, 'admin@test.local');
    console.log('OK one IMPORT audit entry, no per-player rows');

    // ---- rejections, and atomicity ----
    const before = await count(team.id);
    const bad = async (players, pattern, label) => {
      await asAdmin(() => expectError(() => add(team.id, players), pattern));
      assert.strictEqual(await count(team.id), before, `${label}: nothing may be inserted`);
    };
    await bad([{ name: 'Valid One' }, { name: 'Bad Pos', pos: 'STR' }], /Row 2: the position/, 'bad position after a valid row');
    await bad([{ name: 'Dup A' }, { name: 'dup   a' }], /Row 2: "dup a" appears more than once/, 'duplicate inside the file');
    await bad([{ name: 'david  SILVA' }], /already in this squad/, 'duplicate of an existing player');
    await bad([{ name: 'No Number', num: 0 }], /shirt number/, 'shirt number 0');
    await bad([{ name: 'No Number', num: 100 }], /shirt number/, 'shirt number 100');
    await bad([{ name: 'No Number', num: 'abc' }], /shirt number/, 'shirt number text');
    await bad([{ name: 'No Number', num: 7.5 }], /shirt number/, 'shirt number decimal');
    await bad([{ name: 'Neg', goals: -1 }], /goals and cards/, 'negative goals');
    await bad([{ name: 'Neg', yellow: 'x' }], /goals and cards/, 'text yellow cards');
    await bad([{ name: '   ' }], /name must be 1 to 100/, 'blank name');
    await bad([{ name: 'x'.repeat(101) }], /name must be 1 to 100/, 'name too long');
    await bad([], /no players to add/, 'empty list');
    await bad(Array.from({ length: 101 }, (_, i) => ({ name: 'Bulk ' + i })), /At most 100/, 'too many rows');
    await asAdmin(() => expectError(() => q("select public.add_players($1, '{\"name\":\"x\"}'::jsonb)", [team.id]), /JSON array/));
    await asAdmin(() => expectError(() => q("select public.add_players($1, '[\"text\"]'::jsonb)", [team.id]), /expected an object/));
    await asAdmin(() => expectError(() => add('no_such_team', [{ name: 'Ghost' }]), /Team not found/));
    assert.strictEqual((await q("select count(*)::int n from public.audit_log where entity = 'players'"))[0].n, 1, 'failed calls leave no audit entry');
    console.log('OK every invalid payload is rejected and leaves nothing behind');

    // ---- trashed team ----
    await asAdmin(() => q('select public.delete_team($1)', [other]));
    await asAdmin(() => expectError(() => add(other, [{ name: 'Late Arrival' }]), /Team not found/));
    await asAdmin(() => q('select public.restore_team($1)', [other]));
    console.log('OK a team in the trash cannot receive players');

    // ---- archived players do not block a new player with the same name ----
    await exec("update public.players set is_active = false where name = 'Amine Belkacem'");
    await asAdmin(() => add(team.id, [{ name: 'Amine Belkacem', pos: 'GK', num: 12 }]));
    console.log('OK archived players do not count as duplicates');

    // ---- permissions ----
    await asRole('anon', ADMIN_ID, () => expectError(() => add(team.id, [{ name: 'Anon' }]), /permission denied|42501/i));
    await asRole('authenticated', VIEWER_ID, () => expectError(() => add(team.id, [{ name: 'Viewer' }]), /Only admins can add players/));
    assert.strictEqual((await q("select count(*)::int n from public.players where name in ('Anon', 'Viewer')"))[0].n, 0);
    console.log('OK anonymous and non-admin callers are refused');

    // ---- totals are written as the legacy offset, not to stored columns ----
    const stored = await q(`
      select column_name
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'players'
        and column_name in ('goals', 'yellow', 'red')
    `);
    assert.strictEqual(stored.length, 0, 'players must not have stored totals after stage 3');
    const yacine = (await q("select id from public.players where name = 'Yacine Mansouri'"))[0];
    const yacineTotals = (await q(
      'select goals, yellow, red, legacy_goals from public.v_player_stats where player_id = $1',
      [yacine.id]
    ))[0];
    assert.deepStrictEqual(
      [yacineTotals.goals, yacineTotals.yellow, yacineTotals.red, yacineTotals.legacy_goals],
      [2, 1, 0, 2],
      'imported totals land in legacy_* and show up in v_player_stats'
    );
    console.log('OK add_players writes the legacy offset that v_player_stats reads');

    console.log('All add_players tests passed.');
  } finally {
    await db.close();
  }
}

run().catch(error => {
  console.error('add_players tests failed:', error);
  process.exit(1);
});
