import { canonicalHeaders, FAMILIES } from './planning-import.mjs';
import { writeWorkbook } from './xlsx-write.mjs';

// Synthetic examples keyed by destination, never a second list of accepted headers.
const EXAMPLES = {
  employee_no: 'EMP-001', first_name: 'Nome di esempio', last_name: 'Cognome di esempio',
  company: 'Impresa di esempio', qualification: 'Qualifica di esempio', supervisor: 'SUP-001', team: 'TEAM-001',
  hire_date: '2026-11-01', expire_date: '2027-11-01', operational_date: '2026-11-01',
  start_time: '08:00', finish_time: '17:00', work_time: '8', open_hours: '8', booked_hours: '0', source_status: 'Esempio',
  wbs_code: '1', description: 'Lavorazione di esempio', plc_area: 'AREA-001', section: 'SEZ-001', assigned_to: 'TEAM-001',
  planned_start: '2026-11-01 08:00:00', planned_finish: '2026-11-02 17:00:00', actual_start: '', actual_finish: '',
  progress_pct: '0', sort_order: '1', summary_task: 'False', planned_hours: '8', planned_progress_pct: '0',
  delta_progress_source: '0', expected_delay: '', has_files: 'False', has_notes: 'False', has_deviations: 'False',
  deviation_no: 'DEV-001', title: 'Deviazione di esempio', problem_description: 'Problema di esempio',
  status: '01 Open', priority: 'Esempio', author: 'AUT-001', creation_date: '2026-11-01 08:00:00',
  due_date: '2026-11-02 17:00:00', approved_date: '', closed_date: '', actual_cost: '0', claim_quantity: '0',
  labor_hours: '0', completed_tasks_pct: '0', actual: 'Lavorazione di esempio', impediments: 'Impedimento di esempio',
  plan: 'Piano di esempio', next_step: 'Prossima lavorazione di esempio',
};

export function importTemplate(family) {
  const headers = canonicalHeaders(family);
  return writeWorkbook([headers, headers.map(header => EXAMPLES[FAMILIES[family].columns[header].field] ?? '')]);
}
