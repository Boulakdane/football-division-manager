#!/usr/bin/env node
/*
 * Convert the CSV files in data/ into a KickOff Division JSON backup.
 *
 * Usage:
 *   node tools/csv-to-backup.js
 *   node tools/csv-to-backup.js data backups/my-import.json
 *
 * Copy the files from data/examples/ into data/ first, then edit them.
 * The generated JSON can be imported from Settings -> Import Backup (JSON).
 */

'use strict';

const fs = require('fs');
const path = require('path');

const inputDir = path.resolve(process.argv[2] || 'data');
const outputFile = path.resolve(
  process.argv[3] || path.join('backups', `kickoff-import-${new Date().toISOString().slice(0, 10)}.json`)
);

function fail(message) {
  console.error('\nError: ' + message + '\n');
  process.exit(1);
}

function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char === '\r') {
      if (text[i + 1] !== '\n') {
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
      }
    } else {
      field += char;
    }
  }

  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter(cells => cells.some(cell => String(cell).trim() !== ''));
}

/** Undo the apostrophe prefix added by the CSV exporters. */
function unescapeFormula(value) {
  const text = String(value == null ? '' : value);
  return /^'[=+\-@\t\r\n]/.test(text) ? text.slice(1) : text;
}

function readTable(fileName, requiredHeaders, allowEmpty, optional) {
  const file = path.join(inputDir, fileName);
  if (!fs.existsSync(file)) {
    if (optional) return [];
    fail(`Missing ${file}. Copy data/examples/${fileName} to data/${fileName} first.`);
  }

  const rows = parseCsv(fs.readFileSync(file, 'utf8'));
  if (!rows.length) {
    if (optional) return [];
    fail(`${fileName} is empty.`);
  }

  const header = rows[0].map(value => value.trim());
  const missing = requiredHeaders.filter(name => !header.includes(name));
  if (missing.length) {
    fail(`${fileName} is missing column(s): ${missing.join(', ')}`);
  }

  const records = rows.slice(1).map((cells, index) => {
    const record = {};
    header.forEach((name, column) => {
      record[name] = unescapeFormula(String(cells[column] == null ? '' : cells[column]).trim());
    });
    record.__line = index + 2;
    return record;
  });

  if (!records.length && !allowEmpty) fail(`${fileName} has no data rows.`);
  return records;
}

function required(record, field, fileName) {
  const value = record[field];
  if (!value) fail(`${fileName}:${record.__line} — "${field}" is required.`);
  return value;
}

function integer(record, field, fileName, min, fallback) {
  const raw = record[field];
  if (!raw) {
    if (fallback !== undefined) return fallback;
    fail(`${fileName}:${record.__line} — "${field}" is required.`);
  }
  if (!/^-?\d+$/.test(raw)) {
    fail(`${fileName}:${record.__line} — "${field}" must be a whole number.`);
  }
  const value = Number(raw);
  if (value < min) fail(`${fileName}:${record.__line} — "${field}" must be at least ${min}.`);
  return value;
}

function bool(record, field, fileName) {
  const value = record[field].toLowerCase();
  if (['true', '1', 'yes', 'y', 'active'].includes(value)) return true;
  if (['false', '0', 'no', 'n', 'archived'].includes(value)) return false;
  fail(`${fileName}:${record.__line} — "${field}" must be true or false.`);
}

function checkDate(value, field, fileName, record) {
  if (!value) return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    fail(`${fileName}:${record.__line} — "${field}" must use YYYY-MM-DD.`);
  }
  const date = new Date(value + 'T00:00:00Z');
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    fail(`${fileName}:${record.__line} — "${field}" is not a valid date.`);
  }
  return value;
}

function checkDateTime(value, fileName, record) {
  if (!value) return '';
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value)) {
    fail(`${fileName}:${record.__line} — "datetime" must use YYYY-MM-DDTHH:MM.`);
  }
  const datePart = value.slice(0, 10);
  const date = new Date(datePart + 'T00:00:00Z');
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== datePart) {
    fail(`${fileName}:${record.__line} — "datetime" contains an invalid date.`);
  }
  const [hours, minutes, seconds = 0] = value.slice(11).split(':').map(Number);
  if (hours > 23 || minutes > 59 || seconds > 59) {
    fail(`${fileName}:${record.__line} — "datetime" contains an invalid time.`);
  }
  return value;
}

function unique(set, value, label, fileName, record) {
  if (set.has(value)) fail(`${fileName}:${record.__line} - duplicate ${label} "${value}".`);
  set.add(value);
}

function optionalBoolean(record, field, fileName, fallback) {
  const raw = record[field];
  if (raw === undefined || raw === '') return fallback;
  const value = String(raw).toLowerCase();
  if (value === 'true') return true;
  if (value === 'false') return false;
  fail(`${fileName}:${record.__line} - "${field}" must be true or false.`);
}

/** Optional division column: older CSVs default to Division 1. */
function checkDivision(record, fileName, fallback) {
  const raw = record.divisionId;
  if (raw === undefined || raw === '') return fallback;
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(raw)) {
    fail(`${fileName}:${record.__line} - "divisionId" must be a simple id such as d1.`);
  }
  return raw;
}

/** Optional free text with a database length cap. Empty cells become null. */
function optionalText(record, field, fileName, maxLength) {
  const raw = record[field];
  if (raw === undefined || raw === '') return null;
  if (maxLength && raw.length > maxLength) {
    fail(`${fileName}:${record.__line} - "${field}" must be ${maxLength} characters or fewer.`);
  }
  return raw;
}

/** Optional birth date: YYYY-MM-DD between 1900-01-01 and 2100-12-31. */
function checkBirthDate(record, fileName) {
  const value = checkDate(record.birthDate, 'birthDate', fileName, record);
  if (!value) return null;
  if (value < '1900-01-01' || value > '2100-12-31') {
    fail(`${fileName}:${record.__line} - "birthDate" must be between 1900-01-01 and 2100-12-31.`);
  }
  return value;
}

// ---------------------------------------------------------------------------

const seasonRows = readTable(
  'seasons.csv',
  ['id', 'name', 'startDate', 'endDate', 'isActive'],
  false
);
const teamRows = readTable('teams.csv', ['id', 'name', 'code', 'color'], false);
const playerRows = readTable(
  'players.csv',
  ['id', 'teamId', 'name', 'pos', 'num', 'goals', 'yellow', 'red'],
  true
);
const matchRows = readTable(
  'matches.csv',
  ['id', 'seasonId', 'round', 'homeId', 'awayId', 'homeScore', 'awayScore', 'status', 'datetime', 'venue', 'scorersText'],
  true
);
const eventRows = readTable(
  'events.csv',
  ['id', 'matchId', 'teamId', 'playerId', 'type', 'minute'],
  true,
  true
);

const seasonIds = new Set();
const seasons = seasonRows.map(record => {
  const id = required(record, 'id', 'seasons.csv');
  unique(seasonIds, id, 'season id', 'seasons.csv', record);
  const name = required(record, 'name', 'seasons.csv');
  const startDate = checkDate(record.startDate, 'startDate', 'seasons.csv', record);
  const endDate = checkDate(record.endDate, 'endDate', 'seasons.csv', record);
  if (startDate && endDate && endDate < startDate) {
    fail(`seasons.csv:${record.__line} — endDate must be on or after startDate.`);
  }
  return { id, name, startDate, endDate, isActive: bool(record, 'isActive', 'seasons.csv') };
});

const activeSeasons = seasons.filter(season => season.isActive);
if (activeSeasons.length !== 1) {
  fail(`Exactly one season must have isActive=true (found ${activeSeasons.length}).`);
}

const teamIds = new Set();
const teams = teamRows.map(record => {
  const id = required(record, 'id', 'teams.csv');
  unique(teamIds, id, 'team id', 'teams.csv', record);
  const name = required(record, 'name', 'teams.csv');
  const code = required(record, 'code', 'teams.csv');
  const color = required(record, 'color', 'teams.csv');
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) {
    fail(`teams.csv:${record.__line} — color must be a hex value such as #3b82f6.`);
  }
  return {
    id,
    name,
    nameAr: optionalText(record, 'nameAr', 'teams.csv', 100),
    code,
    color: color.toLowerCase(),
    divisionId: checkDivision(record, 'teams.csv', 'd1')
  };
});
const teamById = new Map(teams.map(team => [team.id, team]));

const playerIds = new Set();
const licenseIds = new Set();
const players = playerRows.map(record => {
  const id = required(record, 'id', 'players.csv');
  unique(playerIds, id, 'player id', 'players.csv', record);
  const teamId = required(record, 'teamId', 'players.csv');
  if (!teamIds.has(teamId)) {
    fail(`players.csv:${record.__line} — teamId "${teamId}" does not exist in teams.csv.`);
  }
  const pos = required(record, 'pos', 'players.csv').toUpperCase();
  if (!['GK', 'DEF', 'MID', 'FWD'].includes(pos)) {
    fail(`players.csv:${record.__line} — pos must be GK, DEF, MID or FWD.`);
  }
  const licenseId = optionalText(record, 'licenseId', 'players.csv', 50);
  if (licenseId) unique(licenseIds, licenseId.toUpperCase(), 'licence number', 'players.csv', record);
  return {
    id,
    teamId,
    name: required(record, 'name', 'players.csv'),
    nameAr: optionalText(record, 'nameAr', 'players.csv', 100),
    pos,
    num: integer(record, 'num', 'players.csv', 1),
    goals: integer(record, 'goals', 'players.csv', 0, 0),
    yellow: integer(record, 'yellow', 'players.csv', 0, 0),
    red: integer(record, 'red', 'players.csv', 0, 0),
    isActive: record.isActive === undefined || record.isActive === ''
      ? true
      : bool(record, 'isActive', 'players.csv'),
    licenseId,
    birthDate: checkBirthDate(record, 'players.csv')
  };
});

const matchIds = new Set();
const matches = matchRows.map(record => {
  const id = required(record, 'id', 'matches.csv');
  unique(matchIds, id, 'match id', 'matches.csv', record);
  const seasonId = required(record, 'seasonId', 'matches.csv');
  if (!seasonIds.has(seasonId)) {
    fail(`matches.csv:${record.__line} — seasonId "${seasonId}" does not exist in seasons.csv.`);
  }
  const homeId = required(record, 'homeId', 'matches.csv');
  const awayId = required(record, 'awayId', 'matches.csv');
  if (!teamIds.has(homeId)) {
    fail(`matches.csv:${record.__line} — homeId "${homeId}" does not exist in teams.csv.`);
  }
  if (!teamIds.has(awayId)) {
    fail(`matches.csv:${record.__line} — awayId "${awayId}" does not exist in teams.csv.`);
  }
  if (homeId === awayId) {
    fail(`matches.csv:${record.__line} — homeId and awayId must be different.`);
  }
  // A fixture keeps the division it was played in. Older CSVs omit it; those
  // need the two clubs to still be registered together.
  let divisionId = checkDivision(record, 'matches.csv', '');
  if (!divisionId) {
    const homeDivision = teamById.get(homeId).divisionId;
    const awayDivision = teamById.get(awayId).divisionId;
    if (homeDivision !== awayDivision) {
      fail(`matches.csv:${record.__line} — divisionId is empty and the two clubs are now in different divisions (${homeDivision} vs ${awayDivision}).`);
    }
    divisionId = homeDivision;
  }
  const status = required(record, 'status', 'matches.csv').toUpperCase();
  if (!['SCHEDULED', 'LIVE', 'FINISHED'].includes(status)) {
    fail(`matches.csv:${record.__line} — status must be SCHEDULED, LIVE or FINISHED.`);
  }
  return {
    id,
    seasonId,
    divisionId,
    round: integer(record, 'round', 'matches.csv', 1),
    homeId,
    awayId,
    homeScore: integer(record, 'homeScore', 'matches.csv', 0, 0),
    awayScore: integer(record, 'awayScore', 'matches.csv', 0, 0),
    status,
    datetime: checkDateTime(record.datetime, 'matches.csv', record),
    venue: record.venue || '',
    scorersText: record.scorersText || '',
    eventsCounted: optionalBoolean(record, 'eventsCounted', 'matches.csv', true)
  };
});

const matchById = new Map(matches.map(match => [match.id, match]));
const playerById = new Map(players.map(player => [player.id, player]));

const eventIds = new Set();
const matchEvents = eventRows.map(record => {
  const id = required(record, 'id', 'events.csv');
  unique(eventIds, id, 'event id', 'events.csv', record);

  const matchId = required(record, 'matchId', 'events.csv');
  const match = matchById.get(matchId);
  if (!match) {
    fail(`events.csv:${record.__line} — matchId "${matchId}" does not exist in matches.csv.`);
  }

  const teamId = required(record, 'teamId', 'events.csv');
  if (teamId !== match.homeId && teamId !== match.awayId) {
    fail(`events.csv:${record.__line} — teamId "${teamId}" is not playing in match "${matchId}".`);
  }

  const playerId = required(record, 'playerId', 'events.csv');
  const player = playerById.get(playerId);
  if (!player) {
    fail(`events.csv:${record.__line} — playerId "${playerId}" does not exist in players.csv.`);
  }
  if (player.teamId !== teamId) {
    fail(`events.csv:${record.__line} — playerId "${playerId}" does not belong to team "${teamId}".`);
  }

  const type = required(record, 'type', 'events.csv').toLowerCase();
  if (!['goal', 'yellow', 'red'].includes(type)) {
    fail(`events.csv:${record.__line} — type must be goal, yellow or red.`);
  }

  const minute = integer(record, 'minute', 'events.csv', 1);
  if (minute > 130) {
    fail(`events.csv:${record.__line} — minute must be between 1 and 130.`);
  }

  return { id, matchId, teamId, playerId, type, minute };
});

const payload = { seasons, teams, players, matches, matchEvents };
fs.mkdirSync(path.dirname(outputFile), { recursive: true });
fs.writeFileSync(outputFile, JSON.stringify(payload, null, 2) + '\n');

console.log('CSV import file created:\n  ' + outputFile + '\n');
console.log(`  ${seasons.length} season(s), ${teams.length} team(s), ${players.length} player(s), ${matches.length} match(es), ${matchEvents.length} event(s)`);
console.log(`  Active season: ${activeSeasons[0].name}`);
console.log('\nNext: open the app as admin, then Settings -> Import Backup (JSON) and choose this file.\n');
