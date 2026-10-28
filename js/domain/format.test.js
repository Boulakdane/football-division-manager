import { test } from 'node:test';
import assert from 'node:assert/strict';

import { esc, toInt, csvEscape, contrastTextColor } from './format.js';

test('esc neutralises XSS payloads and quotes', () => {
  assert.equal(
    esc('<script>alert("x")</script>'),
    '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;'
  );
  assert.equal(esc("<img src=x onerror='steal()'>"),
    '&lt;img src=x onerror=&#39;steal()&#39;&gt;');
  assert.equal(esc('Tom & Jerry'), 'Tom &amp; Jerry');
  assert.equal(esc('&amp;'), '&amp;amp;');
});

test('esc treats null and undefined as an empty string', () => {
  assert.equal(esc(null), '');
  assert.equal(esc(undefined), '');
  assert.equal(esc(0), '0');
  assert.equal(esc(false), 'false');
});

test('toInt accepts numbers and numeric strings, rejects negatives and junk', () => {
  assert.equal(toInt(null), 0);
  assert.equal(toInt(undefined), 0);
  assert.equal(toInt(''), 0);
  assert.equal(toInt('7'), 7);
  assert.equal(toInt(7), 7);
  assert.equal(toInt('12px'), 12);
  assert.equal(toInt(-3), 0);
  assert.equal(toInt('-3'), 0);
  assert.equal(toInt(NaN), 0);
  assert.equal(toInt('abc'), 0);
});

test('toInt uses the fallback only when parsing fails or the value is negative', () => {
  assert.equal(toInt(null, 5), 5);
  assert.equal(toInt(-1, 5), 5);
  assert.equal(toInt('abc', 5), 5);
  assert.equal(toInt(0, 5), 0);
  assert.equal(toInt('7', 5), 7);
});

test('csvEscape quotes separators and doubles quotes', () => {
  assert.equal(csvEscape('plain'), 'plain');
  assert.equal(csvEscape('a,b'), '"a,b"');
  assert.equal(csvEscape('say "hi"'), '"say ""hi"""');
  assert.equal(csvEscape('line\nbreak'), '"line\nbreak"');
  assert.equal(csvEscape(null), '');
});

test('csvEscape defuses formulas but leaves numeric negatives numeric', () => {
  assert.equal(csvEscape('=1+1'), "'=1+1");
  assert.equal(csvEscape('+cmd'), "'+cmd");
  assert.equal(csvEscape('-cmd'), "'-cmd");
  assert.equal(csvEscape('@sum'), "'@sum");
  assert.equal(csvEscape('\tcmd'), "'\tcmd");
  assert.equal(csvEscape(-3), '-3');
});

test('contrastTextColor picks a readable foreground', () => {
  assert.equal(contrastTextColor('#000000'), '#ffffff');
  assert.equal(contrastTextColor('#ffffff'), '#020617');
  assert.equal(contrastTextColor('#fff'), '#020617');
  assert.equal(contrastTextColor('3b82f6'), '#020617');
  assert.equal(contrastTextColor('not-a-colour'), '#ffffff');
  assert.equal(contrastTextColor(null), '#ffffff');
});
