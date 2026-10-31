import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCalendar,
  escapeIcsText,
  foldIcsLine,
  icsStamp,
  parseFixtureStart
} from './ics.js';

const NOW = new Date('2026-10-31T09:00:00Z');

function event(overrides) {
  return {
    uid: 'match-m1@mzab-league.github.io',
    start: '2026-11-07T15:30',
    summary: 'Spartan FC vs Titan United',
    location: 'Stade de Ghardaia',
    description: 'Division 1 · Round 3',
    ...overrides
  };
}

const physicalLines = text => text.split('\r\n');

test('every line ends with CRLF and the file ends with one', () => {
  const { text } = buildCalendar({ name: 'Test', events: [event()], now: NOW });
  assert.equal(text.endsWith('\r\n'), true);
  assert.equal(/[^\r]\n/.test(text), false, 'no bare LF anywhere');
  assert.equal(text.startsWith('BEGIN:VCALENDAR\r\n'), true);
  assert.equal(text.includes('\r\nEND:VCALENDAR\r\n'), true);
});

test('the header carries the product id and the calendar name', () => {
  const { text } = buildCalendar({ name: 'Mzab League — Division 1', description: 'Fixtures', events: [], now: NOW });
  const lines = physicalLines(text);
  assert.ok(lines.includes('VERSION:2.0'));
  assert.ok(lines.includes('PRODID:-//Mzab League//Mzab League//EN'));
  assert.ok(lines.includes('CALSCALE:GREGORIAN'));
  assert.ok(lines.includes('METHOD:PUBLISH'));
  assert.ok(lines.includes('X-WR-CALNAME:Mzab League — Division 1'));
  assert.ok(lines.includes('X-WR-CALDESC:Fixtures'));
  assert.equal(text.includes('BEGIN:VEVENT'), false);
});

test('separators, backslashes and newlines in values are escaped', () => {
  assert.equal(escapeIcsText('a,b;c\\d'), 'a\\,b\\;c\\\\d');
  assert.equal(escapeIcsText('line one\nline two'), 'line one\\nline two');
  assert.equal(escapeIcsText('crlf\r\nand cr'), 'crlf\\nand cr');

  const { text } = buildCalendar({
    name: 'Test',
    events: [event({ summary: 'Alpha, Beta; Gamma\\Delta' })],
    now: NOW
  });
  assert.ok(text.includes('SUMMARY:Alpha\\, Beta\\; Gamma\\\\Delta'));
  assert.equal(physicalLines(text).filter(line => line.startsWith('SUMMARY:')).length, 1);
});

test('a long Arabic summary is folded at 75 octets and survives unfolding', () => {
  const summary = 'البطولة المحلية للفرق المزابية — مباراة الأسبوع بين فريق سبارتان وفريق تايتان يونايتد';
  const { text } = buildCalendar({ name: 'بطولة', events: [event({ summary })], now: NOW });

  for (const line of physicalLines(text)) {
    assert.ok(
      new TextEncoder().encode(line).length <= 75,
      `line over 75 octets: ${line}`
    );
  }

  // Unfolding (RFC 5545 3.1) must give the original value back.
  const unfolded = text.replace(/\r\n /g, '');
  assert.ok(unfolded.includes(`SUMMARY:${summary}`));
  assert.ok(text.includes('\r\n '), 'at least one continuation line');
});

test('a fixture time becomes floating local time, never UTC', () => {
  assert.deepEqual(parseFixtureStart('2026-11-07T15:30'), { allDay: false, value: '20261107T153000' });
  assert.deepEqual(parseFixtureStart('2026-11-07T15:30:45'), { allDay: false, value: '20261107T153045' });
  assert.deepEqual(parseFixtureStart('2026-11-07'), { allDay: true, value: '20261107' });
  assert.equal(parseFixtureStart(''), null);
  assert.equal(parseFixtureStart('not a date'), null);
  assert.equal(parseFixtureStart(null), null);

  const { text } = buildCalendar({ name: 'Test', events: [event()], now: NOW });
  assert.ok(text.includes('\r\nDTSTART:20261107T153000\r\n'));
  assert.equal(/DTSTART:[^\r]*Z/.test(text), false, 'no UTC suffix on DTSTART');
  assert.ok(text.includes('\r\nDURATION:PT120M\r\n'));
});

test('a date without a time becomes an all-day event with an exclusive end', () => {
  const { text, written } = buildCalendar({
    name: 'Test',
    events: [event({ start: '2026-12-31' })],
    now: NOW
  });
  assert.equal(written, 1);
  assert.ok(text.includes('\r\nDTSTART;VALUE=DATE:20261231\r\n'));
  assert.ok(text.includes('\r\nDTEND;VALUE=DATE:20270101\r\n'));
  assert.equal(text.includes('DURATION:'), false);
});

test('a custom duration is honoured', () => {
  const { text } = buildCalendar({
    name: 'Test',
    events: [event({ durationMinutes: 90 })],
    now: NOW
  });
  assert.ok(text.includes('\r\nDURATION:PT90M\r\n'));
});

test('undated fixtures are skipped and counted, not written', () => {
  const { text, written, skipped } = buildCalendar({
    name: 'Test',
    events: [
      event({ uid: 'a@x', start: '2026-11-07T15:30' }),
      event({ uid: 'b@x', start: '' }),
      event({ uid: 'c@x', start: 'soon' }),
      event({ uid: '', start: '2026-11-08T15:30' })
    ],
    now: NOW
  });
  assert.equal(written, 1);
  assert.equal(skipped, 3);
  assert.equal(physicalLines(text).filter(line => line === 'BEGIN:VEVENT').length, 1);
  assert.ok(text.includes('UID:a@x'));
  assert.equal(text.includes('UID:b@x'), false);
});

test('each event keeps its own stable UID', () => {
  const { text } = buildCalendar({
    name: 'Test',
    events: [
      event({ uid: 'match-m1@mzab-league.github.io' }),
      event({ uid: 'match-m2@mzab-league.github.io', start: '2026-11-08T15:30' })
    ],
    now: NOW
  });
  assert.ok(text.includes('UID:match-m1@mzab-league.github.io'));
  assert.ok(text.includes('UID:match-m2@mzab-league.github.io'));
  assert.equal(physicalLines(text).filter(line => line.startsWith('UID:')).length, 2);
});

test('the same input gives the same file; only DTSTAMP follows now', () => {
  const first = buildCalendar({ name: 'Test', events: [event()], now: NOW }).text;
  const second = buildCalendar({ name: 'Test', events: [event()], now: NOW }).text;
  assert.equal(first, second);
  assert.ok(first.includes('DTSTAMP:20261031T090000Z'));

  const later = buildCalendar({ name: 'Test', events: [event()], now: new Date('2026-11-01T00:00:00Z') }).text;
  assert.equal(later.replace('20261101T000000Z', '20261031T090000Z'), first);
  assert.equal(icsStamp(new Date('2026-01-02T03:04:05Z')), '20260102T030405Z');
});

test('line folding never splits a line that already fits', () => {
  const short = 'SUMMARY:Spartan FC vs Titan United';
  assert.equal(foldIcsLine(short), short);
  assert.equal(foldIcsLine(short).includes('\r\n'), false);
});
