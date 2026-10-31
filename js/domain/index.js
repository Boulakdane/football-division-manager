/*
 * The browser-facing surface of the domain layer.
 *
 * js/app.js stays a classic script because the Playwright suite calls its
 * globals from page.evaluate. This module publishes the same helpers on
 * globalThis.KickOffDomain; app.js can then look them up at call time instead
 * of re-declaring them. Loading it is deferred, so nothing may read the
 * namespace at classic-script top level — call it after DOMContentLoaded.
 */
import { esc, toInt, csvEscape, contrastTextColor } from './format.js';
import {
  calculateStandings,
  formatEventMinute,
  summarizeEventsForText
} from './standings.js';
import {
  buildRoundRobin,
  dateKeyToUtc,
  formatDateKey,
  generateFixtures,
  shiftRounds
} from './schedule.js';
import { buildCalendar } from './ics.js';

const KickOffDomain = {
  esc,
  toInt,
  csvEscape,
  contrastTextColor,
  calculateStandings,
  formatEventMinute,
  summarizeEventsForText,
  buildRoundRobin,
  dateKeyToUtc,
  formatDateKey,
  generateFixtures,
  shiftRounds,
  buildCalendar
};

globalThis.KickOffDomain = KickOffDomain;

// js/app.js calls these helpers as bare globals. Keep those call sites
// unchanged now that the implementations live here. calculateStandings and
// summarizeEventsForText stay on the namespace because app.js keeps thin
// adapters that inject appState.
globalThis.esc = esc;
globalThis.toInt = toInt;
globalThis.csvEscape = csvEscape;
globalThis.contrastTextColor = contrastTextColor;
globalThis.formatEventMinute = formatEventMinute;

export {
  esc,
  toInt,
  csvEscape,
  contrastTextColor,
  calculateStandings,
  formatEventMinute,
  summarizeEventsForText,
  buildRoundRobin,
  dateKeyToUtc,
  formatDateKey,
  generateFixtures,
  shiftRounds,
  buildCalendar
};
export default KickOffDomain;
