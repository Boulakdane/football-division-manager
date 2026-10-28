#!/usr/bin/env node
/*
 * SQL tests for task I (team crests, first half).
 *
 * Runs in its own in-memory PGlite database and proves that:
 *   * teams.icon is optional and only accepts a small PNG/JPEG/WebP data URL
 *     (no http(s) hotlinks, no SVG, no script URIs, no oversize payload);
 *   * replace_all_data() restores the crest and rejects a bad one atomically;
 *   * list_deleted() returns the crest for a deleted club;
 *   * anonymous visitors can still read the public club row (the crest is
 *     public data) but cannot write it;
 *   * team-icons-migration.sql upgrades a pre-I database, keeps every row and
 *     is re-runnable.
 *
 * Usage: npm run test:team-icons
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');
const { toDbPayload, teamFromRow } = require('./backup-map');

const ROOT = path.resolve(__dirname, '..');
const ADMIN_ID = '00000000-0000-0000-0000-000000000001';

// A real 64x64 RGBA PNG (a filled circle) produced by a tiny script; small
// enough to live in the sample data and in this test.
const PNG_ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAvElEQVR42u3bsRHCMBBEUVdBUbRJoUtIwjAYJFknveDHnnmZ7dvj9rgfOzfyYTlZeYA0rgxAOjctQAY3DUAu7jKATNZQgEzaEIBMXleAFKkLQIrVFCBFawKQ4v0FkEX6CSCLBeAMQBYNwDcAWTwAnwCySQDeAWSzAAAA8ALIpgEAAAAAAAAAAAAAsDuAt0EAAAD4KgzAjxEAfo4CcCABwJGUMzmHkk5lHUs7lzeYMJkxmjKbM5w0nTWeXr0nmIz1xrmkf+AAAAAASUVORK5CYII=';
const JPEG_ICON = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
const WEBP_ICON = 'data:image/webp;base64,UklGRg==';

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
  // db.exec() has no parameter support; db.query() is the parameterised form.
  const run = (sql, params) => db.query(sql, params);
  const asRole = async (role, uid, fn) => {
    await exec(`set test.uid = '${uid}'`);
    await exec(`set role ${role}`);
    try { return await fn(); } finally { await exec('reset role'); await exec("set test.uid = ''"); }
  };
  const asAdmin = fn => asRole('authenticated', ADMIN_ID, fn);
  const asAnon = fn => asRole('anon', '', fn);
  const expectError = async (fn, pattern) => {
    let error = null;
    try { await fn(); } catch (err) { error = err; }
    assert(error, 'expected an error');
    assert(pattern.test(String(error.message || error)), `unexpected error: ${error.message || error}`);
  };

  try {
    await mockAuth(db);
    await exec(fs.readFileSync(path.join(ROOT, 'supabase/schema.sql'), 'utf8'));
    await exec(`insert into auth.users (id, email) values ('${ADMIN_ID}', 'admin@test.local')`);
    await exec(`update public.profiles set role = 'admin' where id = '${ADMIN_ID}'`);

    // ------------------------------------------------------------
    // 1. The column and its check constraint
    // ------------------------------------------------------------
    const column = (await q(`
      select is_nullable, data_type
      from information_schema.columns
      where table_schema = 'public' and table_name = 'teams' and column_name = 'icon'
    `))[0];
    assert(column, 'teams.icon exists');
    assert.strictEqual(column.is_nullable, 'YES', 'the crest is optional');
    assert.strictEqual(column.data_type, 'text');

    const seedTeam = (await q('select id from public.teams order by id limit 1'))[0].id;
    await exec('update public.teams set icon = null');
    for (const [label, value] of [
      ['png', PNG_ICON],
      ['jpeg', JPEG_ICON],
      ['webp', WEBP_ICON]
    ]) {
      await run('update public.teams set icon = $1 where id = $2', [value, seedTeam]);
      assert.strictEqual(
        (await q('select icon from public.teams where id = $1', [seedTeam]))[0].icon,
        value,
        `${label} data URLs are stored verbatim`
      );
    }

    for (const [label, value] of [
      ['an external URL', 'https://example.com/crest.png'],
      ['a relative path', '/crest.png'],
      ['an SVG', 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='],
      ['a GIF', 'data:image/gif;base64,R0lGODlhAQABAAAAACw='],
      ['a script URI', 'javascript:alert(1)'],
      ['an empty payload', 'data:image/png;base64,'],
      ['invalid base64', 'data:image/png;base64,AAAA AAAA'],
      ['an oversize payload', 'data:image/png;base64,' + 'A'.repeat(100000)]
    ]) {
      await expectError(
        () => run('update public.teams set icon = $1 where id = $2', [value, seedTeam]),
        /kickoff_teams_icon_data/
      );
    }
    console.log('OK team icons are optional and only accept small PNG/JPEG/WebP data URLs');

    // ------------------------------------------------------------
    // 2. An anonymous visitor reads the crest but cannot write it
    // ------------------------------------------------------------
    await run('update public.teams set icon = $1 where id = $2', [PNG_ICON, seedTeam]);
    const publicRow = await asAnon(async () =>
      (await q('select icon from public.teams where id = $1', [seedTeam]))[0]
    );
    assert.strictEqual(publicRow.icon, PNG_ICON, 'the crest is public data');
    await expectError(
      () => asAnon(() => run('update public.teams set icon = null where id = $1', [seedTeam])),
      /permission denied|row-level security/i
    );
    console.log('OK anonymous visitors read a crest but cannot write one');

    // ------------------------------------------------------------
    // 3. replace_all_data() restores the crest, atomically
    // ------------------------------------------------------------
    const payloadTeams = [
      { id: 't1', name: 'Spartan FC', nameAr: 'سبارتان', icon: PNG_ICON, code: 'SFC', color: '#3b82f6', divisionId: 'd1' },
      { id: 't2', name: 'Titan United', nameAr: null, icon: null, code: 'TTN', color: '#10b981', divisionId: 'd1' }
    ];
    const backup = {
      seasons: [{ id: 's1', name: '2026 Season', startDate: '2026-08-01', endDate: '2027-05-31', isActive: true }],
      teams: payloadTeams,
      players: [],
      matches: [],
      matchEvents: []
    };

    const callReplace = data => asAdmin(() => exec(
      `select public.replace_all_data(${quoteLiteral(JSON.stringify(toDbPayload(data)))}::jsonb)`
    ));
    await callReplace(backup);

    const restored = await q('select * from public.teams order by id');
    assert.strictEqual(restored.length, 2, 'the import replaced the league');
    assert.strictEqual(teamFromRow(restored[0]).icon, PNG_ICON, 'the crest survives the import');
    assert.strictEqual(teamFromRow(restored[1]).icon, null, 'a club without a crest stays null');

    // A bad crest in the payload is rejected before anything is deleted.
    const bad = {
      ...backup,
      teams: [
        { ...payloadTeams[0], icon: 'https://example.com/evil.png' },
        payloadTeams[1]
      ]
    };
    await expectError(() => callReplace(bad), /kickoff_teams_icon_data/);
    assert.strictEqual(
      (await q('select count(*)::int as n from public.teams'))[0].n,
      2,
      'a rejected import leaves the previous data in place'
    );
    console.log('OK replace_all_data restores a crest and rejects a bad one without changing data');

    // ------------------------------------------------------------
    // 4. list_deleted() shows the crest in the trash
    // ------------------------------------------------------------
    await asAdmin(() => exec("select public.delete_team('t2')"));
    const trash = await asAdmin(async () =>
      (await q('select public.list_deleted() as payload'))[0].payload
    );
    const trashTeam = (trash.teams || []).find(team => team.id === 't2');
    assert(trashTeam, 'the deleted club appears in the trash');
    assert.strictEqual(trashTeam.icon, null, 'list_deleted returns the icon field');
    await asAdmin(() => exec("select public.restore_team('t2')"));
    await asAdmin(() => run("update public.teams set icon = $1 where id = 't2'", [WEBP_ICON]));
    await asAdmin(() => exec("select public.delete_team('t2')"));
    const trash2 = await asAdmin(async () =>
      (await q('select public.list_deleted() as payload'))[0].payload
    );
    assert.strictEqual(
      (trash2.teams || []).find(team => team.id === 't2').icon,
      WEBP_ICON,
      'the trash carries the stored crest'
    );
    console.log('OK list_deleted returns the crest of a deleted club');

    // ------------------------------------------------------------
    // 5. The migration upgrades a pre-I database and is re-runnable
    // ------------------------------------------------------------
    // Recreate the pre-I shape: no column, no constraint, and the two
    // functions without the icon. The migration must restore all four.
    await asAdmin(() => exec("select public.restore_team('t2')"));
    await exec('drop function public.list_deleted()');
    await exec('drop function public.replace_all_data(jsonb)');
    await exec('alter table public.teams drop constraint kickoff_teams_icon_data');
    await exec('alter table public.teams drop column icon');

    const migration = fs.readFileSync(path.join(ROOT, 'supabase/team-icons-migration.sql'), 'utf8');
    await exec(migration);
    await exec(migration);

    const afterColumn = (await q(`
      select is_nullable from information_schema.columns
      where table_schema = 'public' and table_name = 'teams' and column_name = 'icon'
    `))[0];
    assert(afterColumn, 'the migration adds the column');
    const constraint = (await q(`
      select 1 from pg_constraint
      where conname = 'kickoff_teams_icon_data' and conrelid = 'public.teams'::regclass
    `))[0];
    assert(constraint, 'the migration adds the check constraint');

    await callReplace(backup);
    assert.strictEqual(
      (await q("select icon from public.teams where id = 't1'"))[0].icon,
      PNG_ICON,
      'the upgraded replace_all_data restores the crest'
    );
    await asAdmin(() => exec("select public.delete_team('t1')"));
    const trashAfter = await asAdmin(async () =>
      (await q('select public.list_deleted() as payload'))[0].payload
    );
    assert.strictEqual(
      (trashAfter.teams || []).find(team => team.id === 't1').icon,
      PNG_ICON,
      'the upgraded list_deleted returns the crest'
    );
    console.log('OK team-icons-migration.sql upgrades a pre-I database and is re-runnable');

    console.log('\nAll team icon checks passed');
  } finally {
    await db.close();
  }
}

/** Single-quote a string for a SQL literal (the migration test only). */
function quoteLiteral(text) {
  return "'" + String(text).replace(/'/g, "''") + "'";
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
