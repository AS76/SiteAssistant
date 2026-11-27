CREATE TABLE place_aliases (
  id TEXT PRIMARY KEY NOT NULL,
  site_id TEXT NOT NULL,
  place_id TEXT NOT NULL,
  namespace TEXT COLLATE BINARY NOT NULL CHECK (length(trim(namespace)) > 0),
  canonical_code TEXT COLLATE BINARY NOT NULL CHECK (length(trim(canonical_code)) > 0),
  original_code TEXT NOT NULL CHECK (length(trim(original_code)) > 0),
  source TEXT NOT NULL CHECK (length(trim(source)) > 0),
  created_at TEXT NOT NULL,
  valid_to TEXT CHECK (valid_to >= created_at),
  UNIQUE (site_id, namespace, canonical_code),
  FOREIGN KEY (site_id, place_id) REFERENCES places(site_id, id)
);
CREATE INDEX place_aliases_site_place ON place_aliases(site_id, place_id);
