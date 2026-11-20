-- Databases already at 036 need the same provenance backfill as fresh installs.
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
