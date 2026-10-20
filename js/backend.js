/* ---------------------------------------------------------------
   KickOff Division — Supabase data layer
   Loads league data for everyone (public read) and exposes write
   helpers used by the admin UI. Authorization is enforced by
   Postgres Row Level Security, not by this file.
   --------------------------------------------------------------- */
'use strict';

const SUPABASE_URL = (window.KICKOFF_CONFIG && window.KICKOFF_CONFIG.SUPABASE_URL || '').trim();
const SUPABASE_ANON_KEY = (window.KICKOFF_CONFIG && window.KICKOFF_CONFIG.SUPABASE_ANON_KEY || '').trim();

/** True when a Supabase project has been configured and the client loaded. */
let BACKEND_READY = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY && window.supabase && window.supabase.createClient);

/** Supabase client (null in demo mode). */
let db = null;

function initBackend() {
  if (!BACKEND_READY) return;
  try {
    db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true
      }
    });
  } catch (err) {
    console.error('KickOff Division: could not initialise Supabase.', err);
    BACKEND_READY = false;
    db = null;
  }
}

function assertBackend() {
  if (!BACKEND_READY || !db) {
    throw new Error('Supabase is not configured. See js/config.js and supabase/schema.sql.');
  }
}

/* ---------- row mapping (snake_case ⇄ camelCase) ---------- */

function mapSeason(row) {
  return {
    id: row.id,
    name: row.name,
    startDate: row.start_date || '',
    endDate: row.end_date || '',
    isActive: Boolean(row.is_active)
  };
}

function mapTeam(row) {
  return { id: row.id, name: row.name, code: row.code, color: row.color };
}

function mapPlayer(row) {
  return {
    id: row.id,
    teamId: row.team_id,
    name: row.name,
    pos: row.pos,
    num: row.num,
    goals: row.goals,
    yellow: row.yellow,
    red: row.red
  };
}

function mapMatch(row) {
  return {
    id: row.id,
    seasonId: row.season_id || null,
    round: row.round,
    homeId: row.home_id,
    awayId: row.away_id,
    homeScore: row.home_score,
    awayScore: row.away_score,
    status: row.status,
    datetime: row.datetime || '',
    venue: row.venue || '',
    scorersText: row.scorers_text || ''
  };
}

function seasonToRow(season) {
  return {
    id: season.id,
    name: season.name,
    start_date: season.startDate || null,
    end_date: season.endDate || null,
    is_active: Boolean(season.isActive)
  };
}

function teamToRow(team) {
  return { id: team.id, name: team.name, code: team.code, color: team.color };
}

function playerToRow(player) {
  return {
    id: player.id,
    team_id: player.teamId,
    name: player.name,
    pos: player.pos,
    num: player.num,
    goals: player.goals,
    yellow: player.yellow,
    red: player.red
  };
}

function matchToRow(match) {
  const row = {
    id: match.id,
    round: match.round,
    home_id: match.homeId,
    away_id: match.awayId,
    home_score: match.homeScore,
    away_score: match.awayScore,
    status: match.status,
    datetime: match.datetime,
    venue: match.venue,
    scorers_text: match.scorersText
  };
  // Omitted while the database has not been migrated to seasons yet.
  if (match.seasonId) row.season_id = match.seasonId;
  return row;
}

/** True when the seasons table has not been created yet. */
function isMissingSeasonsTable(error) {
  return Boolean(error) && (
    error.code === 'PGRST205' ||
    error.code === '42P01' ||
    /Could not find the table|relation .* does not exist/i.test(error.message || '')
  );
}

/* ---------- reads ---------- */

/** Replace the in-memory state with data from Supabase (or demo data). */
async function refreshData() {
  if (!BACKEND_READY) {
    appState = normalizeState(DEFAULT_DATA);
    appState.seasonsReady = true;
    appState.activeSeasonId = appState.seasons.find(season => season.isActive).id;
    appState.viewSeasonId = appState.activeSeasonId;
    return;
  }

  const [teamsResult, playersResult, matchesResult, seasonsResult] = await Promise.all([
    db.from('teams').select('*').order('name', { ascending: true }),
    db.from('players').select('*').order('num', { ascending: true }),
    db.from('matches').select('*').order('round', { ascending: true }),
    db.from('seasons').select('*').order('created_at', { ascending: false })
  ]);

  const baseError = teamsResult.error || playersResult.error || matchesResult.error;
  if (baseError) throw baseError;

  // The app remains usable (without season switching) until the season
  // migration has been run in the Supabase SQL Editor.
  let seasons = [];
  let seasonsReady = false;
  if (seasonsResult.error) {
    if (!isMissingSeasonsTable(seasonsResult.error)) throw seasonsResult.error;
  } else {
    seasons = (seasonsResult.data || []).map(mapSeason);
    seasonsReady = true;
  }

  const previousView = appState ? appState.viewSeasonId : null;
  const dbActive = seasons.find(season => season.isActive) || null;
  const activeSeasonId = dbActive ? dbActive.id : null;

  if (seasonsReady && seasons.length) {
    seasons = seasons.map(season => ({ ...season, isActive: season.id === activeSeasonId }));
  }

  // Fall back to the newest season for viewing if none is marked active.
  const defaultViewId = activeSeasonId || (seasons[0] ? seasons[0].id : null);
  const viewSeasonId = previousView && seasons.some(season => season.id === previousView)
    ? previousView
    : defaultViewId;

  appState = {
    teams: (teamsResult.data || []).map(mapTeam),
    players: (playersResult.data || []).map(mapPlayer),
    matches: (matchesResult.data || []).map(mapMatch),
    seasons,
    seasonsReady,
    activeSeasonId,
    viewSeasonId
  };
}

/* ---------- writes (guarded by RLS: admins only) ---------- */

async function dbSaveTeam(team) {
  assertBackend();
  const { error } = await db.from('teams').upsert(teamToRow(team));
  if (error) throw error;
}

async function dbDeleteTeam(teamId) {
  assertBackend();
  const { error } = await db.from('teams').delete().eq('id', teamId);
  if (error) throw error;
}

async function dbSavePlayer(player) {
  assertBackend();
  const { error } = await db.from('players').upsert(playerToRow(player));
  if (error) throw error;
}

async function dbDeletePlayer(playerId) {
  assertBackend();
  const { error } = await db.from('players').delete().eq('id', playerId);
  if (error) throw error;
}

async function dbSaveMatch(match) {
  assertBackend();
  const { error } = await db.from('matches').upsert(matchToRow(match));
  if (error) throw error;
}

async function dbDeleteMatch(matchId) {
  assertBackend();
  const { error } = await db.from('matches').delete().eq('id', matchId);
  if (error) throw error;
}

/** Create a season and make it the active one (atomic database function). */
async function dbCreateSeason(name, startDate, endDate) {
  assertBackend();
  const id = 's_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
  const { error } = await db.rpc('create_season', {
    p_id: id,
    p_name: name,
    p_start_date: startDate || null,
    p_end_date: endDate || null
  });
  if (error) throw error;
  return id;
}

/** Make an existing season active again (atomic database function). */
async function dbActivateSeason(seasonId) {
  assertBackend();
  const { error } = await db.rpc('activate_season', { p_id: seasonId });
  if (error) throw error;
}

/** Replace the whole dataset (used by JSON import and reset). Admin only. */
async function dbReplaceAll(data) {
  assertBackend();

  const seasonsReady = Boolean(appState && appState.seasonsReady);
  const seasons = Array.isArray(data.seasons) ? data.seasons : [];
  const tables = seasonsReady
    ? ['matches', 'players', 'teams', 'seasons']
    : ['matches', 'players', 'teams'];

  for (const table of tables) {
    const { error } = await db.from(table).delete().not('id', 'is', null);
    if (error) throw error;
  }

  if (seasonsReady && seasons.length) {
    const { error } = await db.from('seasons').insert(seasons.map(seasonToRow));
    if (error) throw error;
  }
  if (data.teams.length) {
    const { error } = await db.from('teams').insert(data.teams.map(teamToRow));
    if (error) throw error;
  }
  if (data.players.length) {
    const { error } = await db.from('players').insert(data.players.map(playerToRow));
    if (error) throw error;
  }
  if (data.matches.length) {
    const fallbackSeason = seasons.find(season => season.isActive) || seasons[0];
    const rows = data.matches.map(match => matchToRow(
      seasonsReady
        ? { ...match, seasonId: match.seasonId || (fallbackSeason && fallbackSeason.id) }
        : { ...match, seasonId: null }
    ));
    const { error } = await db.from('matches').insert(rows);
    if (error) throw error;
  }
}
