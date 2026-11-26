ALTER TABLE hse_inspections ADD COLUMN computed_outcome TEXT;
ALTER TABLE hse_inspections ADD COLUMN declared_outcome TEXT;
ALTER TABLE hse_inspections ADD COLUMN outcome_source TEXT;
ALTER TABLE hse_inspections ADD COLUMN template_status TEXT;

UPDATE hse_inspections SET computed_outcome = outcome, outcome_source = 'backfilled';
