ALTER TABLE diary ADD COLUMN author_id TEXT REFERENCES users(id);
ALTER TABLE diary ADD COLUMN recording_motivation TEXT;
ALTER TABLE diary ADD COLUMN recorded_late BOOLEAN NOT NULL DEFAULT FALSE CHECK (recorded_late IN (0, 1));
ALTER TABLE diary ADD COLUMN updated_at TEXT;
ALTER TABLE diary ADD COLUMN updated_by TEXT REFERENCES users(id);

CREATE TABLE diary_entry_versions (
  id TEXT PRIMARY KEY NOT NULL,
  diary_id TEXT NOT NULL REFERENCES diary(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL,
  snapshot TEXT NOT NULL CHECK (json_valid(snapshot)),
  author_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  motivation TEXT,
  UNIQUE (diary_id, version)
);
