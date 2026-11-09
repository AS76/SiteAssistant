ALTER TABLE tasks ADD COLUMN blocked_from TEXT NULL;
ALTER TABLE tasks ADD COLUMN submitted_by TEXT NULL;
ALTER TABLE task_events ADD COLUMN action TEXT NULL
  CHECK (action IN ('create', 'start', 'submit', 'verify', 'reject',
    'block', 'resume', 'reopen', 'close'));
