-- Reusable weighted steps; imported progress remains unchanged.
CREATE TABLE IF NOT EXISTS progress_types (
  id UUID PRIMARY KEY,
  site_id UUID NOT NULL REFERENCES sites(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (site_id, code)
);
CREATE TABLE IF NOT EXISTS progress_type_steps (
  id UUID PRIMARY KEY,
  progress_type_id UUID NOT NULL REFERENCES progress_types(id),
  position INTEGER NOT NULL,
  code TEXT NOT NULL,
  description TEXT,
  weight NUMERIC NOT NULL CHECK (weight > 0),
  UNIQUE (progress_type_id, position),
  UNIQUE (progress_type_id, code)
);
ALTER TABLE site_progress_items ADD COLUMN IF NOT EXISTS progress_type_id UUID REFERENCES progress_types(id);
CREATE INDEX IF NOT EXISTS site_progress_items_type ON site_progress_items(progress_type_id);
CREATE TABLE IF NOT EXISTS site_progress_item_steps (
  id UUID PRIMARY KEY,
  site_progress_item_id UUID NOT NULL REFERENCES site_progress_items(id),
  progress_type_step_id UUID NOT NULL REFERENCES progress_type_steps(id),
  percent NUMERIC NOT NULL CHECK (percent >= 0 AND percent <= 100),
  updated_by UUID REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (site_progress_item_id, progress_type_step_id)
);
CREATE INDEX IF NOT EXISTS site_progress_item_steps_type_step ON site_progress_item_steps(progress_type_step_id);
