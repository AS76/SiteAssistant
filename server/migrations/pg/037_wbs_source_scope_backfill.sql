-- Databases already at 036 need the same provenance backfill as fresh installs.
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
