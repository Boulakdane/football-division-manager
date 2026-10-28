#!/usr/bin/env node
/*
 * Dual-run test for roadmap item E.
 *
 * Seeds the same fixtures into an in-memory Postgres (PGlite + supabase/schema.sql),
 * reads public.v_standings, and compares every row with the pure
 * js/domain/standings.js implementation: order, position, played, W/D/L, goals,
 * goal difference, points and form.
 *
 * Scenarios:
 *   1. an active division: points, goal difference, goals scored, a postponed
 *      (still SCHEDULED) fixture that must not count, and an Arabic club name;
 *   2. an empty division: every current club appears with zeroes;
 *   3. an archived season: only clubs that actually played are listed.
 *
 * The name tie-breaker is covered by the Node unit tests. Nothing here ties on
 * every earlier criterion, because Postgres and ICU collations can order Arabic
 * names differently even when both implementations are correct.
 *
 * Usage: npm run test:standings-dual
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { PGlite } = require('@electric-sql/pglite');

const ROOT = path.resolve(__dirname, '..');

async function mockAuth(db) {
  await db.exec(`
    create schema auth;
    create table auth.users (id uuid primary key, email text);
    create or replace function auth.uid() returns uuid
      language sql stable
      as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
    create or replace function auth.jwt() returns jsonb
      language sql stable
      as $$ select coalesce(nullif(current_setting('test.jwt', true), '')::jsonb, '{}'::jsonb) $$;
    create role anon;
    create role authenticated;
  `);
}

const TEAMS = {
  d3: [
    { id: 'dt1', name: 'Domain One', code: 'DM1', color: '#111111' },
    { id: 'dt2', name: 'Domain Two', code: 'DM2', color: '#222222' },
    { id: 'dt3', name: 'Domain Three', code: 'DM3', color: '#333333' },
    { id: 'dt4', name: 'الأهلي', code: 'AHL', color: '#444444' },
    { id: 'dt_late', name: 'Late Joiner', code: 'LAT', color: '#555555' }
  ],
  d4: [
    { id: 'dq1', name: 'Delta Quay', code: 'DLQ', color: '#666666' },
    { id: 'dq2', name: 'Echo Quay', code: 'ECQ', color: '#777777' }
  ]
};

const MATCHES = {
  s_dom: [
    { id: 'md1', home: 'dt1', away: 'dt2', hs: 2, as: 0, status: 'FINISHED', datetime: '2026-03-01T15:00' },
    { id: 'md2', home: 'dt1', away: 'dt3', hs: 1, as: 0, status: 'FINISHED', datetime: '2026-03-02T15:00' },
    { id: 'md3', home: 'dt4', away: 'dt1', hs: 1, as: 0, status: 'FINISHED', datetime: '2026-03-03T15:00' },
    { id: 'md4', home: 'dt2', away: 'dt3', hs: 3, as: 0, status: 'FINISHED', datetime: '2026-03-04T15:00' },
    { id: 'md5', home: 'dt2', away: 'dt4', hs: 1, as: 0, status: 'FINISHED', datetime: '2026-03-05T15:00' },
    { id: 'md6', home: 'dt3', away: 'dt4', hs: 2, as: 1, status: 'FINISHED', datetime: '2026-03-06T15:00' },
    // Postponed fixture: the app has no POSTPONED status, so it stays SCHEDULED
    // and a score on it must be ignored.
    { id: 'md7', home: 'dt4', away: 'dt3', hs: 5, as: 0, status: 'SCHEDULED', datetime: '2026-03-07T15:00' }
  ],
  s_arc: [
    { id: 'ma1', home: 'dt1', away: 'dt2', hs: 1, as: 0, status: 'FINISHED', datetime: '2025-03-01T15:00' },
    { id: 'ma2', home: 'dt2', away: 'dt3', hs: 1, as: 1, status: 'FINISHED', datetime: '2025-03-02T15:00' },
    { id: 'ma3', home: 'dt3', away: 'dt4', hs: 2, as: 0, status: 'FINISHED', datetime: '2025-03-03T15:00' }
  ]
};

const toJsMatch = match => ({
  id: match.id,
  homeId: match.home,
  awayId: match.away,
  homeScore: match.hs,
  awayScore: match.as,
  status: match.status,
  datetime: match.datetime
});

function jsRowsFor(teams, matches, archived) {
  return calculateStandings({ teams, matches, archived }).map((row, index) => ({
    team_id: row.team.id,
    team_name: row.team.name,
    position: index + 1,
    played: row.mp,
    won: row.w,
    drawn: row.d,
    lost: row.l,
    goals_for: row.gf,
    goals_against: row.ga,
    goal_difference: row.gd,
    points: row.pts,
    form: row.form
  }));
}

let calculateStandings;

async function run() {
  ({ calculateStandings } = await import(
    pathToFileURL(path.join(ROOT, 'js/domain/standings.js')).href
  ));

  const db = new PGlite();
  const exec = sql => db.exec(sql);
  const q = async (sql, params) => (await db.query(sql, params)).rows;

  const tableFor = async (seasonId, divisionId) => q(
    `select team_id, team_name, position, played, won, drawn, lost,
            goals_for, goals_against, goal_difference, points, form
       from public.v_standings
      where season_id = $1 and division_id = $2
      order by position`,
    [seasonId, divisionId]
  );

  try {
    await mockAuth(db);
    await exec(fs.readFileSync(path.join(ROOT, 'supabase/schema.sql'), 'utf8'));

    await exec(`
      update public.seasons set is_active = false;
      insert into public.seasons (id, name, is_active) values
        ('s_dom', 'Domain Dual', true),
        ('s_arc', 'Domain Archive', false);

      insert into public.divisions (id, name, sort_order) values
        ('d3', 'Domain Division', 3),
        ('d4', 'Empty Division', 4);

      insert into public.teams (id, name, code, color, division_id) values
        ${TEAMS.d3.map(t => `('${t.id}', '${t.name}', '${t.code}', '${t.color}', 'd3')`).join(',\n        ')},
        ${TEAMS.d4.map(t => `('${t.id}', '${t.name}', '${t.code}', '${t.color}', 'd4')`).join(',\n        ')};

      insert into public.matches
        (id, season_id, division_id, round, home_id, away_id, home_score, away_score, status, datetime)
      values
        ${MATCHES.s_dom.map((m, i) =>
          `('${m.id}', 's_dom', 'd3', ${i + 1}, '${m.home}', '${m.away}', ${m.hs}, ${m.as}, '${m.status}', '${m.datetime}')`
        ).join(',\n        ')},
        ${MATCHES.s_arc.map((m, i) =>
          `('${m.id}', 's_arc', 'd3', ${i + 1}, '${m.home}', '${m.away}', ${m.hs}, ${m.as}, '${m.status}', '${m.datetime}')`
        ).join(',\n        ')};
    `);

    // ------------------------------------------------------------
    // 1. Active division: points, GD, GF, postponed fixture, Arabic name
    // ------------------------------------------------------------
    const sqlActive = await tableFor('s_dom', 'd3');
    const jsActive = jsRowsFor(
      TEAMS.d3.map(t => ({ id: t.id, name: t.name })),
      MATCHES.s_dom.map(toJsMatch),
      false
    );

    assert.strictEqual(sqlActive.length, 5, 'all five current Division 3 clubs should appear');
    assert.deepStrictEqual(jsActive, sqlActive, 'active division: JS and SQL tables must match');
    assert.deepStrictEqual(
      sqlActive.map(row => row.team_id),
      ['dt2', 'dt1', 'dt4', 'dt3', 'dt_late'],
      'points, then GD, then goals scored should decide the order'
    );
    assert.strictEqual(sqlActive.find(row => row.team_id === 'dt3').played, 3,
      'the postponed fixture must not count as played');
    assert.strictEqual(sqlActive.find(row => row.team_id === 'dt4').team_name, 'الأهلي',
      'an Arabic club name should survive the round trip');
    console.log('OK active division: JS and SQL standings agree (points, GD, GF, postponed, Arabic name)');

    // ------------------------------------------------------------
    // 2. Empty division: every current club appears with zeroes
    // ------------------------------------------------------------
    const sqlEmpty = await tableFor('s_dom', 'd4');
    const jsEmpty = jsRowsFor(
      TEAMS.d4.map(t => ({ id: t.id, name: t.name })),
      [],
      false
    );

    assert.strictEqual(sqlEmpty.length, 2, 'both empty-division clubs should appear');
    assert.deepStrictEqual(jsEmpty, sqlEmpty, 'empty division: JS and SQL tables must match');
    assert.deepStrictEqual(sqlEmpty.map(row => row.team_id), ['dq1', 'dq2']);
    assert.ok(sqlEmpty.every(row => row.played === 0 && row.points === 0 && row.form.length === 0));
    console.log('OK empty division: JS and SQL agree on zero rows and name order');

    // ------------------------------------------------------------
    // 3. Archived season: only clubs that played are listed
    // ------------------------------------------------------------
    const sqlArchived = await tableFor('s_arc', 'd3');
    const jsArchived = jsRowsFor(
      TEAMS.d3.map(t => ({ id: t.id, name: t.name })),
      MATCHES.s_arc.map(toJsMatch),
      true
    );

    assert.deepStrictEqual(jsArchived, sqlArchived, 'archived season: JS and SQL tables must match');
    assert.deepStrictEqual(sqlArchived.map(row => row.team_id), ['dt3', 'dt1', 'dt2', 'dt4']);
    assert.ok(
      !sqlArchived.some(row => row.team_id === 'dt_late'),
      'a club that joined later must not enter an archived table'
    );
    console.log('OK archived season: JS and SQL agree and exclude the late joiner');

    console.log('\nAll standings dual-run checks passed.');
  } finally {
    await db.close();
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
