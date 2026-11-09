DO $$
DECLARE
  foreign_keys jsonb;
  fk jsonb;
  col record;
BEGIN
  -- Preserve names and definitions (including delete/update policies).
  SELECT jsonb_agg(jsonb_build_object(
    'table', conrelid::regclass::text, 'name', conname,
    'definition', pg_get_constraintdef(oid))) INTO foreign_keys
  FROM pg_constraint
  WHERE contype = 'f' AND conrelid IN
    ('tasks'::regclass, 'diary'::regclass, 'task_events'::regclass);

  FOR fk IN SELECT * FROM jsonb_array_elements(foreign_keys) LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', fk->>'table', fk->>'name');
  END LOOP;

  FOR col IN
    SELECT c.table_name, c.column_name
    FROM information_schema.columns c
    WHERE c.table_schema = current_schema() AND c.udt_name <> 'uuid'
      AND (c.table_name, c.column_name) IN
        (('sites', 'id'), ('tasks', 'id'), ('tasks', 'site_id'),
         ('diary', 'id'), ('diary', 'site_id'), ('task_events', 'task_id'))
  LOOP
    EXECUTE format('ALTER TABLE %I ALTER COLUMN %I TYPE uuid USING %I::uuid',
      col.table_name, col.column_name, col.column_name);
  END LOOP;

  FOR fk IN SELECT * FROM jsonb_array_elements(foreign_keys) LOOP
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s',
      fk->>'table', fk->>'name', fk->>'definition');
  END LOOP;

  FOR col IN
    SELECT c.table_name, c.column_name
    FROM information_schema.columns c
    WHERE c.table_schema = current_schema() AND c.udt_name <> 'timestamptz'
      AND c.table_name IN ('sites', 'tasks', 'diary', 'task_events')
      AND (c.column_name IN ('created_at', 'updated_at')
        OR (c.table_name = 'task_events' AND c.column_name = 'at'))
  LOOP
    EXECUTE format('ALTER TABLE %I ALTER COLUMN %I TYPE timestamptz USING %I::timestamptz',
      col.table_name, col.column_name, col.column_name);
  END LOOP;

  ALTER TABLE tasks ADD COLUMN IF NOT EXISTS blocked_from TEXT NULL;
  ALTER TABLE tasks ADD COLUMN IF NOT EXISTS submitted_by TEXT NULL;
  ALTER TABLE task_events ADD COLUMN IF NOT EXISTS action TEXT NULL
    CHECK (action IN ('create', 'start', 'submit', 'verify', 'reject',
      'block', 'resume', 'reopen', 'close'));
END;
$$;
