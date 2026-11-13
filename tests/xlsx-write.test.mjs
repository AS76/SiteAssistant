import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { writeWorkbook } from '../server/xlsx-write.mjs';
import { readWorkbook, readSheetNames } from '../server/xlsx.mjs';

test('XLSX writer: text round-trip, XML entities, accents, whitespace and formula-like text', () => {
  const rows = [
    ['Text & <tag> > "quoted"', 'Città, perché è già così', 'Empty', 'Literal'],
    ["'apostrophe' &amp;", ' \tline\nnext\rline ', '', '=SUM(A1:A2)'],
    ['😀', '001', '2026-11-01', '+123'],
  ];
  const buffer = writeWorkbook(rows, { sheetName: 'Test & "à"' });
  assert.ok(Buffer.isBuffer(buffer));
  const result = readWorkbook(buffer);
  assert.deepEqual([result.header, ...result.rows], rows);
  assert.deepEqual(readSheetNames(buffer), ['Test & "à"']);
  assert.deepEqual(readSheetNames(writeWorkbook([])), ['Sheet1']);
  assert.deepEqual(readWorkbook(writeWorkbook([])), { header: [], rows: [] });
});

test('XLSX writer: column references extend past Z and preserve trailing empty text', () => {
  const rows = [Array.from({ length: 54 }, (_, i) => `Column ${i}`), Array.from({ length: 54 }, (_, i) => i === 53 ? '' : String(i))];
  const result = readWorkbook(writeWorkbook(rows));
  assert.deepEqual([result.header, ...result.rows], rows);
});

test('XLSX writer: forbidden XML characters are rejected rather than corrupting text', () => {
  for (const value of ['\0', '\x01', '\x0b', '\x0c', '\x1f', '\ufffe', '\uffff', '\ud800']) {
    assert.throws(() => writeWorkbook([[value]]), /forbidden by XML/);
    assert.throws(() => writeWorkbook([['ok']], { sheetName: value }), /forbidden by XML/);
  }
  assert.throws(() => writeWorkbook([[42]]), /must be strings/);
  for (const sheetName of ['', 'x'.repeat(32), 'bad/name', 'bad:name', "'bad"]) {
    assert.throws(() => writeWorkbook([], { sheetName }), /Invalid XLSX sheet name/);
  }
});

test('XLSX writer: exactly five deflated ZIP parts, valid CRCs and no styles, formulas or shared strings', () => {
  const buffer = writeWorkbook([['&<>"', '=1+1']]), end = buffer.length - 22;
  assert.equal(buffer.readUInt32LE(end), 0x06054b50);
  assert.equal(buffer.readUInt16LE(end + 8), 5);
  assert.equal(buffer.readUInt16LE(end + 10), 5);
  let offset = buffer.readUInt32LE(end + 16);
  const directoryStart = offset, parts = new Map();
  for (let i = 0; i < 5; i++) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50);
    assert.equal(buffer.readUInt16LE(offset + 10), 8);
    const nameLength = buffer.readUInt16LE(offset + 28), name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    const local = buffer.readUInt32LE(offset + 42), size = buffer.readUInt32LE(offset + 20);
    assert.equal(buffer.readUInt32LE(local), 0x04034b50);
    assert.equal(buffer.readUInt16LE(local + 8), 8);
    const start = local + 30 + buffer.readUInt16LE(local + 26);
    const data = inflateRawSync(buffer.subarray(start, start + size));
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    assert.equal(buffer.readUInt32LE(local + 14), crc);
    assert.equal(buffer.readUInt32LE(offset + 16), crc);
    assert.equal(buffer.readUInt32LE(offset + 24), data.length);
    assert.equal(buffer.readUInt32LE(local + 22), data.length);
    assert.equal(buffer.readUInt32LE(local + 18), size);
    parts.set(name, data.toString('utf8'));
    offset += 46 + nameLength;
  }
  assert.equal(offset, end);
  assert.equal(buffer.readUInt32LE(end + 12), offset - directoryStart);
  assert.deepEqual([...parts.keys()], ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/worksheets/sheet1.xml']);
  const sheet = parts.get('xl/worksheets/sheet1.xml');
  assert.match(sheet, /&amp;&lt;&gt;&quot;/);
  assert.match(sheet, /t="inlineStr"/);
  assert.doesNotMatch(sheet, /<f[\s>]|<v[\s>]|<cols[\s>]|\ss="/);
  assert.match(parts.get('_rels/.rels'), /Target="xl\/workbook.xml"/);
  assert.match(parts.get('xl/_rels/workbook.xml.rels'), /Target="worksheets\/sheet1.xml"/);
});
