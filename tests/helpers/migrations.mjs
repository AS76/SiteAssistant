import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { migrate } from '../../server/migrations/index.mjs';
import { assertInventory, buildManifest, fixtureRoot, inventory, migrationRoot, validateManifest } from './migration-manifest.mjs';

export const manifest = validateManifest(JSON.parse(await readFile(new URL('manifest.json', fixtureRoot), 'utf8')));
export const versions = manifest.map(entry => entry.version);
export const prefixBefore = (first = '') => manifest.filter(entry => entry.version < first);
export const registry = db => db.all('SELECT * FROM schema_migrations ORDER BY version');

export async function verifyManifest(root = migrationRoot) {
  assertInventory(manifest.map(entry => entry.file), await inventory(root));
  const actual = await buildManifest(root);
  for (const [index, entry] of manifest.entries()) {
    for (const driver of ['sqlite', 'pg']) {
      assert.equal(actual[index][driver], entry[driver], `SHA-256 changed: ${driver}/${entry.file}`);
    }
  }
}

export function assertSequence(actual, expected) {
  const length = Math.max(actual.length, expected.length);
  for (let i = 0; i < length; i++) {
    assert.equal(actual[i], expected[i],
      `Migration commit #${i + 1}: expected ${expected[i] ?? 'end of sequence'}, observed ${actual[i] ?? 'end of sequence'}`);
  }
}

export function observeMigrations(db, committed, afterCommit = async () => {}) {
  return {
    exec: sql => db.exec(sql),
    async transaction(fn) {
      const written = [];
      const result = await db.transaction(tx => fn({
        ...tx,
        async run(sql, ...params) {
          const value = await tx.run(sql, ...params);
          if (/^INSERT\s+INTO\s+schema_migrations\b/i.test(sql.trim())) written.push(params[0]);
          return value;
        },
      }));
      assert.ok(written.length <= 1, 'Multiple migration versions written in one transaction');
      for (const version of written) {
        committed.push(version);
        await afterCommit(version);
      }
      return result;
    },
  };
}

export async function assertUpgrade(db, { driver, first, demoSandbox = false, afterCommit }) {
  const prefix = prefixBefore(first);
  const before = prefix.length ? await registry(db) : [];
  assert.deepEqual(before.map(row => row.version), prefix.map(entry => entry.version), 'Unexpected fixture migration prefix');
  const committed = [];
  const observed = observeMigrations(db, committed, afterCommit);
  const count = await migrate(observed, { driver, demoSandbox });
  assertSequence(committed, versions.slice(prefix.length));
  assert.equal(count, committed.length, 'Runner return value differs from committed migrations');
  const after = await registry(db);
  assert.deepEqual(after.map(row => row.version), versions, 'Unexpected complete migration registry');
  assert.deepEqual(after.slice(0, before.length), before, 'Upgrade changed existing registry rows');
  committed.length = 0;
  assert.equal(await migrate(observed, { driver, demoSandbox }), 0);
  assertSequence(committed, []);
  assert.deepEqual(await registry(db), after, 'Replay changed migration registry');
  return after;
}
