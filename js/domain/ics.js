/*
 * RFC 5545 (.ics) calendar builder shared by the browser and the Node tests.
 *
 * No DOM and no network: the caller passes plain fixture data plus already
 * translated labels, and gets back a complete VCALENDAR text with the number
 * of events written and the number of fixtures skipped for having no date.
 *
 * Deliberate choices:
 *   * floating local time (no trailing Z, no TZID) — a local league plays at
 *     wall-clock times that must not shift when a supporter travels;
 *   * CRLF line endings and 75-octet folding, both required by RFC 5545, and
 *     folding counts UTF-8 octets so Arabic names stay valid;
 *   * every text value is escaped, so a club name containing a comma or a
 *     semicolon cannot break the file structure.
 */

const CRLF = '\r\n';
const MAX_OCTETS = 75;
const PRODUCT_ID = '-//Mzab League//Mzab League//EN';
const DEFAULT_DURATION_MINUTES = 120;

const encoder = new TextEncoder();
const octets = value => encoder.encode(value).length;

/** Escape one RFC 5545 TEXT value (backslash first, then separators and newlines). */
export function escapeIcsText(value) {
  return String(value == null ? '' : value)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/** Fold one content line so every physical line is at most 75 octets. */
export function foldIcsLine(line) {
  const text = String(line);
  if (octets(text) <= MAX_OCTETS) return text;

  const parts = [];
  let current = '';
  for (const character of text) {
    if (octets(current + character) > MAX_OCTETS) {
      parts.push(current);
      // Continuation lines start with one space, which counts in the limit.
      current = ' ' + character;
      continue;
    }
    current += character;
  }
  parts.push(current);
  return parts.join(CRLF);
}

/** UTC stamp for DTSTAMP: 20261031T090000Z. */
export function icsStamp(value) {
  const date = value instanceof Date ? value : new Date(value == null ? Date.now() : value);
  if (isNaN(date.getTime())) throw new Error('Invalid date for DTSTAMP');
  const pad = part => String(part).padStart(2, '0');
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/;

/**
 * Read the stored fixture datetime ('2026-11-07T15:30' or '2026-11-07').
 * Returns null when there is no usable date, so the caller can skip the match.
 */
export function parseFixtureStart(value) {
  const match = DATE_TIME.exec(String(value == null ? '' : value).trim());
  if (!match) return null;
  const [, year, month, day, hours, minutes, seconds] = match;
  if (!hours) return { allDay: true, value: `${year}${month}${day}` };
  return {
    allDay: false,
    value: `${year}${month}${day}T${hours}${minutes}${seconds || '00'}`
  };
}

/** The next calendar day, for the exclusive DTEND of an all-day event. */
function nextDay(compactDate) {
  const year = Number(compactDate.slice(0, 4));
  const month = Number(compactDate.slice(4, 6)) - 1;
  const day = Number(compactDate.slice(6, 8));
  const date = new Date(Date.UTC(year, month, day + 1));
  const pad = part => String(part).padStart(2, '0');
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`;
}

/** One VEVENT as a list of unfolded content lines, or null when it has no date. */
function renderEvent(event, stamp) {
  const start = parseFixtureStart(event.start);
  if (!start || !event.uid) return null;

  const lines = [
    'BEGIN:VEVENT',
    `UID:${escapeIcsText(event.uid)}`,
    `DTSTAMP:${stamp}`
  ];

  if (start.allDay) {
    lines.push(`DTSTART;VALUE=DATE:${start.value}`);
    lines.push(`DTEND;VALUE=DATE:${nextDay(start.value)}`);
  } else {
    lines.push(`DTSTART:${start.value}`);
    const minutes = Number.isFinite(event.durationMinutes) && event.durationMinutes > 0
      ? Math.round(event.durationMinutes)
      : DEFAULT_DURATION_MINUTES;
    lines.push(`DURATION:PT${minutes}M`);
  }

  lines.push(`SUMMARY:${escapeIcsText(event.summary)}`);
  if (event.description) lines.push(`DESCRIPTION:${escapeIcsText(event.description)}`);
  if (event.location) lines.push(`LOCATION:${escapeIcsText(event.location)}`);
  lines.push('STATUS:CONFIRMED');
  lines.push('END:VEVENT');

  return lines;
}

/**
 * Build a complete VCALENDAR.
 *
 * @param {object} options
 * @param {string} options.name             human title shown in the calendar app
 * @param {string} [options.description]    one-line description
 * @param {Array}  options.events           { uid, start, summary, description, location, durationMinutes }
 * @param {Date|string} [options.now]       DTSTAMP source, injectable for tests
 * @returns {{ text: string, written: number, skipped: number }}
 */
export function buildCalendar(options) {
  const config = options || {};
  const events = Array.isArray(config.events) ? config.events : [];
  const stamp = icsStamp(config.now);

  const blocks = events
    .map(event => renderEvent(event, stamp))
    .filter(Boolean);

  const head = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${PRODUCT_ID}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeIcsText(config.name || 'Calendar')}`
  ];
  if (config.description) head.push(`X-WR-CALDESC:${escapeIcsText(config.description)}`);

  // Fold every content line on its own; folding the joined document would
  // break lines at arbitrary octet offsets inside a property.
  const lines = [...head, ...blocks.flat(), 'END:VCALENDAR'].map(foldIcsLine);

  return {
    text: lines.join(CRLF) + CRLF,
    written: blocks.length,
    skipped: events.length - blocks.length
  };
}
