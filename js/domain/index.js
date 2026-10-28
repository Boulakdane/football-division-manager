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

const KickOffDomain = {
  esc,
  toInt,
  csvEscape,
  contrastTextColor,
  calculateStandings,
  formatEventMinute,
  summarizeEventsForText
};

globalThis.KickOffDomain = KickOffDomain;

export {
  esc,
  toInt,
  csvEscape,
  contrastTextColor,
  calculateStandings,
  formatEventMinute,
  summarizeEventsForText
};
export default KickOffDomain;
