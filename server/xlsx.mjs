// Minimal XLSX reader: a workbook is a zip of XML parts. This module reads the first
// worksheet (or a named one) without third-party packages, which keeps the runtime
// dependency-free. It handles the subset used by the planning exports: shared and inline
// strings, numbers, booleans, and date-formatted numeric cells.
import { inflateRawSync } from 'node:zlib';

const EOCD = 0x06054b50, CENTRAL = 0x02014b50, LOCAL = 0x04034b50;

function entries(buffer) {
  let eocd = -1;
  for (let offset = buffer.length - 22; offset >= 0 && offset > buffer.length - 66000; offset--) {
    if (buffer.readUInt32LE(offset) === EOCD) { eocd = offset; break; }
  }
  if (eocd < 0) throw new Error('Not a zip archive (no end-of-central-directory record).');
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let index = 0; index < count; index++) {
    if (buffer.readUInt32LE(offset) !== CENTRAL) throw new Error('Corrupt zip central directory.');
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    files.set(name, { method, compressedSize, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

function readEntry(buffer, files, name) {
  const entry = files.get(name);
  if (!entry) return null;
  const local = entry.localOffset;
  if (buffer.readUInt32LE(local) !== LOCAL) throw new Error(`Corrupt zip entry ${name}.`);
  const nameLength = buffer.readUInt16LE(local + 26);
  const extraLength = buffer.readUInt16LE(local + 28);
  const start = local + 30 + nameLength + extraLength;
  const raw = buffer.subarray(start, start + entry.compressedSize);
  return entry.method === 0 ? raw : inflateRawSync(raw);
}

const unescape = value => value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const textOf = xml => {
  let out = '';
  for (const match of xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) out += unescape(match[1]);
  return out;
};

function sharedStrings(xml) {
  if (!xml) return [];
  return [...xml.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)].map(match => textOf(match[1]));
}

// Built-in number formats that render as dates (ECMA-376 §18.8.30).
const DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57]);
function dateStyles(xml) {
  if (!xml) return new Set();
  const custom = new Map();
  // Attributes may appear in any order; read them independently.
  for (const match of xml.matchAll(/<numFmt\s[^>]*>/g)) {
    const id = /numFmtId="(\d+)"/.exec(match[0]);
    const code = /formatCode="([^"]*)"/.exec(match[0]);
    if (!id || !code) continue;
    const plain = code[1].replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '');
    if (/[ymdhs]/i.test(plain)) custom.set(Number(id[1]), true);
  }
  const styles = new Set();
  const cellXfs = /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml);
  if (!cellXfs) return styles;
  const formats = [...cellXfs[1].matchAll(/<xf[^>]*numFmtId="(\d+)"/g)].map(match => Number(match[1]));
  formats.forEach((format, index) => { if (DATE_FORMATS.has(format) || custom.has(format)) styles.add(index); });
  return styles;
}

// Excel serial date: 1899-12-30 epoch, no leap-year bug for 1900-03+.
function timeOfDay(value) {
  const seconds = Math.round((value - Math.floor(value)) * 86400) % 86400;
  const pad = number => String(number).padStart(2, '0');
  return `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor((seconds % 3600) / 60))}`;
}

function serialToIso(value) {
  const milliseconds = Math.round((value - 25569) * 86400 * 1000);
  return new Date(milliseconds).toISOString().slice(0, 19).replace('T', ' ');
}

function decodeCell(cell, shared, dates) {
  const type = (/\st="([^"]+)"/.exec(cell) || [])[1];
  const style = Number((/\ss="(\d+)"/.exec(cell) || [])[1] || -1);
  if (type === 'inlineStr') {
    const inline = /<is(?:\s[^>]*)?>([\s\S]*?)<\/is>/.exec(cell);
    return inline ? textOf(inline[1]) : null;
  }
  const value = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(cell);
  if (!value) return null;
  const raw = unescape(value[1]);
  if (type === 's') return shared[Number(raw)] ?? null;
  if (type === 'b') return raw === '1' ? 'True' : 'False';
  if (type === 'str') return raw;
  // Formula cells carry the cached value; numbers may need a date conversion.
  if (dates.has(style) && Number.isFinite(Number(raw)) && Number(raw) > 0) {
    // Values below one are clock times (planning start/finish), not dates.
    return Number(raw) < 1 ? timeOfDay(Number(raw)) : serialToIso(Number(raw));
  }
  return raw;
}

function columnIndex(reference) {
  const letters = /^([A-Z]+)/.exec(reference)[1];
  let index = 0;
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
}

function sheetPath(workbook, rels, wanted) {
  const sheets = [...workbook.matchAll(/<sheet[^>]*name="([^"]*)"[^>]*r:id="([^"]*)"/g)];
  const chosen = wanted ? sheets.find(match => match[1] === wanted) : sheets[0];
  if (!chosen) return null;
  const map = new Map([...rels.matchAll(/<Relationship[^>]*Id="([^"]*)"[^>]*Target="([^"]*)"/g)].map(match => [match[1], match[2]]));
  const target = map.get(chosen[2]);
  if (!target) return null;
  return target.startsWith('/') ? target.slice(1) : `xl/${target}`;
}

export function readWorkbook(buffer, { sheet } = {}) {
  const files = entries(buffer);
  const shared = sharedStrings(readEntry(buffer, files, 'xl/sharedStrings.xml')?.toString('utf8'));
  const dates = dateStyles(readEntry(buffer, files, 'xl/styles.xml')?.toString('utf8'));
  const workbook = readEntry(buffer, files, 'xl/workbook.xml')?.toString('utf8') || '';
  const rels = readEntry(buffer, files, 'xl/_rels/workbook.xml.rels')?.toString('utf8') || '';
  const path = sheetPath(workbook, rels, sheet) || 'xl/worksheets/sheet1.xml';
  const xml = readEntry(buffer, files, path)?.toString('utf8');
  if (!xml) throw new Error(`Worksheet ${path} not found.`);
  const rows = [];
  for (const rowMatch of xml.matchAll(/<row(?:\s[^>]*)?>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    for (const cellMatch of rowMatch[1].matchAll(/<c\s[^>]*>[\s\S]*?<\/c>|<c\s[^>]*\/>/g)) {
      const cell = cellMatch[0];
      const reference = /\sr="([A-Z]+)\d+"/.exec(cell);
      const index = reference ? columnIndex(reference[1]) : cells.length;
      while (cells.length < index) cells.push(null);
      cells[index] = decodeCell(cell, shared, dates);
    }
    rows.push(cells);
  }
  const header = rows.length ? rows[0].map(value => value ?? null) : [];
  // Trailing empty cells are omitted in the XML; pad every row to the header width.
  return { header, rows: rows.slice(1).map(row => row.length < header.length
    ? [...row, ...Array(header.length - row.length).fill(null)] : row) };
}

export const readSheetNames = buffer => {
  const files = entries(buffer);
  const workbook = readEntry(buffer, files, 'xl/workbook.xml')?.toString('utf8') || '';
  return [...workbook.matchAll(/<sheet[^>]*name="([^"]*)"/g)].map(match => unescape(match[1]));
};
