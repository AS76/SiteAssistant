CREATE TABLE IF NOT EXISTS demo_seed_records (
  table_name TEXT NOT NULL,
  record_id TEXT NOT NULL,
  PRIMARY KEY (table_name, record_id)
);

DO $$
DECLARE
  target oid;
BEGIN
  SELECT c.oid INTO target
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = current_schema() AND c.relname = 'demo_seed_records' AND c.relkind = 'r';

  IF target IS NULL OR
    (SELECT count(*) FROM pg_catalog.pg_attribute
      WHERE attrelid = target AND attnum > 0 AND NOT attisdropped) <> 2 OR
    (SELECT count(*) FROM pg_catalog.pg_attribute
      WHERE attrelid = target AND NOT attisdropped AND attnotnull
        AND atttypid = 'pg_catalog.text'::regtype AND attgenerated = ''
        AND ((attnum = 1 AND attname = 'table_name') OR (attnum = 2 AND attname = 'record_id'))) <> 2 OR
    NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
      WHERE conrelid = target AND contype = 'p' AND conkey = ARRAY[1, 2]::smallint[])
  THEN
    RAISE EXCEPTION 'Migration 054: incompatible demo_seed_records schema; expected two NOT NULL TEXT columns and PRIMARY KEY (table_name, record_id)';
  END IF;
END
$$;
