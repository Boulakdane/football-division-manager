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
    scorersText: row.scorers_text || '',
    eventsCounted: row.events_counted !== false
  };
}

function mapMatchEvent(row) {
  return {
    id: row.id,
    matchId: row.match_id,
    teamId: row.team_id,
    playerId: row.player_id,
    type: row.event_type,
    minute: row.minute
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
  // Omitted while the database has not been migrated to seasons/events yet.
  if (match.seasonId) row.season_id = match.seasonId;
  if (appState && appState.eventsReady) row.events_counted = match.eventsCounted !== false;
  return row;
}

function matchEventToRow(event) {
  return {
    id: event.id,
    match_id: event.matchId,
    team_id: event.teamId,
    player_id: event.playerId,
    event_type: event.type,
    minute: event.minute
  };
}

/** True when a table (or the season migration) has not been created yet. */
function isMissingTable(error) {
  return Boolean(error) && (
    error.code === 'PGRST205' ||
    error.code === '42P01' ||
    /Could not find the table|relation .* does not exist/i.test(error.message || '')
  );
}

function isMissingSeasonsTable(error) {
  return isMissingTable(error);
}

/** True when a database function has not been installed yet. */
function isMissingFunction(error) {
  return Boolean(error) && (
    error.code === 'PGRST202' ||
    error.code === '42883' ||
    /Could not find the function|function .* does not exist/i.test(error.message || '')
  );
}

/* ---------- reads ---------- */

/** Replace the in-memory state with data from Supabase (or demo data). */
async function refreshData() {
  if (!BACKEND_READY) {
    appState = normalizeState(DEFAULT_DATA);
    appState.seasonsReady = true;
    appState.eventsReady = true;
    appState.activeSeasonId = appState.seasons.find(season => season.isActive).id;
    appState.viewSeasonId = appState.activeSeasonId;
    return;
  }

  const [teamsResult, playersResult, matchesResult, seasonsResult, eventsResult] = await Promise.all([
    db.from('teams').select('*').order('name', { ascending: true }),
    db.from('players').select('*').order('num', { ascending: true }),
    db.from('matches').select('*').order('round', { ascending: true }),
    db.from('seasons').select('*').order('created_at', { ascending: false }),
    db.from('match_events').select('*').order('minute', { ascending: true })
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

  // Match events are optional until the match-events migration is run.
  let matchEvents = [];
  let eventsReady = false;
  if (eventsResult.error) {
    if (!isMissingTable(eventsResult.error)) throw eventsResult.error;
  } else {
    matchEvents = (eventsResult.data || []).map(mapMatchEvent);
    eventsReady = true;
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
    matchEvents,
    seasonsReady,
    eventsReady,
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

async function dbSaveMatch(match, events) {
  assertBackend();
  const { error } = await db.from('matches').upsert(matchToRow(match));
  if (error) throw error;

  // Only touch events when the caller supplied them and the table exists.
  if (Array.isArray(events) && appState.eventsReady) {
    await dbReplaceMatchEvents(match.id, events);
  }
}

/** Replace a match's events and adjust player totals atomically. */
async function dbReplaceMatchEvents(matchId, events) {
  assertBackend();
  const payload = (events || []).map(event => ({
    id: event.id,
    teamId: event.teamId,
    playerId: event.playerId,
    type: event.type,
    minute: event.minute
  }));

  const { error } = await db.rpc('replace_match_events', {
    p_match_id: matchId,
    p_events: payload
  });
  if (!error) return;

  // Fallback for a project that installed the table but not the RPC yet.
  // Player aggregate totals are not adjusted in this fallback.
  if (isMissingFunction(error)) {
    const cleared = await db.from('match_events').delete().eq('match_id', matchId);
    if (cleared.error) throw cleared.error;
    if (events && events.length) {
      const inserted = await db.from('match_events').insert(events.map(event => ({
        ...matchEventToRow(event),
        match_id: matchId
      })));
      if (inserted.error) throw inserted.error;
    }
    return;
  }

  throw error;
}

async function dbDeleteMatch(matchId) {
  assertBackend();

  // Prefer the RPC so player totals are rolled back with the deletion.
  const { error } = await db.rpc('delete_match', { p_match_id: matchId });
  if (!error) return;

  if (isMissingFunction(error)) {
    const { error: deleteError } = await db.from('matches').delete().eq('id', matchId);
    if (deleteError) throw deleteError;
    return;
  }

  throw error;
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

/** Delete an archived season that no longer has any fixtures. Admin only. */
async function dbDeleteSeason(seasonId) {
  assertBackend();

  const { count, error: countError } = await db
    .from('matches')
    .select('id', { count: 'exact', head: true })
    .eq('season_id', seasonId);
  if (countError) throw countError;
  if (count) throw new Error('Season still has fixtures');

  const { data, error } = await db
    .from('seasons')
    .delete()
    .eq('id', seasonId)
    .eq('is_active', false)
    .select('id');
  if (error) throw error;
  if (!data || data.length === 0) throw new Error('Season cannot be deleted');
}

/** Build the snake_case payload consumed by the atomic import RPC. */
function buildAtomicImportPayload(data) {
  const seasons = Array.isArray(data.seasons) ? data.seasons : [];
  const fallbackSeason = seasons.find(season => season.isActive) || seasons[0];
  return {
    seasons: seasons.map(seasonToRow),
    teams: (Array.isArray(data.teams) ? data.teams : []).map(teamToRow),
    players: (Array.isArray(data.players) ? data.players : []).map(playerToRow),
    matches: (Array.isArray(data.matches) ? data.matches : []).map(match => matchToRow({
      ...match,
      seasonId: match.seasonId || (fallbackSeason && fallbackSeason.id)
    })),
    match_events: (Array.isArray(data.matchEvents) ? data.matchEvents : []).map(matchEventToRow)
  };
}

/** Replace the whole dataset (used by JSON import and reset). Admin only. */
async function dbReplaceAll(data) {
  assertBackend();

  const seasonsReady = Boolean(appState && appState.seasonsReady);
  const eventsReady = Boolean(appState && appState.eventsReady);

  // Prefer the single-transaction RPC. If it has not been installed yet,
  // fall back to the older client-orchestrated import so existing projects
  // remain usable until the migration is applied.
  if (seasonsReady && eventsReady) {
    const { error } = await db.rpc('replace_all_data', {
      p_data: buildAtomicImportPayload(data)
    });
    if (!error) return;
    if (!isMissingFunction(error)) throw error;
  }

  const seasons = Array.isArray(data.seasons) ? data.seasons : [];
  const tables = [];
  if (eventsReady) tables.push('match_events');
  tables.push('matches', 'players', 'teams');
  if (seasonsReady) tables.push('seasons');

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

  // Imported player totals are authoritative, so events are inserted
  // directly without adjusting them again.
  const matchEvents = Array.isArray(data.matchEvents) ? data.matchEvents : [];
  if (eventsReady && matchEvents.length) {
    const { error } = await db.from('match_events').insert(matchEvents.map(matchEventToRow));
    if (error) throw error;
  }
}
