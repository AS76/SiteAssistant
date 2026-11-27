CREATE TABLE place_aliases (
  id UUID PRIMARY KEY NOT NULL,
  site_id UUID NOT NULL,
  place_id UUID NOT NULL,
  namespace TEXT COLLATE "C" NOT NULL CHECK (length(trim(namespace)) > 0),
  canonical_code TEXT COLLATE "C" NOT NULL CHECK (length(trim(canonical_code)) > 0),
  original_code TEXT NOT NULL CHECK (length(trim(original_code)) > 0),
  source TEXT NOT NULL CHECK (length(trim(source)) > 0),
  created_at TIMESTAMPTZ NOT NULL,
  valid_to TIMESTAMPTZ CHECK (valid_to >= created_at),
  UNIQUE (site_id, namespace, canonical_code),
  FOREIGN KEY (site_id, place_id) REFERENCES places(site_id, id)
);
CREATE INDEX place_aliases_site_place ON place_aliases(site_id, place_id);
