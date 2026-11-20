import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../app/api.mjs';

test('diary client combines a full page and a short page across sites', async () => {
  const rows = Array.from({ length: 202 }, (_, index) => ({
    id: `entry-${index}`,
    site_id: index < 200 ? 'site-1' : 'site-2',
    operational_date: '2026-01-01',
    impediments: 'Example delay',
    next_step: 'Example follow-up',
    created_at: '2026-01-01T08:00:00Z',
  }));
  const pages = [rows.slice(0, 200), rows.slice(200)];
  const calls = [];
  const api = createApi({ baseUrl: '/', fetchImpl: async url => {
    calls.push(url);
    return Response.json(pages.shift());
  } });

  const entries = await api.listDiary();
  assert.deepEqual(calls, ['/api/diary?limit=200&offset=0', '/api/diary?limit=200&offset=200']);
  assert.deepEqual(entries.map(entry => entry.id), rows.map(row => row.id));
  assert.deepEqual(entries.at(-1), {
    ...rows.at(-1), siteId: 'site-2', date: '2026-01-01', blockers: 'Example delay',
    next: 'Example follow-up', createdAt: '2026-01-01T08:00:00Z',
  });
});

test('diary client keeps explicit pagination and site filters on subsequent requests', async () => {
  const calls = [];
  const api = createApi({ baseUrl: '/', fetchImpl: async url => {
    calls.push(url);
    return Response.json(calls.length === 1 ? [{ id: 'entry-7', site_id: 'site-1' }] : []);
  } });

  const entries = await api.listDiary({ limit: '1', offset: '7', siteId: 'site-1' });
  assert.deepEqual(calls, ['/api/diary?limit=1&offset=7&siteId=site-1', '/api/diary?limit=1&offset=8&siteId=site-1']);
  assert.deepEqual(entries.map(entry => entry.id), ['entry-7']);
});

test('diary client rejects when all 20 allowed pages are full', async () => {
  let calls = 0;
  const api = createApi({ baseUrl: '/', fetchImpl: async () => {
    calls++;
    return Response.json([{ id: `entry-${calls}` }]);
  } });

  await assert.rejects(api.listDiary({ limit: 1 }), /Diary pagination reached the 20-page limit/);
  assert.equal(calls, 20);
});
