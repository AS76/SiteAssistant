import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { messages } from '../app/i18n.mjs';

const source = await readFile(new URL('../app/app.mjs', import.meta.url), 'utf8');
const literal = source.match(/^const AI_SUGGESTIONS = (\{[\s\S]*?^\});/m)?.[1];
assert.ok(literal, 'Expected an AI_SUGGESTIONS object literal');
const suggestions = runInNewContext(`(${literal})`, {}, { timeout: 1000 });

test('every assistant suggestion list contains keys translated in Italian and English', () => {
  for (const [view, keys] of Object.entries(suggestions)) {
    assert.ok(Array.isArray(keys), `${view} suggestions must be an array`);
    assert.ok(keys.length > 0, `${view} suggestions must not be empty`);
    for (const key of keys) {
      assert.equal(typeof key, 'string', `${view} suggestions must be string keys`);
      assert.ok(Object.hasOwn(messages.it, key), `Missing Italian translation for ${key}`);
      assert.ok(Object.hasOwn(messages.en, key), `Missing English translation for ${key}`);
    }
  }
});

for (const [view, expected] of Object.entries({
  tasks: ['aiSuggestTasks', 'aiSuggestTasksDue', 'aiSuggestTasksBlocked'],
  diary: ['aiSuggestDiary', 'aiSuggestDiaryBlockers', 'aiSuggestDiaryWeek'],
})) {
  test(`assistant suggestions for ${view} match the expected keys in order`, () => {
    const keys = suggestions[view];
    assert.ok(Array.isArray(keys), `${view} suggestions must be an array`);
    assert.deepEqual([...keys], expected);
  });
}
