-- Keep every operational ID and inbound link while adding composite site FKs.
-- Deferred constraints cover the table swaps. Validate the complete graph before
-- clearing SQLite's deferred DROP counters (restored parent rows keep the same IDs).
PRAGMA defer_foreign_keys = ON;
CREATE UNIQUE INDEX project_structure_legacy_id_site ON project_structure(id, site_id);
CREATE TABLE project_structure_with_wbs (
  id TEXT PRIMARY KEY NOT NULL,
  site_id TEXT NOT NULL REFERENCES sites(id),
  parent_id TEXT REFERENCES project_structure(id),
  source_uuid TEXT,
  wbs_code TEXT NOT NULL,
  description TEXT,
  level INTEGER NOT NULL CHECK (level >= 0),
  sort_order INTEGER,
  summary_task BOOLEAN,
  progress_pct NUMERIC,
  planned_start TEXT, planned_finish TEXT,
  actual_start TEXT, actual_finish TEXT,
  planned_hours NUMERIC,
  section TEXT, plc_area TEXT, assigned_to TEXT,
  is_synthetic BOOLEAN NOT NULL DEFAULT FALSE,
  source_entity_key_id TEXT,
  created_at TEXT NOT NULL,
  archived_at TEXT,
  updated_at TEXT,
  updated_by TEXT REFERENCES users(id),
  source_scope TEXT,
  source_run_id TEXT,
  missing_from_source BOOLEAN NOT NULL DEFAULT FALSE,
  CHECK (parent_id IS NULL OR parent_id <> id),
  UNIQUE (site_id, source_uuid),
  UNIQUE (id, site_id),
  FOREIGN KEY (parent_id, site_id) REFERENCES project_structure(id, site_id)
);
INSERT INTO project_structure_with_wbs (id, site_id, parent_id, source_uuid, wbs_code, description, level, sort_order, summary_task, progress_pct, planned_start, planned_finish, actual_start, actual_finish, planned_hours, section, plc_area, assigned_to, is_synthetic, source_entity_key_id, created_at) SELECT id, site_id, parent_id, source_uuid, wbs_code, description, level, sort_order, summary_task, progress_pct, planned_start, planned_finish, actual_start, actual_finish, planned_hours, section, plc_area, assigned_to, is_synthetic, source_entity_key_id, created_at FROM project_structure;
DROP TABLE project_structure;
ALTER TABLE project_structure_with_wbs RENAME TO project_structure;
CREATE INDEX project_structure_parent ON project_structure(site_id, parent_id);
CREATE INDEX project_structure_order ON project_structure(site_id, level, sort_order);
-- Imported rows predate operational provenance. Attach them to the site's
-- explicit source scope so complete-snapshot reconciliation can still see them.
UPDATE project_structure
SET source_scope = (SELECT CAST(c.scope_id AS TEXT) FROM wbs_import_sources c WHERE c.site_id = project_structure.site_id),
    source_run_id = (SELECT CAST(COALESCE(c.promoted_run_id, c.run_id) AS TEXT) FROM wbs_import_sources c WHERE c.site_id = project_structure.site_id)
WHERE source_uuid IS NOT NULL AND source_scope IS NULL
  AND EXISTS (SELECT 1 FROM wbs_import_sources c WHERE c.site_id = project_structure.site_id);
UPDATE project_structure
SET source_scope = 'planning-upload',
    source_run_id = (SELECT CAST(k.last_import_run_id AS TEXT) FROM planning_import_keys k
      WHERE k.site_id = project_structure.site_id AND k.target_id = project_structure.id
        AND k.family = 'time_schedule' LIMIT 1)
WHERE source_uuid IS NOT NULL AND source_scope IS NULL
  AND EXISTS (SELECT 1 FROM planning_import_keys k WHERE k.site_id = project_structure.site_id
    AND k.target_id = project_structure.id AND k.family = 'time_schedule')
  AND NOT EXISTS (SELECT 1 FROM wbs_import_sources c WHERE c.site_id = project_structure.site_id);
CREATE TABLE tasks_with_wbs (
  id TEXT PRIMARY KEY NOT NULL,
  site_id TEXT NOT NULL REFERENCES sites(id),
  title TEXT NOT NULL,
  area TEXT,
  company TEXT,
  executor TEXT NOT NULL,
  verifier TEXT NOT NULL,
  priority TEXT,
  due_date TEXT,
  status TEXT NOT NULL DEFAULT 'todo'
    CHECK (status IN ('todo', 'in_progress', 'to_verify', 'closed', 'blocked')),
  created_at TEXT NOT NULL,
  blocked_from TEXT,
  submitted_by TEXT,
  executor_id TEXT REFERENCES users(id),
  verifier_id TEXT REFERENCES users(id),
  submitted_by_id TEXT REFERENCES users(id),
  kind TEXT,
  wbs_id TEXT,
  FOREIGN KEY (wbs_id, site_id) REFERENCES project_structure(id, site_id)
);
INSERT INTO tasks_with_wbs (id, site_id, title, area, company, executor, verifier, priority, due_date, status, created_at, blocked_from, submitted_by, executor_id, verifier_id, submitted_by_id, kind) SELECT id, site_id, title, area, company, executor, verifier, priority, due_date, status, created_at, blocked_from, submitted_by, executor_id, verifier_id, submitted_by_id, kind FROM tasks;
DROP TABLE tasks;
ALTER TABLE tasks_with_wbs RENAME TO tasks;
CREATE INDEX tasks_site_wbs ON tasks(site_id, wbs_id);
CREATE TABLE site_progress_items_with_wbs (
  id TEXT PRIMARY KEY NOT NULL,
  site_id TEXT NOT NULL REFERENCES sites(id),
  wbs_id TEXT REFERENCES project_structure(id),
  description TEXT,
  plc_area TEXT,
  section TEXT,
  progress_pct NUMERIC,
  planned_progress_pct NUMERIC,
  delta_progress_source NUMERIC,
  assigned_to TEXT,
  planned_start TEXT,
  planned_finish TEXT,
  actual_start TEXT,
  expected_delay TEXT,
  has_files BOOLEAN,
  has_notes BOOLEAN,
  has_deviations BOOLEAN,
  source_row INTEGER NOT NULL,
  source_entity_key_id TEXT,
  created_at TEXT NOT NULL,
  progress_type_id TEXT REFERENCES progress_types(id),
  planned_hours NUMERIC,
  UNIQUE (site_id, source_row),
  UNIQUE (id, site_id),
  FOREIGN KEY (wbs_id, site_id) REFERENCES project_structure(id, site_id)
);
INSERT INTO site_progress_items_with_wbs (id, site_id, wbs_id, description, plc_area, section, progress_pct, planned_progress_pct, delta_progress_source, assigned_to, planned_start, planned_finish, actual_start, expected_delay, has_files, has_notes, has_deviations, source_row, source_entity_key_id, created_at, progress_type_id, planned_hours) SELECT id, site_id, wbs_id, description, plc_area, section, progress_pct, planned_progress_pct, delta_progress_source, assigned_to, planned_start, planned_finish, actual_start, expected_delay, has_files, has_notes, has_deviations, source_row, source_entity_key_id, created_at, progress_type_id, planned_hours FROM site_progress_items;
DROP TABLE site_progress_items;
ALTER TABLE site_progress_items_with_wbs RENAME TO site_progress_items;
CREATE INDEX site_progress_items_site_wbs ON site_progress_items(site_id, wbs_id);
CREATE UNIQUE INDEX work_days_id_site ON work_days(id, site_id);
CREATE TABLE time_bookings_with_wbs (
  id TEXT PRIMARY KEY NOT NULL,
  site_id TEXT NOT NULL REFERENCES sites(id),
  work_day_id TEXT NOT NULL REFERENCES work_days(id),
  site_progress_item_id TEXT NOT NULL REFERENCES site_progress_items(id),
  hours NUMERIC NOT NULL CHECK (hours >= 0),
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  FOREIGN KEY (site_progress_item_id, site_id) REFERENCES site_progress_items(id, site_id),
  UNIQUE (work_day_id, site_progress_item_id),
  FOREIGN KEY (work_day_id, site_id) REFERENCES work_days(id, site_id)
);
INSERT INTO time_bookings_with_wbs (id, site_id, work_day_id, site_progress_item_id, hours, created_by, created_at) SELECT id, site_id, work_day_id, site_progress_item_id, hours, created_by, created_at FROM time_bookings;
DROP TABLE time_bookings;
ALTER TABLE time_bookings_with_wbs RENAME TO time_bookings;
CREATE INDEX time_bookings_item ON time_bookings(site_progress_item_id);
CREATE INDEX time_bookings_site ON time_bookings(site_id);
CREATE TABLE wbs_node_overrides (
  wbs_id TEXT PRIMARY KEY NOT NULL,
  site_id TEXT NOT NULL,
  description TEXT,
  description_set BOOLEAN NOT NULL DEFAULT FALSE,
  parent_id TEXT,
  parent_set BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order INTEGER,
  sort_order_set BOOLEAN NOT NULL DEFAULT FALSE,
  source_values_json TEXT NOT NULL DEFAULT '{}',
  conflicts_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL,
  updated_by TEXT REFERENCES users(id),
  CHECK (parent_id IS NULL OR parent_id <> wbs_id),
  FOREIGN KEY (wbs_id, site_id) REFERENCES project_structure(id, site_id),
  FOREIGN KEY (parent_id, site_id) REFERENCES project_structure(id, site_id)
);
CREATE TEMP TABLE wbs_integrity_guard (valid INTEGER CHECK (valid = 1));
INSERT INTO wbs_integrity_guard SELECT 0 FROM pragma_foreign_key_check LIMIT 1;
DROP TABLE wbs_integrity_guard;
PRAGMA defer_foreign_keys = OFF;
