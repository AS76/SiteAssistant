import { DatabaseSync } from 'node:sqlite';

/** @implements {import('./index.mjs').Storage} */
export class SqliteStorage {
  #db;
  #executor;
  #pending = Promise.resolve();

  constructor(path) {
    this.#db = new DatabaseSync(path);
    this.#executor = {
      all: async (sql, ...params) => this.#db.prepare(sql).all(...params),
      get: async (sql, ...params) => this.#db.prepare(sql).get(...params),
      run: async (sql, ...params) => {
        const result = this.#db.prepare(sql).run(...params);
        return { rowCount: Number(result.changes), lastInsertRowid: result.lastInsertRowid };
      },
      exec: async sql => { this.#db.exec(sql); },
      isUniqueViolation: error => this.isUniqueViolation(error),
    };
  }

  // Async callbacks can yield: keep unrelated operations out of a transaction
  // on this single SQLite connection. Its executor bypasses the outer queue.
  #enqueue(operation) {
    const result = this.#pending.then(operation);
    this.#pending = result.catch(() => {});
    return result;
  }

  all(sql, ...params) {
    return this.#enqueue(() => this.#executor.all(sql, ...params));
  }

  get(sql, ...params) {
    return this.#enqueue(() => this.#executor.get(sql, ...params));
  }

  run(sql, ...params) {
    return this.#enqueue(() => this.#executor.run(sql, ...params));
  }

  exec(sql) {
    return this.#enqueue(() => this.#executor.exec(sql));
  }

  transaction(fn) {
    return this.#enqueue(async () => {
      this.#db.exec('BEGIN');
      try {
        const result = await fn(this.#executor);
        this.#db.exec('COMMIT');
        return result;
      } catch (error) {
        this.#db.exec('ROLLBACK');
        throw error;
      }
    });
  }

  isUniqueViolation(error) {
    return error?.errcode === 2067;
  }

  close() {
    return this.#enqueue(() => { this.#db.close(); });
  }

  get isOpen() {
    return this.#db.isOpen;
  }
}
