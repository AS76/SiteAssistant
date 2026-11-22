ALTER TABLE sites ADD COLUMN assistant_enabled BOOLEAN NOT NULL DEFAULT FALSE
  CHECK (assistant_enabled IN (FALSE, TRUE));
ALTER TABLE sites ADD COLUMN assistant_timeout_ms INTEGER NOT NULL DEFAULT 20000
  CHECK (typeof(assistant_timeout_ms) = 'integer' AND assistant_timeout_ms BETWEEN 5000 AND 60000);
