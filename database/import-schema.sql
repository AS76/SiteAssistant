-- Proposed generic import subsystem. Provider-specific mappings are private runtime configuration.
-- No source data is embedded in this file. Execute only after review in a test database.
-- This is not an application/authentication deployment or a migration already applied.
BEGIN;
CREATE SCHEMA ingest;
CREATE SCHEMA source_snapshot;
CREATE SCHEMA internal_work;
CREATE SCHEMA reporting;

CREATE TABLE ingest.scopes (
    id UUID PRIMARY KEY,
    organization_id UUID NOT NULL,
    source_system_key TEXT NOT NULL,
    project_reference TEXT NOT NULL,
    source_timezone TEXT,
    currency_code TEXT,
    UNIQUE (organization_id, source_system_key, project_reference)
);

CREATE TABLE ingest.import_runs (
    id UUID PRIMARY KEY,
    scope_id UUID NOT NULL REFERENCES ingest.scopes(id),
    declared_export_date DATE,
    source_timezone TEXT,
    loaded_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    status TEXT NOT NULL CHECK (status IN ('loading','ready','failed')),
    completeness_verified BOOLEAN NOT NULL DEFAULT FALSE,
    UNIQUE (id, scope_id),
    CHECK (status <> 'ready' OR completeness_verified)
);

CREATE TABLE ingest.import_batches (
    id UUID PRIMARY KEY,
    scope_id UUID NOT NULL REFERENCES ingest.scopes(id),
    family TEXT NOT NULL CHECK (family IN ('employees','time_schedule','site_progress_items','daily_logs','work_days','deviations')),
    profile_version TEXT NOT NULL,
    source_file_name TEXT NOT NULL,
    original_object_locator TEXT,
    original_object_version TEXT,
    content_sha256 TEXT NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
    file_size_bytes BIGINT NOT NULL CHECK (file_size_bytes >= 0),
    source_sheet TEXT NOT NULL,
    source_headers JSONB NOT NULL CHECK (jsonb_typeof(source_headers) = 'array'),
    expected_rows BIGINT NOT NULL CHECK (expected_rows >= 0),
    source_profile JSONB NOT NULL DEFAULT '{}'::jsonb,
    imported_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    status TEXT NOT NULL CHECK (status IN ('staging','typed','rejected')),
    UNIQUE (scope_id,family,content_sha256,profile_version),
    UNIQUE (id,scope_id),
    UNIQUE (id,scope_id,family)
);

CREATE TABLE ingest.run_batches (
    run_id UUID NOT NULL,
    batch_id UUID NOT NULL,
    scope_id UUID NOT NULL,
    family TEXT NOT NULL,
    PRIMARY KEY (run_id,family),
    FOREIGN KEY (run_id,scope_id) REFERENCES ingest.import_runs(id,scope_id),
    FOREIGN KEY (batch_id,scope_id,family) REFERENCES ingest.import_batches(id,scope_id,family)
);

CREATE TABLE ingest.raw_rows (
    batch_id UUID NOT NULL,
    scope_id UUID NOT NULL,
    source_row BIGINT NOT NULL CHECK (source_row >= 2),
    payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
    cell_types JSONB NOT NULL DEFAULT '{}'::jsonb,
    row_fingerprint TEXT NOT NULL,
    PRIMARY KEY (batch_id,source_row),
    UNIQUE (batch_id,source_row,scope_id),
    FOREIGN KEY (batch_id,scope_id) REFERENCES ingest.import_batches(id,scope_id)
);
CREATE INDEX raw_rows_fingerprint_idx ON ingest.raw_rows(batch_id,row_fingerprint);

CREATE TABLE ingest.entity_keys (
    id UUID PRIMARY KEY,
    scope_id UUID NOT NULL REFERENCES ingest.scopes(id),
    family TEXT NOT NULL,
    external_key TEXT NOT NULL,
    identity_state TEXT NOT NULL CHECK (identity_state IN ('observed','unresolved','manual')),
    UNIQUE (scope_id,family,external_key),
    UNIQUE (scope_id,id)
);

CREATE TABLE ingest.quality_issues (
    id UUID PRIMARY KEY,
    scope_id UUID NOT NULL,
    batch_id UUID NOT NULL,
    source_row BIGINT,
    rule_code TEXT NOT NULL,
    severity TEXT NOT NULL CHECK (severity IN ('error','warning','info')),
    details JSONB NOT NULL,
    resolved_at TIMESTAMPTZ,
    FOREIGN KEY (batch_id,scope_id) REFERENCES ingest.import_batches(id,scope_id),
    FOREIGN KEY (batch_id,source_row,scope_id) REFERENCES ingest.raw_rows(batch_id,source_row,scope_id)
);

CREATE TABLE source_snapshot.time_schedule (
    _batch_id UUID NOT NULL,
    _source_row BIGINT NOT NULL,
    _scope_id UUID NOT NULL,
    _family TEXT GENERATED ALWAYS AS ('time_schedule'::text) STORED,
    _identity_key TEXT NOT NULL,
    has_referenced_items BOOLEAN,
    project_plan TEXT,
    source_status TEXT,
    wbs_code TEXT,
    description TEXT,
    progress_pct NUMERIC,
    planned_start TIMESTAMP WITHOUT TIME ZONE,
    planned_finish TIMESTAMP WITHOUT TIME ZONE,
    referenced_type TEXT,
    sort_order INTEGER,
    date_info_column TEXT,
    actual_finish TIMESTAMP WITHOUT TIME ZONE,
    actual_start TIMESTAMP WITHOUT TIME ZONE,
    baseline_planned_finish TIMESTAMP WITHOUT TIME ZONE,
    baseline_planned_start TIMESTAMP WITHOUT TIME ZONE,
    created_by TEXT,
    creation_date TIMESTAMP WITHOUT TIME ZONE,
    discrepancy_finish_date NUMERIC,
    discrepancy_start_date NUMERIC,
    has_notes BOOLEAN,
    has_subtasks BOOLEAN,
    source_uuid UUID NOT NULL,
    info_1 TEXT,
    last_change_on_referenced_item_s TIMESTAMP WITHOUT TIME ZONE,
    last_modified TIMESTAMP WITHOUT TIME ZONE,
    last_modified_by TEXT,
    level INTEGER,
    notes TEXT,
    planned_hours NUMERIC,
    plc_area TEXT,
    progress_points NUMERIC,
    section TEXT,
    summary_task BOOLEAN,
    referenced_external_no TEXT,
    assigned_to TEXT,
    PRIMARY KEY (_batch_id,_source_row),
    UNIQUE (_batch_id,_source_row,_scope_id),
    FOREIGN KEY (_batch_id,_source_row,_scope_id) REFERENCES ingest.raw_rows(batch_id,source_row,scope_id),
    FOREIGN KEY (_batch_id,_scope_id,_family) REFERENCES ingest.import_batches(id,scope_id,family),
    FOREIGN KEY (_scope_id,_family,_identity_key) REFERENCES ingest.entity_keys(scope_id,family,external_key),
    UNIQUE (_batch_id,source_uuid),
    CHECK (_identity_key = source_uuid::text),
    CHECK (progress_pct BETWEEN 0 AND 100)
);

CREATE INDEX time_schedule_scope_batch_idx ON source_snapshot.time_schedule(_scope_id,_batch_id);

CREATE INDEX schedule_wbs_idx ON source_snapshot.time_schedule(_scope_id,_batch_id,project_plan,wbs_code);

CREATE TABLE source_snapshot.site_progress_items (
    _batch_id UUID NOT NULL,
    _source_row BIGINT NOT NULL,
    _scope_id UUID NOT NULL,
    _family TEXT GENERATED ALWAYS AS ('site_progress_items'::text) STORED,
    _identity_key TEXT,
    has_files BOOLEAN,
    has_notes BOOLEAN,
    delta_progress_source NUMERIC,
    has_deviations BOOLEAN,
    plc_area TEXT,
    section TEXT,
    description TEXT,
    progress_pct NUMERIC,
    planned_progress_pct NUMERIC,
    assigned_to TEXT,
    planned_start TIMESTAMP WITHOUT TIME ZONE,
    planned_finish TIMESTAMP WITHOUT TIME ZONE,
    actual_start TIMESTAMP WITHOUT TIME ZONE,
    expected_delay_raw TEXT,
    PRIMARY KEY (_batch_id,_source_row),
    UNIQUE (_batch_id,_source_row,_scope_id),
    FOREIGN KEY (_batch_id,_source_row,_scope_id) REFERENCES ingest.raw_rows(batch_id,source_row,scope_id),
    FOREIGN KEY (_batch_id,_scope_id,_family) REFERENCES ingest.import_batches(id,scope_id,family),
    FOREIGN KEY (_scope_id,_family,_identity_key) REFERENCES ingest.entity_keys(scope_id,family,external_key),
    CHECK (progress_pct BETWEEN 0 AND 100),
    CHECK (planned_progress_pct BETWEEN 0 AND 100)
);

CREATE INDEX site_progress_items_scope_batch_idx ON source_snapshot.site_progress_items(_scope_id,_batch_id);

CREATE TABLE source_snapshot.employees (
    _batch_id UUID NOT NULL,
    _source_row BIGINT NOT NULL,
    _scope_id UUID NOT NULL,
    _family TEXT GENERATED ALWAYS AS ('employees'::text) STORED,
    _identity_key TEXT NOT NULL,
    has_files BOOLEAN,
    first_name TEXT,
    last_name TEXT,
    employee_no TEXT NOT NULL,
    hire_date DATE,
    expire_date DATE,
    company TEXT,
    qualification TEXT,
    supervisor TEXT,
    team TEXT,
    card_no TEXT,
    date_info_column TEXT,
    PRIMARY KEY (_batch_id,_source_row),
    UNIQUE (_batch_id,_source_row,_scope_id),
    FOREIGN KEY (_batch_id,_source_row,_scope_id) REFERENCES ingest.raw_rows(batch_id,source_row,scope_id),
    FOREIGN KEY (_batch_id,_scope_id,_family) REFERENCES ingest.import_batches(id,scope_id,family),
    FOREIGN KEY (_scope_id,_family,_identity_key) REFERENCES ingest.entity_keys(scope_id,family,external_key),
    UNIQUE (_batch_id,employee_no),
    CHECK (_identity_key = employee_no)
);

CREATE INDEX employees_scope_batch_idx ON source_snapshot.employees(_scope_id,_batch_id);

CREATE TABLE source_snapshot.deviations (
    _batch_id UUID NOT NULL,
    _source_row BIGINT NOT NULL,
    _scope_id UUID NOT NULL,
    _family TEXT GENERATED ALWAYS AS ('deviations'::text) STORED,
    _identity_key TEXT NOT NULL,
    has_files BOOLEAN,
    has_notes BOOLEAN,
    transfer_status TEXT,
    deviation_no TEXT,
    creation_date TIMESTAMP WITHOUT TIME ZONE,
    due_date TIMESTAMP WITHOUT TIME ZONE,
    plc_area TEXT,
    author TEXT,
    assigned_to TEXT,
    title TEXT,
    problem_description TEXT,
    source_status TEXT,
    priority TEXT,
    network_plan_reference TEXT,
    label_photo_flag BOOLEAN,
    actual_cost NUMERIC,
    actual_cost_in_project_currency NUMERIC,
    approved_date TIMESTAMP WITHOUT TIME ZONE,
    claim_quantity NUMERIC,
    closed_date TIMESTAMP WITHOUT TIME ZONE,
    completed_tasks_pct NUMERIC,
    date_info_column TEXT,
    event_date TIMESTAMP WITHOUT TIME ZONE,
    file_references_raw TEXT,
    has_tasks BOOLEAN,
    source_uuid UUID NOT NULL,
    external_issue_assignee TEXT,
    external_issue_author TEXT,
    external_issue_comment TEXT,
    external_issue_key TEXT,
    external_issue_origin TEXT,
    external_issue_status TEXT,
    labor_hours NUMERIC,
    last_modified TIMESTAMP WITHOUT TIME ZONE,
    last_modified_by TEXT,
    latest_picture_reference_raw TEXT,
    missing_part_colli_no TEXT,
    missing_part_delivery_no TEXT,
    custom_date_reference TIMESTAMP WITHOUT TIME ZONE,
    notes TEXT,
    notifications TEXT,
    q_message_1_code_group TEXT,
    q_message_2_product_list TEXT,
    q_message_3_layout_pos TEXT,
    q_taskprocess TEXT,
    reason_for_missing_parts TEXT,
    referenced_descriptions TEXT,
    referenced_nos TEXT,
    rejected_date TIMESTAMP WITHOUT TIME ZONE,
    external_interface_reference TEXT,
    solution_description TEXT,
    external_issue_sync_flag BOOLEAN,
    material_reference TEXT,
    external_spare_part_status TEXT,
    unique_deviation_id TEXT,
    work_completed_date TIMESTAMP WITHOUT TIME ZONE,
    work_started_date TIMESTAMP WITHOUT TIME ZONE,
    assigned_to_company TEXT,
    author_company TEXT,
    causing_company TEXT,
    resolving_company TEXT,
    project_phase TEXT,
    deviation_board TEXT,
    plan TEXT,
    project_description TEXT,
    project_no TEXT,
    external_issue_project_reference TEXT,
    PRIMARY KEY (_batch_id,_source_row),
    UNIQUE (_batch_id,_source_row,_scope_id),
    FOREIGN KEY (_batch_id,_source_row,_scope_id) REFERENCES ingest.raw_rows(batch_id,source_row,scope_id),
    FOREIGN KEY (_batch_id,_scope_id,_family) REFERENCES ingest.import_batches(id,scope_id,family),
    FOREIGN KEY (_scope_id,_family,_identity_key) REFERENCES ingest.entity_keys(scope_id,family,external_key),
    UNIQUE (_batch_id,source_uuid),
    CHECK (_identity_key = source_uuid::text),
    CHECK (completed_tasks_pct BETWEEN 0 AND 100)
);

CREATE INDEX deviations_scope_batch_idx ON source_snapshot.deviations(_scope_id,_batch_id);

CREATE INDEX deviations_status_idx ON source_snapshot.deviations(_scope_id,_batch_id,source_status,due_date);

CREATE TABLE source_snapshot.daily_logs (
    _batch_id UUID NOT NULL,
    _source_row BIGINT NOT NULL,
    _scope_id UUID NOT NULL,
    _family TEXT GENERATED ALWAYS AS ('daily_logs'::text) STORED,
    _identity_key TEXT NOT NULL,
    has_files BOOLEAN,
    section_system TEXT,
    has_deviations BOOLEAN,
    operational_date DATE,
    editor TEXT,
    weather_condition TEXT,
    activities TEXT,
    visitors_on_site TEXT,
    security_concerns TEXT,
    delays TEXT,
    date_info_column TEXT,
    completed_tasks_pct NUMERIC,
    creation_date TIMESTAMP WITHOUT TIME ZONE,
    deviation_comments TEXT,
    file_references_raw TEXT,
    has_notes BOOLEAN,
    has_site_progress_items BOOLEAN,
    has_tasks BOOLEAN,
    hse_activities TEXT,
    source_uuid UUID NOT NULL,
    inspections_and_handovers TEXT,
    internal_comments TEXT,
    last_modified TIMESTAMP WITHOUT TIME ZONE,
    last_modified_by TEXT,
    latest_picture_reference_raw TEXT,
    major_tool_or_equipment_usage TEXT,
    notes TEXT,
    others_suggestions_for_improvement TEXT,
    temperature_c NUMERIC,
    company TEXT,
    project_description TEXT,
    project_no TEXT,
    PRIMARY KEY (_batch_id,_source_row),
    UNIQUE (_batch_id,_source_row,_scope_id),
    FOREIGN KEY (_batch_id,_source_row,_scope_id) REFERENCES ingest.raw_rows(batch_id,source_row,scope_id),
    FOREIGN KEY (_batch_id,_scope_id,_family) REFERENCES ingest.import_batches(id,scope_id,family),
    FOREIGN KEY (_scope_id,_family,_identity_key) REFERENCES ingest.entity_keys(scope_id,family,external_key),
    UNIQUE (_batch_id,source_uuid),
    CHECK (_identity_key = source_uuid::text),
    CHECK (completed_tasks_pct BETWEEN 0 AND 100)
);

CREATE INDEX daily_logs_scope_batch_idx ON source_snapshot.daily_logs(_scope_id,_batch_id);

CREATE INDEX daily_logs_date_idx ON source_snapshot.daily_logs(_scope_id,operational_date);

CREATE TABLE source_snapshot.work_days (
    _batch_id UUID NOT NULL,
    _source_row BIGINT NOT NULL,
    _scope_id UUID NOT NULL,
    _family TEXT GENERATED ALWAYS AS ('work_days'::text) STORED,
    _identity_key TEXT NOT NULL,
    operational_date DATE,
    first_name TEXT,
    last_name TEXT,
    employee_no TEXT,
    source_status TEXT,
    company TEXT,
    qualification TEXT,
    supervisor TEXT,
    team TEXT,
    date_info_column TEXT,
    booked_hours_source NUMERIC,
    certificate_expiration_date DATE,
    created_by TEXT,
    description TEXT,
    employee_picture_reference_raw TEXT,
    face_verification TEXT,
    file_references_raw TEXT,
    finish_time TIME WITHOUT TIME ZONE,
    has_files BOOLEAN,
    source_uuid UUID NOT NULL,
    last_modified_by TEXT,
    latest_picture_reference_raw TEXT,
    locked BOOLEAN,
    number_of_employees INTEGER,
    open_hours_source NUMERIC,
    public_holiday_raw TEXT,
    start_time TIME WITHOUT TIME ZONE,
    total_hourly_rate NUMERIC,
    work_time_source NUMERIC,
    employee TEXT,
    custom_person_reference_raw TEXT,
    qr_code_issued BOOLEAN,
    take_picture_on_terminal_clock_in BOOLEAN,
    type_of_person TEXT,
    type TEXT,
    project_description TEXT,
    project_no TEXT,
    PRIMARY KEY (_batch_id,_source_row),
    UNIQUE (_batch_id,_source_row,_scope_id),
    FOREIGN KEY (_batch_id,_source_row,_scope_id) REFERENCES ingest.raw_rows(batch_id,source_row,scope_id),
    FOREIGN KEY (_batch_id,_scope_id,_family) REFERENCES ingest.import_batches(id,scope_id,family),
    FOREIGN KEY (_scope_id,_family,_identity_key) REFERENCES ingest.entity_keys(scope_id,family,external_key),
    UNIQUE (_batch_id,source_uuid),
    CHECK (_identity_key = source_uuid::text),
    _employee_family TEXT GENERATED ALWAYS AS ('employees'::text) STORED,
    FOREIGN KEY (_scope_id,_employee_family,employee_no) REFERENCES ingest.entity_keys(scope_id,family,external_key)
);

CREATE INDEX work_days_scope_batch_idx ON source_snapshot.work_days(_scope_id,_batch_id);

CREATE INDEX work_days_date_idx ON source_snapshot.work_days(_scope_id,operational_date);

CREATE INDEX work_days_employee_date_idx ON source_snapshot.work_days(_scope_id,employee_no,operational_date);

CREATE TABLE ingest.link_candidates (
    id UUID PRIMARY KEY,
    scope_id UUID NOT NULL,
    from_batch_id UUID NOT NULL,
    from_row BIGINT NOT NULL,
    to_batch_id UUID NOT NULL,
    to_row BIGINT NOT NULL,
    method TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('proposed','accepted','rejected')),
    reviewed_by UUID,
    reviewed_at TIMESTAMPTZ,
    FOREIGN KEY (from_batch_id,from_row,scope_id) REFERENCES ingest.raw_rows(batch_id,source_row,scope_id),
    FOREIGN KEY (to_batch_id,to_row,scope_id) REFERENCES ingest.raw_rows(batch_id,source_row,scope_id),
    UNIQUE (from_batch_id,from_row,to_batch_id,to_row,method)
);

CREATE TABLE internal_work.record_annotations (
    id UUID PRIMARY KEY,
    scope_id UUID NOT NULL,
    entity_key_id UUID NOT NULL,
    author_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    note_text TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    FOREIGN KEY (scope_id,entity_key_id) REFERENCES ingest.entity_keys(scope_id,id)
);

CREATE VIEW reporting.latest_complete_runs AS
SELECT DISTINCT ON (scope_id) id AS run_id,scope_id,declared_export_date,loaded_at
FROM ingest.import_runs
WHERE status='ready' AND completeness_verified AND declared_export_date IS NOT NULL
ORDER BY scope_id,declared_export_date DESC,loaded_at DESC,id DESC;

CREATE VIEW reporting.employees_current AS
SELECT s.*,r.declared_export_date AS snapshot_reference_date,r.loaded_at AS run_loaded_at
FROM reporting.latest_complete_runs r
JOIN ingest.run_batches rb ON rb.run_id=r.run_id AND rb.scope_id=r.scope_id AND rb.family='employees'
JOIN ingest.import_batches b ON b.id=rb.batch_id AND b.scope_id=rb.scope_id AND b.status='typed'
JOIN source_snapshot.employees s ON s._batch_id=rb.batch_id AND s._scope_id=rb.scope_id;

CREATE VIEW reporting.time_schedule_current AS
SELECT s.*,r.declared_export_date AS snapshot_reference_date,r.loaded_at AS run_loaded_at
FROM reporting.latest_complete_runs r
JOIN ingest.run_batches rb ON rb.run_id=r.run_id AND rb.scope_id=r.scope_id AND rb.family='time_schedule'
JOIN ingest.import_batches b ON b.id=rb.batch_id AND b.scope_id=rb.scope_id AND b.status='typed'
JOIN source_snapshot.time_schedule s ON s._batch_id=rb.batch_id AND s._scope_id=rb.scope_id;

CREATE VIEW reporting.site_progress_items_current AS
SELECT s.*,r.declared_export_date AS snapshot_reference_date,r.loaded_at AS run_loaded_at
FROM reporting.latest_complete_runs r
JOIN ingest.run_batches rb ON rb.run_id=r.run_id AND rb.scope_id=r.scope_id AND rb.family='site_progress_items'
JOIN ingest.import_batches b ON b.id=rb.batch_id AND b.scope_id=rb.scope_id AND b.status='typed'
JOIN source_snapshot.site_progress_items s ON s._batch_id=rb.batch_id AND s._scope_id=rb.scope_id;

CREATE VIEW reporting.daily_logs_current AS
SELECT s.*,r.declared_export_date AS snapshot_reference_date,r.loaded_at AS run_loaded_at
FROM reporting.latest_complete_runs r
JOIN ingest.run_batches rb ON rb.run_id=r.run_id AND rb.scope_id=r.scope_id AND rb.family='daily_logs'
JOIN ingest.import_batches b ON b.id=rb.batch_id AND b.scope_id=rb.scope_id AND b.status='typed'
JOIN source_snapshot.daily_logs s ON s._batch_id=rb.batch_id AND s._scope_id=rb.scope_id;

CREATE VIEW reporting.work_days_current AS
SELECT s.*,r.declared_export_date AS snapshot_reference_date,r.loaded_at AS run_loaded_at
FROM reporting.latest_complete_runs r
JOIN ingest.run_batches rb ON rb.run_id=r.run_id AND rb.scope_id=r.scope_id AND rb.family='work_days'
JOIN ingest.import_batches b ON b.id=rb.batch_id AND b.scope_id=rb.scope_id AND b.status='typed'
JOIN source_snapshot.work_days s ON s._batch_id=rb.batch_id AND s._scope_id=rb.scope_id;

CREATE VIEW reporting.deviations_current AS
SELECT s.*,r.declared_export_date AS snapshot_reference_date,r.loaded_at AS run_loaded_at
FROM reporting.latest_complete_runs r
JOIN ingest.run_batches rb ON rb.run_id=r.run_id AND rb.scope_id=r.scope_id AND rb.family='deviations'
JOIN ingest.import_batches b ON b.id=rb.batch_id AND b.scope_id=rb.scope_id AND b.status='typed'
JOIN source_snapshot.deviations s ON s._batch_id=rb.batch_id AND s._scope_id=rb.scope_id;

COMMIT;
