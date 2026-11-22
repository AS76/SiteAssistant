ALTER TABLE sites ADD COLUMN time_zone TEXT NOT NULL DEFAULT 'Europe/Rome'
  CHECK (time_zone GLOB '[A-Za-z]*' AND time_zone NOT GLOB '*[^A-Za-z0-9_+/-]*'
    AND time_zone NOT LIKE '%//%' AND time_zone NOT LIKE '%/');
UPDATE sites SET time_zone = CASE jurisdiction WHEN 'UK' THEN 'Europe/London' ELSE 'Europe/Rome' END;
ALTER TABLE sites ADD COLUMN day_cutoff_time TEXT NOT NULL DEFAULT '06:00'
  CHECK (day_cutoff_time GLOB '[0-2][0-9]:[0-5][0-9]' AND day_cutoff_time < '24:00');
