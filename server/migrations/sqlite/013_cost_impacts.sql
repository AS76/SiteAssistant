-- Internally authored claims, independent of imported deviation status.
CREATE TABLE IF NOT EXISTS cost_impacts (
  id TEXT PRIMARY KEY NOT NULL,
  site_id TEXT NOT NULL REFERENCES sites(id),
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'notification_sent', 'submitted', 'closed')),
  claim_amount NUMERIC,
  settlement_amount NUMERIC,
  result TEXT CHECK (result IN ('settled', 'dropped', 'rejected')),
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  closed_at TEXT,
  CHECK (status <> 'closed' OR result IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS cost_impacts_site_status ON cost_impacts(site_id, status);

CREATE TABLE IF NOT EXISTS cost_impact_deviations (
  cost_impact_id TEXT NOT NULL REFERENCES cost_impacts(id),
  deviation_id TEXT NOT NULL REFERENCES deviations(id),
  PRIMARY KEY (cost_impact_id, deviation_id)
);
