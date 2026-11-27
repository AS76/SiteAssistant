import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fixtureRoot, validateManifest } from './migration-manifest.mjs';
import { manifest } from './migrations.mjs';

const bootstrap = '82fad3c2c56e3cd59f50952ac4fe7ce114ac8971';
const fixturePath = 'tests/fixtures/migrations/';
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });

export function assertManifestPrefix(base, proposed) {
  validateManifest(base);
  validateManifest(proposed);
  for (const [index, entry] of base.entries()) {
    assert.deepEqual(proposed[index], entry, `Historical migration changed at position ${index + 1}: ${entry.file}`);
  }
}

export function migrationBase() {
  const input = process.env.SA_MIGRATION_BASE;
  if (!input) return undefined;
  assert.match(input, /^[0-9a-f]{40}$/, 'SA_MIGRATION_BASE must be a commit SHA');
  const commit = git('rev-parse', '--verify', `${input}^{commit}`).trim();
  const files = new Set(git('ls-tree', '-r', '--name-only', commit, fixturePath).trim().split('\n'));
  const fromBase = name => git('show', `${commit}:${fixturePath}${name}`);
  if (!files.has(fixturePath + 'manifest.json')) {
    assert.equal(commit, bootstrap, 'Migration manifest missing from base outside the initial bootstrap commit');
    assert.equal(git('diff', '--name-only', commit, '--', 'server/migrations/'), '',
      'Initial migration manifest must bootstrap without migration changes');
    return undefined;
  }

  const base = JSON.parse(fromBase('manifest.json'));
  assertManifestPrefix(base, manifest);
  return {
    boundary: base.at(-1).version,
    async snapshot(engine) {
      const name = `${engine}.schema.json`;
      if (!files.has(fixturePath + name)) {
        // The PG16 baseline must first be captured on a real server.
        assert.equal(engine, 'pg16', `Missing ${name} at migration base`);
        return undefined;
      }
      const contents = fromBase(name);
      const proposed = await readFile(new URL(name, fixtureRoot), 'utf8');
      if (base.length === manifest.length) assertSnapshotWithoutTail(proposed, contents, name);
      return JSON.parse(contents);
    },
  };
}

export function assertSnapshotWithoutTail(actual, expected, name) {
  assert.equal(actual, expected, `${name} changed without appending a migration`);
}
