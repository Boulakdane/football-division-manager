/* ---------------------------------------------------------------
   KickOff Division — data store
   Holds the in-memory league state and the demo dataset. Real data
   is loaded from Supabase in js/backend.js.
   --------------------------------------------------------------- */
'use strict';

/** Demo dataset shown in read-only mode (and used by "Reset sample data"). */
const DEFAULT_DATA = {
  seasons: [
    { id: 's1', name: '2026 Season', startDate: '2026-08-01', endDate: '2027-05-31', isActive: true }
  ],
  teams: [
    { id: 't1', name: 'Spartan FC',        code: 'SFC', color: '#3b82f6' },
    { id: 't2', name: 'Titan United',      code: 'TTN', color: '#10b981' },
    { id: 't3', name: 'Phoenix Rovers',    code: 'PHX', color: '#f59e0b' },
    { id: 't4', name: 'Vanguard Athletic', code: 'VNG', color: '#ef4444' },
    { id: 't5', name: 'Atlas Warriors',    code: 'ATL', color: '#8b5cf6' },
    { id: 't6', name: 'Coastal Sharks',    code: 'CSH', color: '#06b6d4' }
  ],
  players: [
    { id: 'p1', teamId: 't1', name: 'David Silva',  pos: 'MID', num: 10, goals: 5, yellow: 1, red: 0 },
    { id: 'p2', teamId: 't1', name: 'Carlos Ramos', pos: 'FWD', num: 9,  goals: 7, yellow: 0, red: 0 },
    { id: 'p3', teamId: 't2', name: 'Ethan Hunt',   pos: 'FWD', num: 11, goals: 4, yellow: 2, red: 0 },
    { id: 'p4', teamId: 't3', name: 'Leo Mendes',   pos: 'MID', num: 8,  goals: 6, yellow: 0, red: 0 },
    { id: 'p5', teamId: 't4', name: 'John Terry',   pos: 'DEF', num: 4,  goals: 1, yellow: 3, red: 1 },
    { id: 'p6', teamId: 't5', name: 'Omar Belaid',  pos: 'FWD', num: 7,  goals: 8, yellow: 1, red: 0 },
    { id: 'p7', teamId: 't5', name: 'Karim Ziani',  pos: 'MID', num: 6,  goals: 2, yellow: 2, red: 0 },
    { id: 'p8', teamId: 't6', name: 'Lucas Ferrao', pos: 'FWD', num: 9,  goals: 3, yellow: 0, red: 0 },
    { id: 'p9', teamId: 't6', name: 'Sam Okafor',   pos: 'GK',  num: 1,  goals: 0, yellow: 0, red: 0 }
  ],
  matches: [
    { id: 'm1', seasonId: 's1', round: 1, homeId: 't1', awayId: 't2', homeScore: 3, awayScore: 1, status: 'FINISHED',  datetime: '2026-10-03T15:00', venue: 'Main Field - Pitch 1',       scorersText: 'Carlos Ramos (2), David Silva (1) - Ethan Hunt (1)' },
    { id: 'm2', seasonId: 's1', round: 1, homeId: 't3', awayId: 't4', homeScore: 2, awayScore: 2, status: 'FINISHED',  datetime: '2026-10-03T17:30', venue: 'Main Field - Pitch 2',       scorersText: 'Leo Mendes (2) - John Terry (1), K. Diaz (1)' },
    { id: 'm3', seasonId: 's1', round: 1, homeId: 't5', awayId: 't6', homeScore: 1, awayScore: 0, status: 'FINISHED',  datetime: '2026-10-04T16:00', venue: 'Community Sports Complex',   scorersText: 'Omar Belaid (1)' },
    { id: 'm4', seasonId: 's1', round: 2, homeId: 't2', awayId: 't3', homeScore: 0, awayScore: 1, status: 'FINISHED',  datetime: '2026-10-10T15:30', venue: 'United Arena',               scorersText: 'Leo Mendes (1)' },
    { id: 'm5', seasonId: 's1', round: 2, homeId: 't4', awayId: 't5', homeScore: 2, awayScore: 2, status: 'FINISHED',  datetime: '2026-10-11T18:00', venue: 'Vanguard Ground',            scorersText: 'John Terry (1), R. Cole (1) - Omar Belaid (2)' },
    { id: 'm6', seasonId: 's1', round: 2, homeId: 't6', awayId: 't1', homeScore: 1, awayScore: 1, status: 'LIVE',      datetime: '2026-10-20T19:00', venue: 'Shark Park',                 scorersText: 'Lucas Ferrao (1) - Carlos Ramos (1)' },
    { id: 'm7', seasonId: 's1', round: 3, homeId: 't1', awayId: 't3', homeScore: 0, awayScore: 0, status: 'SCHEDULED', datetime: '2026-10-24T15:00', venue: 'Main Field - Pitch 1',       scorersText: '' },
    { id: 'm8', seasonId: 's1', round: 3, homeId: 't2', awayId: 't5', homeScore: 0, awayScore: 0, status: 'SCHEDULED', datetime: '2026-10-25T17:00', venue: 'United Arena',               scorersText: '' },
    { id: 'm9', seasonId: 's1', round: 3, homeId: 't4', awayId: 't6', homeScore: 0, awayScore: 0, status: 'SCHEDULED', datetime: '2026-10-25T19:30', venue: 'Vanguard Ground',            scorersText: '' }
  ],
  matchEvents: [
    { id: 'e1',  matchId: 'm1', teamId: 't1', playerId: 'p2', type: 'goal',   minute: 23 },
    { id: 'e2',  matchId: 'm1', teamId: 't1', playerId: 'p1', type: 'goal',   minute: 54 },
    { id: 'e3',  matchId: 'm1', teamId: 't1', playerId: 'p2', type: 'goal',   minute: 71 },
    { id: 'e4',  matchId: 'm1', teamId: 't2', playerId: 'p3', type: 'goal',   minute: 80 },
    { id: 'e5',  matchId: 'm1', teamId: 't2', playerId: 'p3', type: 'yellow', minute: 42 },
    { id: 'e6',  matchId: 'm2', teamId: 't3', playerId: 'p4', type: 'goal',   minute: 12 },
    { id: 'e7',  matchId: 'm2', teamId: 't3', playerId: 'p4', type: 'goal',   minute: 66 },
    { id: 'e8',  matchId: 'm2', teamId: 't4', playerId: 'p5', type: 'goal',   minute: 33 },
    { id: 'e9',  matchId: 'm2', teamId: 't4', playerId: 'p5', type: 'yellow', minute: 58 },
    { id: 'e10', matchId: 'm3', teamId: 't5', playerId: 'p6', type: 'goal',   minute: 77 }
  ]
};

/**
 * Ensure an imported/parsed object has the expected arrays, a valid season
 * list and a seasonId on every match. Old backups without seasons are
 * upgraded automatically into a single default season.
 */
function normalizeState(data) {
  const source = data || {};
  const teams = (Array.isArray(source.teams) ? source.teams : []).map(team => ({ ...team }));
  const players = (Array.isArray(source.players) ? source.players : []).map(player => ({ ...player }));

  let seasons = (Array.isArray(source.seasons) ? source.seasons : [])
    .filter(season => season && typeof season.id === 'string' && season.id)
    .map(season => ({
      id: season.id,
      name: typeof season.name === 'string' ? season.name : '',
      startDate: season.startDate || '',
      endDate: season.endDate || '',
      isActive: Boolean(season.isActive)
    }));

  const hadSeasons = seasons.length > 0;
  if (!hadSeasons) {
    seasons = [{ id: 'season_1', name: 'Season 1', startDate: '', endDate: '', isActive: true }];
  }

  const active = seasons.find(season => season.isActive) || seasons[0];
  seasons = seasons.map(season => ({ ...season, isActive: season.id === active.id }));

  const matches = (Array.isArray(source.matches) ? source.matches : []).map(match => ({
    ...match,
    seasonId: hadSeasons && match.seasonId ? match.seasonId : active.id
  }));

  const matchEvents = (Array.isArray(source.matchEvents) ? source.matchEvents : [])
    .filter(event => event && typeof event === 'object')
    .map(event => ({
      id: event.id,
      matchId: event.matchId,
      teamId: event.teamId,
      playerId: event.playerId,
      type: event.type,
      minute: Number(event.minute)
    }));

  return { teams, players, matches, seasons, matchEvents };
}

/** Current application state. */
let appState = normalizeState(DEFAULT_DATA);
appState.seasonsReady = true;
appState.eventsReady = true;
appState.activeSeasonId = appState.seasons.find(season => season.isActive).id;
appState.viewSeasonId = appState.activeSeasonId;
