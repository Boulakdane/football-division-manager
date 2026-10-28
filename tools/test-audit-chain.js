#!/usr/bin/env node
/*
 * SQL tests for roadmap D (tamper-evident audit chain).
 *
 * Runs in its own in-memory PGlite database and proves that:
 *   * the BEFORE INSERT trigger chains every audit row, whichever path writes it;
 *   * the upgrade migration backfills a pre-D table without changing row order;
 *   * re-running the migration is a no-op and does not repair tampering;
 *   * audit_verify_chain() reports an edited row, a deleted middle row and a
 *     changed tail, while audit_chain_head() exposes only the head;
 *   * only admins can verify, but anyone can read the public chain head.
 *
 * Usage: npm run test:audit-chain
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

function assertChain(rows, label) {
  assert(rows.length > 0, `${label}: expected audit rows`);
  let prev = null;
  for (const row of rows) {
    assert.strictEqual(row.prev_hash, prev, `${label}: row ${row.id} links to the previous hash`);
    assert.strictEqual(typeof row.row_hash, 'string', `${label}: row ${row.id} has a hash`);
    assert.strictEqual(row.row_hash.length, 64, `${label}: row ${row.id} hash is SHA-256 hex`);
    prev = row.row_hash;
  }
  return prev;
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
  const verify = (expectedHead = null) => asAdmin(async () =>
    (await q('select public.audit_verify_chain($1) as r', [expectedHead]))[0].r
  );
  const head = async () => (await q('select public.audit_chain_head() as r'))[0].r;

  try {
    await mockAuth(db);
    await exec(fs.readFileSync(path.join(ROOT, 'supabase/schema.sql'), 'utf8'));
    await exec(`insert into auth.users (id, email) values
      ('${ADMIN_ID}', 'admin@test.local'), ('${VIEWER_ID}', 'viewer@test.local')`);
    await exec(`update public.profiles set role = 'admin' where id = '${ADMIN_ID}'`);
    await exec(`update public.profiles set role = 'viewer' where id = '${VIEWER_ID}'`);

    // ------------------------------------------------------------
    // 1. A fresh install chains every write
    // ------------------------------------------------------------
    await asAdmin(async () => {
      await q("insert into public.teams (id, name, code, color) values ('tchain1', 'Chain FC', 'CHN', '#123456')");
      await q("update public.teams set name = 'Chain FC II' where id = 'tchain1'");
      await q("select public.delete_team('tchain1')");
    });

    const rows = await q('select id, prev_hash, row_hash from public.audit_log order by id');
    assert.strictEqual(rows.length, 3, 'insert, update and soft delete are audited');
    const originalHead = assertChain(rows, 'fresh install');
    assert.strictEqual(originalHead, rows[rows.length - 1].row_hash);

    const ok = await verify();
    assert.strictEqual(ok.ok, true, 'the fresh chain verifies');
    assert.strictEqual(ok.checked, 3);
    assert.strictEqual(ok.total, 3);
    assert.strictEqual(ok.head, originalHead);

    const publicHead = await head();
    assert.deepStrictEqual(
      { count: publicHead.count, lastId: publicHead.lastId, head: publicHead.head },
      { count: 3, lastId: rows[2].id, head: originalHead },
      'the public head matches the last row'
    );
    console.log('OK every audit write is chained and the head matches');

    // ------------------------------------------------------------
    // 2. The migration upgrades and backfills a pre-D table
    // ------------------------------------------------------------
    // Put the database back into its pre-D shape while keeping the audit rows.
    await exec('drop trigger if exists audit_log_chain on public.audit_log');
    await exec('drop function if exists public.audit_log_chain()');
    await exec(`drop function if exists public.audit_row_hash(
      text, bigint, timestamptz, uuid, text, text, text, text, text, text, jsonb, jsonb)`);
    await exec('drop function if exists public.audit_verify_chain(text)');
    await exec('drop function if exists public.audit_chain_head()');
    await exec('alter table public.audit_log drop column prev_hash, drop column row_hash');

    assert.strictEqual(
      (await q('select count(*)::int as n from public.audit_log'))[0].n, 3,
      'the audit rows survive the pre-D simulation'
    );

    const migration = fs.readFileSync(path.join(ROOT, 'supabase/audit-chain-migration.sql'), 'utf8');
    await exec(migration);

    const backfilled = await q('select id, prev_hash, row_hash from public.audit_log order by id');
    assert.deepStrictEqual(
      backfilled.map(row => row.row_hash), rows.map(row => row.row_hash),
      'the backfill reproduces the same hashes for unchanged rows'
    );
    assert.strictEqual((await verify()).ok, true, 'the backfilled chain verifies');
    console.log('OK the migration backfills a pre-D audit table with the same hashes');

    // Re-running must not touch existing hashes.
    await exec(migration);
    const afterRerun = await q('select id, prev_hash, row_hash from public.audit_log order by id');
    assert.deepStrictEqual(afterRerun, backfilled, 'a second run changes nothing');
    console.log('OK the migration is re-runnable');

    // A new row links to the backfilled head.
    await asAdmin(async () => {
      await q("insert into public.teams (id, name, code, color) values ('tchain2', 'Next FC', 'NXT', '#654321')");
    });
    const extended = await q('select id, prev_hash, row_hash from public.audit_log order by id');
    const extendedHead = assertChain(extended, 'after migration');
    assert.strictEqual(extended[3].prev_hash, backfilled[2].row_hash, 'the new row links to the old head');
    assert.strictEqual((await verify()).ok, true);
    assert.strictEqual((await head()).head, extendedHead);
    console.log('OK new writes extend the backfilled chain');

    // ------------------------------------------------------------
    // 3. Only admins verify; everyone can read the head
    // ------------------------------------------------------------
    const anonHead = await asAnon(async () => (await q('select public.audit_chain_head() as r'))[0].r);
    assert.deepStrictEqual(anonHead, await head(), 'the public head is readable without a session');

    for (const [label, call] of [
      ['anon', () => asAnon(async () => q('select public.audit_verify_chain(null)'))],
      ['viewer', () => asViewer(async () => q('select public.audit_verify_chain(null)'))]
    ]) {
      let error = null;
      try { await call(); } catch (err) { error = err; }
      assert(error, `${label} must not verify the chain`);
      assert(/permission denied|Only admins/i.test(String(error.message || error)), `${label}: ${error.message}`);
    }
    console.log('OK only admins verify, while the head stays public');

    // ------------------------------------------------------------
    // 4. Edits, middle deletions and tail deletions are detected
    // ------------------------------------------------------------
    const savedHead = (await head()).head;

    await exec("update public.audit_log set summary = 'tampered' where id = 2");
    const edited = await verify();
    assert.strictEqual(edited.ok, false, 'an edited row is detected');
    assert.strictEqual(edited.brokenAt, 2);
    assert.strictEqual(edited.reason, 'row_hash');
    await exec("update public.audit_log set summary = null where id = 2");
    assert.strictEqual((await verify()).ok, true, 'restoring the value restores the hash');

    await exec('delete from public.audit_log where id = 2');
    const deletedMiddle = await verify();
    assert.strictEqual(deletedMiddle.ok, false, 'a deleted middle row is detected');
    assert.strictEqual(deletedMiddle.reason, 'prev_hash');
    console.log('OK an edited or deleted middle row breaks the chain');

    // Repair the middle by deleting the rows after it (superuser only), then
    // delete the tail: the remaining chain is valid but the published head moves.
    await exec('delete from public.audit_log where id > 2');
    await exec('delete from public.audit_log where id = 2');
    const prefix = await verify();
    assert.strictEqual(prefix.ok, true, 'the remaining prefix is internally valid');
    assert.strictEqual(prefix.head, (await head()).head);

    const tail = await verify(savedHead);
    assert.strictEqual(tail.ok, false, 'a changed tail fails the expected-head check');
    assert.strictEqual(tail.reason, 'head_mismatch');
    assert.strictEqual(tail.expectedHead, savedHead);
    assert.notStrictEqual(tail.actualHead, savedHead);
    console.log('OK a rewritten tail fails the published-head check');

    // Re-running the migration must not repair any of this.
    await exec(migration);
    assert.strictEqual((await verify(savedHead)).ok, false, 're-running does not repair tampering');
    console.log('OK re-running the migration does not repair tampering');

    console.log('\nAll audit-chain checks passed');
  } finally {
    await db.close();
  }
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
