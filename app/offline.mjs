// Browser data is scoped to the API and signed-in user; it is never authentication.
export const SYNC_TAG = 'siteassistant-pending-ops';
export const DB_NAME = 'siteassistant-offline-v1';
export const scopeFor = (baseUrl, userId) => JSON.stringify([baseUrl, userId]);
const types = ['create_task', 'transition_task', 'create_diary', 'create_attachment'];
const collection = type => ({ create_task: 'tasks', transition_task: 'tasks', create_diary: 'diary', create_attachment: 'attachments' })[type];
const failed = code => Object.assign(new Error(code), { code, status: 409 });

export function createOfflineStore({ indexedDB = globalThis.indexedDB, name = DB_NAME, locks = globalThis.navigator?.locks } = {}) {
  let opening;
  function openDb() {
    if (!opening) opening = new Promise((resolve, reject) => {
      if (!indexedDB) return reject(new Error('offlineStorageUnavailable'));
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => {
        for (const store of ['pending_ops', 'mirror', 'mappings']) request.result.createObjectStore(store, { keyPath: 'id' });
      };
      request.onsuccess = () => { request.result.onversionchange = () => { request.result.close(); opening = null; }; resolve(request.result); };
      request.onerror = () => { opening = null; reject(request.error); };
      request.onblocked = () => reject(new Error('offlineStorageUnavailable'));
    });
    return opening;
  }
  // Resolve only on transaction commit, including quota/abort failures after a request succeeds.
  async function transaction(stores, mode, run) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      let result;
      tx.oncomplete = () => resolve(result);
      tx.onabort = tx.onerror = () => reject(tx.error || new Error('offlineStorageUnavailable'));
      try { run(tx, value => { result = value; }); }
      catch (error) { tx.abort(); reject(error); }
    });
  }
  const read = (store, id) => transaction([store], 'readonly', (tx, done) => {
    const request = tx.objectStore(store).get(id); request.onsuccess = () => done(request.result);
  });
  const put = (store, row) => transaction([store], 'readwrite', tx => tx.objectStore(store).put(row));
  const getMirror = async id => (await read('mirror', id))?.value;
  const setMirror = (id, value) => put('mirror', { id, value });
  const listOps = (scope) => transaction(['pending_ops'], 'readonly', (tx, done) => {
    const request = tx.objectStore('pending_ops').getAll();
    request.onsuccess = () => done(request.result.filter(op => scope === undefined || op.scope === scope).sort((a, b) => a.sequence - b.sequence));
  });
  const removeOp = id => transaction(['pending_ops'], 'readwrite', tx => tx.objectStore('pending_ops').delete(id));
  function withSyncLock(run) {
    if (!locks) return Promise.reject(new Error('offlineLockUnavailable'));
    return locks.request(`${name}:sync`, run);
  }
  async function enqueue(input) {
    if (!types.includes(input.op_type) || !input.scope) throw new Error('invalidData');
    const id = input.id || crypto.randomUUID();
    const op = { ...input, id, entity_id: input.entity_id || id, idempotency_key: input.idempotency_key || id,
      created_at: input.created_at || new Date().toISOString(), retries: 0, status: 'pending' };
    const save = () => transaction(['pending_ops', 'mirror', 'mappings'], 'readwrite', (tx, done) => {
      const queue = tx.objectStore('pending_ops');
      const all = queue.getAll();
      all.onsuccess = () => {
        const duplicate = all.result.find(item => item.scope === op.scope && (item.id === id || item.idempotency_key === op.idempotency_key));
        if (duplicate) return done(duplicate);
        const receipt = tx.objectStore('mappings').get(`${op.scope}:${op.entity_id}`);
        receipt.onsuccess = () => {
          if (receipt.result && op.op_type.startsWith('create_')) return done({ ...op, status: 'confirmed', result: receipt.result.value });
          // LWW for a diary slot that has never been submitted; preserve its client identity and FIFO position.
          const older = op.op_type === 'create_diary' && all.result.find(item => item.scope === op.scope && item.op_type === op.op_type && item.status === 'pending' && item.retries === 0 &&
            ['siteId', 'date', 'shift'].every(key => item.payload[key] === op.payload[key]));
          if (older) {
            const winner = Date.parse(op.created_at) > Date.parse(older.created_at) ? { ...older, payload: op.payload, created_at: op.created_at } : older;
            queue.put(winner); return done(winner);
          }
          const counter = tx.objectStore('mirror').get('sequence');
          counter.onsuccess = () => {
            op.sequence = (counter.result?.value || 0) + 1;
            tx.objectStore('mirror').put({ id: 'sequence', value: op.sequence });
            queue.add(op); done(op);
          };
        };
      };
    });
    return locks ? withSyncLock(save) : save();
  }
  async function confirm(op, result) {
    await transaction(['pending_ops', 'mirror', 'mappings'], 'readwrite', tx => {
      if (op.op_type.startsWith('create_')) {
        tx.objectStore('mappings').put({ id: `${op.scope}:${op.entity_id}`, value: result });
        const queue = tx.objectStore('pending_ops');
        const remaining = queue.getAll();
        remaining.onsuccess = () => {
          for (const dependent of remaining.result) {
            if (dependent.scope !== op.scope || dependent.id === op.id) continue;
            if (dependent.op_type === 'transition_task' && dependent.payload.task.id === op.entity_id) {
              dependent.payload.task.id = result.id; dependent.entity_id = result.id; queue.put(dependent);
            }
            if (dependent.op_type === 'create_attachment' && dependent.payload.entity_id === op.entity_id) {
              dependent.payload.entity_id = result.id; queue.put(dependent);
            }
          }
        };
      }
      const mirror = tx.objectStore('mirror');
      const request = mirror.get(`state:${op.scope}`);
      request.onsuccess = () => {
        if (request.result) {
          const value = request.result.value, key = collection(op.op_type);
          value[key] = [...(value[key] || []).filter(item => ![op.entity_id, result.id].includes(item.id)), result];
          mirror.put({ id: `state:${op.scope}`, value });
        }
        tx.objectStore('pending_ops').delete(op.id);
      };
    });
  }
  async function resolveId(scope, id) { return (await read('mappings', `${scope}:${id}`))?.value.id || id; }
  async function reconcile(api, op, payload) {
    if (op.op_type === 'create_diary') {
      return (await api.listDiary({ siteId: payload.siteId })).find(entry =>
        ['date', 'shift', 'plan', 'actual', 'blockers', 'next'].every(key => (entry[key] || '') === (payload[key] || '')));
    }
    if (op.op_type === 'create_attachment') {
      const digest = await crypto.subtle.digest('SHA-256', await payload.blob.arrayBuffer());
      const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
      return (await api.listAttachments({ site_id: payload.site_id, entity_type: payload.entity_type, entity_id: payload.entity_id }))
        .find(entry => !op.before_ids?.includes(entry.id) && entry.filename === payload.filename && entry.content_sha256 === hash && entry.size === payload.blob.size);
    }
    if (op.op_type === 'transition_task') {
      const task = await api.getTask(payload.task.id);
      const event = task.events?.find(event => !op.before_ids?.includes(event.id) && event.from_status === payload.task.status && event.to_status === payload.input.to &&
        event.actor === payload.input.actor && (event.note || '') === (payload.input.note || '') && (event.reason || '') === (payload.input.reason || ''));
      return event ? task : undefined;
    }
  }
  async function replayOps(api, { scope, userId } = {}) {
    return withSyncLock(async () => {
      const summary = { confirmed: 0, failed: 0, pending: 0 };
      const active = await getMirror('active');
      if (!scope || active?.scope !== scope || active.baseUrl !== api.baseUrl) return summary;
      const session = await api.me(); // Never replay using a cached identity or another user's cookie.
      if (session.user.id !== userId) throw new Error('offlineSessionChanged');
      for (const queued of await listOps(scope)) {
        // Earlier acknowledgements may have resolved this operation's client IDs.
        let op = await read('pending_ops', queued.id);
        if (!op) continue;
        if (op.status === 'failed') continue;
        if ((await getMirror('active'))?.scope !== scope) break;
        const payload = structuredClone(op.payload);
        const dependency = op.op_type === 'transition_task' ? payload.task.id : op.op_type === 'create_attachment' ? payload.entity_id : null;
        try {
          if (dependency) {
            const blockers = (await listOps(scope)).filter(item => item.sequence < op.sequence && item.entity_id === dependency);
            if (blockers.length) throw failed('SYNC_DEPENDENCY_FAILED');
            const resolved = await resolveId(scope, dependency);
            if (op.op_type === 'transition_task') payload.task.id = resolved;
            else payload.entity_id = resolved;
          }
          if (['sending', 'uncertain'].includes(op.status) && op.op_type !== 'create_task') {
            const result = await reconcile(api, op, payload);
            if (!result) throw failed('SYNC_UNCERTAIN');
            await confirm(op, result); summary.confirmed++; continue;
          }
          // Record the pre-request state before a non-idempotent write to reconcile a lost response.
          if (op.op_type === 'transition_task') op.before_ids = (await api.getTask(payload.task.id)).events?.map(event => event.id) || [];
          if (op.op_type === 'create_attachment') op.before_ids = (await api.listAttachments({ site_id: payload.site_id, entity_type: payload.entity_type, entity_id: payload.entity_id })).map(entry => entry.id);
          op = { ...op, status: 'sending', retries: op.retries + 1 };
          await put('pending_ops', op);
          const options = { idempotencyKey: op.idempotency_key };
          let result;
          if (op.op_type === 'create_task') result = await api.createTask(payload, options);
          if (op.op_type === 'transition_task') result = await api.transitionTask(payload.task, payload.input, options);
          if (op.op_type === 'create_diary') result = await api.createDiary(payload, options);
          if (op.op_type === 'create_attachment') result = await api.createAttachment(payload, options);
          await confirm(op, result); summary.confirmed++;
        } catch (error) {
          const transient = !error.status || error.status >= 500 || [401, 408, 429].includes(error.status);
          const uncertain = transient && op.status === 'sending' && op.op_type !== 'create_task' && ![401, 429].includes(error.status);
          op = { ...op, status: transient ? (uncertain ? 'uncertain' : 'pending') : 'failed', error: { code: error.code || error.message, status: error.status || 0 } };
          await put('pending_ops', op);
          if (transient) break; // Keep FIFO order when the server cannot confirm the head.
          summary.failed++;
        }
      }
      summary.pending = (await listOps(scope)).filter(op => op.status !== 'failed').length;
      return summary;
    });
  }
  return { openDb, enqueue, listOps, removeOp, replayOps, getMirror, setMirror, withSyncLock };
}

// Overlay only queued local creations. A proposed transition never replaces the authoritative status.
export function overlayPending(state, ops) {
  const result = structuredClone(state);
  for (const key of ['tasks', 'diary', 'attachments']) result[key] = (result[key] || []).filter(item => !item.localOnly).map(({ syncStatus, ...item }) => item);
  for (const op of ops) {
    const key = collection(op.op_type);
    if (!key) continue;
    let entity = result[key].find(item => item.id === op.entity_id);
    if (!entity && op.op_type !== 'transition_task') {
      entity = { ...op.payload, id: op.entity_id, localOnly: true, createdAt: op.created_at, created_at: op.created_at };
      if (op.op_type === 'create_task') Object.assign(entity, { status: 'todo', events: [] });
      result[key].push(entity);
    }
    if (entity) entity.syncStatus = entity.syncStatus === 'failed' ? 'failed' : op.status === 'failed' ? 'failed' : 'pending';
  }
  return result;
}

const defaultStore = createOfflineStore();
export const { openDb, enqueue, listOps, removeOp, replayOps, getMirror, setMirror, withSyncLock } = defaultStore;
export async function registerSync(registration) {
  try { await registration?.sync?.register(SYNC_TAG); } catch { /* The page's online/visibility/retry hooks remain available. */ }
}
