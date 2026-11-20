ALTER TABLE sites ADD COLUMN jurisdiction TEXT NOT NULL DEFAULT 'IT' CHECK (jurisdiction IN ('IT', 'UK'));

ALTER TABLE audit_events DROP CONSTRAINT audit_events_entity_type_check;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_entity_type_check
  CHECK (entity_type IN ('hse_event', 'certification', 'tool', 'site'));
