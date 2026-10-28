'use strict';

/*
 * Shared mapping between the app's camelCase backup format and the
 * snake_case rows accepted by the replace_all_data RPC.
 */

function dateOnly(value) {
  if (!value) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function seasonFromRow(row) {
  return {
    id: row.id,
    name: row.name,
    startDate: dateOnly(row.start_date),
    endDate: dateOnly(row.end_date),
    isActive: Boolean(row.is_active)
  };
}

function teamFromRow(row) {
  return {
    id: row.id,
    name: row.name,
    // Task L: optional Arabic name. Absent on a pre-L project.
    nameAr: row.name_ar || null,
    // Task I: optional crest as a small data URL. Absent on a pre-I project.
    icon: row.icon || null,
    code: row.code,
    color: row.color,
    divisionId: row.division_id || 'd1'
  };
}

function playerFromRow(row) {
  return {
    id: row.id,
    teamId: row.team_id,
    name: row.name,
    nameAr: row.name_ar || null,
    pos: row.pos,
    num: row.num,
    goals: row.goals,
    yellow: row.yellow,
    red: row.red,
    isActive: row.is_active !== false,
    // Personal data from public.player_profiles. Only an admin session can
    // read it, so the anon export leaves these null.
    licenseId: row.license_id || null,
    birthDate: dateOnly(row.birth_date) || null
  };
}

function matchFromRow(row) {
  return {
    id: row.id,
    seasonId: row.season_id,
    divisionId: row.division_id || 'd1',
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

function eventFromRow(row) {
  return {
    id: row.id,
    matchId: row.match_id,
    teamId: row.team_id,
    playerId: row.player_id,
    type: row.event_type,
    minute: row.minute
  };
}

/** Build the payload accepted by public.replace_all_data(jsonb). */
function toDbPayload(data) {
  const seasons = Array.isArray(data.seasons) ? data.seasons : [];
  const fallbackSeason = seasons.find(season => season.isActive) || seasons[0];
  const teamDivisions = new Map(
    (Array.isArray(data.teams) ? data.teams : []).map(team => [team.id, team.divisionId || 'd1'])
  );

  return {
    seasons: seasons.map(season => ({
      id: season.id,
      name: season.name,
      start_date: season.startDate || null,
      end_date: season.endDate || null,
      is_active: Boolean(season.isActive)
    })),
    teams: (Array.isArray(data.teams) ? data.teams : []).map(team => ({
      id: team.id,
      name: team.name,
      name_ar: team.nameAr || null,
      icon: team.icon || null,
      code: team.code || 'TBD',
      color: team.color || '#16a34a',
      division_id: team.divisionId || 'd1'
    })),
    players: (Array.isArray(data.players) ? data.players : []).map(player => ({
      id: player.id,
      team_id: player.teamId,
      name: player.name,
      name_ar: player.nameAr || null,
      pos: player.pos || 'MID',
      num: player.num == null ? 10 : player.num,
      goals: player.goals == null ? 0 : player.goals,
      yellow: player.yellow == null ? 0 : player.yellow,
      red: player.red == null ? 0 : player.red,
      is_active: player.isActive !== false,
      license_id: player.licenseId || null,
      birth_date: player.birthDate || null
    })),
    matches: (Array.isArray(data.matches) ? data.matches : []).map(match => ({
      id: match.id,
      season_id: match.seasonId || (fallbackSeason && fallbackSeason.id),
      division_id: match.divisionId || teamDivisions.get(match.homeId) || 'd1',
      round: match.round == null ? 1 : match.round,
      home_id: match.homeId,
      away_id: match.awayId,
      home_score: match.homeScore == null ? 0 : match.homeScore,
      away_score: match.awayScore == null ? 0 : match.awayScore,
      status: match.status || 'SCHEDULED',
      datetime: match.datetime || null,
      venue: match.venue || null,
      scorers_text: match.scorersText || null,
      events_counted: match.eventsCounted !== false
    })),
    match_events: (Array.isArray(data.matchEvents) ? data.matchEvents : []).map(event => ({
      id: event.id,
      match_id: event.matchId,
      team_id: event.teamId,
      player_id: event.playerId,
      event_type: event.type,
      minute: event.minute
    }))
  };
}

module.exports = {
  seasonFromRow,
  teamFromRow,
  playerFromRow,
  matchFromRow,
  eventFromRow,
  toDbPayload
};
