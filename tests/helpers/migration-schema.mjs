import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fixtureRoot, json } from './migration-manifest.mjs';

const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const objects = rows => Object.fromEntries(rows.sort((a, b) => compare(a.key, b.key))
  .map(({ key, ...definition }) => [key, definition]));
const qualified = ({ type, name, ...definition }) => ({ key: `${type} ${name}`, ...definition });

async function sqliteCatalog(db) {
  const entries = await db.all(`SELECT type, name, tbl_name AS relation, sql
    FROM main.sqlite_schema WHERE name NOT GLOB 'sqlite_*'`);
  for (const entry of entries) {
    if (['table', 'view'].includes(entry.type)) {
      entry.columns = (await db.all(`SELECT name, type, "notnull" AS required, dflt_value AS default_value,
        pk, hidden FROM pragma_table_xinfo(?) ORDER BY cid`, entry.name)).map(row => ({ ...row }));
    }
    if (entry.type === 'table') {
      entry.foreignKeys = (await db.all(`SELECT * FROM pragma_foreign_key_list(?) ORDER BY id, seq`, entry.name))
        .map(row => ({ ...row }));
    }
    if (entry.type === 'index') {
      entry.columns = await indexColumns(db, entry.name);
    }
  }
  for (const table of entries.filter(entry => entry.type === 'table')) {
    const indexes = await db.all(`SELECT name, origin FROM pragma_index_list(?) WHERE origin IN ('u', 'pk')`, table.name);
    // SQLite assigns autoindex names during table rebuilds. Keep their definitions.
    table.implicitIndexes = [];
    for (const { name, origin } of indexes) {
      table.implicitIndexes.push({ origin, columns: await indexColumns(db, name) });
    }
    table.implicitIndexes.sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b)));
  }
  return objects(entries.map(qualified));
}

async function indexColumns(db, name) {
  return (await db.all(`SELECT name, "desc" AS descending, coll, "key" AS is_key
    FROM pragma_index_xinfo(?) ORDER BY seqno`, name)).map(row => ({ ...row }));
}

async function pgCatalog(db) {
  // Run deparsers with the fixture schema on search_path, so local references
  // render unqualified. Only the function declaration header needs rewriting.
  // pg_get_*def() qualify local objects with the fixture schema, whose name is
  // generated per run. Strip that prefix so snapshots are stable across runs and
  // across the schema names used by the test helpers.
  const relations = await db.all(`SELECT CASE c.relkind WHEN 'v' THEN 'view' ELSE 'table' END AS type,
    c.relname AS name,
    CASE WHEN c.relkind = 'v' THEN replace(pg_get_viewdef(c.oid), quote_ident(n.nspname) || '.', '') END AS definition
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'p', 'v')`);
  const columns = await db.all(`SELECT c.relname AS relation, a.attname AS name,
    format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS required,
    pg_get_expr(d.adbin, d.adrelid) AS default_value, a.attidentity AS identity, a.attgenerated AS generated
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
    WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'p', 'v')
      AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`);
  for (const relation of relations) {
    relation.columns = columns.filter(column => column.relation === relation.name)
      .map(({ relation: _, ...column }) => column);
  }
  const constraints = await db.all(`SELECT 'constraint' AS type, c.relname || '.' || x.conname AS name,
    replace(pg_get_constraintdef(x.oid), quote_ident(n.nspname) || '.', '') AS definition, x.convalidated AS validated
    FROM pg_constraint x JOIN pg_class c ON c.oid = x.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = current_schema()`);
  const indexes = await db.all(`SELECT 'index' AS type, c.relname AS name,
    replace(pg_get_indexdef(c.oid), quote_ident(n.nspname) || '.', '') AS definition, i.indisvalid AS valid
    FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = current_schema()`);
  const triggers = await db.all(`SELECT 'trigger' AS type, c.relname || '.' || t.tgname AS name,
    replace(pg_get_triggerdef(t.oid), quote_ident(n.nspname) || '.', '') AS definition, t.tgenabled AS enabled
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = current_schema() AND NOT t.tgisinternal`);
  const functions = await db.all(`SELECT CASE WHEN p.prokind = 'p' THEN 'procedure' ELSE 'function' END AS type, p.proname || '(' ||
    pg_get_function_identity_arguments(p.oid) || ')' AS name,
    quote_ident(n.nspname) AS schema, pg_get_functiondef(p.oid) AS definition
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = current_schema() AND p.prokind IN ('f', 'p', 'w')`);
  const localFunctions = functions.map(({ schema, definition, ...routine }) => {
    const header = /^CREATE OR REPLACE (FUNCTION|PROCEDURE) /.exec(definition)?.[0];
    const prefix = `${header}${schema}.`;
    return { ...routine, definition: definition.startsWith(prefix) ? header + definition.slice(prefix.length) : definition };
  });
  return objects([...relations, ...constraints, ...indexes, ...triggers, ...localFunctions].map(qualified));
}

export function catalog(db, driver) {
  return driver === 'sqlite' ? sqliteCatalog(db) : pgCatalog(db);
}

export function logicalCatalog(snapshot) {
  return Object.fromEntries(Object.entries(snapshot)
    .filter(([key]) => key.startsWith('table ') || key.startsWith('view '))
    .map(([key, definition]) => [key, definition.columns.map(column => column.name)]));
}

export function assertCatalog(actual, expected, label) {
  const differences = [];
  for (const key of [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort()) {
    if (!Object.hasOwn(actual, key)) differences.push(`- ${key} (missing)`);
    else if (!Object.hasOwn(expected, key)) differences.push(`+ ${key} (unexpected)`);
    else if (json(actual[key]) !== json(expected[key])) {
      differences.push(`~ ${key}\n- ${JSON.stringify(expected[key])}\n+ ${JSON.stringify(actual[key])}`);
    }
  }
  assert.ok(!differences.length, `${label} differs:\n${differences.join('\n')}`);
}

export async function readSnapshot(engine) {
  return JSON.parse(await readFile(new URL(`${engine}.schema.json`, fixtureRoot), 'utf8'));
}

export async function assertPg16(db) {
  const { version } = await db.get("SELECT current_setting('server_version_num')::integer AS version");
  assert.equal(Math.floor(version / 10000), 16, 'The PostgreSQL catalog baseline requires PostgreSQL 16');
}
