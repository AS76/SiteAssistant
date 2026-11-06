/**
 * SQL operations available both on a Storage and inside its transaction callback.
 * Parameters use positional `?` placeholders. run() reports affected rows.
 *
 * @typedef {object} StorageExecutor
 * @property {(sql: string, ...params: any[]) => Promise<object[]>} all
 * @property {(sql: string, ...params: any[]) => Promise<object|undefined>} get
 * @property {(sql: string, ...params: any[]) => Promise<{rowCount: number, lastInsertRowid: number|bigint}>} run
 * @property {(sql: string) => Promise<void>} exec
 * @property {(error: Error) => boolean} isUniqueViolation
 */

/**
 * The callback must use its supplied executor for every database operation.
 * A rejected callback rolls back all its writes; a fulfilled callback commits.
 *
 * @typedef {StorageExecutor & {
 *   transaction: <T>(fn: (tx: StorageExecutor) => Promise<T>) => Promise<T>,
 *   close: () => Promise<void>,
 *   isOpen: boolean
 * }} Storage
 */

export { SqliteStorage } from './sqlite.mjs';
