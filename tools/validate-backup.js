#!/usr/bin/env node
/*
 * Validate a KickOff Division JSON backup before trusting it for a restore.
 *
 * Usage:
 *   node tools/validate-backup.js backups/prod-backup-2026-10-24.json
 *
 * Exits non-zero on structural or referential errors. This is the CI-safe
 * half of a restore drill: it proves the artifact can be read and that every
 * foreign key in the payload points at a row that exists.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const file = path.resolve(process.argv[2] || '');
if (!process.argv[2]) {
  console.error('Usage: node tools/validate-backup.js <backup.json>');
  process.exit(1);
}
if (!fs.existsSync(file)) {
  console.error(`Backup not found: ${file}`);
  process.exit(1);
}

let data;
try {
  data = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch (error) {
  console.error(`Could not parse ${file}: ${error.message}`);
  process.exit(1);
}

const errors = [];

function arrayOf(name) {
  if (!Array.isArray(data[name])) {
    errors.push(`"${name}" must be an array`);
    return [];
  }
  return data[name];
}

function optionalArrayOf(name) {
  if (data[name] === undefined) return [];
  return arrayOf(name);
}

function indexById(rows, name) {
  const map = new Map();
  for (const row of rows) {
    if (!row || typeof row.id !== 'string' || !row.id.trim()) {
      errors.push(`${name}: every row needs a non-empty string id`);
      continue;
    }
    if (map.has(row.id)) errors.push(`${name}: duplicate id "${row.id}"`);
    map.set(row.id, row);
  }
  return map;
}

function isNonNegativeInt(value) {
  return Number.isInteger(value) && value >= 0;
}

const seasons = arrayOf('seasons');
const teams = arrayOf('teams');
const players = arrayOf('players');
const matches = arrayOf('matches');
const events = optionalArrayOf('matchEvents');

const seasonById = indexById(seasons, 'seasons');
const teamById = indexById(teams, 'teams');
const playerById = indexById(players, 'players');
const matchById = indexById(matches, 'matches');

if (!seasons.length) errors.push('A backup needs at least one season');
if (!teams.length) errors.push('A backup needs at least one team');

const activeSeasons = seasons.filter(season => season && season.isActive === true);
if (activeSeasons.length !== 1) {
  errors.push(`Exactly one season must be active (found ${activeSeasons.length})`);
}

for (const season of seasons) {
  if (!season || typeof season.name !== 'string' || !season.name.trim()) {
    errors.push(`seasons: ${season && season.id} has an empty name`);
  }
}

for (const team of teams) {
  if (!team || typeof team.name !== 'string' || !team.name.trim()) {
    errors.push(`teams: ${team && team.id} has an empty name`);
  }
}

for (const player of players) {
  if (!player) continue;
  if (!teamById.has(player.teamId)) {
    errors.push(`players: ${player.id} points at missing team "${player.teamId}"`);
  }
  if (!['GK', 'DEF', 'MID', 'FWD'].includes(player.pos)) {
    errors.push(`players: ${player.id} has invalid position "${player.pos}"`);
  }
  for (const key of ['num', 'goals', 'yellow', 'red']) {
    if (!isNonNegativeInt(player[key])) {
      errors.push(`players: ${player.id} has invalid ${key} "${player[key]}"`);
    }
  }
  if (player.isActive !== undefined && typeof player.isActive !== 'boolean') {
    errors.push(`players: ${player.id} has a non-boolean isActive`);
  }
}

const seenFixtures = new Set();
for (const match of matches) {
  if (!match) continue;
  if (!seasonById.has(match.seasonId)) {
    errors.push(`matches: ${match.id} points at missing season "${match.seasonId}"`);
  }
  if (!teamById.has(match.homeId) || !teamById.has(match.awayId)) {
    errors.push(`matches: ${match.id} points at a missing team`);
  }
  if (match.homeId === match.awayId) {
    errors.push(`matches: ${match.id} has the same home and away team`);
  }
  if (!isNonNegativeInt(match.round) || match.round < 1) {
    errors.push(`matches: ${match.id} has an invalid round "${match.round}"`);
  }
  if (!isNonNegativeInt(match.homeScore) || !isNonNegativeInt(match.awayScore)) {
    errors.push(`matches: ${match.id} has an invalid score`);
  }
  if (!['SCHEDULED', 'LIVE', 'FINISHED'].includes(match.status)) {
    errors.push(`matches: ${match.id} has invalid status "${match.status}"`);
  }
  if (match.eventsCounted !== undefined && typeof match.eventsCounted !== 'boolean') {
    errors.push(`matches: ${match.id} has a non-boolean eventsCounted`);
  }

  const fixtureKey = [match.seasonId, match.round, [match.homeId, match.awayId].sort().join('|')].join(':');
  if (seenFixtures.has(fixtureKey)) {
    errors.push(`matches: duplicate fixture in season ${match.seasonId}, round ${match.round}: ` +
      `${match.homeId} vs ${match.awayId}`);
  }
  seenFixtures.add(fixtureKey);
}

for (const event of events) {
  if (!event) continue;
  const match = matchById.get(event.matchId);
  const team = teamById.get(event.teamId);
  const player = playerById.get(event.playerId);

  if (!match) errors.push(`matchEvents: ${event.id} points at missing match "${event.matchId}"`);
  if (!team) errors.push(`matchEvents: ${event.id} points at missing team "${event.teamId}"`);
  if (!player) errors.push(`matchEvents: ${event.id} points at missing player "${event.playerId}"`);
  if (player && player.teamId !== event.teamId) {
    errors.push(`matchEvents: ${event.id} player ${event.playerId} does not belong to team ${event.teamId}`);
  }
  if (match && event.teamId !== match.homeId && event.teamId !== match.awayId) {
    errors.push(`matchEvents: ${event.id} team ${event.teamId} is not playing in match ${event.matchId}`);
  }
  if (!['goal', 'yellow', 'red'].includes(event.type)) {
    errors.push(`matchEvents: ${event.id} has invalid type "${event.type}"`);
  }
  if (!Number.isInteger(event.minute) || event.minute < 1 || event.minute > 130) {
    errors.push(`matchEvents: ${event.id} has invalid minute "${event.minute}"`);
  }
}

const counts = {
  seasons: seasons.length,
  teams: teams.length,
  players: players.length,
  matches: matches.length,
  events: events.length
};

console.log(`Validated ${file}`);
console.log(`Counts: ${counts.seasons} seasons, ${counts.teams} teams, ${counts.players} players, ` +
  `${counts.matches} matches, ${counts.events} events`);

if (errors.length) {
  console.error(`\n${errors.length} error(s):`);
  for (const error of errors.slice(0, 25)) console.error('  - ' + error);
  if (errors.length > 25) console.error(`  ... and ${errors.length - 25} more`);
  process.exit(1);
}

console.log('Backup is structurally valid and every reference resolves.');
