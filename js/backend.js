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
  return {
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
}

/* ---------- reads ---------- */

/** Replace the in-memory state with data from Supabase (or demo data). */
async function refreshData() {
  if (!BACKEND_READY) {
    appState = JSON.parse(JSON.stringify(DEFAULT_DATA));
    return;
  }

  const [teams, players, matches] = await Promise.all([
    db.from('teams').select('*').order('name', { ascending: true }),
    db.from('players').select('*').order('num', { ascending: true }),
    db.from('matches').select('*').order('round', { ascending: true })
  ]);

  const error = teams.error || players.error || matches.error;
  if (error) throw error;

  appState = {
    teams: (teams.data || []).map(mapTeam),
    players: (players.data || []).map(mapPlayer),
    matches: (matches.data || []).map(mapMatch)
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

/** Replace the whole dataset (used by JSON import and reset). Admin only. */
async function dbReplaceAll(data) {
  assertBackend();

  for (const table of ['matches', 'players', 'teams']) {
    const { error } = await db.from(table).delete().not('id', 'is', null);
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
    const { error } = await db.from('matches').insert(data.matches.map(matchToRow));
    if (error) throw error;
  }
}
