import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { readWorkbook, readSheetNames, XlsxLimitError } from '../server/xlsx.mjs';

// Minimal in-memory xlsx writer: a ZIP archive with the parts the reader needs.
const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
const crc32 = buffer => {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

function zip(parts, { method = 0 } = {}) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(parts)) {
    const plain = Buffer.from(content, 'utf8');
    const data = method === 8 ? deflateRawSync(plain) : plain;
    const nameBuffer = Buffer.from(name, 'utf8');
    const crc = crc32(plain);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(plain.length, 22); local.writeUInt16LE(nameBuffer.length, 26); local.writeUInt16LE(0, 28);
    locals.push(local, nameBuffer, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10); central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(plain.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28); central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuffer);
    offset += 30 + nameBuffer.length + data.length;
  }
  const centralBuffer = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(parts).length, 8);
  end.writeUInt16LE(Object.keys(parts).length, 10); end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuffer, end]);
}

const SHEET = `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
<row r="1"><c r="A1" t="str"><v>Name</v></c><c r="B1" t="str"><v>Count</v></c><c r="C1" t="str"><v>Flag</v></c><c r="D1" t="str"><v>Date</v></c><c r="E1" t="str"><v>Time</v></c><c r="F1" t="str"><v>Note</v></c></row>
<row r="2"><c r="A2" t="s"><v>0</v></c><c r="C2" t="str"><v>False</v></c><c r="D2" s="1"><v>46028.333333333336</v></c><c r="E2" s="1"><v>0.28125</v></c><c r="F2" t="inlineStr"><is><t>inline &amp; escaped</t></is></c></row>
<row r="3"><c r="A3" t="s"><v>1</v></c><c r="B3"><v>42</v></c><c r="C3" t="str"><v>True</v></c></row>
</sheetData></worksheet>`;

const STYLES = `<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt formatCode="dd/MM/yyyy" numFmtId="192"/></numFmts>
<cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="192" applyNumberFormat="1"/></cellXfs></styleSheet>`;

const workbook = zip({
  'xl/workbook.xml': `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet" sheetId="1" r:id="rId1"/></sheets></workbook>`,
  'xl/_rels/workbook.xml.rels': `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"/></Relationships>`,
  'xl/sharedStrings.xml': `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>Shared text</t></si><si><t>Second</t></si></sst>`,
  'xl/styles.xml': STYLES,
  'xl/worksheets/sheet1.xml': SHEET,
});

test('xlsx reader: shared and inline strings, numbers, booleans, dates and times', () => {
  const { header, rows } = readWorkbook(workbook);
  assert.deepEqual(header, ['Name', 'Count', 'Flag', 'Date', 'Time', 'Note']);
  assert.deepEqual(rows[0], ['Shared text', null, 'False', '2026-01-06 08:00:00', '06:45', 'inline & escaped']);
  assert.deepEqual(rows[1], ['Second', '42', 'True', null, null, null]);
  assert.deepEqual(readSheetNames(workbook), ['Sheet']);
});

test('xlsx reader: a buffer that is not a zip fails loudly', () => {
  assert.throws(() => readWorkbook(Buffer.from('not a workbook')), /zip archive/i);
});

test('xlsx reader: deflated entries are inflated', () => {
  // Same workbook written with deflate, exercising the compressed path.
  const parts = {
    'xl/workbook.xml': `<sheets><sheet name="Sheet" sheetId="1" r:id="rId1"/></sheets>`,
    'xl/_rels/workbook.xml.rels': `<Relationship Id="rId1" Target="worksheets/sheet1.xml"/>`,
    'xl/worksheets/sheet1.xml': `<sheetData><row r="1"><c r="A1" t="str"><v>Only</v></c></row><row r="2"><c r="A2"><v>1</v></c></row></sheetData>`,
  };
  const { header, rows } = readWorkbook(zip(parts, { method: 8 }));
  assert.deepEqual(header, ['Only']);
  assert.deepEqual(rows, [['1']]);
});

const worksheet = (body, options) => zip({ 'xl/worksheets/sheet1.xml': body }, options);
const centralOffset = buffer => buffer.readUInt32LE(buffer.length - 6);
const limitError = { name: 'XlsxLimitError', code: 'XLSX_LIMIT_EXCEEDED' };

test('xlsx reader: a workbook at its configured limits still parses', () => {
  const limits = { maxEntries: 5, maxRows: 3, maxCells: 18, maxEntryBytes: Buffer.byteLength(SHEET) };
  assert.deepEqual(readWorkbook(workbook, { sheet: 'Sheet', limits }), readWorkbook(workbook));
});

test('xlsx reader and sheet names reject too many central-directory entries', () => {
  for (const read of [readWorkbook, readSheetNames]) {
    assert.throws(() => read(workbook, { limits: { maxEntries: 1 } }), XlsxLimitError);
  }
});

test('xlsx reader rejects oversized stored entries even with a smaller declared size', () => {
  const buffer = worksheet('x'.repeat(128));
  buffer.writeUInt32LE(1, centralOffset(buffer) + 24);
  buffer.writeUInt32LE(1, 22);
  assert.throws(() => readWorkbook(buffer, { limits: { maxEntryBytes: 64 } }), limitError);
});

test('xlsx reader caps declared and actual deflated bytes', () => {
  const buffer = worksheet('x'.repeat(128), { method: 8 });
  const limits = { maxEntryBytes: 64 };
  assert.throws(() => readWorkbook(buffer, { limits }), limitError);
  buffer.writeUInt32LE(1, centralOffset(buffer) + 24);
  buffer.writeUInt32LE(1, 22);
  assert.throws(() => readWorkbook(buffer, { limits }), limitError);
});

test('xlsx reader caps the cumulative bytes of parts read', () => {
  const buffer = zip({
    'xl/workbook.xml': '<sheets/>',
    'xl/worksheets/sheet1.xml': '<row></row>',
  }, { method: 8 });
  assert.throws(() => readWorkbook(buffer, { limits: { maxTotalBytes: 19 } }), limitError);
  assert.deepEqual(readWorkbook(buffer, { limits: { maxTotalBytes: 20 } }), { header: [], rows: [] });
});

test('xlsx reader rejects too many rows, including the header', () => {
  assert.throws(() => readWorkbook(workbook, { limits: { maxRows: 1 } }), limitError);
});

test('xlsx reader rejects too many cells even at duplicate references', () => {
  const buffer = worksheet('<row><c r="A1"/><c r="A1"><v>1</v></c></row>');
  assert.throws(() => readWorkbook(buffer, { limits: { maxCells: 1 } }), limitError);
});

test('xlsx reader caps sparse references and padding before allocating cells', () => {
  const sparse = worksheet('<row><c r="ZZZZZZZZ1"><v>1</v></c></row>');
  assert.throws(() => readWorkbook(sparse, { limits: { maxCells: 2 } }), limitError);
  const padded = worksheet('<row><c r="B1"><v>1</v></c></row><row></row>');
  assert.throws(() => readWorkbook(padded, { limits: { maxCells: 3 } }), limitError);
});

test('xlsx reader reports malformed central and local offsets as ZIP errors', () => {
  const corruptCentral = Buffer.from(workbook);
  corruptCentral.writeUInt32LE(0xffffffff, corruptCentral.length - 6);
  assert.throws(() => readWorkbook(corruptCentral), { name: 'Error', message: /central directory/ });

  const corruptLocal = Buffer.from(workbook);
  corruptLocal.writeUInt32LE(0xffffffff, centralOffset(corruptLocal) + 42);
  assert.throws(() => readWorkbook(corruptLocal), { name: 'Error', message: /Corrupt zip entry/ });

  const corruptData = Buffer.from(workbook);
  corruptData.writeUInt16LE(0xffff, 28);
  assert.throws(() => readWorkbook(corruptData), { name: 'Error', message: /Corrupt zip entry/ });
});

test('XLSX limits must be positive safe integers', () => {
  for (const read of [readWorkbook, readSheetNames]) {
    for (const maxEntries of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1, '1']) {
      assert.throws(() => read(workbook, { limits: { maxEntries } }), TypeError);
    }
  }
});

test('XLSX readers enforce a deadline during parsing', t => {
  const now = t.mock.method(performance, 'now', () => 0);
  for (const read of [readWorkbook, readSheetNames]) {
    let checks = 0;
    now.mock.mockImplementation(() => checks++ < 2 ? 0 : 2);
    assert.throws(() => read(workbook, { limits: { maxParseMs: 1 } }), limitError);
    assert.equal(checks, 3);
  }
});
