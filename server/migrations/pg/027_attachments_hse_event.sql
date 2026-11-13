ALTER TABLE attachments DROP CONSTRAINT attachments_entity_type_check;
ALTER TABLE attachments ADD CONSTRAINT attachments_entity_type_check
  CHECK (entity_type IN ('task', 'diary', 'site', 'hse_event'));
