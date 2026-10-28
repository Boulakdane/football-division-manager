/*
 * DOM-free formatting helpers shared by the browser and the Node tests.
 *
 * These were lifted out of js/app.js unchanged. Keep the behaviour byte for
 * byte: rendering and the CSV exports depend on it.
 */

/** Escape user-supplied strings before injecting them into HTML. */
export function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

/** Pick black or white text for a team colour with WCAG-friendly contrast. */
export function contrastTextColor(color) {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(color || '').trim());
  if (!match) return '#ffffff';
  let hex = match[1];
  if (hex.length === 3) hex = hex.split('').map(char => char + char).join('');
  const channel = index => parseInt(hex.slice(index, index + 2), 16) / 255;
  const linear = value => value <= 0.03928
    ? value / 12.92
    : Math.pow((value + 0.055) / 1.055, 2.4);
  const luminance = 0.2126 * linear(channel(0)) +
    0.7152 * linear(channel(2)) +
    0.0722 * linear(channel(4));
  return luminance > 0.179 ? '#020617' : '#ffffff';
}

/**
 * Parse a non-negative integer. Negative values and NaN fall back, which keeps
 * scores, minutes and counters safe even when the database returns a string.
 */
export function toInt(value, fallback) {
  const n = parseInt(value, 10);
  return isNaN(n) || n < 0 ? (fallback || 0) : n;
}

/**
 * Quote one CSV cell and defuse spreadsheet formula injection. A string that
 * starts with = + - @ tab or newline gets a leading apostrophe; numbers are
 * left alone so negative scores stay numeric.
 */
export function csvEscape(value) {
  let text = String(value == null ? '' : value);
  // Stop spreadsheet formula execution when an exported cell begins with a
  // formula marker. Numeric values are left untouched so negative scores stay numeric.
  if (typeof value === 'string' && /^[=+\-@\t\r\n]/.test(text)) {
    text = "'" + text;
  }
  return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}
