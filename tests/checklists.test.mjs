import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { TEMPLATES, templatesForJurisdiction, findTemplate } from '../server/checklists.mjs';
import { createServer } from '../server/http.mjs';
import { createSite } from '../server/repository.mjs';
import { saveModuleAccess } from '../server/module-access.mjs';
import { authFixture } from './helpers/auth.mjs';
import { openTestDb } from './helpers/db.mjs';

const expected = [
  ['it_lifting', 'IT', 'tool', 24, 'D.Lgs. 81/2008, Allegato VII'],
  ['it_ppe', 'IT', 'ppe', 12, 'D.Lgs. 81/2008, Titolo III, Capo II'],
  ['it_scaffolding', 'IT', 'site_work', 3, 'D.Lgs. 81/2008, Titolo IV'],
  ['uk_lifting', 'UK', 'tool', 12, 'LOLER 1998'],
  ['uk_lifting_accessories', 'UK', 'tool', 6, 'LOLER 1998'],
  ['uk_ppe', 'UK', 'ppe', 12, 'PPE at Work Regulations 1992'],
  ['uk_scaffolding', 'UK', 'site_work', 3, 'Work at Height Regulations 2005'],
];

test('checklist families are filtered by jurisdiction', () => {
  for (const jurisdiction of ['IT', 'UK']) {
    const families = templatesForJurisdiction(jurisdiction);
    assert.deepEqual(families.map(template => template.code),
      expected.filter(row => row[1] === jurisdiction).map(row => row[0]));
    for (const template of families) {
      assert.equal(template.jurisdiction, jurisdiction);
      assert.ok(template.code.startsWith(`${jurisdiction.toLowerCase()}_`));
    }
  }
  assert.deepEqual(templatesForJurisdiction('unknown'), []);
});

test('all seven draft templates have valid metadata and unique visual checks', () => {
  assert.equal(TEMPLATES.length, 7);
  assert.equal(new Set(TEMPLATES.map(template => template.code)).size, TEMPLATES.length);
  assert.deepEqual(TEMPLATES.map(({ code, jurisdiction, kind, intervalMonths, reference }) =>
    [code, jurisdiction, kind, intervalMonths, reference]), expected);
  for (const template of TEMPLATES) {
    assert.equal(template.draft, true);
    assert.equal(template.status, 'draft');
    assert.equal(template.frequency_verified, false);
    assert.ok(Number.isInteger(template.intervalMonths) && template.intervalMonths > 0);
    assert.match(template.code, /^[a-z]+(?:_[a-z]+)*$/);
    assert.match(template.category, /^[a-z]+(?:_[a-z]+)*$/);
    for (const field of ['title', 'reference', 'source']) {
      assert.equal(typeof template[field], 'string');
      assert.ok(template[field].trim().length > 0);
    }
    assert.ok(template.items.length >= 8 && template.items.length <= 14);
    assert.equal(new Set(template.items.map(item => item.code)).size, template.items.length);
    assert.ok(template.items.some(item => item.critical));
    for (const item of template.items) {
      assert.match(item.code, /^[a-z]+(?:_[a-z]+)*$/);
      assert.equal(typeof item.critical, 'boolean');
      assert.equal(typeof item.label, 'string');
      assert.ok(item.label.trim().length > 0);
    }
  }
  for (const [family, code, expected] of [
    ['it_lifting', 'structure', true], ['it_lifting', 'identification', false],
    ['uk_lifting_accessories', 'hooks', true], ['uk_lifting_accessories', 'rated_load', false],
    ['uk_ppe', 'harness_webbing', true], ['uk_ppe', 'gloves', false],
    ['it_scaffolding', 'guardrails', true], ['uk_scaffolding', 'load_signs', false],
  ]) assert.equal(findTemplate(family).items.find(item => item.code === code).critical, expected);
});

test('findTemplate returns the catalogue entry or undefined', () => {
  for (const template of TEMPLATES) assert.equal(findTemplate(template.code), template);
  assert.equal(findTemplate('unknown_template'), undefined);
});

test('inspection template HTTP catalogue', async t => {
  const database = await openTestDb();
  const { db } = database;
  const server = createServer(db);
  t.after(async () => {
    try {
      if (server.listening) await new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
    } finally {
      await database.close();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const { users, cookies } = await authFixture(db);
  const sites = {};
  for (const jurisdiction of ['IT', 'UK']) {
    const site = await createSite(db, { code: randomUUID(), name: 'Synthetic checklist site', jurisdiction });
    for (const role of ['owner', 'editor', 'verifier', 'viewer']) {
      await db.run('INSERT INTO site_members (site_id, user_id, role) VALUES (?, ?, ?)', site.id, users[role].id, role);
    }
    sites[jurisdiction] = site;
  }
  const path = '/api/hse/inspection-templates';
  const get = async (url, role = 'editor') => {
    const response = await fetch(`${base}${url}`, { headers: { cookie: cookies[role] } });
    return { status: response.status, body: await response.json() };
  };
  const error = (response, status, code) => {
    assert.equal(response.status, status);
    assert.equal(response.body.code, code);
  };

  await t.test('Italian and British sites receive only their own families', async () => {
    for (const jurisdiction of ['IT', 'UK']) {
      const response = await get(`${path}?siteId=${sites[jurisdiction].id}`);
      assert.equal(response.status, 200);
      assert.deepEqual(response.body, { jurisdiction, templates: templatesForJurisdiction(jurisdiction) });
    }
  });

  await t.test('the catalogue follows the HSE read roles', async () => {
    for (const role of ['owner', 'editor', 'verifier']) {
      assert.equal((await get(`${path}?siteId=${sites.IT.id}`, role)).status, 200);
    }
    error(await get(`${path}?siteId=${sites.IT.id}`, 'viewer'), 403, 'FORBIDDEN');
  });

  await t.test('missing, empty and malformed site ids give validation errors', async () => {
    for (const query of ['', '?siteId=', '?siteId=not-a-uuid']) {
      error(await get(`${path}${query}`), 400, 'VALIDATION_ERROR');
    }
  });

  await t.test('UUIDs are case insensitive', async () => {
    const response = await get(`${path}?siteId=${sites.UK.id.toUpperCase()}`);
    assert.equal(response.status, 200);
    assert.equal(response.body.jurisdiction, 'UK');
  });

  await t.test('an existing site without membership gives 403', async () => {
    const other = await createSite(db, { code: randomUUID(), name: 'Synthetic unrelated site' });
    error(await get(`${path}?siteId=${other.id}`), 403, 'FORBIDDEN');
  });

  await t.test('an unknown site gives 404', async () => {
    error(await get(`${path}?siteId=${randomUUID()}`), 404, 'SITE_NOT_FOUND');
  });

  await t.test('catalogue reads leave audit history unchanged', async () => {
    const before = await db.all('SELECT * FROM audit_events ORDER BY id');
    assert.equal((await get(`${path}?siteId=${sites.IT.id}`)).status, 200);
    assert.deepEqual(await db.all('SELECT * FROM audit_events ORDER BY id'), before);
  });

  await t.test('the HSE module denial matches the events route', async () => {
    await saveModuleAccess(db, { siteId: sites.IT.id, memberId: users.editor.id,
      module: 'hse', allowed: false }, users.owner);
    for (const route of [path, '/api/hse-events']) {
      error(await get(`${route}?siteId=${sites.IT.id}`), 403, 'MODULE_FORBIDDEN');
      assert.equal((await get(`${route}?siteId=${sites.UK.id}`)).status, 200);
      assert.equal((await get(`${route}?siteId=${sites.IT.id}`, 'owner')).status, 200);
    }
  });
});
