// Fixed catalog shared by the overview and its API. Labels are i18n keys.
export const DASHBOARD_WIDGETS = Object.freeze([
  { id: 'kpi_open_deviations', label: 'kpiOpenDeviations', kind: 'kpi' },
  { id: 'kpi_booked_hours', label: 'kpiBookedHours', kind: 'kpi' },
  { id: 'kpi_open_claims', label: 'kpiOpenClaims', kind: 'kpi' },
  { id: 'kpi_settled_claims', label: 'kpiSettledClaims', kind: 'kpi' },
  { id: 'deviations_by_status', label: 'dashDeviations', kind: 'panel' },
  { id: 'progress_by_section', label: 'dashProgress', kind: 'panel' },
  { id: 'hours_by_week', label: 'dashHours', kind: 'panel' },
  { id: 'earned_value', label: 'earnedValueTitle', kind: 'panel' },
  { id: 'priority_work', label: 'priorityWork', kind: 'panel' },
  { id: 'daily_pulse', label: 'dailyPulse', kind: 'panel' },
  { id: 'journal_today', label: 'journalToday', kind: 'panel' },
].map(Object.freeze));

export const DEFAULT_DASHBOARD_WIDGETS = Object.freeze(DASHBOARD_WIDGETS.map(widget => widget.id));
export const defaultDashboardLayout = () => ({ widgets: [...DEFAULT_DASHBOARD_WIDGETS], custom: false });

export function validDashboardWidgets(widgets) {
  return Array.isArray(widgets) && widgets.length > 0 && widgets.length <= DASHBOARD_WIDGETS.length
    && new Set(widgets).size === widgets.length
    && [...widgets].every(id => DEFAULT_DASHBOARD_WIDGETS.includes(id));
}
