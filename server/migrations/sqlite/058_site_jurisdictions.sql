CREATE TABLE jurisdictions (
  code TEXT PRIMARY KEY NOT NULL,
  country_code TEXT NOT NULL,
  territory_code TEXT,
  label_it TEXT NOT NULL,
  label_en TEXT NOT NULL,
  UNIQUE (country_code, territory_code)
);

INSERT INTO jurisdictions (code, country_code, territory_code, label_it, label_en) VALUES
  ('IT', 'IT', NULL, 'Italia', 'Italy'),
  ('UK', 'UK', NULL, 'Regno Unito · territorio da confermare', 'United Kingdom · territory to confirm'),
  ('UK-GB', 'UK', 'GB', 'Gran Bretagna', 'Great Britain'),
  ('UK-NI', 'UK', 'NI', 'Irlanda del Nord', 'Northern Ireland');

-- NULL jurisdiction_code uses the value recorded under migration 028.
ALTER TABLE sites ADD COLUMN jurisdiction_code TEXT REFERENCES jurisdictions(code);
ALTER TABLE sites ADD COLUMN content_language TEXT CHECK (content_language IN ('it', 'en'));
