import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  calculateStandings,
  formatEventMinute,
  summarizeEventsForText
} from './standings.js';

const team = (id, name) => ({ id, name });

const result = (homeId, awayId, homeScore, awayScore, datetime, extra = {}) => ({
  homeId,
  awayId,
  homeScore,
  awayScore,
  status: 'FINISHED',
  datetime,
  ...extra
});

const shape = rows => rows.map(row => ({
  id: row.team.id,
  mp: row.mp,
  w: row.w,
  d: row.d,
  l: row.l,
  gf: row.gf,
  ga: row.ga,
  gd: row.gd,
  pts: row.pts,
  form: row.form
}));

test('a two-team league awards three points for a win', () => {
  const rows = calculateStandings({
    teams: [team('a', 'Alpha'), team('b', 'Bravo')],
    matches: [result('a', 'b', 3, 1, '2026-01-01T12:00')]
  });

  assert.deepEqual(shape(rows), [
    { id: 'a', mp: 1, w: 1, d: 0, l: 0, gf: 3, ga: 1, gd: 2, pts: 3, form: ['W'] },
    { id: 'b', mp: 1, w: 0, d: 0, l: 1, gf: 1, ga: 3, gd: -2, pts: 0, form: ['L'] }
  ]);
});

test('points lead, then goal difference breaks a four-team tie', () => {
  const rows = calculateStandings({
    teams: [team('p', 'Pumas'), team('q', 'Quails'), team('r', 'Rovers'), team('s', 'Sharks')],
    matches: [
      result('p', 'r', 2, 0, '2026-01-01T12:00'),
      result('p', 's', 1, 0, '2026-01-02T12:00'),
      result('q', 'p', 1, 0, '2026-01-03T12:00'),
      result('q', 's', 1, 0, '2026-01-04T12:00'),
      result('r', 'q', 2, 0, '2026-01-05T12:00'),
      result('r', 's', 3, 0, '2026-01-06T12:00')
    ]
  });

  assert.deepEqual(rows.map(row => row.team.id), ['r', 'p', 'q', 's']);
  assert.deepEqual(rows.map(row => row.pts), [6, 6, 6, 0]);
  assert.deepEqual(rows.map(row => row.gd), [3, 2, 0, -5]);
});

test('goals scored breaks a tie on points and goal difference', () => {
  const rows = calculateStandings({
    teams: ['c', 'x', 'y', 'a', 'b'].map(id => team(id, id.toUpperCase())),
    matches: [
      result('c', 'x', 3, 0, '2026-01-01T12:00'),
      result('c', 'y', 2, 0, '2026-01-02T12:00'),
      result('x', 'a', 3, 1, '2026-01-03T12:00'),
      result('x', 'b', 1, 0, '2026-01-04T12:00'),
      result('y', 'a', 1, 0, '2026-01-05T12:00'),
      result('y', 'b', 1, 0, '2026-01-06T12:00')
    ]
  });

  const byId = Object.fromEntries(rows.map(row => [row.team.id, row]));
  assert.equal(byId.x.pts, byId.y.pts);
  assert.equal(byId.x.gd, byId.y.gd);
  assert.ok(byId.x.gf > byId.y.gf);
  assert.ok(
    rows.findIndex(row => row.team.id === 'x') < rows.findIndex(row => row.team.id === 'y'),
    'the team with more goals scored should rank higher'
  );
});

test('wins break a tie on points, goal difference and goals scored', () => {
  const teams = [
    team('p', 'Pumas'),
    team('q', 'Quails'),
    ...Array.from({ length: 6 }, (_, index) => team(`f${index + 1}`, `Filler ${index + 1}`))
  ];

  const matches = [
    // P: one win and five draws = 8 points, 1 win.
    result('p', 'f1', 2, 1, '2026-01-01T12:00'),
    ...Array.from({ length: 5 }, (_, index) =>
      result('p', `f${index + 2}`, 1, 1, `2026-01-${String(index + 2).padStart(2, '0')}T12:00`)),
    // Q: two wins, two draws and two losses = 8 points, same GD and GF, 2 wins.
    result('q', 'f1', 3, 1, '2026-02-01T12:00'),
    result('q', 'f2', 2, 1, '2026-02-02T12:00'),
    result('q', 'f3', 1, 1, '2026-02-03T12:00'),
    result('q', 'f4', 1, 1, '2026-02-04T12:00'),
    result('q', 'f5', 0, 1, '2026-02-05T12:00'),
    result('q', 'f6', 0, 1, '2026-02-06T12:00')
  ];

  const rows = calculateStandings({ teams, matches });
  const p = rows.find(row => row.team.id === 'p');
  const q = rows.find(row => row.team.id === 'q');

  assert.deepEqual(
    { pts: p.pts, gd: p.gd, gf: p.gf, w: p.w },
    { pts: 8, gd: 1, gf: 7, w: 1 }
  );
  assert.deepEqual(
    { pts: q.pts, gd: q.gd, gf: q.gf, w: q.w },
    { pts: 8, gd: 1, gf: 7, w: 2 }
  );
  assert.ok(
    rows.findIndex(row => row.team.id === 'q') < rows.findIndex(row => row.team.id === 'p'),
    'the team with more wins should rank higher'
  );
});

test('head-to-head does not override goal difference (matches v_standings)', () => {
  const rows = calculateStandings({
    teams: [team('a', 'Alpha'), team('b', 'Bravo'), team('c', 'Charlie')],
    matches: [
      result('a', 'b', 1, 0, '2026-01-01T12:00'),
      result('b', 'c', 5, 0, '2026-01-02T12:00'),
      result('c', 'a', 3, 0, '2026-01-03T12:00')
    ]
  });

  assert.deepEqual(rows.map(row => row.team.id), ['b', 'c', 'a']);
  assert.deepEqual(rows.map(row => row.pts), [3, 3, 3]);
  assert.deepEqual(rows.map(row => row.gd), [4, -2, -2]);
});

test('a postponed fixture (still SCHEDULED) does not count', () => {
  const rows = calculateStandings({
    teams: [team('a', 'Alpha'), team('b', 'Bravo')],
    matches: [
      result('a', 'b', 5, 0, '2026-01-01T12:00', { status: 'SCHEDULED' }),
      result('a', 'b', 2, 1, '2026-01-02T12:00')
    ]
  });

  assert.deepEqual(shape(rows), [
    { id: 'a', mp: 1, w: 1, d: 0, l: 0, gf: 2, ga: 1, gd: 1, pts: 3, form: ['W'] },
    { id: 'b', mp: 1, w: 0, d: 0, l: 1, gf: 1, ga: 2, gd: -1, pts: 0, form: ['L'] }
  ]);
});

test('an empty season lists every club with zeroes, sorted by name', () => {
  const rows = calculateStandings({
    teams: [team('c', 'Charlie'), team('a', 'Alpha'), team('b', 'Bravo')],
    matches: []
  });

  assert.deepEqual(rows.map(row => row.team.name), ['Alpha', 'Bravo', 'Charlie']);
  for (const row of rows) {
    assert.deepEqual(shape([row])[0], {
      id: row.team.id, mp: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, gd: 0, pts: 0, form: []
    });
  }
});

test('an archived table excludes clubs that did not play in that season', () => {
  const teams = [team('a', 'Alpha'), team('b', 'Bravo'), team('late', 'Late Joiner')];
  const matches = [
    result('a', 'b', 1, 0, '2026-01-01T12:00'),
    result('a', 'b', 0, 0, '2026-01-02T12:00', { status: 'SCHEDULED' })
  ];

  assert.deepEqual(
    calculateStandings({ teams, matches, archived: true }).map(row => row.team.id).sort(),
    ['a', 'b']
  );
  assert.deepEqual(
    calculateStandings({ teams, matches, archived: false }).map(row => row.team.id).sort(),
    ['a', 'b', 'late']
  );
});

test('Arabic club names are preserved and still ordered by points', () => {
  const rows = calculateStandings({
    teams: [team('ar', 'الأهلي'), team('fr', 'Paris Saint-Germain')],
    matches: [result('ar', 'fr', 2, 0, '2026-01-01T12:00')]
  });

  assert.deepEqual(rows.map(row => row.team.name), ['الأهلي', 'Paris Saint-Germain']);
  assert.deepEqual(rows.map(row => row.team.id), ['ar', 'fr']);
  assert.equal(rows[0].pts, 3);
});

test('form keeps only the last five results in date order', () => {
  const rows = calculateStandings({
    teams: [team('a', 'Alpha'), team('b', 'Bravo')],
    matches: [
      result('a', 'b', 2, 0, '2026-01-01T12:00'),
      result('a', 'b', 1, 1, '2026-01-02T12:00'),
      result('a', 'b', 0, 1, '2026-01-03T12:00'),
      result('a', 'b', 3, 1, '2026-01-04T12:00'),
      result('a', 'b', 1, 0, '2026-01-05T12:00'),
      result('a', 'b', 2, 1, '2026-01-06T12:00')
    ]
  });

  assert.deepEqual(rows.find(row => row.team.id === 'a').form, ['D', 'L', 'W', 'W', 'W']);
});

test('a fixture against a club missing from the table is ignored', () => {
  const rows = calculateStandings({
    teams: [team('a', 'Alpha')],
    matches: [result('a', 'ghost', 5, 0, '2026-01-01T12:00')]
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].mp, 0);
  assert.equal(rows[0].pts, 0);
});

test('calculateStandings tolerates no arguments', () => {
  assert.deepEqual(calculateStandings(), []);
});

test('formatEventMinute drops blank minutes', () => {
  assert.equal(formatEventMinute(12), "12'");
  assert.equal(formatEventMinute('90'), "90'");
  assert.equal(formatEventMinute(0), '');
  assert.equal(formatEventMinute(null), '');
  assert.equal(formatEventMinute(-3), '');
});

test('summarizeEventsForText orders by minute, groups by team and marks cards', () => {
  const players = [{ id: 'p1', name: 'Alice' }, { id: 'p2', name: 'Bob' }];
  const events = [
    { teamId: 'away', playerId: 'p2', type: 'yellow', minute: 40 },
    { teamId: 'home', playerId: 'p1', type: 'goal', minute: 12 },
    { teamId: 'home', playerId: 'p1', type: 'red', minute: 70 },
    { teamId: 'home', playerId: 'p3', type: 'goal', minute: 5 }
  ];

  assert.equal(
    summarizeEventsForText(events, 'home', 'away', players),
    "? 5', Alice 12', Alice 70' (R) - Bob 40' (Y)"
  );
  assert.equal(summarizeEventsForText([], 'home', 'away', players), '');
});
