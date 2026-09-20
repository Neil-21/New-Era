'use strict';
// Reading .xlsx without a dependency. An xlsx is a ZIP of XML, and we only need
// two members out of it, so a minimal central-directory reader plus zlib is a
// lot less surface than a spreadsheet library.
//
// ponytail: handles the shapes real exports produce - shared strings, inline
// strings, numbers, and the 1900 date system. Formulas are read as their cached
// value, which is what you want when you are looking at data. No styles, no
// merged-cell expansion, no .xls (that is a different, binary format).
const zlib = require('node:zlib');

const EOCD = 0x06054b50;
const CEN = 0x02014b50;

function findEOCD(buf) {
  const min = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD) return i;
  }
  return -1;
}

// Returns a Map of member name -> Buffer for the members `want` accepts.
function unzip(buf, want = () => true) {
  const eocd = findEOCD(buf);
  if (eocd < 0) throw new Error('Not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  const out = new Map();

  for (let i = 0; i < count; i++) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== CEN) break;
    const method = buf.readUInt16LE(at + 10);
    const compSize = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const localAt = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nameLen);
    at += 46 + nameLen + extraLen + commentLen;

    if (!want(name)) continue;
    // The local header repeats the name and extra fields with its own lengths.
    const lNameLen = buf.readUInt16LE(localAt + 26);
    const lExtraLen = buf.readUInt16LE(localAt + 28);
    const start = localAt + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + compSize);
    out.set(name, method === 0 ? raw : zlib.inflateRawSync(raw));
  }
  return out;
}

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decode(text) {
  return text.replace(/&(#x?[0-9a-f]+|\w+);/gi, (whole, code) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X'
        ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

// <si> may hold one <t>, or several inside <r> runs; concatenate either way.
function sharedStrings(xml) {
  if (!xml) return [];
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) => {
    const parts = [...m[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => decode(t[1]));
    return parts.join('');
  });
}

function colIndex(ref) {
  let n = 0;
  for (const ch of ref.replace(/\d+$/, '')) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// Excel's epoch, with the famous 1900 leap-year bug baked in.
function excelDate(serial) {
  const ms = Math.round((serial - 25569) * 86400000);
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? serial : d.toISOString().slice(0, 10);
}

function parseSheet(xml, strings, dateCols) {
  const rows = [];
  for (const rowM of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    for (const c of rowM[1].matchAll(/<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1];
      const inner = c[2] || '';
      const ref = (attrs.match(/r="([A-Z]+\d+)"/) || [])[1];
      const type = (attrs.match(/t="(\w+)"/) || [])[1];
      const style = Number((attrs.match(/s="(\d+)"/) || [])[1]);
      const at = ref ? colIndex(ref) : cells.length;

      let value = '';
      if (type === 'inlineStr') {
        value = [...inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => decode(t[1])).join('');
      } else {
        const v = inner.match(/<v>([\s\S]*?)<\/v>/);
        const raw = v ? decode(v[1]) : '';
        if (type === 's') value = strings[Number(raw)] ?? '';
        else if (type === 'b') value = raw === '1';
        else if (raw === '') value = '';
        else if (/^-?[\d.]+(e[-+]?\d+)?$/i.test(raw)) {
          const n = Number(raw);
          value = dateCols.has(style) ? excelDate(n) : n;
        } else value = raw;
      }
      while (cells.length < at) cells.push('');
      cells[at] = value;
    }
    rows.push(cells);
  }
  return rows;
}

// Which cell styles are dates, so 45000 does not show up where a date should.
function dateStyles(stylesXml) {
  const out = new Set();
  if (!stylesXml) return out;
  const custom = new Set();
  for (const m of stylesXml.matchAll(/<numFmt[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g)) {
    if (/[dmy]/i.test(m[2]) && !/[[]/.test(m[2])) custom.add(m[1]);
  }
  const xfs = stylesXml.match(/<cellXfs[\s\S]*?<\/cellXfs>/);
  if (!xfs) return out;
  [...xfs[0].matchAll(/<xf\b[^>]*>/g)].forEach((xf, i) => {
    const id = (xf[0].match(/numFmtId="(\d+)"/) || [])[1];
    if (!id) return;
    const n = Number(id);
    // 14-22 and 45-47 are Excel's built-in date and time formats.
    if ((n >= 14 && n <= 22) || (n >= 45 && n <= 47) || custom.has(id)) out.add(i);
  });
  return out;
}

function readXlsx(buf) {
  const members = unzip(buf, (n) => n.startsWith('xl/worksheets/')
    || n === 'xl/sharedStrings.xml' || n === 'xl/styles.xml' || n === 'xl/workbook.xml');

  const strings = sharedStrings(members.get('xl/sharedStrings.xml')?.toString('utf8'));
  const dateCols = dateStyles(members.get('xl/styles.xml')?.toString('utf8'));

  const names = [...(members.get('xl/workbook.xml')?.toString('utf8') || '')
    .matchAll(/<sheet\b[^>]*name="([^"]*)"/g)].map((m) => decode(m[1]));

  const sheetFiles = [...members.keys()]
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));

  return sheetFiles.map((file, i) => ({
    name: names[i] || `Sheet${i + 1}`,
    rows: parseSheet(members.get(file).toString('utf8'), strings, dateCols),
  }));
}

// CSV / TSV with quoted fields, doubled quotes and embedded newlines.
function readDelimited(text, delim) {
  const sep = delim || (text.split('\n', 1)[0].includes('\t') ? '\t' : ',');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === sep) { row.push(field); field = ''; continue; }
    if (ch === '\n') {
      row.push(field.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      field = '';
      continue;
    }
    field += ch;
  }
  if (field !== '' || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
  return rows.filter((r) => r.length > 1 || r[0] !== '');
}

module.exports = { readXlsx, readDelimited, unzip };
