CREATE TABLE assistant_usage (
  id UUID PRIMARY KEY NOT NULL,
  site_id UUID NOT NULL REFERENCES sites(id),
  user_id UUID NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL,
  model TEXT NOT NULL,
  input_tokens BIGINT CHECK (input_tokens >= 0),
  output_tokens BIGINT CHECK (output_tokens >= 0),
  cost_nanousd BIGINT CHECK (cost_nanousd >= 0),
  reason TEXT,
  CHECK ((cost_nanousd IS NULL AND reason IS NOT NULL) OR
    (cost_nanousd IS NOT NULL AND reason IS NULL AND input_tokens IS NOT NULL AND output_tokens IS NOT NULL))
);

CREATE INDEX assistant_usage_at ON assistant_usage(requested_at);
CREATE INDEX assistant_usage_site_at ON assistant_usage(site_id, requested_at);
CREATE UNIQUE INDEX assistant_usage_site_pending ON assistant_usage(site_id)
  WHERE reason = 'provider_pending';
