CREATE TABLE assistant_usage (
  id TEXT PRIMARY KEY NOT NULL,
  site_id TEXT NOT NULL REFERENCES sites(id),
  user_id TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER CHECK (input_tokens >= 0),
  output_tokens INTEGER CHECK (output_tokens >= 0),
  cost_nanousd INTEGER CHECK (cost_nanousd >= 0),
  reason TEXT,
  CHECK ((cost_nanousd IS NULL AND reason IS NOT NULL) OR
    (cost_nanousd IS NOT NULL AND reason IS NULL AND input_tokens IS NOT NULL AND output_tokens IS NOT NULL))
);

CREATE INDEX assistant_usage_at ON assistant_usage(requested_at);
CREATE INDEX assistant_usage_site_at ON assistant_usage(site_id, requested_at);
CREATE UNIQUE INDEX assistant_usage_site_pending ON assistant_usage(site_id)
  WHERE reason = 'provider_pending';
