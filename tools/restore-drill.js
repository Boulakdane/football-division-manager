#!/usr/bin/env node
/*
 * Restore drill: load a JSON backup through public.replace_all_data() into an
 * in-memory Postgres (PGlite), then compare the database back to the backup.
 *
 * Usage:
 *   node tools/restore-drill.js backups/prod-backup-2026-10-24.json
 *
 * This is the step between "the JSON is valid" and "the real import works".
 * It uses the same schema and RPC as Supabase, requires no credentials, and
 * leaves no data behind.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { PGlite } = require('@electric-sql/pglite');
const {
  seasonFromRow,
  teamFromRow,
  playerFromRow,
  matchFromRow,
  eventFromRow,
  toDbPayload
} = require('./backup-map');

const ROOT = path.resolve(__dirname, '..');
const ADMIN_ID = '00000000-0000-0000-0000-000000000001';

function log(message) {
  console.log(message);
}

function canonical(value) {
  if (Array.isArray(value)) {
    const items = value.map(canonical);
    if (items.every(item => item && typeof item === 'object' && typeof item.id === 'string')) {
      items.sort((a, b) => a.id.localeCompare(b.id));
    }
    return items;
  }
  if (value && typeof value === 'object') {
    const result = {};
    for (const key of Object.keys(value).sort()) result[key] = canonical(value[key]);
    return result;
  }
  return value;
}

function payloadToBackup(payload) {
  return {
    seasons: payload.seasons.map(seasonFromRow),
    teams: payload.teams.map(teamFromRow),
    players: payload.players.map(playerFromRow),
    matches: payload.matches.map(matchFromRow),
    matchEvents: payload.match_events.map(eventFromRow)
  };
}

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
  const input = process.argv[2];
  if (!input) {
    console.error('Usage: node tools/restore-drill.js <backup.json>');
    process.exit(1);
  }

  const file = path.resolve(input);
  if (!fs.existsSync(file)) {
    console.error(`Backup not found: ${file}`);
    process.exit(1);
  }

  let backup;
  try {
    backup = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    console.error(`Could not parse ${file}: ${error.message}`);
    process.exit(1);
  }

  const payload = toDbPayload(backup);
  const expected = payloadToBackup(payload);

  log(`Restore drill for ${file}`);
  log(`Input: ${expected.seasons.length} seasons, ${expected.teams.length} teams, ` +
    `${expected.players.length} players, ${expected.matches.length} matches, ` +
    `${expected.matchEvents.length} events`);

  const db = await createDatabase();
  try {
    await db.query('select public.replace_all_data($1::jsonb)', [JSON.stringify(payload)]);

    const q = async sql => (await db.query(sql)).rows;
    const counts = {
      seasons: (await q('select count(*)::int n from public.seasons'))[0].n,
      teams: (await q('select count(*)::int n from public.teams'))[0].n,
      players: (await q('select count(*)::int n from public.players'))[0].n,
      matches: (await q('select count(*)::int n from public.matches'))[0].n,
      events: (await q('select count(*)::int n from public.match_events'))[0].n
    };

    assert.strictEqual(counts.seasons, expected.seasons.length, 'season count changed');
    assert.strictEqual(counts.teams, expected.teams.length, 'team count changed');
    assert.strictEqual(counts.players, expected.players.length, 'player count changed');
    assert.strictEqual(counts.matches, expected.matches.length, 'match count changed');
    assert.strictEqual(counts.events, expected.matchEvents.length, 'event count changed');

    const activeSeasons = await q('select count(*)::int n from public.seasons where is_active');
    assert.strictEqual(activeSeasons[0].n, 1, 'restore must leave exactly one active season');

    const nullSeasons = await q('select count(*)::int n from public.matches where season_id is null');
    assert.strictEqual(nullSeasons[0].n, 0, 'every restored match needs a season');

    const orphanEvents = await q(`
      select count(*)::int n
      from public.match_events e
      join public.matches m on m.id = e.match_id
      join public.players p on p.id = e.player_id
      where p.team_id <> e.team_id
         or e.team_id not in (m.home_id, m.away_id)
    `);
    assert.strictEqual(orphanEvents[0].n, 0, 'restored event points at the wrong team');

    const importRows = await q("select count(*)::int n from public.audit_log where action = 'IMPORT'");
    assert.strictEqual(importRows[0].n, 1, 'restore should write exactly one IMPORT audit row');

    const actual = {
      seasons: (await q('select * from public.seasons order by id')).map(seasonFromRow),
      teams: (await q('select * from public.teams order by id')).map(teamFromRow),
      players: (await q('select * from public.players order by id')).map(playerFromRow),
      matches: (await q('select * from public.matches order by id')).map(matchFromRow),
      matchEvents: (await q('select * from public.match_events order by id')).map(eventFromRow)
    };

    assert.deepStrictEqual(canonical(actual), canonical(expected), 'restored data differs from the backup');

    log(`Restored: ${counts.seasons} seasons, ${counts.teams} teams, ${counts.players} players, ` +
      `${counts.matches} matches, ${counts.events} events`);
    log('Round trip is identical; one active season; one IMPORT audit row; no orphan events.');
    log('Restore drill passed.');
  } finally {
    await db.close();
  }
}

run().catch(error => {
  console.error('\nRestore drill failed: ' + (error && error.message ? error.message : String(error)));
  if (error && error.actual !== undefined) {
    console.error('Expected:', JSON.stringify(error.expected));
    console.error('Actual:  ', JSON.stringify(error.actual));
  }
  process.exit(1);
});
