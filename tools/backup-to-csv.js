#!/usr/bin/env node
/*
 * Convert a KickOff Division JSON backup into the five CSV files used by
 * tools/csv-to-backup.js.
 *
 * Usage:
 *   node tools/backup-to-csv.js backups/my-backup.json data
 *   node tools/backup-to-csv.js backups/my-backup.json data --force
 *
 * This is the reverse of csv-to-backup.js. It is useful when you want to
 * edit an existing league in a spreadsheet instead of typing every row into
 * the app. Existing CSV files are protected unless --force is supplied.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2).filter(arg => arg !== '--force');
const force = process.argv.includes('--force');
const inputFile = args[0] ? path.resolve(args[0]) : '';
const outputDir = path.resolve(args[1] || 'data');

function fail(message) {
  console.error('\nError: ' + message + '\n');
  process.exit(1);
}

if (!inputFile) {
  fail('Usage: node tools/backup-to-csv.js <backup.json> [output-dir] [--force]');
}
if (!fs.existsSync(inputFile)) {
  fail(`Backup not found: ${inputFile}`);
}

let data;
try {
  data = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
} catch (error) {
  fail(`Could not read JSON from ${inputFile}: ${error.message}`);
}

if (!data || typeof data !== 'object') fail('The backup must be a JSON object.');
if (!Array.isArray(data.teams)) fail('The backup has no "teams" array.');
if (!Array.isArray(data.matches)) fail('The backup has no "matches" array.');
if (!data.teams.length) fail('The backup has no teams.');

const sourcePlayers = Array.isArray(data.players) ? data.players : [];
if (data.matchEvents !== undefined && !Array.isArray(data.matchEvents)) {
  fail('matchEvents must be an array when present.');
}
const sourceEvents = Array.isArray(data.matchEvents) ? data.matchEvents : [];
let seasons = (Array.isArray(data.seasons) ? data.seasons : [])
  .filter(season => season && typeof season.id === 'string' && season.id);

// Match the app's normalizeState() behaviour for older backups.
const hadSeasons = seasons.length > 0;
if (!hadSeasons) {
  seasons = [{ id: 'season_1', name: 'Season 1', startDate: '', endDate: '', isActive: true }];
}

const activeSeason = seasons.find(season => season && season.isActive) || seasons[0];
if (!activeSeason || !activeSeason.id) fail('The backup has no usable season.');

seasons = seasons.map(season => ({
  id: season.id,
  name: typeof season.name === 'string' ? season.name : '',
  startDate: season.startDate || '',
  endDate: season.endDate || '',
  isActive: season.id === activeSeason.id
}));

const seasonIds = new Set();
for (const season of seasons) {
  if (!season.id) fail('Every season needs an id.');
  if (seasonIds.has(season.id)) fail(`Duplicate season id "${season.id}".`);
  seasonIds.add(season.id);
  if (!season.name.trim()) fail(`Season "${season.id}" has no name.`);
}

const teamIds = new Set();
const teams = data.teams.map(team => {
  if (!team || !team.id || !team.name) fail('Every team needs an id and a name.');
  if (teamIds.has(team.id)) fail(`Duplicate team id "${team.id}".`);
  teamIds.add(team.id);
  return {
    id: team.id,
    name: team.name,
    nameAr: team.nameAr || '',
    // Task I: the crest travels as a data URL; blank when the club has none.
    icon: typeof team.icon === 'string' ? team.icon : '',
    code: team.code || 'TBD',
    color: team.color || '#16a34a',
    divisionId: team.divisionId || 'd1'
  };
});
const teamById = new Map(teams.map(team => [team.id, team]));

const playerIds = new Set();
const players = sourcePlayers.map(player => {
  if (!player || !player.id || !player.name) fail('Every player needs an id and a name.');
  if (playerIds.has(player.id)) fail(`Duplicate player id "${player.id}".`);
  if (!teamIds.has(player.teamId)) fail(`Player "${player.id}" refers to missing team "${player.teamId}".`);
  playerIds.add(player.id);
  return {
    id: player.id,
    teamId: player.teamId,
    name: player.name,
    nameAr: player.nameAr || '',
    pos: player.pos || 'MID',
    num: player.num == null || player.num === '' ? 10 : player.num,
    goals: player.goals == null || player.goals === '' ? 0 : player.goals,
    yellow: player.yellow == null || player.yellow === '' ? 0 : player.yellow,
    red: player.red == null || player.red === '' ? 0 : player.red,
    isActive: player.isActive !== false,
    licenseId: player.licenseId || '',
    birthDate: player.birthDate || ''
  };
});

const matchIds = new Set();
const matches = data.matches.map(match => {
  if (!match || !match.id) fail('Every match needs an id.');
  if (matchIds.has(match.id)) fail(`Duplicate match id "${match.id}".`);
  if (!teamIds.has(match.homeId)) fail(`Match "${match.id}" refers to missing home team "${match.homeId}".`);
  if (!teamIds.has(match.awayId)) fail(`Match "${match.id}" refers to missing away team "${match.awayId}".`);
  if (match.homeId === match.awayId) fail(`Match "${match.id}" has the same home and away team.`);

  const seasonId = hadSeasons && match.seasonId ? match.seasonId : activeSeason.id;
  if (!seasonIds.has(seasonId)) fail(`Match "${match.id}" refers to missing season "${seasonId}".`);

  // A fixture keeps the division it was played in, so it may differ from its
  // clubs' current division after a between-season move. Only when the backup
  // predates divisions do we need to infer it, and then both clubs must agree.
  let divisionId = match.divisionId;
  if (!divisionId) {
    const homeDivision = teamById.get(match.homeId).divisionId;
    const awayDivision = teamById.get(match.awayId).divisionId;
    if (homeDivision !== awayDivision) {
      fail(`Match "${match.id}" has no divisionId and its clubs are now in different divisions (${homeDivision} vs ${awayDivision}).`);
    }
    divisionId = homeDivision;
  }

  matchIds.add(match.id);
  return {
    id: match.id,
    seasonId,
    divisionId,
    round: match.round == null || match.round === '' ? 1 : match.round,
    homeId: match.homeId,
    awayId: match.awayId,
    homeScore: match.homeScore == null || match.homeScore === '' ? 0 : match.homeScore,
    awayScore: match.awayScore == null || match.awayScore === '' ? 0 : match.awayScore,
    status: match.status || 'SCHEDULED',
    datetime: match.datetime || '',
    venue: match.venue || '',
    scorersText: match.scorersText || '',
    eventsCounted: match.eventsCounted !== false
  };
});

const playerById = new Map(players.map(player => [player.id, player]));
const matchById = new Map(matches.map(match => [match.id, match]));
const eventIds = new Set();
const events = sourceEvents.map(event => {
  if (!event || !event.id) fail('Every match event needs an id.');
  if (eventIds.has(event.id)) fail(`Duplicate match event id "${event.id}".`);
  eventIds.add(event.id);

  const match = matchById.get(event.matchId);
  if (!match) fail(`Match event "${event.id}" refers to missing match "${event.matchId}".`);

  const player = playerById.get(event.playerId);
  if (!player) fail(`Match event "${event.id}" refers to missing player "${event.playerId}".`);
  if (!event.teamId || (event.teamId !== match.homeId && event.teamId !== match.awayId)) {
    fail(`Match event "${event.id}" has a team that is not playing in its match.`);
  }
  if (player.teamId !== event.teamId) {
    fail(`Match event "${event.id}" has a player from a different team.`);
  }
  if (!['goal', 'yellow', 'red'].includes(event.type)) {
    fail(`Match event "${event.id}" has an invalid type.`);
  }
  if (!Number.isInteger(Number(event.minute)) || Number(event.minute) < 1 || Number(event.minute) > 130) {
    fail(`Match event "${event.id}" needs a minute between 1 and 130.`);
  }

  return {
    id: event.id,
    matchId: event.matchId,
    teamId: event.teamId,
    playerId: event.playerId,
    type: event.type,
    minute: Number(event.minute)
  };
});

const files = [
  {
    name: 'seasons.csv',
    headers: ['id', 'name', 'startDate', 'endDate', 'isActive'],
    rows: seasons.map(season => ({
      id: season.id,
      name: season.name,
      startDate: season.startDate,
      endDate: season.endDate,
      isActive: season.isActive ? 'true' : 'false'
    }))
  },
  {
    name: 'teams.csv',
    headers: ['id', 'name', 'nameAr', 'icon', 'code', 'color', 'divisionId'],
    rows: teams
  },
  {
    name: 'players.csv',
    headers: ['id', 'teamId', 'name', 'nameAr', 'pos', 'num', 'goals', 'yellow', 'red', 'isActive', 'licenseId', 'birthDate'],
    rows: players.map(player => ({ ...player, isActive: player.isActive ? 'true' : 'false' }))
  },
  {
    name: 'matches.csv',
    headers: ['id', 'seasonId', 'divisionId', 'round', 'homeId', 'awayId', 'homeScore', 'awayScore', 'status', 'datetime', 'venue', 'scorersText', 'eventsCounted'],
    rows: matches
  },
  {
    name: 'events.csv',
    headers: ['id', 'matchId', 'teamId', 'playerId', 'type', 'minute'],
    rows: events
  }
];

if (!force) {
  const existing = files
    .map(file => path.join(outputDir, file.name))
    .filter(file => fs.existsSync(file));
  if (existing.length) {
    fail('Refusing to overwrite existing file(s):\n  ' + existing.join('\n  ') +
      '\nMove them or add --force to overwrite.');
  }
}

function csvCell(value) {
  let text = String(value == null ? '' : value);
  // Prevent spreadsheet formula execution for text cells. Numeric values stay numeric.
  if (typeof value === 'string' && /^[=+\-@\t\r\n]/.test(text)) {
    text = "'" + text;
  }
  return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

fs.mkdirSync(outputDir, { recursive: true });
for (const file of files) {
  const lines = [file.headers.join(',')];
  for (const row of file.rows) {
    lines.push(file.headers.map(header => csvCell(row[header])).join(','));
  }
  fs.writeFileSync(path.join(outputDir, file.name), '\uFEFF' + lines.join('\r\n') + '\r\n');
}

console.log('CSV files written to:\n  ' + outputDir + '\n');
console.log(`  ${seasons.length} season(s), ${teams.length} team(s), ${players.length} player(s), ${matches.length} match(es), ${events.length} event(s)`);
console.log(`  Active season: ${activeSeason.name}`);
console.log('\nNext: edit the CSV files, then run node tools/csv-to-backup.js and import the generated JSON.\n');
