import test from 'node:test';
import { PgStorage, translatePlaceholders } from '../server/storage/pg.mjs';

test('pg placeholders are positional, restart for each statement and support double digits', t => {
  t.assert.strictEqual(translatePlaceholders('SELECT * FROM sites'), 'SELECT * FROM sites');
  t.assert.strictEqual(translatePlaceholders('UPDATE tasks SET status = ? WHERE id = ?'),
    'UPDATE tasks SET status = $1 WHERE id = $2');
  t.assert.strictEqual(translatePlaceholders('SELECT ?'), 'SELECT $1');
  t.assert.strictEqual(translatePlaceholders(Array(12).fill('?').join(', ')),
    Array.from({ length: 12 }, (_, index) => `$${index + 1}`).join(', '));
});

test('pg classifies only SQLSTATE 23505 as a unique violation', t => {
  const classify = error => PgStorage.prototype.isUniqueViolation(error);
  t.assert.strictEqual(classify({ code: '23505' }), true);
  for (const error of [{ code: '23503' }, { code: '23514' }, { errcode: 2067 }, {}, null]) {
    t.assert.strictEqual(classify(error), false);
  }
});
