import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRoundRobin,
  dateKeyToUtc,
  formatDateKey,
  generateFixtures,
  shiftRounds
} from './schedule.js';

function consecutiveStreaks(matches, teamIds) {
  const lengths = [];
  for (const teamId of teamIds) {
    const games = matches
      .filter(match => match.homeId === teamId || match.awayId === teamId)
      .sort((a, b) => a.round - b.round || a.datetime.localeCompare(b.datetime))
      .map(match => (match.homeId === teamId ? 'H' : 'A'));
    let run = 0;
    let previous = '';
    for (const side of games) {
      run = side === previous ? run + 1 : 1;
      previous = side;
      lengths.push(run);
    }
  }
  return Math.max(...lengths);
}

test('the circle method builds a complete single round-robin', () => {
  const rounds = buildRoundRobin(['t1', 't2', 't3', 't4']);
  assert.equal(rounds.length, 3);
  assert.equal(rounds.flat().length, 6);
  const pairs = new Set(rounds.flat().map(([a, b]) => [a, b].sort().join('|')));
  assert.equal(pairs.size, 6);
});

test('an odd team count gets one bye per round', () => {
  const rounds = buildRoundRobin(['t1', 't2', 't3', 't4', 't5']);
  assert.equal(rounds.length, 5);
  assert.deepEqual(rounds.map(round => round.length), [2, 2, 2, 2, 2]);
  assert.equal(rounds.flat().length, 10);
});

test('a double round-robin appends the reversed legs', () => {
  const rounds = buildRoundRobin(['t1', 't2', 't3', 't4'], { doubleRound: true });
  assert.equal(rounds.length, 6);
  const counts = new Map();
  for (const [home, away] of rounds.flat()) {
    const key = [home, away].sort().join('|');
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  assert.equal(counts.size, 6);
  for (const count of counts.values()) assert.equal(count, 2);
});

test('a four-team plan has weekly dates, rotating times and venues', () => {
  const plan = generateFixtures({
    teamIds: ['t1', 't2', 't3', 't4'],
    startDate: '2026-08-08',
    intervalDays: 7,
    kickoffTimes: ['15:00', '17:30'],
    venues: ['Pitch 1', 'Pitch 2']
  });
  assert.equal(plan.teamCount, 4);
  assert.equal(plan.rounds, 3);
  assert.equal(plan.matchCount, 6);
  assert.equal(plan.firstDate, '2026-08-08');
  assert.equal(plan.lastDate, '2026-08-22');
  assert.equal(plan.warnings.length, 0);
  assert.equal(plan.matches[0].datetime, '2026-08-08T15:00');
  assert.equal(plan.matches[0].venue, 'Pitch 1');
  assert.equal(plan.matches[1].datetime, '2026-08-08T17:30');
  assert.equal(plan.matches[1].venue, 'Pitch 2');
  assert.deepEqual([...new Set(plan.matches.map(match => match.round))], [1, 2, 3]);
});

test('every team plays every other once in a single round-robin', () => {
  const teams = ['t1', 't2', 't3', 't4', 't5', 't6'];
  const plan = generateFixtures({ teamIds: teams, startDate: '2026-08-01' });
  const seen = new Map();
  for (const match of plan.matches) {
    const key = [match.homeId, match.awayId].sort().join('|');
    seen.set(key, (seen.get(key) || 0) + 1);
  }
  assert.equal(seen.size, 15);
  for (const count of seen.values()) assert.equal(count, 1);
  assert.ok(consecutiveStreaks(plan.matches, teams) <= 2);
});

test('a 20-team double round-robin is complete and fast', () => {
  const teams = Array.from({ length: 20 }, (_, index) => `team-${index + 1}`);
  const started = Date.now();
  const plan = generateFixtures({
    teamIds: teams,
    doubleRound: true,
    startDate: '2026-08-01',
    intervalDays: 7,
    kickoffTimes: ['13:00', '15:00', '17:00', '19:00'],
    venues: ['Pitch 1', 'Pitch 2']
  });
  const elapsed = Date.now() - started;

  assert.equal(plan.rounds, 38);
  assert.equal(plan.matchCount, 380);
  assert.ok(elapsed < 1000, `generation took ${elapsed}ms`);
  assert.ok(consecutiveStreaks(plan.matches, teams) <= 2);

  const seen = new Map();
  for (const match of plan.matches) {
    const key = [match.homeId, match.awayId].sort().join('|');
    seen.set(key, (seen.get(key) || 0) + 1);
  }
  assert.equal(seen.size, 190);
  for (const count of seen.values()) assert.equal(count, 2);

  // Every pairing must have exactly one leg at each ground, or create_fixtures()
  // would reject the plan.
  const homes = new Map();
  for (const match of plan.matches) {
    const key = [match.homeId, match.awayId].sort().join('|');
    if (!homes.has(key)) homes.set(key, new Map());
    const legs = homes.get(key);
    legs.set(match.homeId, (legs.get(match.homeId) || 0) + 1);
  }
  for (const legs of homes.values()) {
    assert.deepEqual([...legs.values()].sort(), [1, 1], 'one home leg per pairing');
  }
});

test('home and away counts stay balanced', () => {
  const teams = Array.from({ length: 7 }, (_, index) => `t${index + 1}`);
  const plan = generateFixtures({ teamIds: teams, doubleRound: true, startDate: '2026-08-01' });
  for (const team of teams) {
    const home = plan.matches.filter(match => match.homeId === team).length;
    const away = plan.matches.filter(match => match.awayId === team).length;
    assert.equal(home, 6);
    assert.equal(away, 6);
  }
  assert.ok(plan.warnings.includes('ODD_TEAMS'));
});

test('blackout dates push a matchday forward without reordering rounds', () => {
  const plan = generateFixtures({
    teamIds: ['t1', 't2', 't3', 't4'],
    startDate: '2026-08-08',
    intervalDays: 7,
    blackoutDates: ['2026-08-15']
  });
  assert.equal(plan.matches.find(match => match.round === 1).datetime.slice(0, 10), '2026-08-08');
  assert.equal(plan.matches.find(match => match.round === 2).datetime.slice(0, 10), '2026-08-16');
  assert.equal(plan.matches.find(match => match.round === 3).datetime.slice(0, 10), '2026-08-22');
  assert.ok(plan.warnings.includes('BLACKOUT_MOVED'));
});

test('minimum rest wins over a shorter interval', () => {
  const plan = generateFixtures({
    teamIds: ['t1', 't2', 't3', 't4'],
    startDate: '2026-08-08',
    intervalDays: 2,
    minRestDays: 5
  });
  const dates = [...new Set(plan.matches.map(match => match.datetime.slice(0, 10)))];
  assert.deepEqual(dates, ['2026-08-08', '2026-08-13', '2026-08-18']);
});

test('reused slots are reported once instead of silently dropped', () => {
  const plan = generateFixtures({
    teamIds: ['t1', 't2', 't3', 't4'],
    startDate: '2026-08-08',
    kickoffTimes: ['15:00'],
    venues: ['Pitch 1']
  });
  assert.equal(plan.warnings.filter(code => code === 'SLOTS_REUSED').length, 1);
  assert.equal(plan.matches.length, 6);
});

test('a double round-robin keeps exactly one home leg per pairing', () => {
  const teams = ['t1', 't2', 't3', 't4', 't5'];
  const plan = generateFixtures({ teamIds: teams, doubleRound: true, startDate: '2026-08-01' });
  for (let a = 0; a < teams.length; a += 1) {
    for (let b = a + 1; b < teams.length; b += 1) {
      const legs = plan.matches.filter(match =>
        (match.homeId === teams[a] && match.awayId === teams[b]) ||
        (match.homeId === teams[b] && match.awayId === teams[a])
      );
      assert.equal(legs.length, 2, `${teams[a]} and ${teams[b]} play twice`);
      assert.equal(
        legs.filter(match => match.homeId === teams[a]).length,
        1,
        `${teams[a]} hosts exactly once`
      );
    }
  }
});

test('invalid options are rejected', () => {
  assert.throws(() => generateFixtures({ teamIds: ['t1'] }), /at least two teams/);
  assert.throws(() => generateFixtures({ teamIds: ['t1', 't2'], startDate: '2026-02-31' }), /YYYY-MM-DD/);
  assert.throws(
    () => generateFixtures({ teamIds: ['t1', 't2'], startDate: '2026-08-01', kickoffTimes: ['25:00'] }),
    /HH:MM/
  );
  assert.throws(
    () => generateFixtures({ teamIds: ['t1', 't2'], startDate: '2026-08-01', blackoutDates: ['soon'] }),
    /YYYY-MM-DD/
  );
});

test('date helpers reject impossible days and handle leap years', () => {
  assert.equal(dateKeyToUtc('2024-02-29') !== null, true);
  assert.equal(dateKeyToUtc('2026-02-29'), null);
  assert.equal(dateKeyToUtc('2026-13-01'), null);
  assert.equal(formatDateKey(dateKeyToUtc('2026-08-08') + 7 * 24 * 60 * 60 * 1000), '2026-08-15');
});

test('shiftRounds moves only the selected rounds and keeps the time of day', () => {
  const plan = generateFixtures({
    teamIds: ['t1', 't2', 't3', 't4'],
    startDate: '2026-08-08',
    kickoffTimes: ['15:00', '17:30']
  });
  const shifted = shiftRounds(plan.matches, 2, 7);
  assert.equal(shifted.shifted, 4);
  assert.equal(shifted.firstDate, '2026-08-22');
  assert.equal(shifted.lastDate, '2026-08-29');
  assert.equal(
    shifted.matches.find(match => match.round === 1).datetime,
    '2026-08-08T15:00'
  );
  assert.equal(
    shifted.matches.find(match => match.round === 2).datetime,
    '2026-08-22T15:00'
  );
  assert.deepEqual(
    shifted.matches.filter(match => match.round === 3).map(match => match.datetime).sort(),
    ['2026-08-29T15:00', '2026-08-29T17:30'],
    'each fixture keeps its own kick-off time'
  );
  assert.deepEqual(
    plan.matches.filter(match => match.round === 2).map(match => match.datetime).sort(),
    ['2026-08-15T15:00', '2026-08-15T17:30'],
    'the original plan must not be mutated'
  );
});

test('shiftRounds accepts a negative shift and rejects nonsense', () => {
  const matches = [{ round: 2, homeId: 't1', awayId: 't2', datetime: '2026-08-15T15:00' }];
  assert.equal(shiftRounds(matches, 2, -1).matches[0].datetime, '2026-08-14T15:00');
  assert.throws(() => shiftRounds(matches, 2, 0), /between 1 and 365/);
  assert.throws(() => shiftRounds(matches, 0, 7), /at least 1/);
  assert.throws(() => shiftRounds(matches, 2, 400), /between 1 and 365/);
});
