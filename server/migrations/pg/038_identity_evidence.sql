ALTER TABLE deviations DROP CONSTRAINT deviations_site_id_deviation_no_key;
ALTER TABLE deviations ADD COLUMN source_system TEXT CHECK (source_system IN ('internal', 'other'));
ALTER TABLE deviations ADD COLUMN source_id TEXT CHECK (source_id IS NULL OR (source_system IS NOT NULL AND length(trim(source_id)) > 0));
ALTER TABLE deviations ADD COLUMN source_status TEXT;
ALTER TABLE deviations ADD COLUMN source_export_date TEXT;
ALTER TABLE deviations ADD COLUMN last_seen_in_export_date TEXT;
ALTER TABLE deviations ADD COLUMN provenance TEXT NOT NULL DEFAULT 'original' CHECK (provenance IN ('original', 'derived', 'reported'));
ALTER TABLE deviations ADD COLUMN causing_company TEXT;
ALTER TABLE deviations ADD COLUMN resolving_company TEXT;
ALTER TABLE deviations ADD COLUMN attribution_state TEXT NOT NULL DEFAULT 'not_determined' CHECK (attribution_state IN ('not_determined', 'agreed', 'disputed'));
ALTER TABLE deviations ADD COLUMN internal_owner_id UUID REFERENCES users(id);
ALTER TABLE deviations ADD COLUMN internal_owner_since TIMESTAMPTZ;

ALTER TABLE attachments DROP CONSTRAINT attachments_entity_type_check;
ALTER TABLE attachments ADD CONSTRAINT attachments_entity_type_check CHECK (entity_type IN ('task', 'diary', 'site', 'hse_event', 'hse_inspection', 'deviation'));

ALTER TABLE audit_events DROP CONSTRAINT audit_events_entity_type_check;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_entity_type_check CHECK (entity_type IN ('hse_event', 'certification', 'tool', 'site', 'hse_asset', 'hse_inspection', 'purchase_order', 'purchase_order_item', 'package', 'package_item', 'shipment', 'shipment_receipt', 'deviation', 'task'));

CREATE UNIQUE INDEX deviations_legacy_number ON deviations(site_id, deviation_no) WHERE source_system IS NULL;
CREATE UNIQUE INDEX deviations_external_identity ON deviations(site_id, source_system, source_id) WHERE source_id IS NOT NULL;
CREATE FUNCTION protect_deviation_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.source_id IS NOT NULL AND
    (NEW.source_id IS DISTINCT FROM OLD.source_id OR NEW.source_system IS DISTINCT FROM OLD.source_system
      OR NEW.site_id IS DISTINCT FROM OLD.site_id) THEN
    RAISE EXCEPTION 'Deviation source identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER deviations_source_identity BEFORE UPDATE OF source_id, source_system, site_id ON deviations
  FOR EACH ROW EXECUTE FUNCTION protect_deviation_identity();
CREATE INDEX deviations_site_last_seen ON deviations(site_id, last_seen_in_export_date);
CREATE INDEX deviations_site_internal_owner ON deviations(site_id, internal_owner_id);

CREATE TABLE deviation_exports (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  site_id UUID NOT NULL REFERENCES sites(id),
  source_system TEXT NOT NULL CHECK (source_system IN ('internal', 'other')),
  export_date TEXT NOT NULL,
  file_sha256 TEXT NOT NULL,
  complete BOOLEAN NOT NULL,
  scope TEXT NOT NULL,
  UNIQUE (site_id, source_system, export_date, file_sha256, complete, scope)
);
CREATE INDEX deviation_exports_site_system_date ON deviation_exports(site_id, source_system, export_date DESC, id DESC);
CREATE TABLE deviation_export_rows (
  export_id BIGINT NOT NULL REFERENCES deviation_exports(id) ON DELETE CASCADE,
  deviation_id UUID NOT NULL REFERENCES deviations(id),
  PRIMARY KEY (export_id, deviation_id)
);

CREATE TABLE deviation_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  deviation_id UUID NOT NULL REFERENCES deviations(id),
  at TIMESTAMPTZ NOT NULL,
  actor TEXT NOT NULL,
  actor_id UUID REFERENCES users(id),
  source TEXT NOT NULL CHECK (source IN ('import', 'internal')),
  from_status TEXT,
  to_status TEXT NOT NULL,
  action TEXT,
  note TEXT,
  CHECK ((source = 'import' AND actor = 'import' AND actor_id IS NULL)
      OR (source = 'internal' AND actor_id IS NOT NULL))
);
CREATE INDEX deviation_events_timeline ON deviation_events(deviation_id, at, id);
CREATE FUNCTION reject_deviation_event_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Deviation events are append-only';
END;
$$;
CREATE TRIGGER deviation_events_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON deviation_events
  FOR EACH STATEMENT EXECUTE FUNCTION reject_deviation_event_mutation();

ALTER TABLE tasks ADD COLUMN declared_at TIMESTAMPTZ;
ALTER TABLE tasks ADD COLUMN verified_at TIMESTAMPTZ;
ALTER TABLE tasks ADD COLUMN acceptance_document_id UUID REFERENCES attachments(id);
ALTER TABLE tasks ADD COLUMN acceptance_date TEXT;
ALTER TABLE tasks ADD COLUMN acceptance_state TEXT NOT NULL DEFAULT 'none'
  CHECK (acceptance_state IN ('none', 'declared', 'accepted')
    AND (acceptance_state <> 'accepted' OR (acceptance_document_id IS NOT NULL AND acceptance_date IS NOT NULL)));
ALTER TABLE task_events ADD COLUMN waiver BOOLEAN NOT NULL DEFAULT FALSE
  CHECK (NOT waiver OR (action IS NOT NULL AND action = 'close' AND reason IS NOT NULL AND length(trim(reason)) >= 15));
ALTER TABLE task_events ADD COLUMN evidence_attachment_id UUID REFERENCES attachments(id);
CREATE INDEX task_events_evidence_attachment ON task_events(evidence_attachment_id);
CREATE INDEX task_events_current_closure ON task_events(task_id, to_status, from_status, id);
