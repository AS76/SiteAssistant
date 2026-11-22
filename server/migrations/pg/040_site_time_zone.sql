ALTER TABLE sites ADD COLUMN time_zone TEXT
  CHECK (time_zone ~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+)*$');
UPDATE sites SET time_zone = CASE jurisdiction WHEN 'UK' THEN 'Europe/London' ELSE 'Europe/Rome' END;
ALTER TABLE sites ALTER COLUMN time_zone SET NOT NULL;
ALTER TABLE sites ALTER COLUMN time_zone SET DEFAULT 'Europe/Rome';
ALTER TABLE sites ADD COLUMN IF NOT EXISTS day_cutoff_time TEXT NOT NULL DEFAULT '06:00'
  CHECK (day_cutoff_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');
