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

(async () => {
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
})().catch(error => fail(error && error.message ? error.message : String(error)));
