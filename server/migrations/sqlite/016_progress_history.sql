-- Subtasks are WBS nodes when the Time Schedule covers them; the link stays optional.
ALTER TABLE site_progress_item_steps ADD COLUMN wbs_id UUID REFERENCES project_structure(id);

-- Append-only history of recorded percentages: the curves come from here, never from imports.
CREATE TABLE IF NOT EXISTS progress_entries (
  id UUID PRIMARY KEY NOT NULL,
  site_id UUID NOT NULL REFERENCES sites(id),
  site_progress_item_id UUID NOT NULL REFERENCES site_progress_items(id),
  progress_type_step_id UUID NOT NULL REFERENCES progress_type_steps(id),
  percent NUMERIC NOT NULL CHECK (percent >= 0 AND percent <= 100),
  recorded_at TIMESTAMPTZ NOT NULL,
  recorded_by UUID REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS progress_entries_item ON progress_entries(site_progress_item_id, recorded_at);
CREATE INDEX IF NOT EXISTS progress_entries_site ON progress_entries(site_id, recorded_at);
