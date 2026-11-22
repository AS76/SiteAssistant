ALTER TABLE diary ADD COLUMN author_id UUID REFERENCES users(id);
ALTER TABLE diary ADD COLUMN recording_motivation TEXT;
ALTER TABLE diary ADD COLUMN recorded_late BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE diary ADD COLUMN updated_at TIMESTAMPTZ;
ALTER TABLE diary ADD COLUMN updated_by UUID REFERENCES users(id);

CREATE TABLE diary_entry_versions (
  id UUID PRIMARY KEY NOT NULL,
  diary_id UUID NOT NULL REFERENCES diary(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL,
  snapshot JSONB NOT NULL,
  author_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL,
  motivation TEXT,
  UNIQUE (diary_id, version)
);
