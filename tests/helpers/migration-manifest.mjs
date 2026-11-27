import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';

export const fixtureRoot = new URL('../fixtures/migrations/', import.meta.url);
export const migrationRoot = new URL('../../server/migrations/', import.meta.url);
const dialects = ['sqlite', 'pg'];
const filename = /^([0-9]{3})_[a-z_]+\.sql$/;
const digest = /^[0-9a-f]{64}$/;
export const json = value => JSON.stringify(value, null, 2) + '\n';

export function validateManifest(manifest) {
  assert.ok(Array.isArray(manifest) && manifest.length, 'Migration manifest must be a nonempty array');
  let previous = '';
  for (const entry of manifest) {
    assert.deepEqual(Object.keys(entry).sort(), ['file', 'pg', 'sqlite', 'version']);
    assert.equal(filename.exec(entry.file)?.[1], entry.version, `Invalid migration filename/version: ${entry.file}`);
    assert.ok(typeof entry.version === 'string' && entry.version > previous,
      `Duplicate or unordered migration version: ${entry.version}`);
    for (const driver of dialects) assert.match(entry[driver], digest, `Invalid SHA-256 for ${driver}/${entry.file}`);
    previous = entry.version;
  }
  return manifest;
}

export async function inventory(root = migrationRoot) {
  const files = {};
  for (const driver of dialects) {
    files[driver] = (await readdir(new URL(`${driver}/`, root))).filter(file => /\.sql$/i.test(file)).sort();
    for (const file of files[driver]) assert.match(file, filename, `Invalid migration filename: ${driver}/${file}`);
  }
  return files;
}

export function assertInventory(expected, files) {
  const problems = [];
  for (const driver of dialects) {
    for (const file of expected) if (!files[driver].includes(file)) problems.push(`missing ${driver}/${file}`);
    for (const file of files[driver]) if (!expected.includes(file)) problems.push(`unexpected ${driver}/${file}`);
  }
  assert.ok(!problems.length, `Migration directory differs from manifest:\n${problems.join('\n')}`);
}

export function checksum(sql) {
  return createHash('sha256').update(Buffer.from(sql.toString('latin1').replaceAll('\r\n', '\n'), 'latin1')).digest('hex');
}

export async function buildManifest(root = migrationRoot) {
  const files = await inventory(root);
  assertInventory([...new Set([...files.sqlite, ...files.pg])], files);
  return validateManifest(await Promise.all(files.sqlite.map(async file => ({
    version: file.slice(0, 3), file,
    sqlite: checksum(await readFile(new URL(`sqlite/${file}`, root))),
    pg: checksum(await readFile(new URL(`pg/${file}`, root))),
  }))));
}
