// Minimal XLSX reader: a workbook is a zip of XML parts. This module reads the first
// worksheet (or a named one) without third-party packages, which keeps the runtime
// dependency-free. It handles the subset used by the planning exports: shared and inline
// strings, numbers, booleans, and date-formatted numeric cells.
import { inflateRawSync } from 'node:zlib';

const EOCD = 0x06054b50, CENTRAL = 0x02014b50, LOCAL = 0x04034b50;

export class XlsxLimitError extends Error {
  constructor() {
    super('Workbook exceeds the supported size or complexity.');
    this.name = 'XlsxLimitError';
    this.code = 'XLSX_LIMIT_EXCEEDED';
  }
}

export const XLSX_LIMITS = Object.freeze({
  maxEntries: 1024,
  maxEntryBytes: 32 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxRows: 100000,
  maxCells: 2000000,
  maxParseMs: 10000,
});

function parseBudget(overrides) {
  if (overrides !== undefined && (!overrides || typeof overrides !== 'object' || Array.isArray(overrides))) {
    throw new TypeError('XLSX limits must be an object.');
  }
  const limits = { ...XLSX_LIMITS, ...overrides };
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError('XLSX limits must be positive safe integers.');
  }
  const start = performance.now();
  return {
    limits,
    bytesRead: 0,
    checkTime() {
      if (performance.now() - start > limits.maxParseMs) throw new XlsxLimitError();
    },
  };
}

function entries(buffer, budget) {
  let eocd = -1;
  for (let offset = buffer.length - 22; offset >= 0 && offset > buffer.length - 66000; offset--) {
    if ((offset & 255) === 0) budget.checkTime();
    if (buffer.readUInt32LE(offset) === EOCD) { eocd = offset; break; }
  }
  if (eocd < 0) throw new Error('Not a zip archive (no end-of-central-directory record).');
  const count = buffer.readUInt16LE(eocd + 10);
  if (count > budget.limits.maxEntries) throw new XlsxLimitError();
  const directoryStart = buffer.readUInt32LE(eocd + 16);
  const directoryEnd = directoryStart + buffer.readUInt32LE(eocd + 12);
  if (directoryEnd > eocd) throw new Error('Corrupt zip central directory.');
  let offset = directoryStart;
  const files = new Map();
  for (let index = 0; index < count; index++) {
    budget.checkTime();
    if (offset + 46 > directoryEnd || buffer.readUInt32LE(offset) !== CENTRAL) {
      throw new Error('Corrupt zip central directory.');
    }
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const { maxEntryBytes } = budget.limits;
    if (uncompressedSize > maxEntryBytes || (method === 0 && compressedSize > maxEntryBytes)) {
      throw new XlsxLimitError();
    }
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    if (next > directoryEnd || localOffset + 30 > directoryStart) throw new Error('Corrupt zip entry.');
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    files.set(name, { method, compressedSize, localOffset });
    offset = next;
  }
  return { files, directoryStart };
}

function readEntry(buffer, { files, directoryStart }, name, budget) {
  budget.checkTime();
  const entry = files.get(name);
  if (!entry) return null;
  const local = entry.localOffset;
  if (buffer.readUInt32LE(local) !== LOCAL) throw new Error('Corrupt zip entry.');
  const { maxEntryBytes, maxTotalBytes } = budget.limits;
  if (buffer.readUInt32LE(local + 22) > maxEntryBytes) throw new XlsxLimitError();
  const nameLength = buffer.readUInt16LE(local + 26);
  const extraLength = buffer.readUInt16LE(local + 28);
  const start = local + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (end > directoryStart) throw new Error('Corrupt zip entry.');
  const raw = buffer.subarray(start, end);
  const remaining = Math.min(maxEntryBytes, maxTotalBytes - budget.bytesRead);
  let output = raw;
  if (entry.method !== 0) {
    try {
      // Zlib requires a positive cap, even when only an empty part may fit.
      output = inflateRawSync(raw, { maxOutputLength: Math.max(1, remaining) });
    } catch (error) {
      if (error.code === 'ERR_BUFFER_TOO_LARGE') throw new XlsxLimitError();
      throw error;
    }
  }
  if (output.length > remaining) throw new XlsxLimitError();
  budget.bytesRead += output.length;
  budget.checkTime();
  return output;
}

const unescape = value => value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&amp;/g, '&');

// Search for closing tags independently so a missing closer cannot cause a
// fresh scan of the remaining XML for every opening tag.
function* elements(xml, opening, closing, budget, { count, cell = false } = {}) {
  let consumed = 0;
  let end = 0;
  for (const match of xml.matchAll(opening)) {
    budget.checkTime();
    count?.();
    if (match.index < consumed) continue;
    const start = match.index + match[0].length;
    // Count openings even when the legacy matching rules omit them.
    if (match[0].endsWith('/>') && !/\s/.test(match[0])) continue;
    if (cell && !/^<c\s/.test(match[0])) continue;
    if (end !== -1 && end < start) end = xml.indexOf(closing, start);
    if (end !== -1) {
      consumed = end + closing.length;
      yield { body: xml.slice(start, end), element: xml.slice(match.index, consumed) };
    } else if (cell && match[0].endsWith('/>')) {
      yield { element: match[0] };
    } else if (!count) {
      break;
    }
  }
  budget.checkTime();
}

const textOf = (xml, budget) => {
  let out = '';
  for (const { body } of elements(xml, /<t(?:\s[^<>]*)?>/g, '</t>', budget)) out += unescape(body);
  return out;
};

function sharedStrings(xml, budget) {
  const strings = [];
  if (xml) {
    for (const { body } of elements(xml, /<si(?:\s[^<>]*)?>/g, '</si>', budget)) {
      strings.push(textOf(body, budget));
    }
  }
  return strings;
}

// Built-in number formats that render as dates (ECMA-376 §18.8.30).
const DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57]);
function dateStyles(xml, budget) {
  if (!xml) return new Set();
  const custom = new Map();
  // Attributes may appear in any order; read them independently.
  for (const match of xml.matchAll(/<numFmt\s[^<>]*>/g)) {
    budget.checkTime();
    const id = /numFmtId="(\d+)"/.exec(match[0]);
    const code = /formatCode="([^"]*)"/.exec(match[0]);
    if (!id || !code) continue;
    const format = code[1].replace(/"[^"]*"/g, '');
    const bracketEnd = format.lastIndexOf(']') + 1;
    const plain = format.slice(0, bracketEnd).replace(/\[[^\]]*\]/g, '') + format.slice(bracketEnd);
    if (/[ymdhs]/i.test(plain)) custom.set(Number(id[1]), true);
  }
  const styles = new Set();
  const cellXfs = elements(xml, /<cellXfs[^<>]*>/g, '</cellXfs>', budget).next().value;
  if (!cellXfs) return styles;
  let index = 0;
  for (const match of cellXfs.body.matchAll(/<xf[^<>]*numFmtId="(\d+)"/g)) {
    budget.checkTime();
    const format = Number(match[1]);
    if (DATE_FORMATS.has(format) || custom.has(format)) styles.add(index);
    index++;
  }
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

function decodeCell(cell, shared, dates, budget, typedNumber) {
  const type = (/\st="([^"]+)"/.exec(cell) || [])[1];
  const style = Number((/\ss="(\d+)"/.exec(cell) || [])[1] || -1);
  if (type === 'inlineStr') {
    const inline = elements(cell, /<is(?:\s[^<>]*)?>/g, '</is>', budget).next().value;
    return inline ? textOf(inline.body, budget) : null;
  }
  const value = elements(cell, /<v(?:\s[^<>]*)?>/g, '</v>', budget).next().value;
  if (!value) return null;
  const raw = unescape(value.body);
  if (type === 's') return shared[Number(raw)] ?? null;
  if (type === 'b') return raw === '1' ? 'True' : 'False';
  if (type === 'str') return raw;
  // Formula cells carry the cached value; numbers may need a date conversion.
  if (dates.has(style) && Number.isFinite(Number(raw)) && Number(raw) > 0) {
    // Values below one are clock times (planning start/finish), not dates.
    return Number(raw) < 1 ? timeOfDay(Number(raw)) : serialToIso(Number(raw));
  }
  if (typedNumber && (!type || type === 'n') && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw)) {
    return Number(raw);
  }
  return raw;
}

function columnIndex(letters, available) {
  let index = 0;
  for (const letter of letters) {
    index = index * 26 + (letter.charCodeAt(0) - 64);
    if (index > available) throw new XlsxLimitError();
  }
  return index - 1;
}

function lastAttribute(tag, name) {
  const start = tag.lastIndexOf(name);
  if (start === -1) return null;
  const end = tag.indexOf('"', start + name.length);
  return end === -1 ? null : { start, value: tag.slice(start + name.length, end) };
}

function sheetPath(workbook, rels, wanted, budget) {
  let id;
  for (const [tag] of workbook.matchAll(/<sheet[^<>]*>/g)) {
    budget.checkTime();
    const relId = lastAttribute(tag, 'r:id="');
    const name = relId && lastAttribute(tag.slice(0, relId.start), 'name="');
    if (name && (!wanted || name.value === wanted)) {
      id = relId.value;
      break;
    }
  }
  if (id === undefined) return null;
  let target;
  for (const [tag] of rels.matchAll(/<Relationship[^<>]*>/g)) {
    budget.checkTime();
    const path = lastAttribute(tag, 'Target="');
    const relId = path && lastAttribute(tag.slice(0, path.start), 'Id="');
    if (relId?.value === id) target = path.value;
  }
  if (!target) return null;
  return target.startsWith('/') ? target.slice(1) : `xl/${target}`;
}

export function readWorkbook(buffer, { sheet, limits, numericHeaders } = {}) {
  const budget = parseBudget(limits);
  const archive = entries(buffer, budget);
  const readXml = name => readEntry(buffer, archive, name, budget)?.toString('utf8') || '';
  const shared = sharedStrings(readXml('xl/sharedStrings.xml'), budget);
  const dates = dateStyles(readXml('xl/styles.xml'), budget);
  const workbook = readXml('xl/workbook.xml');
  const rels = readXml('xl/_rels/workbook.xml.rels');
  const path = sheetPath(workbook, rels, sheet, budget) || 'xl/worksheets/sheet1.xml';
  const xml = readXml(path);
  if (!xml) throw new Error('Worksheet not found.');

  const { maxRows, maxCells } = budget.limits;
  let rowCount = 0, cellCount = 0, slots = 0;
  const countRow = () => { if (++rowCount > maxRows) throw new XlsxLimitError(); };
  const countCell = () => { if (++cellCount > maxCells) throw new XlsxLimitError(); };
  let header;
  const rows = [];
  for (const { body } of elements(xml, /<row(?:\s[^<>]*)?\/?>/g, '</row>', budget, { count: countRow })) {
    const cells = [];
    for (const { element: cell } of elements(body, /<c(?:\s[^<>]*)?\/?>/g, '</c>', budget, { count: countCell, cell: true })) {
      const reference = /\sr="([A-Z]+)\d+"/.exec(cell);
      const available = Math.min(maxCells - slots, 0xffffffff);
      const index = reference ? columnIndex(reference[1], available) : cells.length;
      if (index >= available) throw new XlsxLimitError();
      const previousLength = cells.length;
      cells[index] = decodeCell(cell, shared, dates, budget, numericHeaders?.has(header?.[index]));
      if (index > previousLength) cells.fill(null, previousLength, index);
    }
    // Sparse references and header-width padding also consume cell slots.
    const width = Math.max(header?.length || 0, cells.length);
    slots += width;
    if (slots > maxCells) throw new XlsxLimitError();
    if (!header) {
      header = cells.map(value => value ?? null);
    } else {
      const previousLength = cells.length;
      cells.length = width;
      cells.fill(null, previousLength);
      rows.push(cells);
    }
  }
  return { header: header || [], rows };
}

export function readSheetNames(buffer, { limits } = {}) {
  const budget = parseBudget(limits);
  const archive = entries(buffer, budget);
  const workbook = readEntry(buffer, archive, 'xl/workbook.xml', budget)?.toString('utf8') || '';
  const names = [];
  for (const [tag] of workbook.matchAll(/<sheet[^<>]*>/g)) {
    budget.checkTime();
    const name = lastAttribute(tag, 'name="');
    if (name) names.push(unescape(name.value));
  }
  budget.checkTime();
  return names;
}
