-- Operational identity stays in project_structure. Imported columns retain source values.
ALTER TABLE tasks ADD COLUMN wbs_id UUID REFERENCES project_structure(id);
CREATE INDEX tasks_site_wbs ON tasks(site_id, wbs_id);
CREATE UNIQUE INDEX project_structure_id_site ON project_structure(id, site_id);
CREATE UNIQUE INDEX progress_id_site ON site_progress_items(id, site_id);
CREATE UNIQUE INDEX work_days_id_site ON work_days(id, site_id);
ALTER TABLE project_structure ADD COLUMN archived_at TIMESTAMPTZ;
ALTER TABLE project_structure ADD COLUMN updated_at TIMESTAMPTZ;
ALTER TABLE project_structure ADD COLUMN updated_by UUID REFERENCES users(id);
ALTER TABLE project_structure ADD COLUMN source_scope TEXT;
ALTER TABLE project_structure ADD COLUMN source_run_id TEXT;
ALTER TABLE project_structure ADD COLUMN missing_from_source BOOLEAN NOT NULL DEFAULT FALSE;
-- Imported rows predate operational provenance. Attach them to the site's
-- explicit source scope so complete-snapshot reconciliation can still see them.
UPDATE project_structure p
SET source_scope = c.scope_id::text,
    source_run_id = COALESCE(c.promoted_run_id, c.run_id)::text
FROM wbs_import_sources c
WHERE p.site_id = c.site_id AND p.source_uuid IS NOT NULL AND p.source_scope IS NULL;
UPDATE project_structure p
SET source_scope = 'planning-upload',
    source_run_id = k.last_import_run_id::text
FROM planning_import_keys k
WHERE k.site_id = p.site_id AND k.target_id = p.id AND k.family = 'time_schedule'
  AND p.source_uuid IS NOT NULL AND p.source_scope IS NULL
  AND NOT EXISTS (SELECT 1 FROM wbs_import_sources c WHERE c.site_id = p.site_id);
CREATE TABLE wbs_node_overrides (
  wbs_id UUID PRIMARY KEY NOT NULL,
  site_id UUID NOT NULL,
  description TEXT,
  description_set BOOLEAN NOT NULL DEFAULT FALSE,
  parent_id UUID,
  parent_set BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order INTEGER,
  sort_order_set BOOLEAN NOT NULL DEFAULT FALSE,
  source_values_json TEXT NOT NULL DEFAULT '{}',
  conflicts_json TEXT NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL,
  updated_by UUID REFERENCES users(id),
  CHECK (parent_id IS NULL OR parent_id <> wbs_id),
  FOREIGN KEY (wbs_id, site_id) REFERENCES project_structure(id, site_id),
  FOREIGN KEY (parent_id, site_id) REFERENCES project_structure(id, site_id)
);
ALTER TABLE project_structure ADD CONSTRAINT project_structure_parent_id_site_fk FOREIGN KEY (parent_id, site_id) REFERENCES project_structure(id, site_id);
ALTER TABLE tasks ADD CONSTRAINT tasks_wbs_id_site_fk FOREIGN KEY (wbs_id, site_id) REFERENCES project_structure(id, site_id);
ALTER TABLE site_progress_items ADD CONSTRAINT site_progress_items_wbs_id_site_fk FOREIGN KEY (wbs_id, site_id) REFERENCES project_structure(id, site_id);
ALTER TABLE time_bookings ADD CONSTRAINT time_bookings_site_progress_item_id_site_fk FOREIGN KEY (site_progress_item_id, site_id) REFERENCES site_progress_items(id, site_id);
ALTER TABLE time_bookings ADD CONSTRAINT time_bookings_work_day_id_site_fk FOREIGN KEY (work_day_id, site_id) REFERENCES work_days(id, site_id);
