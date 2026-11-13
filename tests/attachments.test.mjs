import test from 'node:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { openTestDb } from './helpers/db.mjs';
import { MemoryObjectStorage } from './helpers/object-storage.mjs';
import { ObjectStorageError, S3Storage } from '../server/s3.mjs';
import { createServer } from '../server/http.mjs';
import { tokenHash } from '../server/auth.mjs';
import { createHseEvent, deleteHseEvent } from '../server/hse.mjs';
import { saveModuleAccess } from '../server/module-access.mjs';
import {
  createSite, createTask, createDiary, createAttachment, listAttachments, getAttachment,
  deleteAttachment, MAX_ATTACHMENT_BYTES,
} from '../server/repository.mjs';

const data = Buffer.from('%PDF-1.7\nSynthetic attachment\n%%EOF\n');
const sha = value => createHash('sha256').update(value).digest('hex');

async function fixture(t) {
  const database = await openTestDb();
  t.after(database.close);
  const { db } = database;
  const site = await createSite(db, { code: 'ATTACHMENTS', name: 'Synthetic site' });
  const other = await createSite(db, { code: 'OTHER', name: 'Other synthetic site' });
  const task = await createTask(db, { siteId: site.id, title: 'Synthetic task', executor: 'A', verifier: 'B' });
  const diary = await createDiary(db, { siteId: site.id, shift: 'day' });
  const users = {}, cookies = {};
  for (const role of ['owner', 'editor', 'verifier', 'viewer', 'outsider']) {
    const user = { id: randomUUID(), name: `Synthetic ${role}` };
    await db.run(`INSERT INTO users (id, email, name, password_hash, password_algo, created_at)
      VALUES (?, ?, ?, 'unused', 'scrypt', ?)`, user.id, `${role}@example.invalid`, user.name, new Date().toISOString());
    if (role !== 'outsider') await db.run('INSERT INTO site_members VALUES (?, ?, ?)', site.id, user.id, role);
    const token = randomBytes(32).toString('base64url');
    await db.run(`INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
      randomUUID(), user.id, tokenHash(token), new Date().toISOString(), new Date(Date.now() + 3600000).toISOString());
    users[role] = user; cookies[role] = `sa_session=${token}`;
  }
  const storage = new MemoryObjectStorage();
  const input = { entity_type: 'task', entity_id: task.id, filename: 'Synthetic résumé.pdf', content_type: 'application/pdf', data_base64: data.toString('base64') };
  const upload = (extra = {}, user = users.editor) => createAttachment(db, { ...input, ...extra }, user, storage);
  return { db, site, other, task, diary, users, cookies, storage, input, upload };
}

test('attachments upload task/diary/site with HEAD and byte readback before publishing v1 metadata', async t => {
  const { db, site, task, diary, users, storage, upload } = await fixture(t);
  for (const [entity_type, entity_id] of [['task', task.id], ['diary', diary.id], ['site', site.id]]) {
    const file = await upload({ entity_type, entity_id });
    t.assert.strictEqual(file.content_sha256, sha(data));
    t.assert.strictEqual(file.size, data.length);
    t.assert.strictEqual(file.manifest_version, 'v1');
    t.assert.strictEqual(file.uploaded_by, users.editor.id);
    t.assert.strictEqual(file.site_id, site.id);
    t.assert.strictEqual('storage_locator' in file, false);
    t.assert.deepStrictEqual(storage.calls.slice(-3).map(([method]) => method), ['put', 'head', 'get']);
    t.assert.deepStrictEqual(await listAttachments(db, { site_id: site.id, entity_type, entity_id }, users.viewer), [file]);
    const download = await getAttachment(db, file.id, users.viewer, storage);
    t.assert.deepStrictEqual(await buffer(download.stream), data);
  }
  const repeat = await upload();
  t.assert.strictEqual(storage.objects.size, 4);
  t.assert.strictEqual((await listAttachments(db, { site_id: site.id }, users.verifier)).length, 4);
  await deleteAttachment(db, repeat.id, users.owner, storage);
  t.assert.strictEqual(storage.objects.size, 3);
  await t.assert.rejects(() => getAttachment(db, repeat.id, users.owner, storage), { status: 404 });
});

test('attachments enforce membership and owner/editor writes before touching object storage', async t => {
  const { db, site, users, storage, upload } = await fixture(t);
  for (const role of ['verifier', 'viewer', 'outsider']) await t.assert.rejects(() => upload({}, users[role]), { status: 403 });
  await t.assert.rejects(() => upload({}, null), { status: 401 });
  t.assert.strictEqual(storage.calls.length, 0);
  const file = await upload({}, users.owner);
  const count = storage.calls.length;
  await t.assert.rejects(() => listAttachments(db, { site_id: site.id }, users.outsider), { status: 403 });
  await t.assert.rejects(() => getAttachment(db, file.id, users.outsider, storage), { status: 403 });
  for (const role of ['verifier', 'viewer', 'outsider']) {
    await t.assert.rejects(() => deleteAttachment(db, file.id, users[role], storage), { status: 403 });
  }
  t.assert.strictEqual(storage.calls.length, count);
  await deleteAttachment(db, file.id, users.editor, storage);
  t.assert.strictEqual(storage.objects.size, 0);
});

test('attachments reject invalid types, missing entities, malformed IDs and cross-site links', async t => {
  const { db, site, other, users, storage, upload } = await fixture(t);
  for (const entity_type of ['unknown', 'constructor', '__proto__', null, 1, { toString: null }]) {
    await t.assert.rejects(() => upload({ entity_type }), { status: 400 });
  }
  for (const entity_id of [randomUUID(), 'invalid', null]) await t.assert.rejects(() => upload({ entity_id }), { status: 400 });
  await t.assert.rejects(() => upload({ entity_type: 'site', entity_id: other.id }), { status: 403 });
  await t.assert.rejects(() => upload({ site_id: other.id }), { status: 403 });
  await db.run("INSERT INTO site_members VALUES (?, ?, 'owner')", other.id, users.owner.id);
  await t.assert.rejects(() => upload({ site_id: site.id, entity_type: 'site', entity_id: other.id }, users.owner), { status: 403 });
  await t.assert.rejects(() => listAttachments(db, { site_id: site.id, entity_type: 'site', entity_id: other.id }, users.owner), { status: 403 });
  await t.assert.rejects(() => listAttachments(db, { site_id: site.id, entity_type: 'unknown' }, users.owner), { status: 400 });
  await t.assert.rejects(() => listAttachments(db, {}, users.owner), { status: 400 });
  t.assert.strictEqual(storage.calls.length, 0);
});

test('attachments validate filenames, MIME, canonical base64 and exact decoded 15 MiB limit', async t => {
  const { storage, upload } = await fixture(t);
  for (const filename of ['', '../a.pdf', 'bad\r\nname.pdf', 'x'.repeat(256), '\ud800']) {
    await t.assert.rejects(() => upload({ filename }), { status: 400 });
  }
  for (const content_type of ['text/html', 'application/zip', 'image/', 'image/png\r\nx-test: 1']) {
    await t.assert.rejects(() => upload({ content_type }), { status: 415 });
  }
  for (const data_base64 of ['', null, 3, '%%%=', 'a', 'YW=Jj===', 'AB==', 'YQ==\n']) {
    await t.assert.rejects(() => upload({ data_base64 }), { status: 400 });
  }
  await t.assert.rejects(() => upload({ data_base64: Buffer.alloc(MAX_ATTACHMENT_BYTES + 1).toString('base64') }), { status: 413 });
  t.assert.strictEqual(storage.objects.size, 0);
  const bytes = Buffer.alloc(MAX_ATTACHMENT_BYTES, 42);
  const max = await upload({ data_base64: bytes.toString('base64'), content_type: 'image/png' });
  t.assert.strictEqual(max.size, MAX_ATTACHMENT_BYTES);
  t.assert.strictEqual(max.content_sha256, sha(bytes));
});

test('HEAD mismatch, missing checksum and corruption of actual bytes reject upload and clean up', async t => {
  for (const mode of ['checksum', 'missing', 'size', 'bytes', 'truncated', 'oversized', 'head-error', 'get-error']) {
    await t.test(mode, async t => {
      const { db, storage, upload } = await fixture(t);
      const originalHead = storage.head.bind(storage), originalGet = storage.get.bind(storage);
      storage.head = async key => {
        const result = await originalHead(key);
        if (mode === 'head-error') throw new ObjectStorageError();
        if (mode === 'checksum') result.sha256 = '0'.repeat(64);
        if (mode === 'missing') result.sha256 = null;
        if (mode === 'size') result.size++;
        return result;
      };
      storage.get = async key => {
        if (mode === 'get-error') return Readable.from((async function* () { throw new ObjectStorageError(); })());
        if (mode === 'bytes') return Readable.from([Buffer.alloc(data.length, 0)]);
        if (mode === 'truncated') return Readable.from([data.subarray(1)]);
        if (mode === 'oversized') return Readable.from([data, Buffer.from('extra')]);
        return originalGet(key);
      };
      await t.assert.rejects(() => upload(), { code: mode.endsWith('error') ? 'STORAGE_UNAVAILABLE' : 'ATTACHMENT_CHECKSUM_MISMATCH' });
      t.assert.deepStrictEqual(await db.all('SELECT * FROM attachments'), []);
      t.assert.strictEqual(storage.objects.size, 0);
      t.assert.strictEqual(storage.calls.at(-1)[0], 'delete');
    });
  }
});

test('failed SQL insert rolls back and cleans storage; membership is checked again after upload', async t => {
  const { db, users, storage, input, upload } = await fixture(t);
  const failingDb = {
    get: db.get.bind(db),
    transaction: fn => db.transaction(tx => fn({ ...tx, run: async (...args) => {
      await tx.run(...args);
      throw new Error('Synthetic SQL failure after INSERT');
    } })),
  };
  await t.assert.rejects(() => createAttachment(failingDb, input, users.editor, storage), /Synthetic SQL failure/);
  t.assert.strictEqual(storage.objects.size, 0);
  t.assert.deepStrictEqual(await db.all('SELECT * FROM attachments'), []);
  const head = storage.head.bind(storage);
  storage.head = async key => {
    await db.run('DELETE FROM site_members WHERE user_id = ?', users.editor.id);
    return head(key);
  };
  await t.assert.rejects(() => upload(), { status: 403 });
  t.assert.strictEqual(storage.objects.size, 0);
});

test('failed delete preserves SQL metadata for retry and failed upload cleanup is explicit', async t => {
  const { db, users, storage, upload } = await fixture(t);
  const file = await upload();
  const remove = storage.delete.bind(storage);
  storage.delete = async () => { throw new ObjectStorageError(); };
  await t.assert.rejects(() => deleteAttachment(db, file.id, users.editor, storage), { code: 'STORAGE_UNAVAILABLE' });
  t.assert.ok(await db.get('SELECT id FROM attachments WHERE id = ?', file.id));
  t.assert.strictEqual(storage.objects.size, 1);
  storage.delete = remove;
  await deleteAttachment(db, file.id, users.editor, storage);
  storage.head = async () => ({ size: 1, sha256: 'bad' });
  storage.delete = async () => { throw new ObjectStorageError(); };
  await t.assert.rejects(() => upload(), { code: 'ATTACHMENT_CLEANUP_FAILED' });
  t.assert.deepStrictEqual(await db.all('SELECT * FROM attachments'), []);
});

// A real Writable exercises pipeline/backpressure without opening network sockets.
function invoke(server, path, { method = 'GET', body, rawBody, cookie, headers = {} } = {}) {
  const bytes = rawBody ?? (body === undefined ? null : Buffer.from(JSON.stringify(body)));
  const request = Readable.from(bytes ? [bytes] : []);
  Object.assign(request, { url: path, method, headers: { 'content-type': 'application/json', ...headers, ...(cookie ? { cookie } : {}) }, socket: { remoteAddress: '127.0.0.1' } });
  const chunks = [], responseHeaders = {};
  const response = new Writable({ write(chunk, encoding, done) { chunks.push(Buffer.from(chunk)); done(); } });
  response.setHeader = (name, value) => { responseHeaders[name.toLowerCase()] = value; };
  response.writeHead = (status, extra = {}) => {
    response.status = status; response.headersSent = true;
    for (const [name, value] of Object.entries(extra)) response.setHeader(name, value);
  };
  return new Promise(resolve => {
    response.on('error', () => {});
    response.on('close', () => {
      const raw = Buffer.concat(chunks);
      resolve({ status: response.status, headers: responseHeaders, raw, complete: response.writableFinished,
        body: responseHeaders['content-type']?.startsWith('application/json') ? JSON.parse(raw.toString()) : null });
    });
    server.emit('request', request, response);
  });
}

test('attachment HTTP routes enforce sessions/roles, stream bytes, list metadata and delete', async t => {
  const { db, site, other, cookies, storage, input } = await fixture(t);
  const server = createServer(db, { storage });
  const request = (path, options = {}) => invoke(server, path, { cookie: cookies.editor, ...options });
  const list = `/api/attachments?site_id=${site.id}&entity_type=task&entity_id=${input.entity_id}`;
  t.assert.strictEqual((await request('/api/attachments', { method: 'POST', body: input, cookie: undefined })).status, 401);
  for (const role of ['viewer', 'verifier', 'outsider']) {
    t.assert.strictEqual((await request('/api/attachments', { method: 'POST', body: input, cookie: cookies[role] })).status, 403);
  }
  const created = await request('/api/attachments', { method: 'POST', body: input });
  t.assert.strictEqual(created.status, 201);
  t.assert.strictEqual(created.body.content_sha256, sha(data));
  t.assert.strictEqual('storage_locator' in created.body, false);
  const path = `/api/attachments/${created.body.id}`;
  for (const role of ['owner', 'editor', 'verifier', 'viewer']) {
    const response = await request(path, { cookie: cookies[role] });
    t.assert.strictEqual(response.status, 200);
    t.assert.strictEqual(response.complete, true);
    t.assert.deepStrictEqual(response.raw, data);
    t.assert.strictEqual(response.headers['content-type'], 'application/pdf');
    t.assert.strictEqual(response.headers['content-length'], String(data.length));
    t.assert.match(response.headers['content-disposition'], /attachment;.*filename\*=UTF-8''Synthetic%20r%C3%A9sum%C3%A9.pdf/);
    t.assert.strictEqual(response.headers['x-content-type-options'], 'nosniff');
    t.assert.strictEqual(response.headers['cache-control'], 'no-store');
    t.assert.deepStrictEqual((await request(list, { cookie: cookies[role] })).body, [created.body]);
  }
  for (const [route, method] of [[path, 'GET'], [path, 'DELETE'], [list, 'GET']]) {
    t.assert.strictEqual((await request(route, { method, cookie: cookies.outsider })).status, 403);
    t.assert.strictEqual((await request(route, { method, cookie: undefined })).status, 401);
  }
  for (const role of ['verifier', 'viewer']) t.assert.strictEqual((await request(path, { method: 'DELETE', cookie: cookies[role] })).status, 403);
  t.assert.strictEqual((await request(`/api/attachments?site_id=${other.id}`)).status, 403);
  t.assert.strictEqual((await request(path, { method: 'DELETE' })).status, 204);
  t.assert.strictEqual((await request(path)).status, 404);
  t.assert.deepStrictEqual((await request(list)).body, []);
  t.assert.strictEqual(storage.objects.size, 0);
});

test('attachment HTTP validates input and accepts JSON above the ordinary 64 KiB ceiling', async t => {
  const { db, other, cookies, storage, input } = await fixture(t);
  const server = createServer(db, { storage });
  const upload = body => invoke(server, '/api/attachments', { method: 'POST', body, cookie: cookies.editor });
  for (const [extra, status] of [
    [{ entity_type: 'bad' }, 400], [{ entity_id: randomUUID() }, 400],
    [{ entity_id: 'not-a-uuid' }, 400], [{ site_id: other.id }, 403],
    [{ entity_type: 'site', entity_id: other.id }, 403], [{ content_type: 'text/plain' }, 415],
    [{ data_base64: 'bad!' }, 400], [{ data_base64: Buffer.alloc(MAX_ATTACHMENT_BYTES + 1).toString('base64') }, 413],
  ]) t.assert.strictEqual((await upload({ ...input, ...extra })).status, status);
  const large = Buffer.alloc(70000, 42);
  const response = await upload({ ...input, content_type: 'image/jpeg', data_base64: large.toString('base64') });
  t.assert.strictEqual(response.status, 201);
  t.assert.strictEqual(response.body.size, large.length);
  t.assert.strictEqual((await invoke(server, '/api/attachments', {
    method: 'POST', cookie: cookies.editor, rawBody: Buffer.alloc(4 * Math.ceil(MAX_ATTACHMENT_BYTES / 3) + 65537, 32),
  })).status, 413);
  t.assert.strictEqual((await invoke(server, '/api/attachments', { method: 'POST', cookie: cookies.editor, rawBody: Buffer.from('{') })).status, 400);
  storage.head = async () => ({ size: data.length, sha256: 'bad' });
  const mismatch = await upload(input);
  t.assert.strictEqual(mismatch.status, 502);
  t.assert.strictEqual(mismatch.body.code, 'ATTACHMENT_CHECKSUM_MISMATCH');
  const unconfigured = createServer(db, { storage: new S3Storage({ env: {} }) });
  t.assert.strictEqual((await invoke(unconfigured, '/api/attachments', { method: 'POST', body: input, cookie: cookies.editor })).status, 503);
});

test('download stream failure terminates the binary response without appending JSON', async t => {
  const { db, cookies, storage, upload } = await fixture(t);
  const file = await upload();
  storage.get = async () => Readable.from((async function* () {
    yield Buffer.from('partial');
    throw new Error('Synthetic stream failure');
  })());
  const response = await invoke(createServer(db, { storage }), `/api/attachments/${file.id}`, { cookie: cookies.viewer });
  t.assert.strictEqual(response.status, 200);
  t.assert.strictEqual(response.complete, false);
  t.assert.strictEqual(response.raw.toString(), 'partial');
});

async function hseFixture(t) {
  const f = await fixture(t);
  const event = await createHseEvent(f.db, { siteId: f.site.id, type: 'observation', severity: 'low', occurredOn: '2026-11-01' }, f.users.editor);
  const input = { ...f.input, entity_type: 'hse_event', entity_id: event.id };
  return { ...f, event, input, upload: (extra = {}, user = f.users.editor) => createAttachment(f.db, { ...input, ...extra }, user, f.storage) };
}

test('HSE attachment HTTP role matrix, minimal read audit and mixed-site listing', async t => {
  const { db, site, task, event, input, users, cookies, storage } = await hseFixture(t);
  const server = createServer(db, { storage });
  const scoped = `/api/attachments?site_id=${site.id}&entity_type=hse_event&entity_id=${event.id}`;
  const files = [];
  for (const role of ['owner', 'editor', 'verifier', 'viewer', 'outsider']) {
    const created = await invoke(server, '/api/attachments', { method: 'POST', body: input, cookie: cookies[role] });
    t.assert.strictEqual(created.status, ['owner', 'editor'].includes(role) ? 201 : 403, role);
    if (created.status === 201) files.push(created.body);
  }
  t.assert.strictEqual(storage.objects.size, 2);
  const taskFile = await createAttachment(db, { ...input, entity_type: 'task', entity_id: task.id }, users.editor, storage);
  const file = files[0], path = `/api/attachments/${file.id}`;
  t.assert.strictEqual((await invoke(server, path)).status, 401);
  for (const role of ['owner', 'editor', 'verifier', 'viewer', 'outsider']) {
    const allowed = ['owner', 'editor', 'verifier'].includes(role);
    const list = await invoke(server, scoped, { cookie: cookies[role] });
    t.assert.strictEqual(list.status, allowed ? 200 : 403, role);
    // Both uploads can share the same created_at, so the server orders by created_at then id:
    // compare by id, not by insertion order.
    if (allowed) t.assert.deepStrictEqual([...list.body].sort((a, b) => a.id.localeCompare(b.id)), [...files].sort((a, b) => a.id.localeCompare(b.id)));
    const response = await invoke(server, path, { cookie: cookies[role] });
    t.assert.strictEqual(response.status, allowed ? 200 : 403, role);
    if (allowed) t.assert.deepStrictEqual(response.raw, data);
  }
  const audit = await invoke(server, `/api/audit-events?site_id=${site.id}&entity_type=hse_event&entity_id=${event.id}`, { cookie: cookies.verifier });
  t.assert.strictEqual(audit.status, 200);
  const reads = audit.body.filter(row => row.action === 'read');
  t.assert.strictEqual(reads.length, 3);
  t.assert.deepStrictEqual(reads.map(row => row.actor).sort(), ['owner', 'editor', 'verifier'].map(role => users[role].id).sort());
  for (const row of reads) {
    t.assert.strictEqual(row.entity_type, 'hse_event');
    t.assert.strictEqual(row.entity_id, event.id);
    t.assert.strictEqual(row.site_id, site.id);
    t.assert.strictEqual(new Date(row.at).toISOString(), row.at);
    t.assert.deepStrictEqual(JSON.parse(row.changes), { attachment: { id: file.id, filename: file.filename } });
  }
  t.assert.deepStrictEqual((await invoke(server, `/api/attachments?site_id=${site.id}`, { cookie: cookies.viewer })).body, [taskFile]);
  const taskRead = await invoke(server, `/api/attachments/${taskFile.id}`, { cookie: cookies.viewer });
  t.assert.strictEqual(taskRead.status, 200);
  t.assert.deepStrictEqual(taskRead.raw, data);
  await saveModuleAccess(db, { siteId: site.id, memberId: users.verifier.id, module: 'hse', allowed: false }, users.owner);
  t.assert.strictEqual((await invoke(server, path, { cookie: cookies.verifier })).status, 403);
  t.assert.strictEqual((await invoke(server, scoped, { cookie: cookies.verifier })).status, 403);
  t.assert.deepStrictEqual((await invoke(server, `/api/attachments?site_id=${site.id}`, { cookie: cookies.verifier })).body, [taskFile]);
  t.assert.strictEqual(Number((await db.get("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'read'")).n), 3);
  for (const role of ['verifier', 'viewer']) {
    t.assert.strictEqual((await invoke(server, path, { method: 'DELETE', cookie: cookies[role] })).status, 403);
  }
  t.assert.strictEqual((await invoke(server, path, { method: 'DELETE', cookie: cookies.editor })).status, 204);
});

test('soft-deleted HSE events hide attachments from every list and download while preserving originals', async t => {
  const { db, site, event, users, cookies, storage, input, upload } = await hseFixture(t);
  const file = await upload();
  await deleteHseEvent(db, event.id, users.owner);
  const calls = storage.calls.length;
  const server = createServer(db, { storage });
  for (const role of ['owner', 'editor', 'verifier']) {
    for (const suffix of ['', '&entity_type=hse_event', `&entity_type=hse_event&entity_id=${event.id}`]) {
      const response = await invoke(server, `/api/attachments?site_id=${site.id}${suffix}`, { cookie: cookies[role] });
      t.assert.strictEqual(response.status, 200);
      t.assert.deepStrictEqual(response.body, []);
    }
    t.assert.strictEqual((await invoke(server, `/api/attachments/${file.id}`, { cookie: cookies[role] })).status, 404);
  }
  t.assert.strictEqual((await invoke(server, '/api/attachments', { method: 'POST', body: input, cookie: cookies.editor })).status, 404);
  t.assert.strictEqual(storage.calls.length, calls);
  t.assert.strictEqual(storage.objects.size, 1);
  t.assert.ok(await db.get('SELECT id FROM attachments WHERE id = ?', file.id));
  t.assert.strictEqual(Number((await db.get("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'read'")).n), 0);
});

test('HSE download remains complete with HTTP 200 and an explicit log when audit writing fails', async t => {
  const { db, cookies, storage, upload } = await hseFixture(t);
  const file = await upload();
  const failing = {
    get: db.get.bind(db), all: db.all.bind(db),
    run: (sql, ...values) => {
      if (/^INSERT INTO audit_events/.test(sql)) throw new Error('Synthetic audit write failure');
      return db.run(sql, ...values);
    },
  };
  const logs = [];
  t.mock.method(console, 'error', (...args) => logs.push(args));
  const response = await invoke(createServer(failing, { storage }), `/api/attachments/${file.id}`, { cookie: cookies.verifier });
  t.assert.strictEqual(response.status, 200);
  t.assert.strictEqual(response.complete, true);
  t.assert.deepStrictEqual(response.raw, data);
  t.assert.deepStrictEqual(logs, [['HSE attachment read audit failed.']]);
  t.assert.strictEqual(Number((await db.get("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'read'")).n), 0);
});

test('HSE attachments keep size/type validation and recheck deletion after the storage round trip', async t => {
  const { db, event, users, storage, upload } = await hseFixture(t);
  await t.assert.rejects(() => upload({ content_type: 'text/html' }), { status: 415 });
  await t.assert.rejects(() => upload({ data_base64: Buffer.alloc(MAX_ATTACHMENT_BYTES + 1).toString('base64') }), { status: 413 });
  t.assert.strictEqual(storage.calls.length, 0);
  const head = storage.head.bind(storage);
  storage.head = async key => {
    await deleteHseEvent(db, event.id, users.owner);
    return head(key);
  };
  await t.assert.rejects(() => upload(), { status: 404 });
  t.assert.deepStrictEqual(await db.all('SELECT * FROM attachments'), []);
  t.assert.strictEqual(storage.objects.size, 0);
});
