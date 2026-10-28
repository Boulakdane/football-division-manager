/*
 * Pure league domain: standings and match-event summaries.
 *
 * No DOM, no appState, no globals. The classic js/app.js keeps a thin adapter
 * that passes plain arrays in, so rendering does not change.
 *
 * The ordering here is deliberate and mirrors public.v_standings in
 * supabase/schema.sql: points, goal difference, goals scored, wins, then name.
 * Head-to-head is NOT a tie-breaker in either implementation.
 */
import { toInt } from './format.js';

/** Format a match minute for a timeline or a one-line summary. */
export function formatEventMinute(minute) {
  const value = toInt(minute);
  return value ? `${value}'` : '';
}

/**
 * One-line event summary used in exports and fixture cards.
 *
 * @param {Array<{teamId: string, playerId: string, type: string, minute: number|string}>} events
 * @param {string} homeId
 * @param {string} awayId
 * @param {Array<{id: string, name: string}>} players
 * @returns {string} "Home scorer 12', Home scorer 40' (Y) - Away scorer 55'"
 */
export function summarizeEventsForText(events, homeId, awayId, players) {
  const playerName = id => {
    const player = players.find(item => item.id === id);
    return player ? player.name : '?';
  };
  const teamText = teamId => events
    .filter(event => event.teamId === teamId)
    .slice()
    .sort((a, b) => toInt(a.minute) - toInt(b.minute))
    .map(event => {
      const suffix = event.type === 'yellow' ? ' (Y)' : event.type === 'red' ? ' (R)' : '';
      return `${playerName(event.playerId)} ${formatEventMinute(event.minute)}${suffix}`;
    })
    .join(', ');

  return [teamText(homeId), teamText(awayId)].filter(Boolean).join(' - ');
}

/**
 * Build a league table from plain arrays.
 *
 * @param {object} input
 * @param {Array<{id: string, name: string}>} [input.teams] Clubs eligible for the table.
 * @param {Array<object>} [input.matches] Fixtures already scoped to one season/division.
 * @param {boolean} [input.archived] When true, only clubs that appear in the fixtures are listed.
 * @returns {Array<object>} Rows sorted by points, GD, goals for, wins, then name.
 */
export function calculateStandings({ teams = [], matches = [], archived = false } = {}) {
  const stats = {};

  // An archived table should not gain clubs that joined in a later season.
  const seasonTeamIds = new Set();
  matches.forEach(match => {
    seasonTeamIds.add(match.homeId);
    seasonTeamIds.add(match.awayId);
  });
  const tableTeams = archived
    ? teams.filter(team => seasonTeamIds.has(team.id))
    : teams;

  tableTeams.forEach(team => {
    stats[team.id] = {
      team,
      mp: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, gd: 0, pts: 0,
      form: []
    };
  });

  // Only finished matches count towards the table. Postponed, scheduled,
  // cancelled and live fixtures are ignored.
  const finished = matches
    .filter(match => match.status === 'FINISHED')
    .sort((a, b) => (a.datetime || '').localeCompare(b.datetime || ''));

  finished.forEach(match => {
    const home = stats[match.homeId];
    const away = stats[match.awayId];
    if (!home || !away) return;

    const hs = toInt(match.homeScore);
    const as = toInt(match.awayScore);
    home.mp++; away.mp++;
    home.gf += hs; home.ga += as;
    away.gf += as; away.ga += hs;

    if (hs > as) {
      home.w++; home.pts += 3; home.form.push('W');
      away.l++; away.form.push('L');
    } else if (hs < as) {
      away.w++; away.pts += 3; away.form.push('W');
      home.l++; home.form.push('L');
    } else {
      home.d++; home.pts += 1; home.form.push('D');
      away.d++; away.pts += 1; away.form.push('D');
    }
  });

  const rows = Object.values(stats).map(row => {
    row.gd = row.gf - row.ga;
    row.form = row.form.slice(-5);
    return row;
  });

  // Tie-breakers: points → goal difference → goals scored → wins → name.
  rows.sort((a, b) =>
    b.pts - a.pts || b.gd - a.gd || b.gf - a.gf || b.w - a.w ||
    a.team.name.localeCompare(b.team.name)
  );
  return rows;
}
