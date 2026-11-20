CREATE TABLE IF NOT EXISTS sites (
  id TEXT PRIMARY KEY NOT NULL,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  location TEXT,
  start_date TEXT,
  end_date TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY NOT NULL,
  site_id TEXT NOT NULL REFERENCES sites(id),
  title TEXT NOT NULL,
  area TEXT,
  company TEXT,
  executor TEXT NOT NULL,
  verifier TEXT NOT NULL,
  priority TEXT,
  due_date TEXT,
  status TEXT NOT NULL DEFAULT 'todo'
    CHECK (status IN ('todo', 'in_progress', 'to_verify', 'closed', 'blocked')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_events (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  note TEXT,
  reason TEXT
);

CREATE TABLE IF NOT EXISTS diary (
  id TEXT PRIMARY KEY NOT NULL,
  site_id TEXT NOT NULL REFERENCES sites(id),
  operational_date TEXT NOT NULL,
  shift TEXT NOT NULL CHECK (shift IN ('day', 'night')),
  plan TEXT,
  actual TEXT,
  impediments TEXT,
  next_step TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (site_id, operational_date, shift)
);
