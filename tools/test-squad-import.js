'use strict';
// Parser tests for js/squad-import.js (no dependencies). Run: npm run test:squad-import
const fs = require('fs');
const path = require('path');
const SI = require('../js/squad-import.js');

const dir = path.join(__dirname, '..', 'tests', 'fixtures');
const load = name => new Uint8Array(fs.readFileSync(path.join(dir, name)));
let failed = 0;
function check(label, ok, extra) {
  if (ok) console.log('  ok   ' + label);
  else { failed += 1; console.log('  FAIL ' + label + (extra ? ' -> ' + JSON.stringify(extra) : '')); }
}
const existing = [{ name: 'David Silva', num: 8, isActive: true }, { name: 'Old Timer', num: 3, isActive: false }];

(async () => {
  let r = SI.analyze(await SI.readFile(load('squad-en.xlsx')), []);
  check('EN xlsx: header found, 4 rows ok', r.headerFound && r.counts.ok === 4 && r.canImport, r.counts);
  check('EN: name whitespace collapsed', r.toAdd[1].name === 'Yacine Brahimi', r.toAdd[1]);
  check('EN: Midfielder -> MID, "04" -> 4', r.toAdd[1].pos === 'MID' && r.toAdd[3].num === 4, r.toAdd);
  check('EN: totals read', r.toAdd[0].goals === 3 && r.toAdd[0].yellow === 1);

  for (const f of ['squad-fr-title.xlsx', 'squad-fr-libreoffice.xlsx']) {
    r = SI.analyze(await SI.readFile(load(f)), []);
    check(f + ': title rows skipped, 4 players', r.headerFound && r.toAdd.length === 4, r.counts);
    const gk = r.toAdd.find(p => p.pos === 'GK');
    check(f + ': Arabic name + position', gk && gk.name === 'محمد الأمين' && gk.num === 16, r.toAdd);
    check(f + ': Attaquant/Milieu/Défenseur mapped', ['FWD', 'MID', 'DEF'].every(c => r.toAdd.some(p => p.pos === c)));
  }

  r = SI.analyze(await SI.readFile(load('squad-bad.xlsx')), existing);
  const codes = r.rows.map(x => x.issues.map(i => i.code).join('|'));
  check('bad: blocks import', !r.canImport && r.counts.error >= 4, r.counts);
  check('bad: empty name', codes[1].includes('nameMissing'), codes);
  check('bad: invalid position', codes[2].includes('posInvalid'), codes);
  check('bad: number out of range', codes[3].includes('numInvalid'), codes);
  check('bad: duplicate in file', codes[4].includes('duplicateInFile'), codes);
  check('bad: already in squad is skipped, not error', r.rows[5].status === 'skip', r.rows[5]);
  check('bad: shirt number clash is a warning', r.rows[6].status === 'warn' && codes[6].includes('numTaken'), r.rows[6]);

  r = SI.analyze(await SI.readFile(load('squad-semicolon.csv')), []);
  check('csv: semicolon + cp1252 + quoted delimiter', r.toAdd.length === 2 && r.toAdd[0].name === 'Amine Gouiri' && r.toAdd[1].name === 'Zinedine; Jr' && r.toAdd[1].pos === 'MID', r.toAdd);

  r = SI.analyze([{ name: 'x', rows: [['foo', 'bar'], ['a', 'b']] }], []);
  check('no header -> headerFound false', r.headerFound === false && !r.canImport);

  const many = [['name', 'pos', 'num']];
  for (let i = 0; i < 101; i++) many.push(['P' + i, 'MID', (i % 99) + 1]);
  r = SI.validateSquad(many, []);
  check('more than 100 players blocked', !r.canImport && r.rows.some(x => x.issues.some(i => i.code === 'tooManyRows')), r.counts);

  const rejects = async (label, bytes, code) => {
    try { await SI.readFile(bytes); check(label, false); } catch (e) { check(label, e.code === code, e.code); }
  };
  await rejects('legacy .xls refused', new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0, 0]), 'XLS_UNSUPPORTED');
  await rejects('broken zip refused', new Uint8Array([0x50, 0x4b, 1, 2, 3, 4, 5, 6]), 'NOT_XLSX');
  await rejects('empty file refused', new Uint8Array(0), 'EMPTY');
  await rejects('oversize refused', new Uint8Array(SI.LIMITS.fileBytes + 1), 'TOO_LARGE');

  console.log(failed ? '\n' + failed + ' check(s) failed' : '\nAll squad-import checks passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
