import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TOOL_STATUSES, corePermissions, filterTools, navGroups, toolCompanies, toolStatusLabelKey,
} from '../app/domain.mjs';
import { createApi, ApiError } from '../app/api.mjs';
import { messages } from '../app/i18n.mjs';

test('desktop navigation groups keep every route in the requested sections', () => {
  assert.deepEqual(navGroups(), [
    { label: 'navOperations', items: ['overview', 'tasks', 'deviations', 'diary'] },
    { label: 'navSite', items: ['progress', 'bookings', 'wbs', 'impacts'] },
    { label: 'navManagement', items: ['sites', 'tools', 'certifications'] },
  ]);
  const groups = navGroups();
  groups[0].items.push('report');
  assert.deepEqual(navGroups()[0].items, ['overview', 'tasks', 'deviations', 'diary']);
  for (const language of ['it', 'en']) {
    for (const key of ['navOperations', 'navSite', 'navManagement', 'tools', 'certifications', 'certificationsSub', 'certStatus_valid']) assert.equal(typeof messages[language][key], 'string');
  }
});

test('tool statuses, labels and write permission are centralized and bilingual', () => {
  assert.deepEqual(TOOL_STATUSES, ['available', 'in_use', 'maintenance', 'retired']);
  assert.equal(toolStatusLabelKey('in_use'), 'toolStatusInUse');
  assert.equal(toolStatusLabelKey('unknown'), 'coreUnknown');
  for (const language of ['it', 'en']) {
    for (const status of TOOL_STATUSES) assert.equal(typeof messages[language][toolStatusLabelKey(status)], 'string');
    for (const key of ['toolName', 'toolCode', 'toolCompany', 'toolStatus', 'toolLocation', 'toolEmpty', 'toolEmptyHint']) {
      assert.equal(typeof messages[language][key], 'string');
    }
  }
  assert.equal(corePermissions('owner').tools, true);
  assert.equal(corePermissions('editor').tools, true);
  assert.equal(corePermissions('verifier').tools, true);
  assert.equal(corePermissions('viewer').tools, false);
});

test('tool companies and filtering are exact, sorted and non-mutating', () => {
  const tools = [
    { id: '3', name: 'Zeta', company: 'Beta', status: 'retired' },
    { id: '2', name: 'Alpha', company: 'Alpha', status: 'in_use' },
    { id: '1', name: 'Beta', company: 'Alpha', status: 'in_use' },
    { id: '4', name: 'No company', company: null, status: 'available' },
  ];
  const before = structuredClone(tools);
  assert.deepEqual(toolCompanies(tools), ['Alpha', 'Beta']);
  assert.deepEqual(filterTools(tools).map(tool => tool.id), ['2', '1', '3', '4']);
  assert.deepEqual(filterTools(tools, { company: 'Alpha', status: 'in_use' }).map(tool => tool.id), ['2', '1']);
  assert.deepEqual(filterTools(tools, { company: 'alpha' }), []);
  assert.deepEqual(tools, before);
});

test('tools API client maps filters, partial writes, response keys and errors', async () => {
  const requests = [];
  const row = { id: 'tool-1', site_id: 'site-1', name: 'Synthetic tool', code: 'A-1', company: 'Example company',
    status: 'available', location: 'Zone A', notes: null, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' };
  const api = createApi({ baseUrl: 'https://api.example.invalid/', fetchImpl: async (url, options) => {
    requests.push({ url, options });
    return Response.json(url.includes('/api/tools?') ? [row] : url.endsWith('/tools') ? { ...row, name: 'Created' } : { ...row, name: 'Changed' });
  } });
  const listed = await api.listTools({ siteId: 'site /?&', company: 'Example & company' });
  assert.equal(requests[0].url, 'https://api.example.invalid/api/tools?site_id=site+%2F%3F%26&company=Example+%26+company');
  assert.equal(listed[0].siteId, 'site-1');
  assert.equal(listed[0].createdAt, row.created_at);

  await api.createTool({ siteId: 'site-1', name: 'Created', code: '  ', company: 'Example company', status: 'available' });
  assert.equal(requests[1].url, 'https://api.example.invalid/api/tools');
  assert.equal(requests[1].options.method, 'POST');
  assert.deepEqual(JSON.parse(requests[1].options.body), { site_id: 'site-1', name: 'Created', code: '  ', company: 'Example company', status: 'available' });

  await api.updateTool('tool /?&', { name: 'Changed', status: 'in_use' });
  assert.equal(requests[2].url, 'https://api.example.invalid/api/tools/tool%20%2F%3F%26');
  assert.equal(requests[2].options.method, 'PATCH');
  assert.deepEqual(JSON.parse(requests[2].options.body), { name: 'Changed', status: 'in_use' });

  await api.deleteTool('tool /?&');
  assert.equal(requests[3].url, 'https://api.example.invalid/api/tools/tool%20%2F%3F%26');
  assert.equal(requests[3].options.method, 'DELETE');

  const failing = createApi({ fetchImpl: async () => Response.json({ error: 'Synthetic tool error', code: 'TOOL_NOT_FOUND' }, { status: 404 }) });
  await assert.rejects(() => failing.deleteTool('missing-tool'), error => error instanceof ApiError
    && error.status === 404 && error.code === 'TOOL_NOT_FOUND' && error.message === 'Synthetic tool error');
});
