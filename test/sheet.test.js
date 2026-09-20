// The xlsx reader parses bytes we did not write, so it gets a real file to
// chew on: the test builds a spec-shaped .xlsx (stored and deflated members,
// shared strings, inline strings, date styles) and reads it back.
const test = require('node:test');
const assert = require('node:assert');
const zlib = require('node:zlib');
const { readXlsx, readDelimited, unzip } = require('../src/sheet.js');

function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return ~c >>> 0;
}

// Minimal zip writer, so the reader is tested against bytes rather than a mock.
function zip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, text, deflate] of files) {
    const data = Buffer.from(text, 'utf8');
    const body = deflate ? zlib.deflateRawSync(data) : data;
    const nameBuf = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, body);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(deflate ? 8 : 0, 10);
    cen.writeUInt32LE(crc32(data), 16);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += local.length + nameBuf.length + body.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

const WORKBOOK = '<workbook><sheets><sheet name="Readings" sheetId="1"/>'
  + '<sheet name="Notes &amp; more" sheetId="2"/></sheets></workbook>';

const STRINGS = '<sst><si><t>sensor</t></si><si><t>value</t></si>'
  + '<si><t>when</t></si><si><r><t>cam</t></r><r><t>-a</t></r></si>'
  + '<si><t>caf&#233; &amp; co</t></si></sst>';

// numFmtId 14 is a built-in date format; style index 1 points at it.
const STYLES = '<styleSheet><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/>'
  + '</cellXfs></styleSheet>';

const SHEET1 = '<worksheet><sheetData>'
  + '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c>'
  + '<c r="C1" t="s"><v>2</v></c></row>'
  + '<row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2"><v>12.4</v></c>'
  + '<c r="C2" s="1"><v>45000</v></c></row>'
  // C skipped entirely, and a boolean, to check column alignment
  + '<row r="3"><c r="A3" t="inlineStr"><is><t>cam-b</t></is></c>'
  + '<c r="B3"><v>9</v></c><c r="D3" t="b"><v>1</v></c></row>'
  + '</sheetData></worksheet>';

const SHEET2 = '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>4</v></c></row>'
  + '</sheetData></worksheet>';

function book() {
  return zip([
    ['xl/workbook.xml', WORKBOOK, false],
    ['xl/sharedStrings.xml', STRINGS, true],
    ['xl/styles.xml', STYLES, true],
    ['xl/worksheets/sheet1.xml', SHEET1, true],
    ['xl/worksheets/sheet2.xml', SHEET2, false],
    ['docProps/app.xml', '<Properties/>', true],
  ]);
}

test('unzip reads both stored and deflated members', () => {
  const members = unzip(book());
  assert.strictEqual(members.get('xl/worksheets/sheet2.xml').toString(), SHEET2, 'stored');
  assert.strictEqual(members.get('xl/styles.xml').toString(), STYLES, 'deflated');
});

test('xlsx: sheets, shared strings, inline strings, numbers, dates', () => {
  const sheets = readXlsx(book());
  assert.deepStrictEqual(sheets.map((s) => s.name), ['Readings', 'Notes & more']);

  const rows = sheets[0].rows;
  assert.deepStrictEqual(rows[0], ['sensor', 'value', 'when']);
  assert.deepStrictEqual(rows[1], ['cam-a', 12.4, '2023-03-15'], 'run-split string, number, date');
  assert.strictEqual(typeof rows[1][1], 'number', 'numbers stay numbers');

  // A gap in the row must shift later cells, not close up.
  assert.deepStrictEqual(rows[2], ['cam-b', 9, '', true]);

  assert.deepStrictEqual(sheets[1].rows[0], ['café & co'], 'entities decode');
});

test('xlsx: a non-zip is refused rather than parsed into nonsense', () => {
  assert.throws(() => readXlsx(Buffer.from('this is not a spreadsheet')), /Not a zip/);
});

test('csv: quotes, doubled quotes, embedded separators and newlines', () => {
  const rows = readDelimited('a,b,c\n1,"two, and a half","he said ""hi"""\n3,"line\nbreak",z\n');
  assert.deepStrictEqual(rows[0], ['a', 'b', 'c']);
  assert.deepStrictEqual(rows[1], ['1', 'two, and a half', 'he said "hi"']);
  assert.deepStrictEqual(rows[2], ['3', 'line\nbreak', 'z']);
});

test('tsv is detected from the header row', () => {
  assert.deepStrictEqual(readDelimited('a\tb\n1\t2\n'), [['a', 'b'], ['1', '2']]);
});

test('csv: trailing newline does not add a phantom row', () => {
  assert.strictEqual(readDelimited('a,b\n1,2\n').length, 2);
  assert.strictEqual(readDelimited('a,b\r\n1,2\r\n').length, 2);
});
