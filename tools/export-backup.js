#!/usr/bin/env node
/*
 * Export the public league data from Supabase without an admin session.
 *
 * Usage:
 *   node tools/export-backup.js                     # production -> backups/
 *   node tools/export-backup.js --env=dev           # development project
 *   node tools/export-backup.js --out=path.json     # explicit destination
 *
 * The anon/publishable key only reads what RLS exposes to visitors, so this
 * works in CI without secrets. Trashed rows are intentionally excluded, just
 * like the admin JSON export in the app.
 *
 * Roadmap D: when the project has audit_chain_head(), the backup also records
 * the public head of the audit hash chain. It contains no log entries, only the
 * row count, last id/time and head hash, so publishing it with the backup makes
 * a later rewrite of the log detectable. A project that predates roadmap D has
 * no such function; the backup is then written without the field.
 *
 * Environment overrides: SUPABASE_URL, SUPABASE_ANON_KEY.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { fail, readConfig } = require('./supabase-config');
const {
  seasonFromRow,
  teamFromRow,
  playerFromRow,
  matchFromRow,
  eventFromRow
} = require('./backup-map');

const args = process.argv.slice(2);
const envArg = (args.find(a => a.startsWith('--env=')) || '--env=prod').split('=')[1];
const outArg = (args.find(a => a.startsWith('--out=')) || '').slice('--out='.length);


async function getRows(base, table, order, { optional = false } = {}) {
  const pageSize = 1000;
  const rows = [];
  let from = 0;

  while (true) {
    const response = await fetch(`${base.url}/rest/v1/${table}?select=*&order=${order}`, {
      headers: {
        apikey: base.key,
        Authorization: 'Bearer ' + base.key,
        Accept: 'application/json',
        Range: `${from}-${from + pageSize - 1}`,
        'Range-Unit': 'items'
      }
    });
    if (!response.ok) {
      // A project that predates roadmap A has no v_player_stats; its totals
      // are still on players.goals and the merge below leaves them alone.
      if (optional && response.status === 404) return [];
      const body = await response.text();
      fail(`${table} request failed (${response.status}): ${body.slice(0, 300)}`);
    }

    const page = await response.json();
    if (!Array.isArray(page)) fail(`${table} returned an unexpected response.`);
    rows.push(...page);
    if (!page.length) return rows;

    from += page.length;
    if (from > 100000) {
      fail(`Refusing to paginate ${table} beyond ${from} rows.`);
    }
  }
}

function seasonRow(row) {
  return seasonFromRow(row);
}

function teamRow(row) {
  return teamFromRow(row);
}

function playerRow(row) {
  return playerFromRow(row);
}

function matchRow(row) {
  return matchFromRow(row);
}

function eventRow(row) {
  return eventFromRow(row);
}

/**
 * Read public.audit_chain_head() with the publishable key.
 *
 * Returns null on a project that predates roadmap D (404) and on any other
 * failure, so a chain problem never blocks the data backup; the warning is
 * printed so CI keeps the evidence.
 */
async function readChainHead(base) {
  try {
    const response = await fetch(`${base.url}/rest/v1/rpc/audit_chain_head`, {
      method: 'POST',
      headers: {
        apikey: base.key,
        Authorization: 'Bearer ' + base.key,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: '{}'
    });
    if (response.status === 404) {
      console.log('Audit chain: not installed on this project (roadmap D pending)');
      return null;
    }
    if (!response.ok) {
      console.warn(`Audit chain: head request failed (${response.status}); backup continues without it`);
      return null;
    }
    const head = await response.json();
    const shaped = head && Number.isInteger(head.count) &&
      (typeof head.head === 'string' || (head.head === null && head.count === 0));
    if (!shaped) {
      console.warn('Audit chain: head response did not match the expected shape; backup continues without it');
      return null;
    }
    return { ...head, readAt: new Date().toISOString() };
  } catch (error) {
    console.warn(`Audit chain: head request failed (${error.message}); backup continues without it`);
    return null;
  }
}

async function main() {
  const base = readConfig(envArg);
  console.log(`Reading ${envArg === 'dev' ? 'development' : 'production'} data from ${base.url}`);
  console.log(`Credentials: ${base.source}`);

  const [seasons, teams, players, stats, matches, events] = await Promise.all([
    getRows(base, 'seasons', 'created_at.desc,id.asc'),
    getRows(base, 'teams', 'name.asc,id.asc'),
    getRows(base, 'players', 'num.asc,id.asc'),
    getRows(base, 'v_player_stats', 'player_id.asc', { optional: true }),
    getRows(base, 'matches', 'round.asc,id.asc'),
    getRows(base, 'match_events', 'minute.asc,id.asc')
  ]);

  if (!seasons.length) fail('The export contains no seasons; refusing to write an empty backup.');
  if (!teams.length) fail('The export contains no teams; refusing to write an empty backup.');

  // After roadmap A stage 3 the totals only exist in v_player_stats, so merge
  // them onto the player rows before mapping to the backup format.
  const statsById = new Map(stats.map(row => [row.player_id, row]));
  const playersWithTotals = players.map(row => {
    const derived = statsById.get(row.id);
    if (!derived) return row;
    return { ...row, goals: derived.goals, yellow: derived.yellow, red: derived.red };
  });

  const payload = {
    seasons: seasons.map(seasonRow),
    teams: teams.map(teamRow),
    players: playersWithTotals.map(playerRow),
    matches: matches.map(matchRow),
    matchEvents: events.map(eventRow)
  };

  const auditChainHead = await readChainHead(base);
  if (auditChainHead) {
    payload.auditChainHead = auditChainHead;
    console.log(`Audit chain: ${auditChainHead.count} rows, last id ${auditChainHead.lastId}, ` +
      `head ${String(auditChainHead.head).slice(0, 16)}...`);
  }

  const json = JSON.stringify(payload, null, 2) + '\n';
  const outFile = path.resolve(
    outArg || path.join('backups', `${envArg === 'dev' ? 'dev' : 'prod'}-backup-${new Date().toISOString().slice(0, 10)}.json`)
  );
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, json, 'utf8');

  const hash = crypto.createHash('sha256').update(json).digest('hex');
  console.log(`Wrote ${outFile}`);
  console.log(`Counts: ${payload.seasons.length} seasons, ${payload.teams.length} teams, ` +
    `${payload.players.length} players, ${payload.matches.length} matches, ${payload.matchEvents.length} events`);
  console.log(`SHA-256 (file): ${hash}`);
}

module.exports = { readChainHead };

if (require.main === module) {
  main().catch(error => fail(error && error.message ? error.message : String(error)));
}
