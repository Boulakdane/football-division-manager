/* ---------------------------------------------------------------
   KickOff Division — squad import (Excel / CSV)
   Reads a team's player list from an .xlsx or CSV file and checks every
   row, so the admin sees a preview before anything is saved.

   - No third-party library: an .xlsx file is a ZIP of XML files, read here
     with the browser's built-in DecompressionStream. This keeps the CSP at
     script-src 'self' and adds no supply-chain risk.
   - Pure data in, data out (no DOM). The same file runs in the browser
     (window.SquadImport) and in Node tests (require).
   - The database re-validates everything in public.add_players(); this
     file only gives fast, friendly feedback.
   --------------------------------------------------------------- */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SquadImport = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const LIMITS = {
    fileBytes: 5 * 1024 * 1024,      // refuse bigger uploads outright
    entryBytes: 10 * 1024 * 1024,    // max size of one unzipped XML part
    rows: 2000,                      // rows read from a sheet
    columns: 60,
    players: 100                     // must match add_players()
  };

  /** Error with a stable code the UI can translate. */
  function importError(code, detail) {
    const error = new Error(code + (detail ? ': ' + detail : ''));
    error.code = code;
    return error;
  }

  /* ------------------------------ text helpers ------------------------------ */

  /** Lower-case, strip accents and punctuation: "Numéro de maillot" -> "numerodemaillot". */
  function norm(value) {
    return String(value == null ? '' : value)
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[آأإ]/g, 'ا')       // alef variants
      .replace(/[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g, '') // Arabic marks, tatweel
      .toLowerCase()
      .replace(/[^a-z0-9؀-ۿ]+/g, '');
  }

  function cleanName(value) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  }

  function decodeEntities(text) {
    return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, function (match, body) {
      switch (body) {
        case 'amp': return '&';
        case 'lt': return '<';
        case 'gt': return '>';
        case 'quot': return '"';
        case 'apos': return "'";
        default: {
          const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
          return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
        }
      }
    });
  }

  function parseAttributes(text) {
    const attrs = {};
    const pattern = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let match;
    while ((match = pattern.exec(text))) attrs[match[1]] = decodeEntities(match[2] !== undefined ? match[2] : match[3]);
    return attrs;
  }

  /* ------------------------------ ZIP reader ------------------------------ */

  function readZipEntries(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let eocd = -1;
    const lowest = Math.max(0, bytes.length - 22 - 65535);
    for (let i = bytes.length - 22; i >= lowest; i--) {
      if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw importError('NOT_XLSX');

    const count = view.getUint16(eocd + 10, true);
    let offset = view.getUint32(eocd + 16, true);
    if (count === 0xffff || offset === 0xffffffff) throw importError('NOT_XLSX', 'zip64');

    const entries = new Map();
    const decoder = new TextDecoder('utf-8');
    for (let n = 0; n < count; n++) {
      if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) throw importError('NOT_XLSX');
      const flags = view.getUint16(offset + 8, true);
      const method = view.getUint16(offset + 10, true);
      const compressedSize = view.getUint32(offset + 20, true);
      const size = view.getUint32(offset + 24, true);
      const nameLength = view.getUint16(offset + 28, true);
      const extraLength = view.getUint16(offset + 30, true);
      const commentLength = view.getUint16(offset + 32, true);
      const localOffset = view.getUint32(offset + 42, true);
      const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
      entries.set(name, { name, flags, method, compressedSize, size, localOffset });
      offset += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
  }

  async function inflateRaw(data, limit) {
    if (typeof DecompressionStream === 'undefined') throw importError('NO_DECOMPRESSION');
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    const reader = stream.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const step = await reader.read();
      if (step.done) break;
      total += step.value.length;
      if (total > limit) {          // zip-bomb guard: stop before memory grows
        await reader.cancel();
        throw importError('TOO_LARGE');
      }
      chunks.push(step.value);
    }
    const out = new Uint8Array(total);
    let position = 0;
    for (const chunk of chunks) { out.set(chunk, position); position += chunk.length; }
    return out;
  }

  async function readEntry(bytes, entry) {
    if (entry.flags & 1) throw importError('ENCRYPTED');
    if (entry.size > LIMITS.entryBytes) throw importError('TOO_LARGE');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const local = entry.localOffset;
    if (local + 30 > bytes.length || view.getUint32(local, true) !== 0x04034b50) throw importError('NOT_XLSX');
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + entry.compressedSize);
    if (entry.method === 0) return data;
    if (entry.method === 8) return inflateRaw(data, LIMITS.entryBytes);
    throw importError('NOT_XLSX', 'compression ' + entry.method);
  }

  async function readText(bytes, entries, name) {
    const entry = entries.get(name);
    if (!entry) return null;
    return new TextDecoder('utf-8').decode(await readEntry(bytes, entry));
  }

  /* ------------------------------ XLSX reader ------------------------------ */

  const P = '(?:[A-Za-z0-9_]+:)?'; // optional XML namespace prefix

  function parseSharedStrings(xml) {
    const strings = [];
    const items = new RegExp('<' + P + 'si\\b[^>]*>([\\s\\S]*?)</' + P + 'si>', 'g');
    const texts = new RegExp('<' + P + 't\\b[^>]*>([\\s\\S]*?)</' + P + 't>', 'g');
    let item;
    while ((item = items.exec(xml))) {
      const body = item[1].replace(new RegExp('<' + P + 'rPh\\b[\\s\\S]*?</' + P + 'rPh>', 'g'), '');
      let text = '';
      let part;
      texts.lastIndex = 0;
      while ((part = texts.exec(body))) text += decodeEntities(part[1]);
      strings.push(text);
    }
    return strings;
  }

  function columnIndex(letters) {
    let index = 0;
    for (const char of letters) index = index * 26 + (char.charCodeAt(0) - 64);
    return index - 1;
  }

  function parseSheet(xml, shared) {
    const grid = [];
    const rowPattern = new RegExp('<' + P + 'row\\b([^>]*?)(?:/>|>([\\s\\S]*?)</' + P + 'row>)', 'g');
    const cellPattern = new RegExp('<' + P + 'c\\b([^>]*?)(?:/>|>([\\s\\S]*?)</' + P + 'c>)', 'g');
    const valuePattern = new RegExp('<' + P + 'v\\b[^>]*>([\\s\\S]*?)</' + P + 'v>');
    const inlinePattern = new RegExp('<' + P + 'is\\b[^>]*>([\\s\\S]*?)</' + P + 'is>');
    const textPattern = new RegExp('<' + P + 't\\b[^>]*>([\\s\\S]*?)</' + P + 't>', 'g');

    let rowMatch;
    let sequential = 0;
    while ((rowMatch = rowPattern.exec(xml))) {
      sequential += 1;
      const rowAttrs = parseAttributes(rowMatch[1]);
      const rowNumber = Number(rowAttrs.r) || sequential;
      if (rowNumber > LIMITS.rows) break;
      while (grid.length < rowNumber - 1) grid.push([]);
      const cells = [];
      const body = rowMatch[2] || '';
      let cellMatch;
      cellPattern.lastIndex = 0;
      let position = 0;
      while ((cellMatch = cellPattern.exec(body))) {
        const attrs = parseAttributes(cellMatch[1]);
        const ref = /^([A-Z]+)\d+$/.exec(attrs.r || '');
        const column = ref ? columnIndex(ref[1]) : position;
        position = column + 1;
        if (column >= LIMITS.columns) continue;
        const inner = cellMatch[2] || '';
        let value = '';
        if (attrs.t === 'inlineStr') {
          const inline = inlinePattern.exec(inner);
          let part;
          textPattern.lastIndex = 0;
          while (inline && (part = textPattern.exec(inline[1]))) value += decodeEntities(part[1]);
        } else {
          const raw = valuePattern.exec(inner);
          const text = raw ? decodeEntities(raw[1]) : '';
          if (attrs.t === 's') value = shared[Number(text)] !== undefined ? shared[Number(text)] : '';
          else if (attrs.t === 'b') value = text === '1' ? 'TRUE' : 'FALSE';
          else if (attrs.t === 'e') value = '';
          else value = text;
        }
        while (cells.length < column) cells.push('');
        cells[column] = String(value).trim();
      }
      grid.push(cells);
    }
    return grid;
  }

  async function readWorkbook(bytes) {
    const entries = readZipEntries(bytes);
    if (!entries.has('xl/workbook.xml')) throw importError('NOT_XLSX');

    const workbook = await readText(bytes, entries, 'xl/workbook.xml');
    const rels = (await readText(bytes, entries, 'xl/_rels/workbook.xml.rels')) || '';
    const targets = {};
    const relPattern = new RegExp('<' + P + 'Relationship\\b([^>]*?)/?>', 'g');
    let rel;
    while ((rel = relPattern.exec(rels))) {
      const attrs = parseAttributes(rel[1]);
      if (attrs.Id && attrs.Target) {
        targets[attrs.Id] = attrs.Target.charAt(0) === '/' ? attrs.Target.slice(1) : 'xl/' + attrs.Target;
      }
    }

    const sheets = [];
    const sheetPattern = new RegExp('<' + P + 'sheet\\b([^>]*?)/?>', 'g');
    let sheet;
    while ((sheet = sheetPattern.exec(workbook))) {
      const attrs = parseAttributes(sheet[1]);
      const target = targets[attrs['r:id']] || targets[attrs.id];
      if (!target || (attrs.state && attrs.state !== 'visible')) continue;
      sheets.push({ name: attrs.name || '', path: target });
    }
    if (!sheets.length) throw importError('NOT_XLSX');

    const sharedXml = await readText(bytes, entries, 'xl/sharedStrings.xml');
    const shared = sharedXml ? parseSharedStrings(sharedXml) : [];

    const result = [];
    for (const item of sheets) {
      const xml = await readText(bytes, entries, item.path);
      if (xml) result.push({ name: item.name, rows: parseSheet(xml, shared) });
    }
    return result;
  }

  /* ------------------------------ CSV reader ------------------------------ */

  function decodeText(bytes) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (error) {
      // Excel's plain "CSV (Comma delimited)" is Windows-1252 in French locales.
      return new TextDecoder('windows-1252').decode(bytes);
    }
  }

  function parseDelimited(text) {
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const firstLine = (text.split(/\r\n|\n|\r/).find(line => line.trim() !== '') || '');
    const stripped = firstLine.replace(/"[^"]*"/g, '');
    const candidates = [',', ';', '\t'];
    let delimiter = ',';
    let best = -1;
    for (const candidate of candidates) {
      const found = stripped.split(candidate).length - 1;
      if (found > best) { best = found; delimiter = candidate; }
    }

    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (quoted) {
        if (char === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
        } else field += char;
      } else if (char === '"') quoted = true;
      else if (char === delimiter) { row.push(field.trim()); field = ''; }
      else if (char === '\n' || char === '\r') {
        if (char === '\r' && text[i + 1] === '\n') i++;
        row.push(field.trim());
        rows.push(row);
        row = [];
        field = '';
        if (rows.length >= LIMITS.rows) break;
      } else field += char;
    }
    if (field !== '' || row.length) { row.push(field.trim()); rows.push(row); }
    return rows;
  }

  /* ------------------------------ file entry point ------------------------------ */

  /**
   * Read a File/Blob/ArrayBuffer and return candidate sheets: [{ name, rows }].
   * Throws importError(code) with: TOO_LARGE, XLS_UNSUPPORTED, NOT_XLSX, ENCRYPTED, NO_DECOMPRESSION, EMPTY.
   */
  async function readFile(file) {
    const buffer = file.arrayBuffer ? await file.arrayBuffer() : file;
    const bytes = new Uint8Array(buffer);
    if (bytes.length > LIMITS.fileBytes) throw importError('TOO_LARGE');
    if (!bytes.length) throw importError('EMPTY');

    if (bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) {
      throw importError('XLS_UNSUPPORTED');   // legacy binary .xls
    }
    if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
      return readWorkbook(bytes);
    }
    return [{ name: 'CSV', rows: parseDelimited(decodeText(bytes)) }];
  }

  /* ------------------------------ table detection ------------------------------ */

  const HEADERS = {
    name: ['name', 'fullname', 'playername', 'player', 'nom', 'nomcomplet', 'nomdujoueur', 'joueur',
      'nometprenom', 'nomprenom', 'prenomnom', 'nometprenoms', 'الاسم', 'اسم',
      'اسماللاعب', 'اللاعب'],
    pos: ['pos', 'position', 'poste', 'role', 'المركز', 'مركز'],
    num: ['num', 'number', 'no', 'nr', 'n', 'shirt', 'shirtnumber', 'shirtno', 'jersey', 'jerseynumber',
      'numero', 'nmaillot', 'ndemaillot', 'nodemaillot', 'nonumero', 'numeromaillot', 'numerodemaillot', 'dossard', 'maillot', 'الرقم',
      'رقم', 'رقمالقميص'],
    goals: ['goals', 'goal', 'buts', 'but', 'الاهداف', 'اهداف'],
    yellow: ['yellow', 'yellows', 'yellowcards', 'yellowcard', 'jaune', 'jaunes', 'cartonjaune', 'cartonsjaunes',
      'بطاقةصفراء', 'بطاقاتصفراء', 'انذار', 'إنذار'],
    red: ['red', 'reds', 'redcards', 'redcard', 'rouge', 'rouges', 'cartonrouge', 'cartonsrouges',
      'بطاقةحمراء', 'بطاقاتحمراء', 'طرد', 'احمر', 'أحمر']
  };

  /** Find the header row (within the first rows) and map field -> column index. */
  function detectTable(rows) {
    const lookup = {};
    Object.keys(HEADERS).forEach(function (field) {
      HEADERS[field].forEach(function (alias) { lookup[alias] = field; });
    });

    for (let r = 0; r < Math.min(rows.length, 15); r++) {
      const columns = {};
      (rows[r] || []).forEach(function (cell, index) {
        const field = lookup[norm(cell)];
        if (field && columns[field] === undefined) columns[field] = index;
      });
      if (columns.name !== undefined) return { headerRow: r, columns };
    }
    return null;
  }

  /* ------------------------------ row validation ------------------------------ */

  const POSITIONS = {
    GK: ['gk', 'g', 'gb', 'gardien', 'gardiendebut', 'goalkeeper', 'keeper', 'portier', 'حارس',
      'حارسمرمى', 'حارسالمرمى'],
    DEF: ['def', 'df', 'd', 'defenseur', 'defender', 'defense', 'arriere', 'lateral', 'centralback', 'cb',
      'مدافع', 'دفاع'],
    MID: ['mid', 'mf', 'm', 'milieu', 'milieudeterrain', 'midfielder', 'midfield', 'وسط',
      'لاعبوسط', 'محور'],
    FWD: ['fwd', 'fw', 'f', 'a', 'att', 'attaquant', 'avant', 'forward', 'striker', 'attacker', 'winger',
      'ailier', 'مهاجم', 'هجوم']
  };

  const POSITION_LOOKUP = {};
  Object.keys(POSITIONS).forEach(function (code) {
    POSITIONS[code].forEach(function (alias) { POSITION_LOOKUP[alias] = code; });
  });

  /** "Goalkeeper", "gardien", "حارس", "Defender (DEF)" -> GK/DEF/MID/FWD, or null. */
  function normalizePosition(value) {
    const direct = POSITION_LOOKUP[norm(value)];
    if (direct) return direct;
    const code = /\b(gk|def|mid|fwd)\b/i.exec(String(value));
    return code ? code[1].toUpperCase() : null;
  }

  /** Whole number from "7", "07", "7.0", "#7", "N°7", "7." — or null. */
  function parseWhole(value) {
    const text = String(value == null ? '' : value).trim();
    const match = /^\D{0,3}(\d{1,4})(?:[.,]0+)?\D{0,2}$/.exec(text);
    return match ? parseInt(match[1], 10) : null;
  }

  function nameKey(name) {
    return cleanName(name).toLowerCase();
  }

  /**
   * Check the rows of one sheet against the team's current squad.
   * existing: [{ name, num, isActive }] of the team (archived players are ignored).
   * Returns { rows, counts, toAdd, canImport, headerFound }.
   * Each row: { line, name, pos, num, goals, yellow, red, status, issues:[{level, code, params}] }
   *   status: 'ok' | 'warn' | 'skip' (already in squad) | 'error'
   */
  function validateSquad(rows, existing) {
    const table = detectTable(rows);
    if (!table) return { headerFound: false, rows: [], counts: { total: 0, ok: 0, warn: 0, skip: 0, error: 0 }, toAdd: [], canImport: false };

    const squad = (existing || []).filter(function (player) { return player.isActive !== false; });
    const squadNames = new Set(squad.map(function (player) { return nameKey(player.name); }));
    const takenNumbers = new Map();
    squad.forEach(function (player) { if (player.num != null) takenNumbers.set(Number(player.num), player.name); });

    const seenInFile = new Map();
    const out = [];
    const cell = function (row, field) {
      const index = table.columns[field];
      return index === undefined ? '' : String(row[index] == null ? '' : row[index]).trim();
    };

    for (let r = table.headerRow + 1; r < rows.length; r++) {
      const row = rows[r] || [];
      if (!row.some(function (value) { return String(value).trim() !== ''; })) continue;

      const issues = [];
      const add = function (level, code, params) { issues.push({ level: level, code: code, params: params || {} }); };
      const name = cleanName(cell(row, 'name'));
      const entry = { line: r + 1, name: name, pos: 'MID', num: 10, goals: 0, yellow: 0, red: 0, status: 'ok', issues: issues };

      if (!name) add('error', 'nameMissing');
      else if (name.length > 100) add('error', 'nameTooLong');

      const posText = cell(row, 'pos');
      if (!posText) {
        add('warn', 'posMissing');
      } else {
        const pos = normalizePosition(posText);
        if (pos) entry.pos = pos;
        else add('error', 'posInvalid', { value: posText });
      }

      const numText = cell(row, 'num');
      if (!numText) {
        add('warn', 'numMissing');
      } else {
        const num = parseWhole(numText);
        if (num === null || num < 1 || num > 99) add('error', 'numInvalid', { value: numText });
        else entry.num = num;
      }

      ['goals', 'yellow', 'red'].forEach(function (field) {
        const text = cell(row, field);
        if (!text) return;
        const value = parseWhole(text);
        if (value === null) add('error', 'totalInvalid', { field: field, value: text });
        else entry[field] = value;
      });

      if (name) {
        const key = nameKey(name);
        if (seenInFile.has(key)) add('error', 'duplicateInFile', { line: seenInFile.get(key) });
        else seenInFile.set(key, r + 1);
        if (squadNames.has(key)) add('skip', 'alreadyInSquad');
      }

      if (!issues.some(function (i) { return i.level === 'error' || i.level === 'skip'; }) && numText) {
        const holder = takenNumbers.get(entry.num);
        if (holder !== undefined) add('warn', 'numTaken', { num: entry.num, player: holder });
      }
      if (!issues.some(function (i) { return i.level === 'error'; }) && numText) {
        if (!takenNumbers.has(entry.num)) takenNumbers.set(entry.num, name);
      }

      entry.status = issues.some(function (i) { return i.level === 'error'; }) ? 'error'
        : issues.some(function (i) { return i.level === 'skip'; }) ? 'skip'
        : issues.some(function (i) { return i.level === 'warn'; }) ? 'warn' : 'ok';
      out.push(entry);
    }

    const toAdd = out.filter(function (e) { return e.status === 'ok' || e.status === 'warn'; });
    if (toAdd.length > LIMITS.players) {
      out.forEach(function (e, index) {
        if ((e.status === 'ok' || e.status === 'warn') && toAdd.indexOf(e) >= LIMITS.players) {
          e.issues.push({ level: 'error', code: 'tooManyRows', params: { max: LIMITS.players } });
          e.status = 'error';
        }
      });
    }

    const counts = { total: out.length, ok: 0, warn: 0, skip: 0, error: 0 };
    out.forEach(function (e) { counts[e.status] += 1; });
    const finalAdd = out.filter(function (e) { return e.status === 'ok' || e.status === 'warn'; });
    return {
      headerFound: true,
      rows: out,
      counts: counts,
      toAdd: finalAdd.map(function (e) {
        return { name: e.name, pos: e.pos, num: e.num, goals: e.goals, yellow: e.yellow, red: e.red };
      }),
      canImport: counts.error === 0 && finalAdd.length > 0
    };
  }

  /** Pick the first sheet that has a recognisable header, validate it. */
  function analyze(sheets, existing) {
    for (const sheet of sheets) {
      if (detectTable(sheet.rows)) {
        const result = validateSquad(sheet.rows, existing);
        result.sheetName = sheet.name;
        return result;
      }
    }
    return { headerFound: false, rows: [], counts: { total: 0, ok: 0, warn: 0, skip: 0, error: 0 }, toAdd: [], canImport: false, sheetName: '' };
  }

  /**
   * A blank, header-only CSV template for the current language.
   * French Excel splits comma-separated files badly, so French uses ';'.
   * The BOM keeps accents and Arabic readable when Excel opens the file.
   */
  const TEMPLATE_HEADERS = {
    en: ['Name', 'Position', 'Number', 'Goals', 'Yellow', 'Red'],
    fr: ['Nom', 'Poste', 'Numéro', 'Buts', 'Jaunes', 'Rouges'],
    ar: ['الاسم', 'المركز', 'الرقم', 'الأهداف', 'بطاقات صفراء', 'بطاقات حمراء']
  };

  function template(lang) {
    const code = TEMPLATE_HEADERS[lang] ? lang : 'en';
    const delimiter = code === 'fr' ? ';' : ',';
    return {
      lang: code,
      filename: 'kickoff_squad_template_' + code + '.csv',
      mime: 'text/csv;charset=utf-8',
      text: '\ufeff' + TEMPLATE_HEADERS[code].join(delimiter) + '\r\n'
    };
  }

  return {
    LIMITS: LIMITS,
    readFile: readFile,
    analyze: analyze,
    validateSquad: validateSquad,
    detectTable: detectTable,
    normalizePosition: normalizePosition,
    parseWhole: parseWhole,
    template: template,
    _internal: { readWorkbook: readWorkbook, parseDelimited: parseDelimited, parseSheet: parseSheet, parseSharedStrings: parseSharedStrings, decodeText: decodeText, norm: norm }
  };
});
