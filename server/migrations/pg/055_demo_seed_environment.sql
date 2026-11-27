CREATE TABLE demo_seed_environment (
  singleton INTEGER NOT NULL PRIMARY KEY CHECK (singleton = 1),
  marker TEXT NOT NULL
);
