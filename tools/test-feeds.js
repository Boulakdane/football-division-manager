'use strict';

/*
 * Offline tests for the hosted calendar feeds (plan section 22.8, stage 2).
 * No network: the synthetic backup stands in for the public read views.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const { normalizeData, buildFeeds, writeFeeds } = require('./build-feeds');

const root = path.resolve(__dirname, '..');

async function main() {
  const { buildCalendar } = await import(pathToFileURL(path.join(root, 'js', 'domain', 'ics.js')).href);
  const backup = JSON.parse(fs.readFileSync(path.join(root, 'backups', 'synthetic-league-full.json'), 'utf8'));
  const data = normalizeData(backup);

  const first = buildFeeds(data, { buildCalendar });
  const second = buildFeeds(normalizeData(backup), { buildCalendar });

  // Deterministic output: same data in, same bytes out.
  assert.deepStrictEqual([...first.files.entries()], [...second.files.entries()], 'feeds must be deterministic');

  // One file per feed plus the manifest.
  assert.ok(first.files.has('all.ics'), 'all.ics exists');
  assert.ok(first.files.has('division-d1.ics'), 'division feed exists');
  assert.ok(first.files.has('team-t1.ics'), 'team feed exists');
  assert.ok(first.files.has('index.json'), 'manifest exists');

  const all = first.files.get('all.ics');
  assert.ok(all.startsWith('BEGIN:VCALENDAR\r\n'), 'VCALENDAR header');
  assert.ok(all.endsWith('END:VCALENDAR\r\n'), 'VCALENDAR footer');
  assert.ok(all.includes('UID:match-m1@mzab-league.github.io'), 'stable match UID');
  assert.ok(all.includes('DTSTART:20261004T150000'), 'floating local kick-off');
  assert.ok(all.includes('SUMMARY:North FC 2–1 East United'), 'finished score in the summary');
  assert.ok(all.includes('LOCATION:North Stadium'), 'venue as the location');
  assert.ok(all.includes('DTSTAMP:20261012T000000Z'), 'DTSTAMP comes from the data, not the clock');

  const team = first.files.get('team-t1.ics');
  assert.ok(team.includes('UID:match-m1@'), 't1 has its fixture');
  assert.ok(!team.includes('UID:match-m2@'), 't1 does not get another club fixture');

  const manifest = JSON.parse(first.files.get('index.json'));
  assert.strictEqual(manifest.season, 's1');
  assert.strictEqual(manifest.feeds.length, 8, 'all + one division + six teams');
  assert.ok(manifest.feeds.every(feed => feed.file && feed.name), 'every feed is named');

  // Escaping and the all-day / no-date edge cases.
  const edge = normalizeData({
    seasons: [{ id: 's2', name: 'Edge, Season; 2', isActive: true, startDate: '2026-09-01' }],
    teams: [
      { id: 'a', name: 'A, B; C' },
      { id: 'b', name: 'D' }
    ],
    matches: [
      { id: 'e1', seasonId: 's2', round: 1, homeId: 'a', awayId: 'b', status: 'SCHEDULED', datetime: '2026-10-05' },
      { id: 'e2', seasonId: 's2', round: 1, homeId: 'b', awayId: 'a', status: 'SCHEDULED', datetime: '' }
    ]
  });
  const edgeFeed = buildFeeds(edge, { buildCalendar });
  const edgeAll = edgeFeed.files.get('all.ics');
  assert.ok(edgeAll.includes('SUMMARY:A\\, B\\; C vs D'), 'commas and semicolons are escaped');
  assert.ok(edgeAll.includes('DTSTART;VALUE=DATE:20261005'), 'date-only fixture is all-day');
  assert.ok(edgeAll.includes('DTEND;VALUE=DATE:20261006'), 'all-day end is exclusive');
  assert.strictEqual(edgeFeed.manifest.feeds[0].events, 1);
  assert.strictEqual(edgeFeed.manifest.feeds[0].skipped, 1);

  // writeFeeds removes stale files and --check reports them without writing.
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'kickoff-feeds-'));
  try {
    fs.writeFileSync(path.join(out, 'team-gone.ics'), 'stale', 'utf8');
    const report = writeFeeds(out, first.files, true);
    assert.ok(report.stale.includes('team-gone.ics'), 'check mode reports stale files');
    assert.ok(fs.existsSync(path.join(out, 'team-gone.ics')), 'check mode does not delete');
    const written = writeFeeds(out, first.files, false);
    assert.ok(written.changed.includes('all.ics'), 'first write creates files');
    assert.ok(!fs.existsSync(path.join(out, 'team-gone.ics')), 'write mode removes stale files');
    assert.strictEqual(fs.readFileSync(path.join(out, 'all.ics'), 'utf8'), all, 'written bytes match');
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }

  console.log('OK hosted calendar feeds are deterministic, escaped and scoped');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
