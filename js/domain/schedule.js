/*
 * Pure fixture-plan domain: round-robin pairings, home/away balancing and
 * calendar assignment.
 *
 * No DOM, no appState. The browser form passes plain options in and gets a
 * plan back for the preview; js/backend.js sends the same rows to
 * public.create_fixtures(). The SQL function re-checks every invariant, so a
 * bug here can never write a broken schedule.
 *
 * Dates are handled as UTC day keys (YYYY-MM-DD) so the result does not depend
 * on the browser timezone. Kick-off times stay local wall-clock strings, which
 * is what matches.datetime stores.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Parse YYYY-MM-DD into a UTC midnight timestamp, or null when invalid. */
export function dateKeyToUtc(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value == null ? '' : value).trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const time = Date.UTC(year, month - 1, day);
  const date = new Date(time);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return time;
}

/** Format a UTC timestamp as YYYY-MM-DD. */
export function formatDateKey(time) {
  const date = new Date(time);
  const pad = part => String(part).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function requireDateKey(value, label) {
  const time = dateKeyToUtc(value);
  if (time == null) throw new Error(`${label} must use YYYY-MM-DD`);
  return time;
}

function normaliseTimes(times) {
  const list = (Array.isArray(times) ? times : String(times || '').split(','))
    .map(value => String(value == null ? '' : value).trim())
    .filter(Boolean);
  const valid = list.filter(value => /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(value));
  if (!list.length) return ['15:00'];
  if (valid.length !== list.length) throw new Error('Kick-off times must use HH:MM');
  return valid;
}

function normaliseList(value) {
  return (Array.isArray(value) ? value : String(value == null ? '' : value).split(','))
    .map(item => String(item == null ? '' : item).trim())
    .filter(Boolean);
}

/**
 * Circle-method pairings. An odd team count gets one bye per round.
 * `doubleRound` appends the same rounds with home and away reversed.
 */
export function buildRoundRobin(teamIds, options = {}) {
  const ids = [...new Set((teamIds || []).map(String).filter(Boolean))];
  if (ids.length < 2) return [];

  const circle = ids.slice();
  if (circle.length % 2 === 1) circle.push(null);

  const size = circle.length;
  const first = [];
  let rotation = circle.slice();

  for (let round = 0; round < size - 1; round += 1) {
    const pairs = [];
    for (let i = 0; i < size / 2; i += 1) {
      const home = rotation[i];
      const away = rotation[size - 1 - i];
      if (home != null && away != null) pairs.push([home, away]);
    }
    first.push(pairs);
    rotation = [rotation[0], rotation[size - 1], ...rotation.slice(1, size - 1)];
  }

  if (!options.doubleRound) return first;
  return first.concat(first.map(pairs => pairs.map(([home, away]) => [away, home])));
}

function initialStats(teamIds) {
  return new Map(teamIds.map(id => [id, { home: 0, away: 0, streak: 0 }]));
}

function sideCost(teamId, side, stats, maxConsecutive) {
  const row = stats.get(teamId) || { home: 0, away: 0, streak: 0 };
  const nextStreak = row.streak > 0
    ? (side === 1 ? row.streak + 1 : -1)
    : row.streak < 0
      ? (side === -1 ? row.streak - 1 : 1)
      : side;
  const length = Math.abs(nextStreak);
  let cost = 0;
  if (length > maxConsecutive) cost += 10000;
  else if (length === maxConsecutive) cost += 40;
  else if (length === maxConsecutive - 1) cost += 4;
  const home = row.home + (side === 1 ? 1 : 0);
  const away = row.away + (side === -1 ? 1 : 0);
  return cost + Math.abs(home - away) * 3;
}

function recordSide(stats, teamId, side) {
  const row = stats.get(teamId) || { home: 0, away: 0, streak: 0 };
  if (side === 1) {
    row.home += 1;
    row.streak = row.streak > 0 ? row.streak + 1 : 1;
  } else {
    row.away += 1;
    row.streak = row.streak < 0 ? row.streak - 1 : -1;
  }
  stats.set(teamId, row);
}

function orientRounds(rounds, teamIds, maxConsecutive) {
  const stats = initialStats(teamIds);
  const matches = [];
  rounds.forEach((pairs, roundIndex) => {
    pairs.forEach(([a, b], matchIndex) => {
      const ab = sideCost(a, 1, stats, maxConsecutive) + sideCost(b, -1, stats, maxConsecutive);
      const ba = sideCost(b, 1, stats, maxConsecutive) + sideCost(a, -1, stats, maxConsecutive);
      const preferAb = ab < ba || (ab === ba && (roundIndex + matchIndex) % 2 === 0);
      const homeId = preferAb ? a : b;
      const awayId = preferAb ? b : a;
      recordSide(stats, homeId, 1);
      recordSide(stats, awayId, -1);
      matches.push({ round: roundIndex + 1, homeId, awayId });
    });
  });
  return matches;
}

function countStreakViolations(matches, teamIds, maxConsecutive) {
  const byTeam = new Map(teamIds.map(id => [id, []]));
  for (const match of matches) {
    byTeam.get(match.homeId).push({ round: match.round, side: 1 });
    byTeam.get(match.awayId).push({ round: match.round, side: -1 });
  }
  let violations = 0;
  for (const list of byTeam.values()) {
    list.sort((a, b) => a.round - b.round);
    let run = 0;
    let previous = 0;
    for (const item of list) {
      run = item.side === previous ? run + 1 : 1;
      previous = item.side;
      if (run > maxConsecutive) violations += 1;
    }
  }
  return violations;
}

function flipMatch(match) {
  return { ...match, homeId: match.awayId, awayId: match.homeId };
}

/**
 * Greedy orientation already keeps most teams legal. This local search fixes
 * the leftovers by flipping single fixtures.
 */
function repairOrientation(matches, teamIds, maxConsecutive) {
  let current = matches.slice();
  let violations = countStreakViolations(current, teamIds, maxConsecutive);
  const limit = Math.max(8, teamIds.length * matches.length);

  for (let pass = 0; pass < limit && violations > 0; pass += 1) {
    let improved = false;

    for (let i = 0; i < current.length && !improved; i += 1) {
      const candidate = current.slice();
      candidate[i] = flipMatch(candidate[i]);
      const next = countStreakViolations(candidate, teamIds, maxConsecutive);
      if (next < violations) {
        current = candidate;
        violations = next;
        improved = true;
      }
    }

    if (!improved) break;
  }

  return { matches: current, violations };
}

function pairCounts(matches) {
  const counts = new Map();
  for (const match of matches) {
    const key = [match.homeId, match.awayId].sort().join('|');
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

/**
 * Second leg of a double round-robin: the same pairings, magnitudes reversed
 * and played in reverse round order. Mirroring the round order means a club's
 * first game after the break is at the opposite ground to its last game before
 * it, so the halfway point can never create a third consecutive home or away
 * game. Each pairing still has exactly one home leg per club.
 */
function mirrorLeg(matches, halfLength) {
  const second = [];
  for (let k = 1; k <= halfLength; k += 1) {
    const sourceRound = halfLength + 1 - k;
    for (const match of matches) {
      if (match.round !== sourceRound) continue;
      second.push({
        round: halfLength + k,
        homeId: match.awayId,
        awayId: match.homeId
      });
    }
  }
  return second;
}

/**
 * Build a complete plan.
 *
 * @param {object} options
 * @param {string[]} options.teamIds teams of one division, in display order
 * @param {boolean} [options.doubleRound] two legs, one hosted by each club
 * @param {string} options.startDate first matchday, YYYY-MM-DD
 * @param {number} [options.intervalDays] days between matchdays (default 7)
 * @param {string[]|string} [options.kickoffTimes] HH:MM values (default 15:00)
 * @param {string[]|string} [options.venues] venue names (default none)
 * @param {string[]|string} [options.blackoutDates] YYYY-MM-DD dates with no match
 * @param {number} [options.minRestDays] minimum days between a club's games
 * @param {number} [options.maxConsecutive] max consecutive home or away games
 * @returns {{matches: object[], rounds: number, teamCount: number, matchCount: number,
 *   firstDate: string, lastDate: string, warnings: string[]}} `warnings` holds
 *   stable codes (ODD_TEAMS, BLACKOUT_MOVED, SLOTS_REUSED, BALANCE_UNREPAIRED)
 *   so the UI can translate them.
 */
export function generateFixtures(options = {}) {
  const teamIds = [...new Set((options.teamIds || []).map(String).filter(Boolean))];
  if (teamIds.length < 2) throw new Error('A fixture plan needs at least two teams');

  const doubleRound = Boolean(options.doubleRound);
  const startTime = requireDateKey(options.startDate, 'The start date');
  const intervalDays = Math.max(1, Number(options.intervalDays) || 7);
  const minRestDays = Math.max(0, Number(options.minRestDays) || 0);
  const maxConsecutive = Math.max(1, Number(options.maxConsecutive) || 2);
  const kickoffTimes = normaliseTimes(options.kickoffTimes);
  const venues = normaliseList(options.venues);
  const blackout = new Set(
    normaliseList(options.blackoutDates).map(value => {
      const time = requireDateKey(value, 'A blackout date');
      return formatDateKey(time);
    })
  );

  const halfRounds = buildRoundRobin(teamIds, { doubleRound: false });
  const repaired = repairOrientation(orientRounds(halfRounds, teamIds, maxConsecutive), teamIds, maxConsecutive);
  const schedule = doubleRound
    ? repaired.matches.concat(mirrorLeg(repaired.matches, halfRounds.length))
    : repaired.matches;
  const roundCount = halfRounds.length * (doubleRound ? 2 : 1);

  const matches = [];
  const warnings = [];
  const addWarning = code => {
    if (!warnings.includes(code)) warnings.push(code);
  };
  let previousDate = null;
  const spacing = Math.max(intervalDays, minRestDays, 1);
  let shiftedRounds = 0;

  for (let roundIndex = 0; roundIndex < roundCount; roundIndex += 1) {
    let target = startTime + roundIndex * spacing * DAY_MS;
    if (previousDate != null && target <= previousDate) target = previousDate + DAY_MS;
    const base = target;
    while (blackout.has(formatDateKey(target))) target += DAY_MS;
    if (target !== base) shiftedRounds += 1;
    const dateKey = formatDateKey(target);
    previousDate = target;

    const roundMatches = schedule.filter(match => match.round === roundIndex + 1);
    if (roundMatches.length > kickoffTimes.length * Math.max(venues.length, 1)) {
      addWarning('SLOTS_REUSED');
    }

    roundMatches.forEach((match, matchIndex) => {
      const time = kickoffTimes[matchIndex % kickoffTimes.length];
      const venue = venues.length ? venues[matchIndex % venues.length] : '';
      matches.push({
        round: roundIndex + 1,
        homeId: match.homeId,
        awayId: match.awayId,
        datetime: `${dateKey}T${time}`,
        venue
      });
    });
  }

  if (teamIds.length % 2 === 1) addWarning('ODD_TEAMS');
  if (shiftedRounds > 0) addWarning('BLACKOUT_MOVED');
  if (repaired.violations > 0) addWarning('BALANCE_UNREPAIRED');

  const expected = doubleRound ? 2 : 1;
  const counts = pairCounts(matches);
  if (counts.size !== (teamIds.length * (teamIds.length - 1)) / 2 ||
      [...counts.values()].some(count => count !== expected)) {
    throw new Error('The round-robin plan is incomplete');
  }
  if (doubleRound) {
    // One leg at each ground, or the RPC would reject the plan.
    const homes = new Map();
    for (const match of matches) {
      const key = [match.homeId, match.awayId].sort().join('|');
      if (!homes.has(key)) homes.set(key, new Map());
      const legs = homes.get(key);
      legs.set(match.homeId, (legs.get(match.homeId) || 0) + 1);
    }
    for (const legs of homes.values()) {
      if ([...legs.values()].some(count => count !== 1)) {
        throw new Error('The round-robin plan does not split home and away legs');
      }
    }
  }

  return {
    matches,
    rounds: roundCount,
    teamCount: teamIds.length,
    matchCount: matches.length,
    firstDate: matches.length ? matches[0].datetime.slice(0, 10) : '',
    lastDate: matches.length ? matches[matches.length - 1].datetime.slice(0, 10) : '',
    warnings
  };
}

/**
 * Move every fixture from `fromRound` onwards by `days`, keeping the time of
 * day. Used to preview a postponement; public.shift_fixture_rounds() applies
 * the same rule in the database.
 */
export function shiftRounds(matches, fromRound, days) {
  const shift = Number(days);
  const start = Number(fromRound);
  if (!Number.isInteger(shift) || shift === 0 || Math.abs(shift) > 365) {
    throw new Error('The date shift must be between 1 and 365 days');
  }
  if (!Number.isInteger(start) || start < 1) {
    throw new Error('The starting round must be at least 1');
  }

  const updated = (matches || []).map(match => {
    if (Number(match.round) < start || !match.datetime) return { ...match };
    const [datePart, timePart] = String(match.datetime).split('T');
    const time = dateKeyToUtc(datePart);
    if (time == null) return { ...match };
    return {
      ...match,
      datetime: `${formatDateKey(time + shift * DAY_MS)}T${timePart || '00:00'}`
    };
  });

  const affected = updated.filter(match => Number(match.round) >= start && match.datetime);
  const dates = affected.map(match => match.datetime.slice(0, 10)).sort();
  return {
    matches: updated,
    shifted: affected.length,
    firstDate: dates[0] || '',
    lastDate: dates[dates.length - 1] || ''
  };
}
