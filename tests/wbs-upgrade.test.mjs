import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { wbsDatabase } from './helpers/wbs.mjs';
import { applyMigration } from '../server/migrations/index.mjs';

for (const driver of ['sqlite', 'pg']) test(`036 ${driver}: populated upgrade keeps original nodes, history and inbound references`, async t => {
  const db = await wbsDatabase(t, driver, { beforeOperational: true });
  const site = randomUUID(), root = randomUUID(), child = randomUUID(), task = randomUUID(), item = randomUUID(), employee = randomUUID(), day = randomUUID(), booking = randomUUID(), at = '2026-11-16T22:00:00Z';
  const scope = randomUUID(), run = randomUUID();
  await db.run("INSERT INTO sites (id, code, name, created_at) VALUES (?, 'SYN-UPGRADE', 'Synthetic upgrade', ?)", site, at);
  await db.run("INSERT INTO wbs_import_sources (site_id, scope_id, run_id) VALUES (?, ?, ?)", site, scope, run);
  await db.run("INSERT INTO project_structure (id, site_id, wbs_code, level, created_at, source_uuid) VALUES (?, ?, 'ROOT', 0, ?, ?)", root, site, at, randomUUID());
  await db.run("INSERT INTO project_structure (id, site_id, parent_id, wbs_code, level, created_at) VALUES (?, ?, ?, 'C03', 1, ?)", child, site, root, at);
  await db.run("INSERT INTO tasks (id, site_id, title, executor, verifier, created_at) VALUES (?, ?, 'Synthetic linked work', 'Crew', 'Checker', ?)", task, site, at);
  await db.run("INSERT INTO task_events (task_id, at, actor, from_status, to_status) VALUES (?, ?, 'Crew', 'todo', 'in_progress')", task, at);
  await db.run('INSERT INTO site_progress_items (id, site_id, wbs_id, source_row, created_at) VALUES (?, ?, ?, 1, ?)', item, site, child, at);
  await db.run("INSERT INTO employees (id, site_id, employee_no, created_at) VALUES (?, ?, 'SYN-1', ?)", employee, site, at);
  await db.run("INSERT INTO work_days (id, site_id, employee_id, operational_date, shift, created_at) VALUES (?, ?, ?, '2026-11-16', 'night', ?)", day, site, employee, at);
  await db.run('INSERT INTO time_bookings (id, site_id, work_day_id, site_progress_item_id, hours, created_at) VALUES (?, ?, ?, ?, 6, ?)', booking, site, day, item, at);
  const tables = ['project_structure', 'tasks', 'task_events', 'site_progress_items', 'time_bookings', 'work_days'];
  const before = await Promise.all(tables.map(table => db.all(`SELECT * FROM ${table} ORDER BY id`)));
  await db.transaction(tx => applyMigration(tx, '036_wbs_operational.sql', { driver }));
  for (const [index, table] of tables.entries()) {
    const after = await db.all(`SELECT * FROM ${table} ORDER BY id`);
    assert.deepEqual(after.map(row => Object.fromEntries(Object.keys(before[index][0]).map(key => [key, row[key]]))), before[index].map(row => ({ ...row })));
  }
  assert.deepEqual({ ...await db.get('SELECT source_scope, source_run_id FROM project_structure WHERE id = ?', root) }, { source_scope: scope, source_run_id: run });
  assert.equal((await db.get('SELECT wbs_id FROM tasks WHERE id = ?', task)).wbs_id, null);
  await db.run('UPDATE project_structure SET source_scope = NULL, source_run_id = NULL WHERE id = ?', root);
  await db.transaction(tx => applyMigration(tx, '037_wbs_source_scope_backfill.sql', { driver }));
  assert.deepEqual({ ...await db.get('SELECT source_scope, source_run_id FROM project_structure WHERE id = ?', root) }, { source_scope: scope, source_run_id: run });
  await db.run('UPDATE tasks SET wbs_id = ? WHERE id = ?', child, task);
  if (driver === 'sqlite') {
    assert.deepEqual(await db.all('PRAGMA foreign_key_check'), []);
    assert.equal(Number((await db.get('PRAGMA foreign_keys')).foreign_keys), 1);
    const keys = await db.all('PRAGMA foreign_key_list(tasks)');
    assert.ok(keys.some(key => key.from === 'site_id' && key.table === 'project_structure'));
  }
});
