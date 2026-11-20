import pg from 'pg';

// Shared SQL has no question marks inside string literals.
export function translatePlaceholders(sql) {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

const isUniqueViolation = error => error?.code === '23505';

function executor(connection) {
  const query = (sql, params) => connection.query(translatePlaceholders(sql), params);
  return {
    all: async (sql, ...params) => (await query(sql, params)).rows,
    get: async (sql, ...params) => (await query(sql, params)).rows[0],
    run: async (sql, ...params) => ({ rowCount: (await query(sql, params)).rowCount }),
    exec: async sql => { await connection.query(sql); },
    isUniqueViolation,
  };
}

/** @implements {import('./index.mjs').Storage} */
export class PgStorage {
  #pool;
  #executor;
  #schema;
  #isOpen = true;

  constructor(connectionString = process.env.DATABASE_URL, { schema } = {}) {
    if (!connectionString) throw new Error('DATABASE_URL is required for the pg driver.');
    // Restrict schema identifiers so both SQL and connection options are safe.
    if (schema !== undefined && !/^[a-z_][a-z0-9_]*$/.test(schema)) {
      throw new Error('Invalid PostgreSQL schema name.');
    }
    this.#schema = schema;
    if (schema !== undefined) {
      // pg gives URL options precedence over Pool options. Remove any URL
      // override so every connection uses only the selected schema.
      let url;
      try { url = new URL(connectionString); }
      catch { throw new Error('DATABASE_URL must be a PostgreSQL URL.'); }
      url.searchParams.delete('options');
      connectionString = url.href;
    }
    this.#pool = new pg.Pool({
      connectionString,
      max: 10,
      // Keep the storage/JSON contract identical to SQLite, including in tx.
      types: {
        getTypeParser: (oid, format) => oid === 1184 && format !== 'binary'
          ? value => new Date(value).toISOString()
          : pg.types.getTypeParser(oid, format),
      },
      ...(schema === undefined ? {} : { options: `-c search_path=${schema}` }),
    });
    this.#executor = executor(this.#pool);
  }

  async open() {
    if (this.#schema !== undefined) {
      await this.exec(`CREATE SCHEMA IF NOT EXISTS "${this.#schema}"`);
    }
    return this;
  }

  all(sql, ...params) { return this.#executor.all(sql, ...params); }
  get(sql, ...params) { return this.#executor.get(sql, ...params); }
  run(sql, ...params) { return this.#executor.run(sql, ...params); }
  exec(sql) { return this.#executor.exec(sql); }

  async transaction(fn) {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(executor(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  isUniqueViolation(error) { return isUniqueViolation(error); }

  async close() {
    if (!this.#isOpen) return;
    this.#isOpen = false;
    await this.#pool.end();
  }

  get isOpen() { return this.#isOpen; }
}
