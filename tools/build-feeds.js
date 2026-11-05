'use strict';

/*
 * Build the hosted calendar subscriptions (plan section 22.8, stage 2).
 *
 * GitHub Pages serves this repository from its root, so the feeds are plain
 * .ics files committed under feeds/ and refreshed by .github/workflows/feeds.yml.
 * That keeps the zero-server promise: no Edge Function, no new origin and no
 * secret beyond the publishable key that already ships in js/config.js.
 *
 * The browser export in js/app.js and this generator share js/domain/ics.js, so
 * a downloaded file and a subscription use the same UID and the same event
 * shape. DTSTAMP is derived from the data (the latest fixture date), not from
 * the clock, so re-running the job on unchanged data produces byte-identical
 * files and the workflow does not commit noise.
 */

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const { root, readConfig } = require('./supabase-config');

const DEFAULT_OUT = path.join(root, 'feeds');
const PAGE_SIZE = 1000;
const UID_DOMAIN = 'mzab-league.github.io';

const STATUS_LABELS = {
  SCHEDULED: 'Scheduled',
  LIVE: 'Live',
  FINISHED: 'Finished',
  POSTPONED: 'Postponed',
  CANCELLED: 'Cancelled'
};

function parseArgs(argv) {
  const options = { env: 'prod', out: DEFAULT_OUT, from: null, check: false };
  for (const arg of argv) {
    if (arg === '--check') options.check = true;
    else if (arg.startsWith('--env=')) options.env = arg.slice(6) === 'dev' ? 'dev' : 'prod';
    else if (arg.startsWith('--out=')) options.out = path.resolve(arg.slice(6));
    else if (arg.startsWith('--from=')) options.from = path.resolve(arg.slice(7));
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node tools/build-feeds.js [--env=prod|dev] [--out=feeds] [--from=backup.json] [--check]');
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    }
  }
  return options;
}

/** Accept both the camelCase backup shape and snake_case PostgREST rows. */
function normalizeData(raw) {
  const data = raw && typeof raw === 'object' ? raw : {};
  const rows = value => (Array.isArray(value) ? value : []);

  return {
    seasons: rows(data.seasons).map(row => ({
      id: row.id,
      name: row.name || row.id,
      startDate: row.startDate || row.start_date || '',
      isActive: row.isActive !== undefined ? Boolean(row.isActive) : Boolean(row.is_active),
      deletedAt: row.deletedAt || row.deleted_at || null
    })),
    divisions: rows(data.divisions).map(row => ({
      id: row.id,
      name: row.name || row.id,
      sortOrder: Number(row.sortOrder !== undefined ? row.sortOrder : row.sort_order) || 0
    })),
    teams: rows(data.teams).map(row => ({
      id: row.id,
      name: row.name || row.id,
      nameAr: row.nameAr || row.name_ar || null,
      divisionId: row.divisionId || row.division_id || 'd1',
      deletedAt: row.deletedAt || row.deleted_at || null
    })),
    matches: rows(data.matches).map(row => ({
      id: row.id,
      seasonId: row.seasonId || row.season_id || null,
      divisionId: row.divisionId || row.division_id || 'd1',
      round: Number(row.round) || 0,
      homeId: row.homeId || row.home_id,
      awayId: row.awayId || row.away_id,
      homeScore: row.homeScore !== undefined ? row.homeScore : row.home_score,
      awayScore: row.awayScore !== undefined ? row.awayScore : row.away_score,
      status: row.status || 'SCHEDULED',
      datetime: row.datetime || '',
      venue: row.venue || '',
      deletedAt: row.deletedAt || row.deleted_at || null
    }))
  };
}

async function fetchRows(config, table, query) {
  const rows = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const url = `${config.url}/rest/v1/${table}?select=${query}&order=id.asc&limit=${PAGE_SIZE}&offset=${offset}`;
    const response = await fetch(url, {
      headers: {
        apikey: config.key,
        Authorization: `Bearer ${config.key}`,
        Accept: 'application/json'
      }
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`${table}: HTTP ${response.status} ${body.slice(0, 200)}`);
    }
    const page = await response.json();
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return rows;
}

async function fetchData(env) {
  const config = readConfig(env);
  const [seasons, divisions, teams, matches] = await Promise.all([
    fetchRows(config, 'seasons', 'id,name,start_date,is_active,deleted_at'),
    fetchRows(config, 'divisions', 'id,name,sort_order'),
    fetchRows(config, 'teams', 'id,name,name_ar,division_id,deleted_at'),
    fetchRows(config, 'matches', 'id,season_id,division_id,round,home_id,away_id,home_score,away_score,status,datetime,venue,deleted_at')
  ]);
  return normalizeData({ seasons, divisions, teams, matches });
}

/** The latest fixture date, or the season start, as a fixed UTC DTSTAMP. */
function feedStamp(matches, season) {
  const dates = matches
    .map(match => String(match.datetime || '').slice(0, 10))
    .filter(value => /^\d{4}-\d{2}-\d{2}$/.test(value))
    .sort();
  const latest = dates.length
    ? dates[dates.length - 1]
    : (season && season.startDate) || '2026-01-01';
  return `${latest}T00:00:00Z`;
}

function teamName(teams, id) {
  const team = teams.get(id);
  return team ? team.name : String(id || '');
}

function divisionLabel(divisions, id) {
  const division = divisions.get(id);
  if (division && division.name) return division.name;
  return String(id || 'D1').toUpperCase();
}

function statusLabel(status) {
  return STATUS_LABELS[status] || String(status || 'Scheduled');
}

function eventForMatch(match, context) {
  const { teams, divisions, season } = context;
  const home = teamName(teams, match.homeId);
  const away = teamName(teams, match.awayId);
  const finished = match.status === 'FINISHED' &&
    match.homeScore !== null && match.homeScore !== undefined &&
    match.awayScore !== null && match.awayScore !== undefined;
  const summary = finished
    ? `${home} ${Number(match.homeScore)}–${Number(match.awayScore)} ${away}`
    : `${home} vs ${away}`;
  const description = [
    match.round ? `R${match.round}` : '',
    divisionLabel(divisions, match.divisionId),
    season && season.name ? season.name : '',
    match.venue ? `Venue: ${match.venue}` : '',
    statusLabel(match.status)
  ].filter(Boolean).join(' · ');

  return {
    uid: `match-${match.id}@${UID_DOMAIN}`,
    start: match.datetime || '',
    summary,
    description,
    location: match.venue || ''
  };
}

/**
 * Build every feed in memory.
 * @returns {{ files: Map<string, string>, manifest: object }}
 */
function buildFeeds(data, options) {
  const config = options || {};
  const calendarBuilder = config.buildCalendar;
  if (typeof calendarBuilder !== 'function') {
    throw new Error('buildFeeds needs a buildCalendar function (pass options.buildCalendar)');
  }
  const season = data.seasons.find(item => item.isActive && !item.deletedAt) ||
    data.seasons.find(item => !item.deletedAt) ||
    null;
  const seasonId = season ? season.id : null;
  const activeMatches = data.matches.filter(match =>
    !match.deletedAt && (!seasonId || match.seasonId === seasonId)
  );
  const teams = new Map(data.teams.filter(team => !team.deletedAt).map(team => [team.id, team]));
  const divisions = new Map(data.divisions.map(division => [division.id, division]));
  const stamp = feedStamp(activeMatches, season);
  const context = { teams, divisions, season };
  const seasonName = season && season.name ? season.name : 'BSGST';
  const files = new Map();
  const manifestFeeds = [];

  const addFeed = (id, filename, name, matches) => {
    const events = matches.map(match => eventForMatch(match, context));
    const calendar = calendarBuilder({
      name,
      description: `${seasonName} — hosted calendar subscription`,
      events,
      now: stamp
    });
    files.set(filename, calendar.text);
    manifestFeeds.push({
      id,
      file: filename,
      name,
      events: calendar.written,
      skipped: calendar.skipped
    });
  };

  addFeed('all', 'all.ics', `${seasonName} — BSGST`, activeMatches);

  const divisionIds = [...new Set([
    ...data.divisions.map(division => division.id),
    ...activeMatches.map(match => match.divisionId)
  ])].sort();
  for (const divisionId of divisionIds) {
    const matches = activeMatches.filter(match => match.divisionId === divisionId);
    addFeed(
      `division-${divisionId}`,
      `division-${encodeURIComponent(divisionId)}.ics`,
      `${seasonName} — ${divisionLabel(divisions, divisionId)}`,
      matches
    );
  }

  const teamIds = [...new Set([
    ...teams.keys(),
    ...activeMatches.flatMap(match => [match.homeId, match.awayId])
  ])].sort();
  for (const teamId of teamIds) {
    const team = teams.get(teamId);
    const matches = activeMatches.filter(match => match.homeId === teamId || match.awayId === teamId);
    addFeed(
      `team-${teamId}`,
      `team-${encodeURIComponent(teamId)}.ics`,
      `${team ? team.name : teamId} — ${seasonName}`,
      matches
    );
  }

  const manifest = {
    season: seasonId,
    seasonName,
    stamp,
    feeds: manifestFeeds
  };
  files.set('index.json', JSON.stringify(manifest, null, 2) + '\n');
  return { files, manifest };
}

function writeFeeds(outDir, files, check) {
  const existing = fs.existsSync(outDir)
    ? fs.readdirSync(outDir).filter(name => name.endsWith('.ics') || name === 'index.json')
    : [];
  const stale = existing.filter(name => !files.has(name)).sort();
  const changed = [];
  let events = 0;
  let skipped = 0;

  for (const [name, text] of files) {
    const target = path.join(outDir, name);
    const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
    if (current !== text) changed.push(name);
  }

  if (!check) {
    fs.mkdirSync(outDir, { recursive: true });
    for (const [name, text] of files) {
      fs.writeFileSync(path.join(outDir, name), text, 'utf8');
    }
    for (const name of stale) fs.rmSync(path.join(outDir, name), { force: true });
  }

  const manifest = JSON.parse(files.get('index.json'));
  for (const feed of manifest.feeds) {
    events += feed.events;
    skipped += feed.skipped;
  }

  return { changed, stale, events, skipped, manifest };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const ics = await import(pathToFileURL(path.join(root, 'js', 'domain', 'ics.js')).href);

  const data = options.from
    ? normalizeData(JSON.parse(fs.readFileSync(options.from, 'utf8')))
    : await fetchData(options.env);

  const result = buildFeeds(data, { ...options, buildCalendar: ics.buildCalendar });
  const report = writeFeeds(options.out, result.files, options.check);
  const changed = report.changed.length + report.stale.length;

  if (options.check) {
    if (changed) {
      console.error(`Feeds are stale: ${report.changed.join(', ') || 'no changes'}` +
        (report.stale.length ? ` (stale: ${report.stale.join(', ')})` : ''));
      process.exit(1);
    }
    console.log(`Feeds are current (${result.files.size} files, ${report.events} events).`);
    return;
  }

  console.log(`Built ${result.files.size} feed files from ${options.from ? options.from : options.env}: ` +
    `${report.events} events, ${report.skipped} skipped, ${changed} changed.`);
  if (report.changed.length) console.log(`  changed: ${report.changed.join(', ')}`);
  if (report.stale.length) console.log(`  removed: ${report.stale.join(', ')}`);
}

// buildCalendar is injected by main() or by the test; buildFeeds stays pure.

module.exports = {
  normalizeData,
  buildFeeds,
  writeFeeds,
  feedStamp,
  eventForMatch
};

if (require.main === module) {
  main().catch(error => {
    console.error(`\nError: ${error.message}\n`);
    process.exit(1);
  });
}
