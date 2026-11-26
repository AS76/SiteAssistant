// The ledger stores scalar primary keys as text and composite keys as JSON arrays.
export const compositeKeys = {
  shipment_packages: ['shipment_id', 'package_id'],
  cost_impact_deviations: ['cost_impact_id', 'deviation_id'],
  deviation_links: ['deviation_id', 'entity_type', 'entity_id'],
  deviation_export_rows: ['export_id', 'deviation_id'],
  site_members: ['site_id', 'user_id'],
};

export function recordFixture(db, table, key) {
  const recordId = Array.isArray(key) ? JSON.stringify(key.map(String)) : String(key);
  return db.run(`INSERT INTO demo_seed_records (table_name, record_id)
    VALUES (?, ?) ON CONFLICT DO NOTHING`, table, recordId);
}

export function keyForRecord(table, recordId) {
  const columns = compositeKeys[table];
  if (!columns) return { where: 'id = ?', values: [recordId] };
  const values = JSON.parse(recordId);
  if (!Array.isArray(values) || values.length !== columns.length || values.some(value => typeof value !== 'string')) {
    throw new Error(`Invalid demo registry key for ${table}: ${recordId}`);
  }
  return { where: columns.map(column => `${column} = ?`).join(' AND '), values };
}

const quote = name => '"' + name.replaceAll('"', '""') + '"';

// Check cascading foreign keys before deleting a parent. Restrictive foreign
// keys are enforced by the engine, except for users we intentionally retain.
export async function inboundDemoReferences(db, sqlite) {
  if (sqlite) return db.all(`SELECT 'main' AS child_schema, child.name AS child_table,
      fk."table" AS parent_table, fk.id AS constraint_id, fk."from" AS child_column,
      COALESCE(fk."to", pk.name) AS parent_column
    FROM main.sqlite_schema child JOIN pragma_foreign_key_list(child.name, 'main') fk
    LEFT JOIN pragma_table_info(fk."table", 'main') pk ON pk.pk = fk.seq + 1
    WHERE child.type = 'table' AND (fk.on_delete IN ('CASCADE', 'SET NULL', 'SET DEFAULT') OR fk."table" = 'users')`);
  return db.all(`SELECT child_ns.nspname AS child_schema, child.relname AS child_table,
      parent.relname AS parent_table, fk.oid AS constraint_id,
      child_key.attname AS child_column, parent_key.attname AS parent_column
    FROM pg_constraint fk
    JOIN pg_class child ON child.oid = fk.conrelid
    JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace
    JOIN pg_class parent ON parent.oid = fk.confrelid
    JOIN pg_namespace parent_ns ON parent_ns.oid = parent.relnamespace
    CROSS JOIN LATERAL unnest(fk.conkey, fk.confkey) AS keys(child_attnum, parent_attnum)
    JOIN pg_attribute child_key ON child_key.attrelid = child.oid AND child_key.attnum = keys.child_attnum
    JOIN pg_attribute parent_key ON parent_key.attrelid = parent.oid AND parent_key.attnum = keys.parent_attnum
    WHERE fk.contype = 'f' AND parent_ns.nspname = current_schema()
      AND (fk.confdeltype IN ('c', 'n', 'd') OR parent.relname = 'users')`);
}

export async function referencingTable(db, references, table, where, values) {
  const constraints = new Map();
  for (const column of references.filter(reference => reference.parent_table === table)) {
    const key = JSON.stringify([column.child_schema, column.child_table, column.constraint_id]);
    if (!constraints.has(key)) constraints.set(key, []);
    constraints.get(key).push(column);
  }
  for (const columns of constraints.values()) {
    const [{ child_schema: schema, child_table: child }] = columns;
    const join = columns.map(({ child_column, parent_column }) => `child.${quote(child_column)} = parent.${quote(parent_column)}`).join(' AND ');
    if (await db.get(`SELECT 1 FROM ${quote(schema)}.${quote(child)} child
      WHERE EXISTS (SELECT 1 FROM (SELECT * FROM ${table} WHERE ${where}) parent WHERE ${join}) LIMIT 1`, ...values)) {
      return child;
    }
  }
}

const attachmentTargets = {
  deviations: 'deviation',
  diary: 'diary',
  hse_events: 'hse_event',
  hse_inspections: 'hse_inspection',
  tasks: 'task',
};
const deviationLinkTargets = {
  diary: 'diary',
  site_progress_items: 'site_progress_item',
  tasks: 'task',
  work_days: 'work_day',
};

export async function referencingOperationalLink(db, table, id) {
  for (const [relation, targets] of [['attachments', attachmentTargets], ['deviation_links', deviationLinkTargets]]) {
    const entityType = targets[table];
    if (entityType && await db.get(`SELECT 1 FROM ${relation} WHERE entity_type = ? AND entity_id = ? LIMIT 1`, entityType, id)) {
      return relation;
    }
  }
}
