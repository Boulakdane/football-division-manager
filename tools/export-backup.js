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

const args = process.argv.slice(2);
const envArg = (args.find(a => a.startsWith('--env=')) || '--env=prod').split('=')[1];
const outArg = (args.find(a => a.startsWith('--out=')) || '').slice('--out='.length);


async function getRows(base, table, order) {
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
  return {
    id: row.id,
    name: row.name,
    startDate: row.start_date || '',
    endDate: row.end_date || '',
    isActive: Boolean(row.is_active)
  };
}

function teamRow(row) {
  return { id: row.id, name: row.name, code: row.code, color: row.color };
}

function playerRow(row) {
  return {
    id: row.id,
    teamId: row.team_id,
    name: row.name,
    pos: row.pos,
    num: row.num,
    goals: row.goals,
    yellow: row.yellow,
    red: row.red,
    isActive: row.is_active !== false
  };
}

function matchRow(row) {
  return {
    id: row.id,
    seasonId: row.season_id,
    round: row.round,
    homeId: row.home_id,
    awayId: row.away_id,
    homeScore: row.home_score,
    awayScore: row.away_score,
    status: row.status,
    datetime: row.datetime || '',
    venue: row.venue || '',
    scorersText: row.scorers_text || '',
    eventsCounted: row.events_counted !== false
  };
}

function eventRow(row) {
  return {
    id: row.id,
    matchId: row.match_id,
    teamId: row.team_id,
    playerId: row.player_id,
    type: row.event_type,
    minute: row.minute
  };
}

(async () => {
  const base = readConfig(envArg);
  console.log(`Reading ${envArg === 'dev' ? 'development' : 'production'} data from ${base.url}`);
  console.log(`Credentials: ${base.source}`);

  const [seasons, teams, players, matches, events] = await Promise.all([
    getRows(base, 'seasons', 'created_at.desc,id.asc'),
    getRows(base, 'teams', 'name.asc,id.asc'),
    getRows(base, 'players', 'num.asc,id.asc'),
    getRows(base, 'matches', 'round.asc,id.asc'),
    getRows(base, 'match_events', 'minute.asc,id.asc')
  ]);

  if (!seasons.length) fail('The export contains no seasons; refusing to write an empty backup.');
  if (!teams.length) fail('The export contains no teams; refusing to write an empty backup.');

  const payload = {
    seasons: seasons.map(seasonRow),
    teams: teams.map(teamRow),
    players: players.map(playerRow),
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
