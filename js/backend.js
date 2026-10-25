/* ---------------------------------------------------------------
   KickOff Division — Supabase data layer
   Loads league data for everyone (public read) and exposes write
   helpers used by the admin UI. Authorization is enforced by
   Postgres Row Level Security, not by this file.
   --------------------------------------------------------------- */
'use strict';

const SUPABASE_URL = (window.KICKOFF_CONFIG && window.KICKOFF_CONFIG.SUPABASE_URL || '').trim();
const SUPABASE_ANON_KEY = (window.KICKOFF_CONFIG && window.KICKOFF_CONFIG.SUPABASE_ANON_KEY || '').trim();

/** True when a Supabase project has been configured. */
const AUTH_CONFIGURED = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

/** True when a Supabase project has been configured and the client loaded. */
let BACKEND_READY = Boolean(AUTH_CONFIGURED && window.supabase && window.supabase.createClient);

/** Pick the right error when auth is unavailable: missing config vs. missing client. */
function authUnavailableKey() {
  return AUTH_CONFIGURED ? 'authLibraryMissing' : 'authConfigMissing';
}

/** Supabase client (null in demo mode). */
let db = null;

/** True once the players table has the is_active column (integrity migration). */
let PLAYERS_ARCHIVE_READY = false;

/**
 * True once the database has supabase/derive-totals-migration.sql: the
 * players.legacy_* columns, the v_player_stats view and set_player_totals().
 * Detected from the player rows themselves, so an older project keeps working
 * from the stored totals without an extra failing request on every page load.
 */
let PLAYER_TOTALS_READY = false;

/** Totals are always non-negative whole numbers, whatever the project answers. */
function numberOrZero(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

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
    goals: numberOrZero(row.goals),
    yellow: numberOrZero(row.yellow),
    red: numberOrZero(row.red),
    isActive: row.is_active !== false
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

/** Map an audit_log row for the admin activity panel. */
function mapAuditEntry(row) {
  return {
    id: row.id,
    at: row.occurred_at,
    actorId: row.actor_id || null,
    actorEmail: row.actor_email || '',
    action: row.action,
    entity: row.entity,
    entityId: row.entity_id || null,
    seasonId: row.season_id || null,
    summary: row.summary || '',
    before: row.before || null,
    after: row.after || null
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

/** Player columns that exist in every schema version. */
function playerIdentityToRow(player, includeActive = true) {
  const row = {
    id: player.id,
    team_id: player.teamId,
    name: player.name,
    pos: player.pos,
    num: player.num
  };
  if (includeActive) row.is_active = player.isActive !== false;
  return row;
}

/** Full player row, including the stored totals used by older projects. */
function playerToRow(player, includeActive = true) {
  return {
    ...playerIdentityToRow(player, includeActive),
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

/** Event shape consumed by replace_match_events and save_match. */
function matchEventRpcPayload(events) {
  return (events || []).map(event => ({
    id: event.id,
    teamId: event.teamId,
    playerId: event.playerId,
    type: event.type,
    minute: event.minute
  }));
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

/**
 * Fetch every visible row, not just PostgREST's first page (default 1000).
 * Without this, a busy season with >1000 events would silently lose rows.
 * `tiebreaker` is the unique column that keeps pages stable. Pass null when
 * the primary order column is already unique.
 */
async function selectAllRows(table, orderColumn, ascending, tiebreaker = 'id') {
  const pageSize = 1000;
  const rows = [];
  let from = 0;
  let total = null;

  while (true) {
    let query = db
      .from(table)
      .select('*', { count: 'exact' })
      .order(orderColumn, { ascending });
    if (tiebreaker && tiebreaker !== orderColumn) {
      query = query.order(tiebreaker, { ascending: true });
    }
    const { data, error, count } = await query.range(from, from + pageSize - 1);

    if (error) return { data: null, error };
    if (typeof count === 'number') total = count;

    const page = data || [];
    rows.push(...page);
    if (!page.length || (total !== null && rows.length >= total)) break;

    from += page.length;
    if (from > 100000) {
      return { data: null, error: new Error(`Refusing to paginate ${table} beyond 100000 rows.`) };
    }
  }

  return { data: rows, error: null };
}

/** True when the page is talking to the development project. */
function isDevelopment() {
  return Boolean(window.KICKOFF_CONFIG && window.KICKOFF_CONFIG.ENVIRONMENT === 'development');
}

/**
 * Dual-run check for roadmap A. Until the stored totals are dropped, compare
 * them with v_player_stats and warn about any difference. Development only, so
 * a public production visitor never pays for it.
 */
function comparePlayerTotals(playerRows, statsRows) {
  const hasStoredColumns = playerRows.some(row =>
    Object.prototype.hasOwnProperty.call(row, 'goals')
  );
  if (!hasStoredColumns) return;

  const storedById = new Map(playerRows.map(row => [row.id, row]));
  const fields = ['goals', 'yellow', 'red'];
  const differences = [];

  statsRows.forEach(stat => {
    const stored = storedById.get(stat.player_id);
    if (!stored) return;
    if (!fields.some(field => numberOrZero(stored[field]) !== numberOrZero(stat[field]))) return;
    differences.push({
      player: stat.name || stat.player_id,
      stored: fields.map(field => numberOrZero(stored[field])).join('/'),
      derived: fields.map(field => numberOrZero(stat[field])).join('/')
    });
  });

  if (differences.length) {
    console.warn(
      `KickOff Division: ${differences.length} player(s) disagree with v_player_stats (stored vs derived goals/yellow/red).`,
      differences
    );
  }
}

/** Replace the in-memory state with data from Supabase (or demo data). */
async function refreshData() {
  if (!BACKEND_READY) {
    PLAYERS_ARCHIVE_READY = true;
    PLAYER_TOTALS_READY = false;
    appState = normalizeState(DEFAULT_DATA);
    appState.seasonsReady = true;
    appState.eventsReady = true;
    appState.playerStatsReady = false;
    appState.activeSeasonId = appState.seasons.find(season => season.isActive).id;
    appState.viewSeasonId = appState.activeSeasonId;
    return;
  }

  const [teamsResult, playersResult, matchesResult, seasonsResult, eventsResult] = await Promise.all([
    selectAllRows('teams', 'name', true),
    selectAllRows('players', 'num', true),
    selectAllRows('matches', 'round', true),
    selectAllRows('seasons', 'created_at', false),
    selectAllRows('match_events', 'minute', true)
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

  // The integrity migration adds players.is_active. Detect it from the
  // selected rows so the frontend can stay compatible with older projects.
  const playerRows = playersResult.data || [];
  PLAYERS_ARCHIVE_READY = playerRows.some(row =>
    Object.prototype.hasOwnProperty.call(row, 'is_active')
  );
  if (!PLAYERS_ARCHIVE_READY && playerRows.length === 0) {
    // An empty table returns no rows, so probe the column once.
    const probe = await db.from('players').select('is_active').limit(1);
    PLAYERS_ARCHIVE_READY = !probe.error;
  }

  // Roadmap A, stage 2: once supabase/derive-totals-migration.sql has run, the
  // totals come from events (plus the legacy offset) through v_player_stats.
  // The stored columns stay authoritative on projects that were not migrated
  // yet, so a static deployment never depends on the order of the SQL run.
  PLAYER_TOTALS_READY = playerRows.some(row =>
    Object.prototype.hasOwnProperty.call(row, 'legacy_goals')
  );
  if (!PLAYER_TOTALS_READY && playerRows.length === 0 && PLAYERS_ARCHIVE_READY) {
    // Empty squad list: ask for the legacy column instead of guessing.
    const probe = await db.from('players').select('legacy_goals').limit(1);
    PLAYER_TOTALS_READY = !probe.error;
  }

  let statsRows = null;
  if (PLAYER_TOTALS_READY) {
    const statsResult = await selectAllRows('v_player_stats', 'player_id', true, null);
    if (statsResult.error) {
      // Keep the league usable: fall back to the stored totals rather than
      // showing no players at all.
      console.warn(
        'KickOff Division: v_player_stats could not be read, showing stored player totals.',
        statsResult.error.message || statsResult.error
      );
    } else {
      statsRows = statsResult.data || [];
    }
  }

  const derivedById = new Map((statsRows || []).map(row => [row.player_id, row]));
  if (statsRows && isDevelopment()) comparePlayerTotals(playerRows, statsRows);

  const players = playerRows.map(row => {
    const player = mapPlayer(row);
    const derived = derivedById.get(player.id);
    if (derived) {
      player.goals = numberOrZero(derived.goals);
      player.yellow = numberOrZero(derived.yellow);
      player.red = numberOrZero(derived.red);
    }
    return player;
  });

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
    players,
    matches: (matchesResult.data || []).map(mapMatch),
    seasons,
    matchEvents,
    seasonsReady,
    eventsReady,
    playerStatsReady: Boolean(statsRows),
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

  // Prefer the RPC so opponent totals are adjusted before the cascade.
  const { error } = await db.rpc('delete_team', { p_team_id: teamId });
  if (!error) return;
  if (!isMissingFunction(error)) throw error;

  // Before the integrity migration, only allow the unsafe cascade when
  // there are no structured events that could leave stale totals.
  const teamMatches = new Set(
    (appState.matches || [])
      .filter(match => match.homeId === teamId || match.awayId === teamId)
      .map(match => match.id)
  );
  const hasEvents = (appState.matchEvents || []).some(event => teamMatches.has(event.matchId));
  if (hasEvents) throw integrityMigrationError(error);

  const { data, error: deleteError } = await db
    .from('teams')
    .delete()
    .eq('id', teamId)
    .select('id');
  if (deleteError) throw deleteError;
  if (!data || !data.length) throw new Error('Team delete was blocked');
}

async function dbSavePlayer(player) {
  assertBackend();

  // Older projects store the totals on the player row itself.
  if (!PLAYER_TOTALS_READY) {
    const { error } = await db.from('players').upsert(playerToRow(player, PLAYERS_ARCHIVE_READY));
    if (error) throw error;
    return;
  }

  // Once totals are derived, the row carries identity only and the totals go
  // through set_player_totals(), which moves the legacy offset so that
  // v_player_stats keeps showing the number the admin typed.
  const { error } = await db
    .from('players')
    .upsert(playerIdentityToRow(player, PLAYERS_ARCHIVE_READY));
  if (error) throw error;

  const totals = await db.rpc('set_player_totals', {
    p_player_id: player.id,
    p_goals: numberOrZero(player.goals),
    p_yellow: numberOrZero(player.yellow),
    p_red: numberOrZero(player.red)
  });
  if (!totals.error) return;

  if (isMissingFunction(totals.error)) {
    // Half-applied migration: keep the edit instead of losing it.
    const { error: storedError } = await db
      .from('players')
      .upsert(playerToRow(player, PLAYERS_ARCHIVE_READY));
    if (storedError) throw storedError;
    return;
  }

  if (/total cannot be lower/i.test(totals.error.message || '')) {
    const limitError = new Error(totals.error.message);
    limitError.code = 'PLAYER_TOTALS_BELOW_EVENTS';
    throw limitError;
  }

  throw totals.error;
}

async function dbDeletePlayer(playerId) {
  assertBackend();
  const { data, error } = await db.from('players').delete().eq('id', playerId).select('id');
  if (error) throw error;
  if (!data || !data.length) {
    // RLS blocks deletes for players with match events. Report it so the UI
    // can archive them instead of silently claiming success.
    const historyError = new Error('Player has match history; archive instead');
    historyError.code = 'PLAYER_HAS_HISTORY';
    throw historyError;
  }
}

async function dbArchivePlayer(playerId) {
  assertBackend();
  const { error } = await db.rpc('archive_player', { p_player_id: playerId });
  if (error) throw integrityMigrationError(error);
}

async function dbRestorePlayer(playerId) {
  assertBackend();
  const { error } = await db.rpc('restore_player', { p_player_id: playerId });
  if (error) throw integrityMigrationError(error);
}

/**
 * Add a whole squad to one team in a single transaction. The database validates
 * every row again; the browser preview is only a convenience.
 */
async function dbAddPlayers(teamId, players) {
  assertBackend();
  const { data, error } = await db.rpc('add_players', {
    p_team_id: teamId,
    p_players: players.map(player => ({
      name: player.name,
      pos: player.pos,
      num: player.num,
      goals: player.goals,
      yellow: player.yellow,
      red: player.red
    }))
  });
  if (error) {
    if (isMissingFunction(error)) {
      const migrationError = new Error('Run supabase/add-players-migration.sql');
      migrationError.code = 'SQUAD_IMPORT_MIGRATION_REQUIRED';
      throw migrationError;
    }
    throw error;
  }
  return data;
}

/** Mark a missing integrity-migration function so the UI can explain it. */
function integrityMigrationError(error) {
  if (isMissingFunction(error)) {
    const migrationError = new Error('Run supabase/integrity-migration.sql');
    migrationError.code = 'INTEGRITY_MIGRATION_REQUIRED';
    return migrationError;
  }
  return error;
}

async function dbSaveMatch(match, events) {
  assertBackend();
  const row = matchToRow(match);

  // Prefer the single-transaction RPC so a rejected event cannot leave a
  // half-saved match behind.
  if (appState.eventsReady) {
    const { error } = await db.rpc('save_match', {
      p_match: row,
      p_events: Array.isArray(events) ? matchEventRpcPayload(events) : null
    });
    if (!error) return;
    if (!isMissingFunction(error)) throw error;
  }

  const { error } = await db.from('matches').upsert(row);
  if (error) throw error;

  // Only touch events when the caller supplied them and the table exists.
  if (Array.isArray(events) && appState.eventsReady) {
    await dbReplaceMatchEvents(match.id, events);
  }
}

/** Replace a match's events and adjust player totals atomically. */
async function dbReplaceMatchEvents(matchId, events) {
  assertBackend();
  const payload = matchEventRpcPayload(events);

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
    const { data, error: deleteError } = await db
      .from('matches')
      .delete()
      .eq('id', matchId)
      .select('id');
    if (deleteError) throw deleteError;
    if (!data || !data.length) throw new Error('Match delete was blocked');
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

  // Prefer the RPC: it moves the season to the trash and can be undone.
  const { error } = await db.rpc('delete_season', { p_season_id: seasonId });
  if (!error) return;
  if (!isMissingFunction(error)) throw error;

  // Before the soft-delete migration, fall back to a physical delete.
  const { count, error: countError } = await db
    .from('matches')
    .select('id', { count: 'exact', head: true })
    .eq('season_id', seasonId);
  if (countError) throw countError;
  if (count) throw new Error('Season still has fixtures');

  const { data, error: deleteError } = await db
    .from('seasons')
    .delete()
    .eq('id', seasonId)
    .eq('is_active', false)
    .select('id');
  if (deleteError) throw deleteError;
  if (!data || data.length === 0) throw new Error('Season cannot be deleted');
}

/** Mark a missing soft-delete-migration function so the UI can explain it. */
function softDeleteMigrationError(error) {
  if (isMissingFunction(error)) {
    const migrationError = new Error('Run supabase/soft-delete-migration.sql');
    migrationError.code = 'SOFT_DELETE_MIGRATION_REQUIRED';
    return migrationError;
  }
  return error;
}

/**
 * Recently deleted teams, matches and seasons.
 * Returns null when supabase/soft-delete-migration.sql has not been applied.
 */
async function dbListDeleted() {
  assertBackend();
  const { data, error } = await db.rpc('list_deleted');
  if (error) {
    if (isMissingFunction(error)) return null;
    throw error;
  }
  return data || { teams: [], matches: [], seasons: [] };
}

async function dbRestoreTeam(teamId) {
  assertBackend();
  const { error } = await db.rpc('restore_team', { p_team_id: teamId });
  if (error) throw softDeleteMigrationError(error);
}

async function dbRestoreMatch(matchId) {
  assertBackend();
  const { error } = await db.rpc('restore_match', { p_match_id: matchId });
  if (error) throw softDeleteMigrationError(error);
}

async function dbRestoreSeason(seasonId) {
  assertBackend();
  const { error } = await db.rpc('restore_season', { p_season_id: seasonId });
  if (error) throw softDeleteMigrationError(error);
}

/**
 * Recent audit entries for the admin activity panel.
 * Returns null when supabase/audit-log-migration.sql has not been applied.
 */
async function dbListAuditLog(limit = 50) {
  assertBackend();
  const { data, error } = await db.rpc('list_audit_log', { p_limit: limit });
  if (error) {
    if (isMissingFunction(error)) return null;
    throw error;
  }
  return (data || []).map(mapAuditEntry);
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

/**
 * Replace the whole dataset (used by JSON import and reset). Admin only.
 *
 * Runs only through the single-transaction replace_all_data() RPC. There is
 * deliberately no table-by-table fallback: a failure partway through such a
 * fallback could leave the league half-deleted. If the migration is missing,
 * the import fails before anything is changed.
 */
async function dbReplaceAll(data) {
  assertBackend();

  const ready = Boolean(appState && appState.seasonsReady && appState.eventsReady);
  if (!ready) {
    throw new Error(
      'Import is unavailable: run the database migrations (supabase/schema.sql) so the atomic import function exists.'
    );
  }

  const { error } = await db.rpc('replace_all_data', {
    p_data: buildAtomicImportPayload(data)
  });
  if (error) {
    if (isMissingFunction(error)) {
      throw new Error(
        'Import is unavailable: replace_all_data() is not installed. Run supabase/atomic-import-migration.sql.'
      );
    }
    throw error;
  }
}
