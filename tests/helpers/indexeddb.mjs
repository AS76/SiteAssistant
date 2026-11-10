// Small asynchronous IndexedDB test double with structured cloning, serialized
// transactions and rollback. Storage belongs to the factory, not a connection.
export function mockIndexedDB() {
  const databases = new Map();
  let abortNext = false;
  return {
    abortNextCommit() { abortNext = true; },
    open(name) {
      const request = {};
      setImmediate(() => {
        const fresh = !databases.has(name);
        if (fresh) databases.set(name, { stores: new Map(), jobs: [], busy: false });
        const database = databases.get(name);
        const pump = () => {
          if (database.busy || !database.jobs.length) return;
          database.busy = true; database.jobs.shift()();
        };
        request.result = {
          close() {},
          createObjectStore(name) { database.stores.set(name, new Map()); },
          transaction(names, mode) {
            let stores, active = false, aborted = false;
            const jobs = [];
            const tx = {
              error: null,
              abort() { aborted = true; tx.error ||= new Error('AbortError'); if (active) setImmediate(drain); },
              objectStore(name) {
                const operation = fn => {
                  const req = {};
                  jobs.push(() => {
                    try { req.result = structuredClone(fn(stores.get(name))); req.onsuccess?.(); }
                    catch (error) { tx.error = req.error = error; req.onerror?.(); aborted = true; }
                  });
                  return req;
                };
                return {
                  get: id => operation(store => store.get(id)),
                  getAll: () => operation(store => [...store.values()]),
                  put: row => operation(store => { store.set(row.id, structuredClone(row)); return row.id; }),
                  add: row => operation(store => { if (store.has(row.id)) throw new Error('ConstraintError'); store.set(row.id, structuredClone(row)); return row.id; }),
                  delete: id => operation(store => { store.delete(id); }),
                };
              },
            };
            let finished = false;
            const drain = () => {
              if (finished) return;
              if (jobs.length && !aborted) { jobs.shift()(); setImmediate(drain); return; }
              if (mode === 'readwrite' && abortNext) { abortNext = false; aborted = true; tx.error = new Error('QuotaExceededError'); }
              if (!aborted && mode === 'readwrite') for (const [name, rows] of stores) database.stores.set(name, rows);
              finished = true;
              if (aborted) tx.onabort?.(); else tx.oncomplete?.();
              database.busy = false; pump();
            };
            database.jobs.push(() => {
              stores = new Map(names.map(name => [name, structuredClone(database.stores.get(name))]));
              active = true; setImmediate(drain);
            });
            setImmediate(pump);
            return tx;
          },
        };
        if (fresh) request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  };
}
export function mockLocks() {
  const tails = new Map();
  return { request(name, callback) {
    const result = (tails.get(name) || Promise.resolve()).then(callback);
    tails.set(name, result.catch(() => {})); return result;
  } };
}
