#!/usr/bin/env node
/*
 * Anonymous grant test.
 *
 * Supabase gives the anon role full privileges on new public tables by default, and
 * Row Level Security is the only thing that then stops anonymous writes. This test
 * recreates that default, loads supabase/schema.sql and checks that the anon role
 * ends up with no write-type privilege on any public table (and keeps SELECT on the
 * public league tables). It also checks the stand-alone migration and that tables
 * created later do not inherit anonymous write privileges.
 *
 * Runs in an in-memory PGlite database in its own process so it cannot disturb
 * tools/test-sql-integrity.js.
 *
 * Usage: npm run test:grants
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

const ROOT = path.resolve(__dirname, '..');
const WRITE_PRIVILEGES = ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
const PUBLIC_READ_TABLES = ['seasons', 'teams', 'players', 'matches', 'match_events'];

async function anonWriteGrants(db) {
  const { rows } = await db.query("select tablename from pg_tables where schemaname = 'public' order by tablename");
  const found = [];
  for (const { tablename } of rows) {
    for (const privilege of WRITE_PRIVILEGES) {
      const result = await db.query('select has_table_privilege($1, $2, $3) as allowed', ['anon', 'public.' + tablename, privilege]);
      if (result.rows[0].allowed) found.push(`${tablename}:${privilege}`);
    }
  }
  return { tables: rows.map(r => r.tablename), found };
}

async function canSelect(db, table) {
  const result = await db.query("select has_table_privilege('anon', $1, 'SELECT') as allowed", ['public.' + table]);
  return result.rows[0].allowed;
}

async function run() {
  const db = new PGlite();
  try {
    await db.exec(`
      create schema auth;
      create table auth.users (id uuid primary key, email text);
      create or replace function auth.uid() returns uuid
        language sql stable as $$ select null::uuid $$;
      create or replace function auth.jwt() returns jsonb
        language sql stable as $$ select '{}'::jsonb $$;
      create role anon;
      create role authenticated;
      -- What a new Supabase project does by default.
      alter default privileges in schema public grant all on tables to anon, authenticated;
    `);

    await db.exec(fs.readFileSync(path.join(ROOT, 'supabase/schema.sql'), 'utf8'));

    const afterSchema = await anonWriteGrants(db);
    assert(afterSchema.tables.length >= 6, 'expected the league tables to exist');
    assert.deepStrictEqual(afterSchema.found, [], 'anon must hold no write privilege after schema.sql: ' + afterSchema.found.join(', '));
    for (const table of PUBLIC_READ_TABLES) {
      assert(await canSelect(db, table), `anon must keep SELECT on ${table}`);
    }
    console.log('OK schema.sql leaves anon read-only at the grant layer');

    // A table created later (by a future migration) must not inherit anonymous writes.
    await db.exec('create table public.zz_future_table (id int)');
    const future = await anonWriteGrants(db);
    assert.deepStrictEqual(future.found, [], 'new tables must not grant anon writes: ' + future.found.join(', '));
    console.log('OK tables created later do not inherit anonymous writes');

    // The stand-alone migration repairs a project that still has the default grants.
    await db.exec('grant insert, update, delete, truncate, references, trigger on all tables in schema public to anon');
    const drifted = await anonWriteGrants(db);
    assert(drifted.found.length > 0, 'test setup should have re-granted writes');
    await db.exec(fs.readFileSync(path.join(ROOT, 'supabase/revoke-anon-write-grants-migration.sql'), 'utf8'));
    const repaired = await anonWriteGrants(db);
    assert.deepStrictEqual(repaired.found, [], 'migration must remove every anon write privilege: ' + repaired.found.join(', '));
    for (const table of PUBLIC_READ_TABLES) {
      assert(await canSelect(db, table), `migration must keep anon SELECT on ${table}`);
    }
    await db.exec(fs.readFileSync(path.join(ROOT, 'supabase/revoke-anon-write-grants-migration.sql'), 'utf8'));
    console.log('OK migration removes anonymous writes, keeps reads, and is re-runnable');

    console.log('All anonymous grant tests passed.');
  } finally {
    await db.close();
  }
}

run().catch(error => {
  console.error('Anonymous grant tests failed:', error);
  process.exit(1);
});
