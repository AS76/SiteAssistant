import { formatDisplayNumber, formatDateInput, parseDateInput, initialView, todayActions, todayBlockedTaskMeta, recentActions, defaultViewState, sanitizeViewState, viewStatePayload, lightTaskRows, transitionNeedsDialog, TASK_COLUMNS, REPORT_PROGRESS_COLUMNS, REPORT_DEVIATION_COLUMNS, reportProgressRows, reportDeviationRows, offlineBannerState, STATUSES, PRIORITIES, today, validDate, allowedTransitions, transitionRequirements, counts, csvCell, taskPayload, diaryPayload, transitionPayload, DEVIATION_STATUSES, groupDeviationRows, IMPACT_STATUSES, IMPACT_RESULTS, TOOL_STATUSES, TASK_KINDS, taskKindLabelKey, impactTransitions, corePermissions, filterSortRecords, impactTotals, groupBookings, weeklyBookingHours, flattenWbs, navGroups, visibleModules, toolCompanies, filterTools, toolStatusLabelKey, filterCertifications, certificationCounts, CERT_CATEGORIES, CERT_STATUSES, certCategoryLabelKey, certStatusLabelKey, HSE_TYPES, HSE_MANUAL_TYPES, HSE_SEVERITIES, filterHseEvents, hseCounts } from './domain.mjs';
import { createApi, DEFAULT_BASE_URL } from './api.mjs';
import { supportsPasskeys, runPasskey } from './webauthn-client.mjs';
import { messages } from './i18n.mjs';
import { resolveLanguage } from './language.mjs';
import { hseAttachmentNeedsReview } from './domain.mjs';
import { hasOpenProgressSteps } from './domain.mjs';
import { taskFormalAcceptance, taskVerificationOutcome } from './domain.mjs';
import { INSPECTION_STATUSES, inspectionStatusLabelKey, filterHseAssets, sortHseAssets, hseAssetCounts, inspectionOutcomeLabelKey, inspectionModeLabelKey, inspectionItemResultLabelKey, inspectionTally, sortInspections, inspectionSuggestion, inspectionProgress, inspectionPayload } from './domain.mjs';
import { DASHBOARD_WIDGETS, defaultDashboardLayout, validDashboardWidgets } from './dashboard-layout.mjs';
import { openDb, enqueue, listOps, replayOps, removeOp, getMirror, setMirror, purgeScope, overlayPending, scopeFor, registerSync, withSyncLock, confirmedCreation } from './offline.mjs';

const api = createApi({ baseUrl: new URL(document.querySelector('meta[name=siteassistant-api-base]')?.content || DEFAULT_BASE_URL, location.href).href, onUnauthorized: () => clearSession(true) });
const freshApi = createApi({ baseUrl: api.baseUrl, fresh: true, onUnauthorized: () => clearSession(true) });
// Display preferences live in this browser: currency and number formatting for money fields.
const PREF_KEY = 'siteassistant-prefs';
let prefs = (() => {
  const defaults = { version: 2, currency: 'EUR', separators: 'auto' };
  try {
    const stored = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
    const separator = stored?.version === 2 && ['auto', 'it', 'en'].includes(stored.separators) ? stored.separators : 'auto';
    return { ...defaults, ...stored, version: 2, separators: separator };
  } catch { return defaults; }
})();
const savePrefs = () => { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch { /* private mode */ } };
savePrefs();
const money = value => {
  if (value == null || value === '') return t('coreUnknown');
  try { return esc(formatDisplayNumber(value, { kind: 'money', language: ['it', 'en'].includes(prefs.separators) ? prefs.separators : language, currency: prefs.currency })); }
  catch { return esc(value); }
};

let offlineScope, pendingOps = [], offline = !navigator.onLine, storageReady = false, storageError = false, swUnavailable = false, swRegistration, syncRun;
const accountChannel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('siteassistant-session') : null;
const accountLock = run => navigator.locks ? withSyncLock(run) : run();
const logoutKey = `logout:${api.baseUrl}`;
let logoutPending = false;
const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
let session = null;
const LANGUAGE_KEY = 'sa-language';
let deviceLanguage, language = 'it', loginLanguage, pendingLanguage;
function interfaceLanguage(profile) {
  return resolveLanguage({
    profile, device: deviceLanguage, browser: navigator.languages?.length ? navigator.languages : navigator.language,
  });
}
function initLanguage() {
  try { deviceLanguage = localStorage.getItem(LANGUAGE_KEY); } catch { /* storage can be unavailable */ }
  language = interfaceLanguage();
}
let state = { sites: [], tasks: [], diary: [], attachments: [] }, siteId, actor = '', loading = true, loadError = null, toastTimer, modalVersion = 0;
let view = initialView({ width: window.innerWidth, hash: location.hash });
let filters = { search: '', status: '', person: '', priority: '', kind: '' };
let taskView = 'board';
let taskSort = defaultViewState().sort, taskColumns = [...TASK_COLUMNS];
let selectedViewId = '', savedViewsCache = null;
let wbsView = 'tree', wbsLoad = null;
const wbsCache = new Map();
let reportDate = operationalDay(new Date(), null).date;
let reportPrintIntent = null, lastReport = null;
const evidenceLabels = {
  evidenceExport: ['Esporta registro delle prove', 'Export evidence register'],
  evidenceCsv: ['Scarica CSV', 'Download CSV'],
  evidenceChecksum: ['Scarica SHA-256', 'Download SHA-256'],
  evidenceChecksumHint: ['L’impronta SHA-256 permette di verificare l’integrità del CSV scaricato. L’autenticazione della fonte e la certificazione del contenuto richiedono una prova separata.', 'Use the SHA-256 checksum to verify the downloaded CSV’s integrity. Source authentication and content certification require separate evidence.'],
  evidenceProvenance: ['Provenienza', 'Provenance'],
  evidenceSource: ['Sistema sorgente', 'Source system'],
  evidenceSourceInternal: ['Inserimento manuale', 'Manual entry'],
  evidenceSourceOther: ['Altro', 'Other'],
  evidenceSourceId: ['ID sorgente', 'Source ID'],
  evidenceSourceStatus: ['Stato sorgente', 'Source status'],
  evidenceExportDate: ['Data export', 'Export date'],
  evidenceLastSeen: ['Ultimo export completo', 'Last complete export'],
  evidenceTraceability: ['Tracciabilità', 'Traceability'],
  evidenceFull: ['Completa', 'Full'],
  evidencePartial: ['Parziale', 'Partial'],
  evidenceNone: ['Assente', 'None'],
  evidenceAbsence: ['Presenza nell’export', 'Export presence'],
  evidencePresent: ['Presente nell’export completo del {date} (perimetro: {scope})', 'Present in the complete export dated {date} (scope: {scope})'],
  evidenceAbsent: ['Assente dall’export completo del {date} (perimetro: {scope})', 'Absent from the complete export dated {date} (scope: {scope})'],
  evidenceCompareUnavailable: ['Confronto non disponibile', 'Comparison unavailable'],
  evidenceIncomplete: ['Ultimo export incompleto', 'Latest export is incomplete'],
  evidenceDifferentScope: ['Perimetri diversi', 'Different scopes'],
  evidenceSingleExport: ['Un solo export completo', 'Only one complete export'],
  evidenceSameDate: ['Export della stessa data', 'Exports share the same date'],
  evidenceUntracked: ['ID sorgente assente', 'Source ID unavailable'],
  evidenceNoExport: ['Nessun export registrato', 'No registered export'],
  evidenceOutsideComparison: ['Voce fuori dal confronto', 'Record outside the comparison'],
  evidenceOwner: ['Responsabile interno', 'Internal owner'],
  evidenceOwnerSince: ['Assegnato dal', 'Assigned since'],
  evidenceWithoutOwner: ['Senza responsabile', 'Without an internal owner'],
  evidenceAbsentFilter: ['Assenti da export valido', 'Absent from a comparable export'],
  evidenceAttribution: ['Attribuzione', 'Attribution'],
  evidenceCausing: ['Impresa che ha causato la deviazione', 'Company that caused the deviation'],
  evidenceResolving: ['Impresa incaricata della risoluzione', 'Company responsible for resolution'],
  evidenceUndetermined: ['Da determinare', 'Undetermined'],
  evidenceAgreed: ['Concordata', 'Agreed'],
  evidenceDisputed: ['Contestata', 'Disputed'],
  evidenceImported: ['Importazione', 'Import'],
  evidenceReopened: ['Riapertura', 'Reopening'],
  evidenceReopenCount: ['Riaperture', 'Reopenings'],
  evidenceImport: ['Importa export con provenienza', 'Import export with provenance'],
  evidenceScope: ['Perimetro', 'Scope'],
  evidenceComplete: ['Export completo per il perimetro indicato', 'Complete export for the stated scope'],
  evidenceImportHint: ['Seleziona un file XLSX con la colonna source_id e gli identificativi stabili delle deviazioni.', 'Select an XLSX file with a source_id column and stable deviation IDs.'],
  evidenceIdentityError: ['Gli ID sorgente mancanti, duplicati o ambigui richiedono riconciliazione.', 'Missing, duplicate or ambiguous source IDs require reconciliation.'],
  evidenceImportError: ['Controlla i metadati, l’impronta e le righe dell’export.', 'Check the export metadata, checksum and rows.'],
  evidenceOwnerError: ['Seleziona un membro attivo del cantiere.', 'Select an active site member.'],
  evidenceDeclared: ['Dichiarata il', 'Declared on'],
  evidenceVerified: ['Verificata il', 'Verified on'],
  evidenceAcceptance: ['Accettazione formale', 'Formal acceptance'],
  evidenceVerification: ['Verifica operativa', 'Operational verification'],
  evidenceVerificationPending: ['Verifica da registrare', 'Verification pending'],
  evidenceVerificationRecorded: ['Verifica registrata', 'Verification recorded'],
  evidenceVerificationLegacy: ['Chiusura storica senza verifica documentata', 'Historical closure without documented verification'],
  evidenceAcceptanceNotRecorded: ['Accettazione formale non registrata', 'Formal acceptance not recorded'],
  evidenceAccepted: ['Accettata', 'Accepted'],
  evidenceAcceptanceDocument: ['Documento di accettazione', 'Acceptance document'],
  evidenceAcceptanceDate: ['Data di accettazione', 'Acceptance date'],
  evidenceAcceptanceMissing: ['Per l’accettazione formale servono un allegato dell’attività e una data valida.', 'Formal acceptance requires a task attachment and a valid date.'],
  evidenceWaiver: ['Chiusura in deroga', 'Closure by waiver'],
  evidenceWaiverReason: ['Motivo della deroga (almeno 15 caratteri)', 'Waiver reason (at least 15 characters)'],
  evidenceWaiverView: ['Chiusure in deroga', 'Closures by waiver'],
  taskEvidenceRequired: ['Per chiudere, aggiungi un allegato oppure indica un motivo di deroga di almeno 15 caratteri.', 'To close this task, add an attachment or provide a waiver reason of at least 15 characters.'],
};
const t = key => Object.hasOwn(messages[language], key) ? messages[language][key]
  : Object.hasOwn(evidenceLabels, key) ? evidenceLabels[key][language === 'it' ? 0 : 1] : key;
const personName = name => esc(name || '—');
const currentSite = () => state.sites.find(site => site.id === siteId);
const siteTasks = () => state.tasks.filter(task => task.siteId === siteId);
const dateLabel = value => value && validDate(value) ? new Intl.DateTimeFormat(language === 'it' ? 'it-IT' : 'en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(`${value}T12:00:00`)) : t('noDue');
const coreDate = value => value == null || value === '' ? t('coreUnknown') : esc(dateLabel(String(value).slice(0, 10)));
const timeLabel = value => new Intl.DateTimeFormat(language === 'it' ? 'it-IT' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
function timeZoneForSite(site) {
  return site?.time_zone ?? (site?.jurisdiction === 'UK' ? 'Europe/London' : 'Europe/Rome');
}
function operationalDay(instant = new Date(), site = currentSite()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timeZoneForSite(site),
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(instant);
  const { year, month, day, hour, minute } = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const date = new Date(`${year}-${month}-${day}T12:00:00Z`);
  const clock = `${hour}:${minute}`, cutoff = site?.day_cutoff_time ?? '06:00', nightStart = '18:00';
  if (clock < cutoff) date.setUTCDate(date.getUTCDate() - 1);
  const isDay = cutoff <= nightStart ? clock >= cutoff && clock < nightStart : clock >= cutoff || clock < nightStart;
  return { date: date.toISOString().slice(0, 10), shift: isDay ? 'day' : 'night' };
}
function notebookTime(value, timeZone = timeZoneForSite(currentSite())) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return '';
  const format = zone => new Intl.DateTimeFormat(language === 'it' ? 'it-IT' : 'en-GB', {
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: zone,
  }).format(new Date(value));
  let clock;
  try { clock = format(timeZone || 'Europe/Rome'); } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    clock = format('UTC');
  }
  return `<time class="num" datetime="${esc(value)}">${esc(clock)}</time>`;
}
const paths = {
  today: '<rect x="3" y="5" width="18" height="16" rx="1.5"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  bookings: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3 2"/>',
  workforce_presence: '<circle cx="9" cy="8" r="3"/><path d="M3 20v-2a6 6 0 0 1 12 0v2m1-13a3 3 0 0 1 0 6m1 3a4 4 0 0 1 4 4"/>',
  wbs: '<path d="M12 8v4M5 16v-4h14v4"/><rect x="9" y="3" width="6" height="5" rx="1"/><rect x="2" y="16" width="6" height="5" rx="1"/><rect x="16" y="16" width="6" height="5" rx="1"/>',
  impacts: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h4"/>',
  certifications: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M9 12h6m-3-3v6"/>',
  'progress': '<path d="M12 4l8.5 4.5L12 13 3.5 8.5z"/><path d="M4.5 13.5L12 17.5l7.5-4"/>',
  'logistics': '<path d="M3.5 8h17v12h-17z"/><path d="M3.5 8L5.5 4h13L20.5 8"/><path d="M12 8v12"/>',
  'deviations': '<path d="M12 4.5l8 15H4z"/><path d="M12 10v4.5"/><circle cx="12" cy="17.4" r="1" fill="currentColor" stroke="none"/>',
  'document': '<path d="M6 3.5h7.5L18 8v12.5H6z"/><path d="M13.5 3.5V8H18"/><path d="M9 12h6M9 15h4.5"/>',
  'photo': '<rect x="3.5" y="5" width="17" height="14" rx="2"/><circle cx="9" cy="10" r="1.1" fill="currentColor" stroke="none"/><path d="M4.5 17l5-5 3.5 3.5 3-3 4 4"/>',
  'diary-next': '<path d="M5 19l.9-3.7L16.3 4.9a1.5 1.5 0 012.1 0l.7.7a1.5 1.5 0 010 2.1L8.7 18.1z"/><path d="M14.6 6.6l2.8 2.8"/>',
  'hse': '<path d="M7 13.5a5 5 0 013.4-4.7V6.5h3.2v2.3A5 5 0 0117 13.5"/><path d="M3.5 13.5h17"/><path d="M6 17h12"/>',
  reporting: '<path d="M4 3h16v18H4zM8 16v-4m4 4V8m4 8v-6"/>',
  inspectionFailed: '<circle cx="12" cy="12" r="9"/><path d="m8 8 8 8m0-8-8 8"/>',
  inspectionNever: '<circle cx="12" cy="12" r="9"/><path d="M9.5 8a2.5 2.5 0 0 1 5 0c0 2-2.5 2-2.5 4m0 4h.01"/>',
  overview:'<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  sites:'<path d="M3 21h18M5 21V7l7-4 7 4v14M9 9h1m4 0h1M9 13h1m4 0h1M10 21v-4h4v4"/>',
  'tasks': '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 12.3l2.8 2.8L16.5 9"/>',
  'diary': '<path d="M4 5.6A1.6 1.6 0 015.6 4H11v16H5.6A1.6 1.6 0 014 18.4z"/><path d="M20 5.6A1.6 1.6 0 0018.4 4H13v16h5.4A1.6 1.6 0 0020 18.4z"/>',
  tools:'<path d="m14.7 6.3-2.3 2.3-3-3 2.3-2.3a4 4 0 0 0-5.4 5.4L3 12l3 3 6.3-6.3a4 4 0 0 0 5.4 2.3Z"/><path d="m13 15 6 6M15 13l6 6"/>',
  execution:'<path d="m8 5 11 7-11 7V5Z"/>',review:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',closed:'<circle cx="12" cy="12" r="9"/><path d="m7 12 3 3 7-7"/>',overdue:'<path d="m12 3 10 18H2L12 3Zm0 6v5m0 3h.01"/>',
};
const icon = key => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[key] || paths.tasks}</svg>`;
const badge = (status, label = t(status)) => `<span class="badge ${esc(status)}">${esc(label)}</span>`;
const taskStatusLabel = status => t(status === 'closed' ? 'notebookClosed' : status);
const formalAcceptanceLabel = task => t(taskFormalAcceptance(task) === 'accepted' ? 'evidenceAccepted' : 'evidenceAcceptanceNotRecorded');
const priorityBadge = priority => priority !== 'normal' ? `<span class="badge ${esc(priority)}">${esc(t(priority))}</span>` : '';
const button = (key, command, extra = '', css = '') => `<button type="button" class="${css}" data-command="${command}" ${extra}>${t(key)}</button>`;
function toast(message) {
  clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 5000);
}
const errorKeys = {
  MOTIVATION_REQUIRED: 'diaryMotivationHint',
  TASK_CLOSURE_EVIDENCE_REQUIRED: 'taskEvidenceRequired', TASK_ACCEPTANCE_EVIDENCE_REQUIRED: 'evidenceAcceptanceMissing',
  DEVIATION_OWNER_INVALID: 'evidenceOwnerError', DEVIATION_IDENTITY_UNRESOLVED: 'evidenceIdentityError',
  DEVIATION_EXPORT_META_INVALID: 'evidenceImportError', DEVIATION_EXPORT_INVALID: 'evidenceImportError',
  DEVIATION_EXPORT_CHECKSUM_MISMATCH: 'evidenceImportError', SHIPMENT_NOT_FOUND: 'shpNotFound', SHIPMENT_DUPLICATE_NUMBER: 'shpDuplicateNumber', SHIPMENT_PACKAGE_NOT_FOUND: 'shpPackageUnavailable', SHIPMENT_PACKAGE_SITE_MISMATCH: 'shpPackageUnavailable', SHIPMENT_PACKAGE_TAKEN: 'shpPackageTaken', SHIPMENT_STATUS_CONFLICT: 'shpStatusConflict', SHIPMENT_ITEM_NOT_FOUND: 'shpItemNotFound', PACKAGE_NOT_FOUND: 'pkgNotFound', PACKAGE_ITEM_NOT_FOUND: 'poItemNotFound', PACKAGE_DUPLICATE_NUMBER: 'pkgDuplicateNumber', PACKAGE_QUANTITY_EXCEEDED: 'pkgQuantityExceeded', PACKAGE_STATUS_CONFLICT: 'pkgStatusConflict', PO_STATUS_CONFLICT: 'poStatusConflict', PO_DUPLICATE_NUMBER: 'poDuplicateNumber', PO_DUPLICATE_LINE: 'poDuplicateLine', PO_NOT_FOUND: 'poNotFound', PO_ITEM_NOT_FOUND: 'poItemNotFound', HSE_INVALID: 'hseInvalid', HSE_FORBIDDEN: 'forbidden', HSE_NOT_FOUND: 'hseNotFound', MODULE_FORBIDDEN: 'moduleUnavailable', ACCESS_INVALID: 'accessInvalid', LAYOUT_INVALID: 'layoutInvalid', MAP_INVALID: 'importMappingInvalid', PREVIEW_MISMATCH: 'importPreviewStale', PREVIEW_EXPIRED: 'importPreviewStale', VIEW_NAME_TAKEN: 'viewNameTaken', VIEW_NOT_FOUND: 'viewNotFound', VIEW_FORBIDDEN: 'forbidden', VIEW_INVALID: 'viewInvalid', TOOL_NOT_FOUND: 'toolNotFound', TOOL_FORBIDDEN: 'forbidden', TOOL_INVALID: 'toolInvalid', VALIDATION_ERROR: 'invalidData', TIME_BOOKING_NOT_FOUND: 'coreRecordGone', WORK_DAY_NOT_FOUND: 'coreRecordGone', SITE_PROGRESS_ITEM_NOT_FOUND: 'coreRecordGone', DEVIATION_NOT_FOUND: 'coreRecordGone', COST_IMPACT_NOT_FOUND: 'coreRecordGone', TIME_BOOKING_DUPLICATE: 'coreDuplicateBooking', TIME_BOOKING_SITE_MISMATCH: 'coreSiteMismatch', COST_IMPACT_CONFLICT: 'coreImpactConflict', SHARED_DEMO_PREFERENCE: 'sharedDemoPreference', MAIL_NOT_CONFIGURED: 'mailUnavailable', MAIL_UNAVAILABLE: 'mailUnavailable', DUPLICATE_SITE_CODE: 'duplicateCode', DUPLICATE_DIARY: 'duplicateDiary', SEPARATE_PEOPLE_REQUIRED: 'separatePeople', INVALID_TRANSITION: 'actionDenied', VERIFIER_REQUIRED: 'verifierRequired', NOTE_REQUIRED: 'noteRequired', REASON_REQUIRED: 'reasonRequired' };
function errorMessage(error) { if (error.code === 'PASSWORD_CHANGE_REQUIRED') return t('passwordChangeNotice'); if (error.code === 'MODULE_FORBIDDEN') return t('moduleUnavailable'); if (error.code === 'PAGINATION_LIMIT') return t('paginationLimit'); return t(({ 401: error.code === 'INVALID_CREDENTIALS' ? 'invalidCredentials' : 'authRequired', 403: 'forbidden', 429: 'rateLimited' })[error.status] || errorKeys[error.code] || (error.message in messages[language] ? error.message : 'apiError')); }
function clearSession(invalidate = false) {
  reportPrintIntent = null; lastReport = null;
  resetSavedViews();
  overviewCache.clear();
  wbsCache.clear(); wbsLoad = null; resetCore();
  session = null; pendingLanguage = undefined; language = interfaceLanguage(); actor = ''; siteId = undefined; loadError = null; offlineScope = undefined; pendingOps = [];
  state = { sites: [], tasks: [], diary: [], attachments: [] };
  filters = { search: '', status: '', person: '', priority: '', kind: '' };
  closeModal();
  if (invalidate) void forgetActive().catch(() => { storageError = true; });
  if (!loading) render();
}
async function forgetActive() {
  if (storageReady) await setMirror('active', null);
  if ('caches' in window) for (const key of await caches.keys()) if (key.startsWith('siteassistant-v') && key.includes('-data-')) await caches.delete(key);
}
async function flushLogout() {
  if (!logoutPending && !(storageReady && await getMirror(logoutKey))) return;
  try { await api.logout(); }
  catch (error) { if (error.status !== 401) throw error; }
  if (storageReady) await setMirror(logoutKey, null);
  logoutPending = false;
}
async function logout() {
  try {
    await accountLock(async () => {
      const active = storageReady ? await getMirror('active') : null;
      const scope = offlineScope ?? active?.scope;
      const current = !active || active.scope === scope;
      if (storageReady) await purgeScope(scope, current ? logoutKey : undefined);
      if ('caches' in window && scope) {
        const suffix = `-data-${encodeURIComponent(scope)}`;
        try {
          for (const key of await caches.keys()) if (key.startsWith('siteassistant-v') && key.endsWith(suffix)) await caches.delete(key);
        } catch { storageError = true; }
      }
      clearSession(); accountChannel?.postMessage('changed');
      if (!current) return;
      logoutPending = !storageReady;
      if (navigator.onLine) await flushLogout();
    });
  } catch (error) { toast(errorMessage(error)); }
}
async function persistState() {
  if (!storageReady || !offlineScope || (await getMirror('active'))?.scope !== offlineScope) return;
  await setMirror(`state:${offlineScope}`, {
    ...state,
    tasks: state.tasks.filter(item => !item.localOnly), diary: state.diary.filter(item => !item.localOnly),
    attachments: (state.attachments || []).filter(item => !item.localOnly),
  });
}
async function refreshPending() {
  pendingOps = storageReady && offlineScope ? await listOps(offlineScope) : [];
  state = overlayPending(state, pendingOps);
}
async function loadPages(load) {
  const rows = [], limit = 200;
  for (let offset = 0; ; offset += limit) {
    const page = await load(offset ? { offset } : {});
    rows.push(...page);
    if (page.length < limit) return rows;
  }
}
async function saveLanguagePreference() {
  const choice = pendingLanguage;
  const user = session?.user;
  if (!choice || choice.userId !== user?.id || user.shared_demo !== false) return;
  if (user.language === choice.language) {
    pendingLanguage = undefined;
    return;
  }
  try {
    const { user: updated } = await api.updatePreferences({ language: choice.language });
    if (session?.user.id !== choice.userId) return;
    session.user = updated;
    if (pendingLanguage === choice) pendingLanguage = undefined;
    if (storageReady && offlineScope && (await getMirror('active'))?.scope === offlineScope) {
      await setMirror('active', { scope: offlineScope, baseUrl: api.baseUrl, session });
    }
  } catch (error) {
    if (session?.user.id === choice.userId) toast(errorMessage(error));
  }
}

async function loadData({ signedIn = false } = {}) {
  coreCache.clear(); overviewCache.clear();
  loading = true; loadError = null; render();
  try {
    await accountLock(async () => {
      if (logoutPending || (storageReady && await getMirror(logoutKey))) {
        if (navigator.onLine) await flushLogout().catch(() => {});
        return;
      }
      let active = storageReady ? await getMirror('active') : null;
      try {
        session = await freshApi.me(); actor = session.user.name; offline = false;
        if (pendingLanguage?.userId !== session.user.id) pendingLanguage = undefined;
        const chosen = signedIn ? loginLanguage : null;
        loginLanguage = undefined;
        if (chosen) pendingLanguage = { userId: session.user.id, language: chosen };
        language = chosen ?? pendingLanguage?.language ?? interfaceLanguage(session.user.language);
        renderChrome();
        offlineScope = scopeFor(api.baseUrl, session.user.id);
        await saveLanguagePreference();
        if (!session) return;
        active = { scope: offlineScope, baseUrl: api.baseUrl, session };
        if (storageReady) await setMirror('active', active);
      } catch (error) {
        if (error.code !== 'NETWORK_ERROR' || active?.baseUrl !== api.baseUrl) throw error;
        const saved = await getMirror(`state:${active.scope}`);
        if (!saved && !active.session.password_change_required) throw error;
        offline = true; session = active.session; actor = session.user.name; offlineScope = active.scope; state = saved;
        language = pendingLanguage?.userId === session.user.id ? pendingLanguage.language : interfaceLanguage(session.user.language);
      }
      if (session.password_change_required) {
        state = { sites: [], tasks: [], diary: [], attachments: [] };
        siteId = undefined; pendingOps = [];
        return;
      }
      if (!offline) {
        try {
          const [sites, tasks, diary] = await Promise.all([freshApi.listSites(), freshApi.listTasks(), freshApi.listDiary()]);
          const accessRows = await Promise.all(sites.map(async site => [site.id, await freshApi.listModuleAccess(site.id)]));
          const memberAccess = Object.fromEntries(accessRows);
          const saved = storageReady ? await getMirror(`state:${offlineScope}`) : null;
          state = { sites, tasks, diary, memberAccess, attachments: saved?.attachments || [], todayResources: saved?.todayResources || {} };
          if (sites.length) {
            const selected = sites.some(site => site.id === siteId) ? siteId : sites[0].id;
            try {
              const files = await freshApi.listAttachments({ site_id: selected });
              state.attachments = [...state.attachments.filter(file => file.site_id !== selected), ...files];
            } catch (error) { if (error.status === 401 || error.status === 403) throw error; }
          }
          try { await persistState(); } catch { storageError = true; }
        } catch (error) {
          const saved = storageReady && offlineScope ? await getMirror(`state:${offlineScope}`) : null;
          if (error.code !== 'NETWORK_ERROR' || !saved) throw error;
          state = saved; offline = true;
        }
      }
      await refreshPending();
      if (!state.sites.some(site => site.id === siteId)) {
        resetSavedViews(); siteId = state.sites[0]?.id; reportDate = operationalDay().date;
      }
    });
  } catch (error) { loadError = error; }
  loading = false; render();
}
async function syncQueue(currentDiaryId) {
  if (syncRun || !navigator.onLine || !session || session.password_change_required || !storageReady) return syncRun;
  syncRun = (async () => {
    try {
      await replayOps(freshApi, { scope: offlineScope, userId: session.user.id, currentDiaryId });
      await loadData();
    } catch (error) {
      if (error.code === 'NETWORK_ERROR') offline = true;
      else toast(errorMessage(error));
      await refreshPending(); render();
    }
    if (pendingOps.some(op => op.status !== 'failed')) await registerSync(swRegistration);
  })().finally(() => { syncRun = null; });
  return syncRun;
}
async function writeOperation(op_type, payload, entity_id) {
  if (!offlineScope) throw new Error('authRequired');
  if (!storageReady) {
    if (offline) throw new Error('offlineStorageUnavailable');
    if (op_type === 'create_task') { const task = await api.createTask(payload, { idempotencyKey: crypto.randomUUID() }); state.tasks.push(task); return task; }
    if (op_type === 'create_diary') { const entry = await api.createDiary(payload); state.diary.push(entry); return entry; }
    if (op_type === 'transition_task') { rememberTask(await api.transitionTask(payload.task, payload.input)); return; }
    if (op_type === 'create_attachment') { const file = await api.createAttachment(payload); state.attachments.push(file); return file; }
    return;
  }
  const op = await enqueue({ op_type, payload, entity_id, scope: offlineScope }, { requireActive: true });
  await refreshPending();
  if (navigator.onLine && !offline) await syncQueue(op_type === 'create_diary' ? op.id : undefined);
  if (pendingOps.some(item => item.status !== 'failed')) await registerSync(swRegistration);
  const current = pendingOps.find(item => item.id === op.id);
  if (current?.status === 'failed') throw Object.assign(new Error('syncFailed'), current.error);
  if (op_type === 'create_diary') return confirmedCreation(op.scope, op.entity_id);
  return op;
}
const syncBadge = entity => entity?.syncStatus ? `<span class="badge sync-${entity.syncStatus}">${t(entity.syncStatus === 'failed' ? 'syncFailed' : 'syncPending')}</span>` : '';
function renderOffline() {
  const banner = $('#offline-banner');
  const failed = pendingOps.filter(op => op.status === 'failed' || op.status === 'uncertain');
  const state = offlineBannerState({ offline, storageError, swUnavailable, pending: pendingOps.length });
  banner.hidden = !state.visible;
  banner.innerHTML = `${state.offline ? `<strong>${t('offlineNotice')}</strong> ` : ''}${state.storage ? `<strong>${t('offlineStorageUnavailable')}</strong> ` : ''}${state.serviceWorker ? `<strong>${t('offlineSwUnavailable')}</strong> ` : ''}${state.pending ? `<span>${state.pending} ${t('syncPending')}</span> ${button('syncNow', 'sync-now')}` : ''}${failed.length ? `<ul>${failed.map(op => `<li>${esc(op.payload.title || op.payload.filename || op.payload.task?.title || op.payload.date || '')}: ${t(op.error?.code === 'SYNC_UNCERTAIN' || op.status === 'uncertain' ? 'syncUncertain' : op.error?.code === 'DUPLICATE_DIARY' ? 'duplicateDiary' : 'syncFailed')} ${op.status === 'failed' ? button('discardOperation', 'discard-op', `data-id="${esc(op.id)}"`) : ''}</li>`).join('')}</ul>` : ''}`;
}
function rememberTask(task) {
  state.tasks = state.tasks.map(item => {
    if (item.id !== task.id) return item;
    if (item.status !== task.status || item.acceptance_state !== task.acceptance_state || item.wbsId !== task.wbsId) {
      coreCache.get(task.siteId)?.delete('progress');
    }
    return task;
  });
}
function heading(title, subtitle, actions = '') {
  return `<div class="page-heading"><div><div class="eyebrow">${esc(currentSite()?.code || '')}<span class="eyebrow-site-name"> · ${esc(currentSite()?.name || '')}</span></div><h1>${t(title)}</h1><p>${t(subtitle)}</p></div><div class="heading-actions">${actions}</div></div>`;
}
function empty(title, subtitle, action = '') { return `<div class="empty"><strong>${t(title)}</strong>${t(subtitle)}${action ? `<div style="margin-top:16px">${action}</div>` : ''}</div>`; }
const DEMO_NOTICE_KEY = 'sa-demo-notice-dismissed';
function initDemoNotice() {
  const banner = $('#demo-banner');
  try { banner.hidden = localStorage.getItem(DEMO_NOTICE_KEY) === '1'; }
  catch { banner.hidden = false; }
  renderDemoNotice();
}
function renderDemoNotice() {
  const info = $('#demo-info');
  info.textContent = t('demoInfoTitle');
  info.hidden = false;
  if ($('#demo-banner').hidden) return;
  $('#demo-notice-title').textContent = t('demoNoticeTitle');
  $('#demo-notice-text').textContent = t('demoNoticeText');
  $('#demo-feedback').textContent = t('demoNoticeFeedback');
  $('#dismiss-demo-notice').setAttribute('aria-label', t('demoNoticeDismiss'));
}
function dismissDemoNotice() {
  $('#demo-banner').hidden = true;
  try { localStorage.setItem(DEMO_NOTICE_KEY, '1'); } catch { /* storage unavailable */ }
  $('#main').focus({ preventScroll: true });
}
function showDemoInfo() {
  showModal(t('demoInfoTitle'), `<div class="demo-info">
    <p>${esc(t('demoInfoEnvironment'))}</p>
    <h3>${esc(t('demoInfoLimits'))}</h3>
    <ul>
      <li>${esc(t('demoInfoLogistics'))}</li>
      <li>${esc(t('demoInfoCountryModules'))}</li>
      <li>${esc(t('demoInfoQualityAcceptance'))}</li>
      <li>${esc(t('demoInfoLocationHierarchy'))}</li>
    </ul>
    <p>${esc(t('demoInfoAssistant'))}</p>
    <p>${esc(t('demoInfoRetention'))}</p>
  </div>`);
}
function demoLanguageLegend() {
  return `<p class="note demo-language-note" role="note" aria-label="${esc(t('demoLanguageLabel'))}">${esc(t('demoLanguageNote'))}</p>`;
}
function renderChrome() {
  const manualPages = {
    sites: 'moduli/cantieri/',
    tasks: 'moduli/attivita/',
    wbs: 'moduli/wbs/',
    deviations: 'moduli/deviazioni/',
    progress: 'moduli/avanzamento/',
    bookings: 'moduli/prenotazioni-ore/',
    impacts: 'moduli/impatti-economici/',
    diary: 'moduli/diario/',
    tools: 'moduli/attrezzature/',
    certifications: 'moduli/idoneita/',
    hse: 'moduli/hse/',
    logistics: 'moduli/logistica/',
    settings: 'guida/impostazioni/'
  };
  renderOffline();
  const accountReady = Boolean(session && !session.password_change_required);
  document.documentElement.lang = language;
  if (document.documentElement.dataset) document.documentElement.dataset.lang = language;
  document.title = `SiteAssistant · ${t(session ? view : 'login')}`;
  renderAssistantChrome();
  const nav = $('#navigation');
  const rail = window.matchMedia('(min-width: 1180px)').matches;
  const destinations = rail ? [] : visibleModules(headerNavItems(), currentModules());
  const more = !rail && !destinations.includes(view);
  const navLabel = key => t(({ bookings: 'bookingsShort', diary: 'diaryNav', progress: rail ? 'progress' : 'progressShort' })[key] || key);
  const navLink = key => {
    const active = view === key;
    return `<a href="#${key}"${active ? ' aria-current="page"' : ''}>${icon(key)}<span>${navLabel(key)}</span></a>`;
  };
  const navSlot = $(rail ? '.rail-navigation' : '.topbar-navigation');
  if (nav.parentElement !== navSlot) navSlot.append(nav);
  nav.setAttribute('aria-label', t('nav'));
  nav.innerHTML = rail ? desktopNavigation(navLink) : destinations.map(navLink).join('')
    + `<button type="button" class="nav-more${more ? ' active' : ''}" data-command="more-nav" aria-haspopup="dialog">${icon('more')}<span>${t('more')}</span></button>`;
  if (rail) bindDesktopNavigation();
  nav.hidden = !accountReady;
  $('#skip').textContent = t('skip');
  $('.site-control').hidden = !accountReady;
  $('#site-label').textContent = t('site');
  $('#settings-button').title = t('settingsTitle');
  $('#settings-button').hidden = Boolean(session?.password_change_required);
  $('#settings-button').setAttribute('aria-label', t('settingsTitle'));
  $('#manual-link').textContent = t('manual');
  $('#manual-link').href = `https://as76.github.io/SiteAssistant/${language === 'en' ? 'en/' : ''}${session ? manualPages[view] || '' : 'guida/accesso/'}`;
  $('#privacy-link').textContent = t('privacy');
  $('#privacy-link').href = `/privacy?lang=${language}`;
  $('#cookie-link').textContent = t('cookiePolicy');
  $('#cookie-link').href = `/cookie-policy?lang=${language}`;
  $('#site-select').innerHTML = state.sites.map(site => `<option value="${esc(site.id)}" ${site.id === siteId ? 'selected' : ''}>${esc(site.name)}</option>`).join('');
  const site = currentSite();
  $('#site-select').title = site?.name || '';
  $('#topbar-code').textContent = site?.code || '';
  $('#topbar-code').hidden = !site?.code;
  $('#site-location').textContent = site?.location || '';
  $('#site-location').hidden = !site?.location;
  $('#operational-context').hidden = !site;
  if (site) {
    const { date, shift } = operationalDay();
    const dateParts = new Intl.DateTimeFormat(language === 'it' ? 'it-IT' : 'en-GB', {
      day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
    }).formatToParts(new Date(`${date}T12:00:00Z`));
    $('#operational-label').textContent = t('reportDate');
    $('#operational-date').dateTime = date;
    $('#operational-date').innerHTML = dateParts.map(({ type, value }) =>
      type === 'day' ? `<b class="num">${esc(value)}</b>` : esc(value)).join('');
    $('#operational-shift').textContent = t(shift);
  }
  $('#actor-name').textContent = actor;
  const memberRole = role();
  $('#actor-role').textContent = memberRole ? t(`responsibleRole_${memberRole}`) : '';
  let logoutButton = $('#logout');
  if (!logoutButton) {
    $('#language').insertAdjacentHTML('beforebegin', '<button type="button" id="logout" data-command="logout"></button>');
    logoutButton = $('#logout');
  }
  let passwordBanner = $('#password-banner');
  if (!passwordBanner) {
    $('#demo-banner').insertAdjacentHTML('afterend', '<section id="password-banner" class="demo-banner"></section>');
    passwordBanner = $('#password-banner');
  }
  passwordBanner.hidden = !session?.password_change_required;
  passwordBanner.innerHTML = passwordBanner.hidden ? ''
    : `<h1>${t('passwordChangeNotice')}</h1> ${button('changePassword', 'change-password', offline ? 'disabled' : '')}`;
  logoutButton.hidden = !session; logoutButton.textContent = t('logout');
  $('#site-select').disabled = loading || !state.sites.length;
  $('#language').textContent = language === 'it' ? 'EN' : 'IT';
  $('#language').setAttribute('aria-label', language === 'it' ? 'Switch to English' : 'Passa all’italiano');
  $('#language').lang = language === 'it' ? 'en' : 'it';
  renderDemoNotice();
  let loginLegend = $('#login-demo-language');
  if (!loginLegend) {
    $('#demo-banner').insertAdjacentHTML('afterend', '<div id="login-demo-language" class="demo-banner"></div>');
    loginLegend = $('#login-demo-language');
  }
  loginLegend.hidden = Boolean(session);
  loginLegend.innerHTML = !session ? demoLanguageLegend() : '';
  $('#footer-note').textContent = t('footer');
}
let aiScope = null, aiMessages = [], aiBusy = false, aiError = null;
const aiNoticedSites = new Set();
const assistantAvailable = () => Boolean(session && currentSite()?.assistant_enabled === true);
function renderAssistantChrome() {
  const scope = assistantAvailable() ? `${session.user.id}:${siteId}` : null;
  const panel = $('#ai-panel');
  if (aiScope !== scope) {
    aiScope = scope;
    aiMessages = [];
    aiBusy = false;
    aiError = null;
    $('#ai-form [name=message]').value = '';
    $('#ai-log').innerHTML = '';
    $('#ai-suggestions').innerHTML = '';
    $('#ai-error').textContent = '';
    panel.hidden = true;
  }
  if (!scope) panel.hidden = true;
  for (const selector of ['#ai-fab', '#ai-top']) {
    const trigger = $(selector);
    trigger.hidden = !scope;
    trigger.setAttribute('aria-expanded', String(!panel.hidden));
    trigger.setAttribute('aria-label', t('aiTitle'));
  }
  if (!panel.hidden) renderAssistant();
  if (!scope || loading || aiNoticedSites.has(siteId)) return;
  aiNoticedSites.add(siteId);
  const key = `sa-assistant-demo-notice:${siteId}`;
  try {
    if (localStorage.getItem(key) === '1') return;
    localStorage.setItem(key, '1');
  } catch { /* the in-memory record covers unavailable storage */ }
  toast(t('aiDemoNotice'));
}
function dueMarkup(task) { return `<span class="due ${task.status !== 'closed' && task.due && task.due < today() ? 'overdue' : ''}">${dateLabel(task.due)}</span>`; }
function taskRow(task) {
  return `<div class="task-row"><div><h3><button data-command="detail" data-id="${esc(task.id)}">${esc(task.title)}</button></h3><p>${esc(task.area || t('noArea'))} · ${esc(task.company)}</p>${badge(task.status, taskStatusLabel(task.status))} ${priorityBadge(task.priority)} ${syncBadge(task)}</div><div class="subtitle">${dueMarkup(task)}</div></div>`;
}
function todayResource(name) {
  const entry = coreCache.get(siteId)?.get(name);
  if (!offline && [401, 403].includes(entry?.error?.status)) return [];
  return entry?.data ?? state.todayResources?.[siteId]?.[name] ?? [];
}
function rememberTodayResource(name, data, selected = siteId) {
  if (!['progress', 'deviations'].includes(name)) return;
  const cached = coreCache.get(selected)?.get(name);
  if (cached?.data) cached.data = data;
  state.todayResources ??= {};
  state.todayResources[selected] ??= {};
  state.todayResources[selected][name] = data;
  const scope = offlineScope;
  void accountLock(async () => {
    if (scope === offlineScope) await persistState();
  }).catch(() => { storageError = true; });
}
function progressPlannedDay(item) {
  const start = item.plannedStart;
  if (validDate(start)) return start;
  return start && Number.isFinite(Date.parse(start)) ? operationalDay(new Date(start)).date : null;
}
function currentTodayActions(day = operationalDay().date) {
  return todayActions({ progress: todayResource('progress'),
    diary: state.diary.filter(entry => entry.siteId === siteId), deviations: todayResource('deviations'),
    userId: session?.user.id, today: day, modules: currentModules(), plannedDay: progressPlannedDay });
}
function canCloseTodayTask(task) {
  return task.status !== 'closed' && canRunLightTransition(task);
}
function todayPhotoTargets() {
  const day = operationalDay().date;
  const entries = canAttachDiary()
    ? state.diary.filter(entry => entry.siteId === siteId && entry.date === day)
    .map(entry => ({ type: 'diary', id: entry.id, title: `${t('journalToday')} · ${t(entry.shift)}` })) : [];
  const tasks = canEditTask() ? filterSortRecords(siteTasks().filter(task => task.status !== 'closed'), {}, [{ key: 'due' }, { key: 'title' }, { key: 'id' }])
    .map(task => ({ type: 'task', id: task.id, title: task.title })) : [];
  return [...entries, ...tasks].slice(0, 5);
}
const notebookStates = {
  todo: ['○', 'todo'], in_progress: ['▶', 'in_progress'], to_verify: ['◆', 'to_verify'],
  blocked: ['▲', 'blocked'], closed: ['✓', 'notebookClosed'], upcoming: ['→', 'todayUpcoming'],
};
function notebookState(status, state = Object.hasOwn(notebookStates, status) ? notebookStates[status] : null) {
  return state ? `<span class="notebook-state"><span aria-hidden="true">${state[0]}</span> ${esc(t(state[1]))}</span>` : '';
}
const notebookSync = entity => entity.syncStatus ? `<span class="notebook-meta">${t(entity.syncStatus === 'failed' ? 'syncFailed' : 'syncPending')}</span>` : '';
const notebookPriority = priority => priority !== 'normal' ? `<span class="notebook-meta">${esc(t(priority))}</span>` : '';
const notebookCount = (count, singular, plural) => `<strong class="num">${count}</strong> ${t(count === 1 ? singular : plural)}`;
const notebookBoardHead = (state, count) => `${state}<span class="count num">${count}</span>`;
const notebookDue = task => `<span class="num">${dueMarkup(task)}</span>`;
function todayTaskItem(task, day) {
  const status = task.status;
  const event = task.events?.findLast(event => event.to_status === status);
  const time = status === 'to_verify' ? task.declared_at || event?.at : event?.at;
  const hasDue = validDate(task.due), dueTodayOrPast = hasDue && task.due <= day;
  const block = status === 'blocked' ? { ...todayBlockedTaskMeta(task, day), hasDue, dueTodayOrPast } : null;
  const resumeReview = status === 'blocked' && task.blocked_from === 'to_verify';
  const transitions = status === 'to_verify' || resumeReview ? taskTransitions(task) : [];
  const canVerify = transitions.includes('closed');
  const canResume = resumeReview && transitions.includes('to_verify');
  return {
    kind: 'task', id: task.id, title: task.title, status, time, due: task.due, block,
    meta: [task.area, task.company, task.wbsCode, task.assignee,
      status === 'to_verify' && task.submitted_by,
      dueTodayOrPast && `${t('due')} ${dateLabel(task.due)}`,
      task.executor_id === session?.user.id && t('todayMine'),
      task.syncStatus && t(task.syncStatus === 'failed' ? 'syncFailed' : 'syncPending')],
    note: block ? block.blockNote : event?.note,
    canVerify, canResume,
    inVerification: (status === 'to_verify' || resumeReview) && (canVerify || canResume || !hasDue || dueTodayOrPast),
    reviewDenied: status === 'to_verify' && !canReviewTask(task),
  };
}
function todayReviewActions(item, primary = false) {
  const options = { todayReview: true };
  const actions = item.canVerify
    ? taskActionButton(item.id, 'closed', t('taskVerify'), { ...options, primary }) + taskActionButton(item.id, 'in_progress', t('taskReject'), options)
    : item.canResume ? taskActionButton(item.id, 'to_verify', t('taskResume'), { ...options, resume: true }) : '';
  return actions ? `<div class="notebook-actions today-review-actions">${actions}</div>`
    : item.reviewDenied ? `<p class="note today-review-note">${t('verifyNoPermission')}</p>` : '';
}
function todayBlockedRow(item, actions) {
  const { blockNote, overdueDays, hasDue, dueTodayOrPast } = item.block;
  const delay = dueTodayOrPast ? t(overdueDays === 1 ? 'todayLateDay' : 'todayLateDays').replace('{days}', overdueDays) : '';
  return `<li><button type="button" class="today-row today-row-blocked" data-command="detail" data-kind="task" data-id="${esc(item.id)}">
    ${notebookState(item.status)}
    <strong>${esc(item.title)}</strong>
    ${hasDue ? `<time class="num today-row-time due${overdueDays > 0 ? ' overdue' : ''}" datetime="${esc(item.due)}">${esc(dateLabel(item.due))}</time>` : `<span class="today-row-time">${t('noDue')}</span>`}
    ${blockNote || delay ? `<span class="today-row-sub">${blockNote ? `<span class="today-row-clamp">${esc(t('todayBlockReason').replace('{text}', () => blockNote))}</span>` : ''}${delay ? `<span class="num">${blockNote ? ' · ' : ''}${esc(delay)}</span>` : ''}</span>` : ''}
  </button>${button('history', 'task-history', `data-id="${esc(item.id)}"`, 'small today-history')}${actions}</li>`;
}
function notebookRow(item, upcoming = false, actions = '') {
  if (item.status === 'blocked') return todayBlockedRow(item, actions);
  if (item.kind === 'diary-next') return `<li><button type="button" class="today-row today-row-diary-next" data-command="today-open" data-kind="diary-next" data-id="${esc(item.id)}">
    <span class="today-row-mark" aria-hidden="true">${icon('diary-next')}</span><span class="today-row-main"><strong class="today-row-clamp">${esc(item.title)}</strong>
    <span class="notebook-meta">${esc(item.meta.filter(Boolean).join(' · '))}</span></span>
  </button></li>`;
  const type = ({ task: 'tasks', recent: 'tasks', progress: 'progress', deviation: 'deviations', diary: 'diary' })[item.kind];
  const column = upcoming ? `<time class="num" datetime="${esc(item.due)}">${esc(dateLabel(item.due))}</time>`
    : notebookTime(item.time) || '<span aria-hidden="true">—</span>';
  return `<li><button type="button" class="today-row" data-command="today-open" data-kind="${item.kind}" data-id="${esc(item.id)}">
    <span class="today-row-time">${column}</span><span class="today-row-main"><strong>${esc(item.title)}</strong>
      <span class="notebook-meta">${esc([...new Set(item.meta.filter(Boolean))].join(' · '))}</span>
      ${item.note ? `<span class="notebook-meta prewrap">${esc(item.note)}</span>` : ''}</span>
    ${notebookState(item.status)}<span class="today-row-mark" aria-hidden="true">${icon(type)}<span>›</span></span>
  </button>${actions}</li>`;
}
const todaySkeleton = (lines = 1) => `<span class="skeleton-list" aria-hidden="true">${'<span></span>'.repeat(lines)}</span>`;
function renderToday() {
  const day = operationalDay().date;
  const resources = ['progress', 'deviations'].filter(moduleVisible).map(name => {
    const entry = offline ? null : coreResource(name);
    const cached = state.todayResources?.[siteId]?.[name];
    const status = offline ? (cached ? 'todayCached' : 'todayUnavailableOffline')
      : entry.pending ? 'loading' : entry.error ? 'todayResourceError' : !entry.data.length ? 'todayResourceEmpty' : null;
    return { name, entry, status };
  });
  const incomplete = resources.some(({ entry, status }) => entry?.pending || entry?.error || status === 'todayUnavailableOffline');
  const resourceStates = resources.filter(row => row.status).map(({ name, entry, status }) => {
    const label = `${t(name)} · ${t(status)}`;
    return `<p class="notebook-meta" role="${entry?.error ? 'alert' : 'status'}">${label}${entry?.pending ? todaySkeleton() : ''}${entry?.error ? ` ${button('retry', 'today-retry', `data-resource="${name}"`)}` : ''}</p>`;
  }).join('');
  const tasksVisible = moduleVisible('tasks');
  const diaryVisible = moduleVisible('diary');
  const tasks = tasksVisible ? filterSortRecords(siteTasks().filter(task => task.status !== 'closed'), {},
    [{ key: 'due' }, { key: 'title' }, { key: 'id' }]).map(task => todayTaskItem(task, day)) : [];
  const review = tasks.filter(item => item.inVerification);
  const verify = review.filter(item => item.status === 'to_verify');
  const work = tasks.filter(item => item.status !== 'to_verify' && !item.inVerification && validDate(item.due) && item.due <= day);
  const upcomingProgress = moduleVisible('progress') ? todayResource('progress').filter(hasOpenProgressSteps).map(item => ({
    kind: 'progress', id: item.id, title: item.description, due: progressPlannedDay(item), meta: [t('todayOpenSteps')],
  })).filter(item => item.due > day) : [];
  const upcoming = filterSortRecords([
    ...tasks.filter(item => !item.inVerification && validDate(item.due) && item.due > day), ...upcomingProgress,
  ], {}, [{ key: 'due' }, { key: 'title' }]).map(item => ({ ...item, status: 'upcoming' }));
  const other = currentTodayActions(day).filter(item => item.meta.label !== 'todayDiaryMissing').map(item => ({
    kind: item.kind, id: item.id, title: item.title || t('journalToday'),
    status: item.meta.status,
    meta: [t(item.meta.label), item.meta.status && !Object.hasOwn(notebookStates, item.meta.status) && t(item.meta.status),
      item.meta.date && dateLabel(item.meta.date), item.meta.shift && t(item.meta.shift)],
  }));
  const now = verify.find(item => item.canVerify) || work.find(item => item.status !== 'blocked') || verify[0] || work[0] || other[0] || review[0];
  const nowIsContextRow = now?.status === 'blocked' || now?.kind === 'diary-next';
  const recent = tasksVisible ? recentActions({ tasks: siteTasks() }).map(item => ({
    ...item, kind: 'recent', status: 'closed', time: item.date,
    meta: [item.date ? timeLabel(item.date) : t('todayClosureUnknown')],
  })) : [];
  const section = (id, title, rows) => rows.length ? `<section aria-labelledby="${id}">
    <div class="notebook-section-head"><h2 id="${id}">${t(title)}</h2><span class="num">${rows.length}</span></div>
    <ul class="today-list">${rows.map(item => notebookRow(item, false, id === 'today-verify' ? todayReviewActions(item) : '')).join('')}</ul></section>` : '';
  const openDiary = diaryVisible ? button('openDiary', 'today-diary') : '';
  const primary = now && !now.canVerify ? button('details', 'today-open', `data-id="${esc(now.id)}" data-kind="${now.kind}"`, 'notebook-primary') : '';
  const quick = (label, action, enabled) => button(label, 'today-quick', `data-action="${action}"${enabled ? '' : ' disabled'}`);
  const quickActions = [
    tasksVisible && verify.length && canTransitionTask() ? quick('todayVerificationList', 'verify', true) : '',
    diaryVisible ? quick('todayWriteDiary', 'diary', canWriteTask()) : '',
    (tasksVisible || diaryVisible) ? quick('todayTakePhoto', 'photo', ['owner', 'editor'].includes(role())) : '',
    moduleVisible('progress') ? quick('todayOpenProgress', 'progress', true) : '',
  ].join('');
  $('#main').innerHTML = `<div class="notebook today-content">
    <header class="notebook-page-head"><div><h1>${t('today')}</h1><time class="notebook-meta num" datetime="${day}">${esc(dateLabel(day))}</time></div>
      ${now && openDiary ? `<div class="notebook-actions">${openDiary}</div>` : ''}</header>
    <section class="today-section" aria-labelledby="today-now">
      <div class="notebook-section-head"><h2 id="today-now">${t('todayNow')}</h2></div>
      ${nowIsContextRow ? `<ul class="today-list">${notebookRow(now, false, todayReviewActions(now))}</ul>` : now ? `<article class="today-next">
        <div class="today-next-top">${notebookState(now.status)}${notebookTime(now.time)}</div>
        <h3>${esc(now.title)}</h3><p class="notebook-meta">${esc(now.meta.filter(Boolean).join(' · '))}</p>
        ${now.note ? `<p class="today-next-note prewrap">${esc(now.note)}</p>` : ''}
        ${todayReviewActions(now, true)}${primary ? `<div class="notebook-actions">${primary}</div>` : ''}
      </article>` : `<div class="today-empty">${icon('today')}<h3>${t(incomplete ? 'todayIncompleteTitle' : 'todayEmptyTitle')}</h3>
        <p class="notebook-meta">${t(incomplete ? 'todayIncomplete' : 'todayEmpty')}</p>
        <div class="notebook-actions">${openDiary}${tasksVisible ? `<button type="button" data-command="today-see-upcoming">${t('todaySeeUpcoming')} <span aria-hidden="true">→</span></button>` : ''}</div>
      </div>`}
    </section>
    ${section('today-verify', 'to_verify', review.filter(item => item !== now))}
    ${section('today-work', 'todayWork', [...work, ...other].filter(item => item !== now))}
    ${tasksVisible || upcoming.length ? `<section id="today-upcoming" class="today-upcoming" aria-labelledby="today-upcoming-title">
      <div class="notebook-section-head"><h2 id="today-upcoming-title" tabindex="-1">${t('todayUpcoming')}</h2><span>${t('todayOutsideDay')}</span></div>
      ${upcoming.length ? `<ul class="today-list">${upcoming.map(item => notebookRow(item, true)).join('')}</ul>`
        : `<p class="notebook-meta">${t('todayUpcomingEmpty')}</p>`}</section>` : ''}
    ${quickActions ? `<section aria-labelledby="today-quick"><div class="notebook-section-head"><h2 id="today-quick">${t('todayQuick')}</h2></div>
      <div class="notebook-actions today-quick">${quickActions}</div></section>` : ''}
    ${section('today-recent', 'todayRecent', recent)}
    ${resourceStates ? `<div class="today-resource-states">${resourceStates}</div>` : ''}
    ${offline ? `<p class="notebook-meta" role="status"><strong class="num">${pendingOps.length}</strong> ${t('todayQueued')}</p>` : ''}
  </div>`;
}
function openTodayAction(control) {
  const { id, kind } = control.dataset;
  let target;
  if (kind === 'task' || kind === 'recent') {
    if (siteTasks().some(task => task.id === id)) target = { view: 'tasks', filters: { id } };
  } else if (kind === 'progress') {
    if (todayResource('progress').some(item => item.id === id)) target = { view: 'progress', filters: { id } };
  } else {
    target = currentTodayActions().find(row => row.id === id && row.kind === kind)?.target;
  }
  if (!target || !moduleVisible(target.view)) return;
  if (target.view === 'deviations') { void showCoreDetail('deviations', id); return; }
  if (target.view === 'tasks') { resetSavedViews(); filters = { ...filters, ...target.filters }; taskView = 'list'; }
  else if (target.view === 'diary') reportDate = target.date;
  else coreFilters[target.view] = { ...Object.fromEntries(Object.keys(coreFilters[target.view]).map(key => [key, ''])), ...target.filters };
  go(target.view);
}
function runTodayQuick(action) {
  if (action === 'verify' && canTransitionTask()) {
    resetSavedViews(); filters = { ...filters, status: 'to_verify', kind: 'ordinary', closable: true }; taskView = 'light'; go('tasks');
  } else if (action === 'diary' && moduleVisible('diary') && canWriteTask()) {
    reportDate = operationalDay().date; showEntryForm();
  } else if (action === 'progress' && moduleVisible('progress')) {
    coreFilters.progress = { wbsId: '' }; go('progress');
  } else if (action === 'photo' && ['owner', 'editor'].includes(role()) && (moduleVisible('tasks') || moduleVisible('diary'))) {
    const targets = todayPhotoTargets();
    showModal(t('todayTakePhoto'), `<p class="note">${t('todayPhotoTarget')}</p>${targets.length
      ? `<div class="today-photo-targets">${targets.map(item => `<button type="button" data-command="today-photo-target" data-entity-type="${item.type}" data-id="${esc(item.id)}">${esc(item.title)}</button>`).join('')}</div>`
      : `<p>${t('todayPhotoEmpty')}</p>`}`);
  }
}
function openTodayPhoto(type, id) {
  if (!canWriteTask() || !todayPhotoTargets().some(item => item.type === type && item.id === id)) return;
  showAttachmentForm(type, id, { camera: true });
  $('#attachment-form [name=file]')?.click();
}
function renderOverview() {
  $('#main').innerHTML = heading('overviewTitle', 'overviewSub',
    button('layoutCustomize', 'layout-open') + button('reportPrint', 'open-report')
    + (canImport() ? button('importOpen', 'import-open') : '')
    + (canWriteTask() ? button('newTask', 'new-task', '', 'primary') : ''))
    + demoLanguageLegend()
    + `<div class="date-caption">${t('today')} · ${new Intl.DateTimeFormat(language === 'it' ? 'it-IT' : 'en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date())}</div>`
    + `<div id="overview-widgets" aria-live="polite" aria-busy="true"><p role="status">${t('loading')}</p></div>`;
  void loadOverviewDashboard();
}

function localOverviewWidgets() {
  const tasks = siteTasks(), count = counts(tasks), total = tasks.length;
  const attention = tasks.filter(task => task.status !== 'closed').sort((a, b) => {
    const score = task => (task.status === 'blocked' ? 10 : task.status === 'to_verify' ? 6 : 0) + (task.due && task.due < today() ? 12 : 0) + PRIORITIES.indexOf(task.priority);
    return score(b) - score(a) || (a.due || '9999').localeCompare(b.due || '9999');
  }).slice(0, 5);
  const diaryDate = operationalDay().date;
  const lastEntry = state.diary.filter(item => item.siteId === siteId && item.date === diaryDate).at(-1);
  const diaryLink = moduleVisible('diary') && lastEntry
    ? `<a class="subtitle" href="#diary" data-command="go-diary">${t('openDiary')} →</a>` : '';
  return {
    priority_work: `<section class="panel"><div class="panel-header"><h2>${t('priorityWork')}</h2><a class="subtitle" href="#tasks">${t('seeAll')} →</a></div>${attention.length ? attention.map(taskRow).join('') : empty('noTasks', 'noTasksHint')}</section>`,
    daily_pulse: `<section class="panel"><div class="panel-header"><h2>${t('dailyPulse')}</h2></div><div class="panel-body"><div class="metrics">${['execution', 'review', 'closed', 'overdue'].map(key => `<div class="metric ${key === 'overdue' ? 'alert' : key === 'closed' ? 'complete' : key}"><div class="metric-top">${t(key)}${icon(key)}</div><strong data-metric="${key}">${count[key]}</strong><small>${t(`${key}Hint`)}</small></div>`).join('')}</div><div class="progress-label"><span>${t('verifiedProgress')}</span><strong>${count.closed} / ${total}</strong></div><div class="progress-track"><span style="width:${total ? count.closed / total * 100 : 0}%"></span></div><p class="note">${total - count.closed} ${t('nonClosed')}</p><div class="summary-stack">${!count.blocked && !count.review ? `<p class="note">${t('pulseClear')}</p>` : `<div class="summary-line"><strong>${count.blocked} ${t('blockedPlural')}</strong><p>${count.review} ${t('reviewPlural')}</p></div>`}${count.review ? `<div class="summary-line"><strong>${t('workingRule')}</strong><p>${t('workingRuleNote')}</p></div>` : ''}</div></div></section>`,
    journal_today: `<section class="panel"><div class="panel-header"><h2>${t('journalToday')}</h2>${!lastEntry && moduleVisible('diary') ? button('draft', 'go-diary') : ''}</div><div class="panel-body"><p class="notebook-meta">${t('reportDate')} <time datetime="${esc(diaryDate)}">${esc(dateLabel(diaryDate))}</time></p><p class="subtitle prewrap">${lastEntry ? esc(lastEntry.actual) : t('noDiary')}</p>${syncBadge(lastEntry)}${diaryLink}</div></section>`,
  };
}

// Reporting is online-only; a replaced view never receives a late aggregate response.
function renderReporting() {
  $('#main').innerHTML = heading('reporting', 'reportingSub', button('reportingRefresh', 'reporting-refresh'))
    + `<p class="note" role="note">${t('reportingScopeNote')}</p>`
    + `<div id="reporting-overview" class="reporting-overview" aria-busy="true"><p role="status">${t('reportingLoading')}</p></div>`;
  void loadReporting($('#reporting-overview'));
}
async function loadReporting(target) {
  const selected = siteId, user = session?.user.id;
  const current = () => view === 'reporting' && siteId === selected && session?.user.id === user
    && moduleVisible('reporting') && document.body.contains(target);
  try {
    const data = await freshApi.reportingOverview();
    if (!current()) return;
    target.innerHTML = renderReportingOverview(data);
  } catch {
    if (current()) target.innerHTML = `<p role="alert">${t('reportingError')}</p>`;
  } finally {
    if (current()) target.setAttribute('aria-busy', 'false');
  }
}
function renderReportingOverview(data) {
  if (!data.configured) return empty('reportingNotConfigured', 'reportingNotConfiguredHint');
  if (!data.scopes.length) return empty('reportingEmpty', 'reportingEmptyHint');
  const families = ['employees', 'work_days', 'time_schedule', 'site_progress_items', 'daily_logs', 'deviations'];
  const timestamp = value => value == null ? esc(t('reportingUnknown'))
    : `<time datetime="${esc(value)}">${esc(timeLabel(value))}</time>`;
  return data.scopes.map(scope => `<article class="panel panel-body reporting-scope">
    <h2>${t('reportingProject')}: <span class="reporting-ref">${esc(scope.projectReference ?? t('reportingUnknown'))}</span></h2>
    <dl class="reporting-dates"><div><dt>${t('reportingScopeId')}</dt><dd>${esc(scope.scopeId ?? t('reportingUnknown'))}</dd></div><div><dt>${t('reportingExportDate')}</dt><dd>${scope.exportDate == null ? esc(t('reportingUnknown'))
      : `<time datetime="${esc(scope.exportDate)}">${esc(dateLabel(scope.exportDate))}</time>`}</dd></div>
      <div><dt>${t('reportingLoadedAt')}</dt><dd>${timestamp(scope.loadedAt)}</dd></div></dl>
    <div class="table-scroll"><table><caption>${t('reportingCounts')}</caption>
      <thead><tr><th scope="col">${t('reportingFamily')}</th><th scope="col">${t('reportingRows')}</th></tr></thead>
      <tbody>${families.map(family => `<tr><th scope="row">${t(`reportingFamily_${family}`)}</th><td>${esc(scope.counts[family])}</td></tr>`).join('')}</tbody>
      <tfoot><tr><th scope="row">${t('reportingTotalRows')}</th><td>${esc(scope.totalRows)}</td></tr></tfoot></table></div>
    <p class="reporting-quality">${t('reportingQualityIssues')}: <strong>${esc(scope.qualityIssues)}</strong></p>
  </article>`).join('');
}
// Every report opening fetches current data; a late response cannot print another site or view.
function renderReport() {
  $('#main').innerHTML = heading('report', 'reportSub', button('reportCsvProgress', 'report-csv-progress', 'disabled')
    + button('reportCsvDeviations', 'report-csv-deviations', 'disabled') + button('reportPrint', 'open-report', 'disabled'))
    + `<div id="site-report" class="site-report" aria-busy="true"><p role="status">${t('loading')}</p></div>`;
  void loadReport($('#site-report'));
}
async function loadReport(target) {
  const selected = siteId, user = session?.user.id;
  const current = () => view === 'report' && siteId === selected && session?.user.id === user && document.body.contains(target);
  try {
    const data = await freshApi.report(selected);
    if (!current()) return;
    const percent = value => value == null ? esc(t('coreUnknown')) : `<span>${coreNumber(value, 'percent')}%</span>
      <span class="report-bar" aria-hidden="true"><span style="width:${Math.min(100, Math.max(0, Number(value)))}%"></span></span>`;
    const table = (caption, columns, rows) => `<div class="report-table-wrap"><table class="report-table"><caption>${t(caption)}</caption>
      <thead><tr>${columns.map(key => `<th scope="col">${t(key)}</th>`).join('')}</tr></thead>
      <tbody>${rows.length ? rows.map(cells => `<tr>${cells.map((cell, index) => index === 0 ? `<th scope="row">${cell}</th>` : `<td>${cell}</td>`).join('')}</tr>`).join('')
        : `<tr><td colspan="${columns.length}">${t('noResults')}</td></tr>`}</tbody></table></div>`;
    // Keep an explicit UTC label on the timestamp, including on the printed copy.
    const generated = new Intl.DateTimeFormat(language === 'it' ? 'it-IT' : 'en-GB', {
      dateStyle: 'medium', timeStyle: 'medium', timeZone: 'UTC',
    }).format(new Date(data.generated_at));
    target.innerHTML = `<header class="report-header"><h2>${esc(data.site.code)} · ${esc(data.site.name)}</h2>
      <p>${t('reportGenerated')}: <time datetime="${esc(data.generated_at)}">${esc(generated)} UTC</time></p></header>`
      + '<section>' + table('reportCockpit', ['reportArea', 'reportItems', 'reportActual', 'reportPlanned', 'reportSource'],
        data.progress.map(row => [esc(row.area), coreNumber(row.items, 'count'), percent(row.actual), percent(row.planned), esc(t(`reportSource_${row.source}`))]))
      + `<h3>${t('earnedValueTitle')}</h3>` + earnedValueSummary(data.earnedValue) + '</section>'
      + table('deviations', ['reportArea', 'reportTotal', 'reportOpen', 'reportClosed', 'reportByStatus'],
        data.deviations.map(row => [esc(row.area), coreNumber(row.total, 'count'), coreNumber(row.open, 'count'), coreNumber(row.closed, 'count'),
          row.by_status.map(entry => `<span class="report-status">${esc(entry.status == null ? t('coreUnknown') : t(entry.status))}: ${coreNumber(entry.count, 'count')}</span>`).join(' ')]))
      + reconciliationReport(data.reconciliation);
    target.setAttribute('aria-busy', 'false');
    lastReport = data;
    for (const command of ['open-report', 'report-csv-progress', 'report-csv-deviations']) {
      const control = $('#main [data-command="' + command + '"]');
      if (control) control.disabled = false;
    }
    if (reportPrintIntent?.site === selected && reportPrintIntent?.user === user) {
      const intent = reportPrintIntent;
      await document.fonts?.ready;
      requestAnimationFrame(() => {
        if (!current() || reportPrintIntent !== intent) return;
        reportPrintIntent = null;
        window.print();
      });
    }
  } catch (error) {
    if (!current()) return;
    target.setAttribute('aria-busy', 'false');
    target.innerHTML = `<div role="alert"><p>${esc(errorMessage(error))}</p>${button('retry', 'report-retry')}</div>`;
  }
}

// Overview dashboard: counters plus three small charts, computed server-side per site and cached.
const overviewCache = new Map();
function earnedValueSummary(value) {
  if (!value?.available) return `<p class="note">${t('earnedValueNoHours')}</p>`;
  const plainHours = number => number == null ? t('coreUnknown') : formatDisplayNumber(number, { kind: 'hours', language });
  const amount = number => number == null ? t('coreUnknown') : `${coreNumber(number, 'hours')} h`;
  const maximum = Math.max(1, value.ev_hours ?? 0, value.pv_hours ?? 0, value.ac_hours ?? 0);
  const bar = (label, number, className) => {
    const width = Math.max(0, Math.min(100, ((number ?? 0) / maximum) * 100)).toFixed(1);
    return `<div class="earned-row"><span class="earned-label">${t(label)}</span><strong class="earned-value">${amount(number)}</strong><span class="earned-track" role="img" aria-label="${esc(t(label))}: ${esc(plainHours(number))} h"><span class="earned-fill ${className}" style="width:${width}%"></span></span></div>`;
  };
  const index = (label, number, hint, partial = false) => `<div class="earned-index${partial ? ' earned-index-partial' : ''}"><span>${t(label)}${partial ? ` <em class="earned-badge">${t('earnedValuePartialBadge')}</em>` : ''}</span><strong>${coreNumber(number)}</strong><small>${t(hint)}</small></div>`;
  const partial = value.ac_hours != null && value.ev_hours != null && Number(value.ac_hours) < Number(value.ev_hours);
  return `<p class="note earned-intro">${t('earnedValueIntro')}</p>`
    + `<div class="earned-bars">${bar('earnedValuePlanned', value.pv_hours, 'planned')}${bar('earnedValueProduced', value.ev_hours, 'produced')}${bar('earnedValueBooked', value.ac_hours, 'booked')}</div>`
    + (partial ? `<p class="note earned-caveat" role="note">${t('earnedValuePartial')}</p>` : '')
    + `<div class="earned-indices">${index('earnedValueEfficiency', value.cpi, 'earnedValueEfficiencyHint', partial)}${index('earnedValueSchedule', value.spi, 'earnedValueScheduleHint')}</div>`
    + (value.items_without_hours ? `<p class="note">${t('earnedValueMissingHours')}: ${coreNumber(value.items_without_hours, 'count')}</p>` : '')
    + `<details class="earned-help"><summary>${t('earnedValueHowTo')}</summary><p>${t('earnedValueFormula')}</p></details>`;
}
const STATUS_COLORS = { open: '#b96027', approved: '#3b69a0', in_progress: '#126c57',
  work_completed: '#6b8f86', closed: '#377348', rejected: '#a73c37' };
function donut(data, total) {
  const radius = 54, circumference = 2 * Math.PI * radius;
  let offset = 0;
  const arcs = data.filter(row => row.count > 0).map(row => {
    const fraction = total ? row.count / total : 0;
    const segment = `<circle r="${radius}" cx="70" cy="70" fill="transparent" stroke="${STATUS_COLORS[row.status] || '#94a3a3'}" stroke-width="18" stroke-dasharray="${(fraction * circumference).toFixed(2)} ${circumference.toFixed(2)}" stroke-dashoffset="${(-offset * circumference).toFixed(2)}" transform="rotate(-90 70 70)"></circle>`;
    offset += fraction;
    return segment;
  }).join('');
  return `<svg class="donut" viewBox="0 0 140 140" role="img" aria-label="${t('dashDeviations')}"><circle r="${radius}" cx="70" cy="70" fill="transparent" stroke="#edf1ef" stroke-width="18"></circle>${arcs}<text x="70" y="68" text-anchor="middle" class="donut-value">${total}</text></svg>`;
}
function sectionBars(rows) {
  const max = Math.max(1, ...rows.map(row => Math.max(row.actual ?? 0, row.planned ?? 0)));
  return `<ul class="mini-bars">${rows.map(row => `<li><span class="bar-label">${esc(row.section)}</span><span class="bar-track"><span class="bar-actual" style="width:${((row.actual ?? 0) / max * 100).toFixed(1)}%"></span>${row.planned == null ? '' : `<span class="bar-planned" style="left:${(row.planned / max * 100).toFixed(1)}%"></span>`}</span><span class="bar-value">${row.actual == null ? '—' : `${formatDisplayNumber(row.actual, { kind: 'percent', language })}%`}</span></li>`).join('')}</ul>`;
}
function renderOverviewWidgets(target, widgets, data, failed = false) {
  const content = localOverviewWidgets();
  const panel = (label, body) => `<section class="panel"><div class="panel-header"><h2>${t(label)}</h2></div><div class="panel-body">${body}</div></section>`;
  const unavailable = `<p class="note" role="status">${t(failed ? 'apiError' : 'loading')}</p>`;
  const kpis = {};
  let hoursDetail = '';
  if (data) {
    const total = data.deviations.reduce((sum, row) => sum + row.count, 0);
    kpis.kpi_open_deviations = data.deviations.filter(row => !['closed', 'rejected'].includes(row.status)).reduce((sum, row) => sum + row.count, 0);
    const number = value => formatDisplayNumber(value, { kind: 'hours', language });
    const coverage = data.hoursCoverage;
    const weeks = weeklyBookingHours(data.hours, data.workDays || []);
    const sixWeekHours = weeks.reduce((sum, row) => sum + Number(row.hoursExact ?? row.appBookedHours), 0);
    kpis.kpi_booked_hours = number(sixWeekHours) + ' h';
    const outsideWindow = coverage ? Math.max(0, coverage.appBookedHours - sixWeekHours) : null;
    const period = coverage?.bookedFrom && coverage?.bookedTo
      ? `${esc(dateLabel(coverage.bookedFrom))} – ${esc(dateLabel(coverage.bookedTo))}` : t('coreUnknown');
    const source = !coverage || !coverage.sourceWorkDays ? t('dashSourceAbsent')
      : `${t('dashSourceCoverage')}: ${coverage.sourceWorkDays} / ${coverage.workDays}. `
        + (coverage.sourceWorkTime == null ? `${t('dashSourcePartial')}: ${number(coverage.knownSourceWorkTime)} h`
          : `${t('coreSourceWorkTime')}: ${number(coverage.sourceWorkTime)} h`);
    hoursDetail = `<div class="dashboard-hours-detail"><p>${t('dashSixWeekWindow')}: ${weeks.length ? `${esc(dateLabel(weeks[0].week))} – ${esc(dateLabel(weeks.at(-1).week))}` : t('coreUnknown')}</p>
      <p>${t('dashAllBooked')}: <strong>${coverage ? number(coverage.appBookedHours) + ' h' : t('coreUnknown')}</strong> · ${period}</p>
      <p>${t('dashOutsideWindow')}: <strong>${coverage ? number(outsideWindow) + ' h' : t('coreUnknown')}</strong></p>
      <p>${source}</p></div>`;
    kpis.kpi_open_claims = money(data.claims.open);
    kpis.kpi_settled_claims = money(data.claims.settled);
    const maxHours = Math.max(1, ...weeks.map(row => row.appBookedHours));
    content.deviations_by_status = panel('dashDeviations', `<div class="dash-donut">${donut(data.deviations, total)}
      <ul class="donut-legend">${data.deviations.map(row => `<li><i style="background:${STATUS_COLORS[row.status] || '#94a3a3'}"></i>${esc(t(row.status))}<strong>${row.count}</strong></li>`).join('')}</ul></div>`);
    content.progress_by_section = panel('dashProgress', data.progress.length ? sectionBars(data.progress) : `<p class="note">${t('noResults')}</p>`);
    const weeklyChart = weeks.length ? `<ul class="mini-bars weekly-hours">${weeks.map(row => `<li><span class="bar-label">${esc(row.week)}</span><span class="bar-track"><span class="bar-actual" style="width:${(row.appBookedHours / maxHours * 100).toFixed(1)}%"></span></span><span class="bar-value"><span>${t('coreAppBookedHours')}: ${number(row.appBookedHours)}</span>${row.sourceWorkTime == null ? '' : `<span>${t('coreSourceWorkTime')}: ${number(row.sourceWorkTime)}</span>`}</span></li>`).join('')}</ul>` : `<p class="note">${t('noResults')}</p>`;
    content.hours_by_week = panel('dashHours', weeklyChart + hoursDetail);
    content.earned_value = panel('earnedValueTitle', earnedValueSummary(data.earnedValue)
      + `<p class="note">${t('dashEfficiencyCoverage')}</p><p class="note">${source}</p>`);
  }
  const chosen = widgets.map(id => DASHBOARD_WIDGETS.find(widget => widget.id === id));
  const cards = chosen.filter(widget => widget.kind === 'kpi').map(widget => {
    const claim = { kpi_open_claims: 'open', kpi_settled_claims: 'settled' }[widget.id];
    const coverage = data?.claims.coverage?.[claim];
    const detail = coverage ? `<small>${esc(t('dashClaimCoverage').replace('{known}', coverage.known).replace('{total}', coverage.total))}</small>` : '';
    return `<div class="kpi-card" data-widget="${widget.id}"><span>${t(widget.label)}</span><strong>${data ? esc(String(kpis[widget.id])) : esc(t(failed ? 'apiError' : 'loading'))}</strong>${widget.id === 'kpi_booked_hours' ? hoursDetail : detail}</div>`;
  }).join('');
  const panels = chosen.filter(widget => widget.kind === 'panel').map(widget => `<div data-widget="${widget.id}">${content[widget.id] || panel(widget.label, unavailable)}</div>`).join('');
  target.innerHTML = (cards ? `<div class="kpi-row">${cards}</div>` : '') + (panels ? `<div class="dash-grid">${panels}</div>` : '');
}

async function readOverviewLayout(selected) {
  try {
    const layout = await freshApi.dashboardLayout(selected);
    if (validDashboardWidgets(layout.widgets)) return layout;
  } catch { /* A layout failure must not prevent use of the overview. */ }
  return { ...defaultDashboardLayout(), fallback: true };
}

async function loadOverviewDashboard() {
  const target = $('#overview-widgets'), selected = siteId, user = session?.user.id;
  if (!target || !selected) return;
  const current = () => view === 'overview' && siteId === selected && session?.user.id === user && document.body.contains(target);
  // Fetch independently: local widgets and layout still work if the figures fail.
  const figures = (overviewCache.has(selected) ? Promise.resolve(overviewCache.get(selected))
    : freshApi.dashboard(selected)).catch(() => null);
  const layout = await readOverviewLayout(selected);
  if (!current()) return;
  renderOverviewWidgets(target, layout.widgets, null);
  const data = await figures;
  if (!current()) return;
  if (data) overviewCache.set(selected, data);
  renderOverviewWidgets(target, layout.widgets, data, !data);
  target.setAttribute('aria-busy', 'false');
}

async function showDashboardLayoutForm() {
  const selected = siteId, user = session?.user.id;
  showModal(t('layoutCustomize'), `<p role="status">${t('loading')}</p>`);
  const version = modalVersion;
  const layout = await readOverviewLayout(selected);
  if (version !== modalVersion || siteId !== selected || session?.user.id !== user || !$('#modal').open) return;
  // Hidden widgets remain in the editor and can be re-enabled without losing edits.
  const order = [...layout.widgets, ...DASHBOARD_WIDGETS.map(widget => widget.id).filter(id => !layout.widgets.includes(id))];
  showModal(t('layoutCustomize'), `<form id="dashboard-layout-form" data-site="${esc(selected)}" data-user="${esc(user)}">
    <div class="form-error" role="alert" tabindex="-1" hidden></div><p class="note">${t('layoutHint')}</p>
    ${layout.fallback ? `<p class="note" role="status">${t('layoutFallback')}</p>` : ''}
    <ol class="layout-widgets">${order.map(id => {
      const widget = DASHBOARD_WIDGETS.find(widget => widget.id === id);
      return `<li data-layout-widget="${id}"><label><input type="checkbox" value="${id}" ${layout.widgets.includes(id) ? 'checked' : ''}> ${t(widget.label)}</label>
        <div class="layout-arrows">${['up', 'down'].map(direction => `<button type="button" data-command="layout-move" data-direction="${direction}" aria-label="${t(direction === 'up' ? 'layoutMoveUp' : 'layoutMoveDown')}: ${esc(t(widget.label))}">${direction === 'up' ? '↑' : '↓'}</button>`).join('')}</div></li>`;
    }).join('')}</ol>
    <div class="form-actions layout-actions">${button('layoutReset', 'layout-reset')}${button('cancel', 'close-modal')}<button type="submit" class="primary">${t('save')}</button></div></form>`);
  updateLayoutArrows($('#dashboard-layout-form'));
}

function updateLayoutArrows(form) {
  const rows = [...form.querySelectorAll('[data-layout-widget]')];
  rows.forEach((row, index) => {
    row.querySelector('[data-direction=up]').disabled = index === 0;
    row.querySelector('[data-direction=down]').disabled = index === rows.length - 1;
  });
}
function moveLayoutWidget(control) {
  const form = control.closest('form'), row = control.closest('[data-layout-widget]');
  if (!form || form.dataset.saving) return;
  const sibling = control.dataset.direction === 'up' ? row.previousElementSibling : row.nextElementSibling;
  if (!sibling) return;
  if (control.dataset.direction === 'up') row.parentNode.insertBefore(row, sibling);
  else row.parentNode.insertBefore(sibling, row);
  updateLayoutArrows(form);
  row.querySelector('input').focus();
}
async function submitDashboardLayout(form, reset = false) {
  if (!form || form.dataset.saving || form.dataset.site !== siteId || form.dataset.user !== session?.user.id) return;
  const selected = siteId, user = session.user.id, version = modalVersion;
  const widgets = [...form.querySelectorAll('input:checked')].map(input => input.value);
  form.dataset.saving = 'true';
  const controls = form.querySelectorAll('input, button:not([data-command=close-modal])');
  controls.forEach(control => { control.disabled = true; });
  try {
    if (!reset && !validDashboardWidgets(widgets)) throw new Error('layoutInvalid');
    if (reset) await freshApi.deleteDashboardLayout(selected);
    else await freshApi.saveDashboardLayout(selected, widgets);
    if (session?.user.id !== user || siteId !== selected) return;
    overviewCache.delete(selected);
    if (version === modalVersion) closeModal();
    if (view === 'overview') renderOverview();
    toast(t(reset ? 'layoutResetDone' : 'layoutSaved'));
  } catch (error) {
    if (version === modalVersion && form.isConnected) formError(form, error);
  } finally {
    delete form.dataset.saving;
    controls.forEach(control => { control.disabled = false; });
    updateLayoutArrows(form);
  }
}
function renderSites() {
  $('#main').innerHTML = heading('sitesTitle', 'sitesSub', canCreateSite() ? button('newSite', 'new-site', '', 'primary') : '') + `<div class="site-grid">${state.sites.map(site => {
    const tasks = state.tasks.filter(task => task.siteId === site.id), count = counts(tasks);
    return `<article class="site-card ${site.id === siteId ? 'selected' : ''}"><span class="site-code">${esc(site.code)}</span><h2>${esc(site.name)}</h2><p>${esc(site.location || '—')}</p><div class="site-counts"><span><strong>${tasks.length}</strong>${t('tasks')}</span><span><strong>${tasks.length - count.closed}</strong>${t('nonClosed')}</span></div>
      <div class="progress-track" aria-hidden="true"><span style="width:${tasks.length ? count.closed / tasks.length * 100 : 0}%"></span></div><p>${site.start ? dateLabel(site.start) : '—'} → ${site.end ? dateLabel(site.end) : '—'}</p>${button(site.id === siteId ? 'selected' : 'openSite', 'select-site', `data-id="${esc(site.id)}"`, site.id === siteId ? 'small' : 'primary small')}</article>`;
  }).join('')}</div>`;
  if (siteId && !offline && moduleVisible('tasks') && moduleVisible('deviations')) {
    $('#main').insertAdjacentHTML('beforeend', `<section class="panel"><div class="panel-body"><h2>${t('evidenceExport')}</h2>
      <p>${t('evidenceChecksumHint')}</p>${button('evidenceExport', 'evidence-export')}</div></section>`);
  }
  if (role() === 'owner' && siteId) {
    const modules = [...navGroups(ownerModules).flatMap(group => group.items), 'workforce_names'];
    const members = state.memberAccess?.[siteId]?.members || [];
    $('#main').insertAdjacentHTML('beforeend', `<section class="panel module-access"><div class="panel-body"><h2>${t('moduleAccess')}</h2><p>${t('moduleAccessHint')}</p><div class="table-scroll"><table><thead><tr><th scope="col">${t('accessMember')}</th>${modules.map(module => `<th scope="col">${t(module)}</th>`).join('')}</tr></thead><tbody>${members.map(member => `<tr><th scope="row">${esc(member.name)}<br><small>${esc(member.email)} · ${esc(member.role === 'owner' ? t('accessOwner') : member.role)}</small></th>${modules.map(module => {
      const locked = member.role === 'owner' || ['sites', 'overview'].includes(module);
      return `<td><input type="checkbox" data-member-access data-site="${esc(siteId)}" data-member="${esc(member.user_id)}" data-module="${module}" aria-label="${esc(member.name)} · ${t(module)}" ${locked || visibleModules([module], member.modules).length ? 'checked' : ''} ${locked || offline ? 'disabled' : ''}></td>`;
    }).join('')}</tr>`).join('')}</tbody></table></div></div></section>`);
  }
}
function filteredTasks() {
  const needle = filters.search.trim().toLocaleLowerCase();
  return siteTasks().filter(task => (!filters.id || task.id === filters.id)
    && (!filters.closable || canCloseTodayTask(task))
    && (!filters.wbsId || task.wbsId === filters.wbsId)
    && (!filters.openVerification || task.status === 'to_verify')
    && (!filters.waiver || task.closed_with_waiver)
    && (!filters.status || task.status === filters.status) && (!filters.person || task.assignee === filters.person)
    && (!filters.priority || task.priority === filters.priority)
    && (!filters.kind || (task.kind ?? 'ordinary') === filters.kind)
    && (!needle || `${task.title} ${task.area} ${task.company}`.toLocaleLowerCase().includes(needle)));
}
const currentViewState = () => viewStatePayload({ filters, sort: taskSort, columns: taskColumns, layout: taskView });
const selectedSavedView = () => savedViewsCache?.data?.find(item => item.id === selectedViewId);
const canCreateView = () => ['owner', 'editor', 'verifier'].includes(role());
const canWriteTask = () => ['owner', 'editor', 'verifier'].includes(role());
const canEditTask = () => canWriteTask() && ['owner', 'editor'].includes(role()) && moduleVisible('tasks');
const canAttachDiary = () => ['owner', 'editor'].includes(role()) && moduleVisible('diary');
const canTransitionTask = () => canWriteTask() && moduleVisible('tasks');
const savingTaskTransitions = new Set();
function canReviewTask(task) {
  if (!canTransitionTask() || (role() !== 'owner' && task.verifier_id !== session?.user.id)) return false;
  const submitter = task.submitted_by_id ?? task.submitted_by;
  return Boolean(submitter) && submitter !== (task.submitted_by_id ? session?.user.id : actor);
}
function taskTransitions(task) {
  if (!task || !canTransitionTask() || pendingOps.some(op => op.entity_id === task.id
    && (op.op_type === 'transition_task' || op.status === 'failed'))) return [];
  return allowedTransitions(task).filter(to => {
    if (task.status === 'to_verify' && (to === 'closed' || to === 'in_progress')) return canReviewTask(task);
    return task.status !== 'closed' || role() === 'owner' || task.verifier_id === session?.user.id;
  });
}
function taskTransitionLabel(task, to) {
  if (task.status === 'blocked') return t('taskResume');
  if (task.status === 'to_verify' && to === 'in_progress') return t('taskReject');
  if (to === 'closed') return t('taskVerify');
  return `${t('transitionTo')} ${t(to)}`;
}
function taskActionButton(id, to, label, { primary = false, resume = false, todayReview = false } = {}) {
  const origin = todayReview ? ' data-today-review="true"' : resume ? ' data-task-detail="true"' : '';
  const busy = savingTaskTransitions.has(id) ? ' disabled aria-busy="true"' : '';
  return `<button type="button" class="${primary ? 'notebook-primary' : 'notebook-outline'}" data-command="${resume ? 'status-transition' : 'transition'}" data-id="${esc(id)}" data-to="${to}"${origin}${busy}>${esc(label)}</button>`;
}
const canCreateSite = () => role() === 'owner';
const canEditView = item => Boolean(item && session && (item.owner_id === session.user.id || role() === 'owner'));
function applyViewState(payload) {
  const next = sanitizeViewState(payload);
  filters = next.filters; taskSort = next.sort; taskColumns = next.columns; taskView = next.layout;
}
function resetSavedViews() {
  savedViewsCache = null; selectedViewId = ''; applyViewState(defaultViewState());
}
function loadSavedViews() {
  if (savedViewsCache || !siteId || !session) return;
  const selected = siteId, user = session.user.id;
  const cache = savedViewsCache = { data: [], pending: true, error: null, saving: false };
  freshApi.listViews(selected, 'tasks').then(data => { cache.data = data; }, error => { cache.error = error; }).finally(() => {
    cache.pending = false;
    if (savedViewsCache === cache && siteId === selected && session?.user.id === user && view === 'tasks') renderSavedViews();
  });
}
function renderViewDirty() {
  const target = $('#saved-view-dirty'), selected = selectedSavedView();
  if (target) target.textContent = selected && JSON.stringify(currentViewState()) !== JSON.stringify(viewStatePayload(selected.payload)) ? t('viewModified') : '';
}
function renderSavedViews() {
  const target = $('#saved-views');
  if (!target) return;
  const cache = savedViewsCache, selected = selectedSavedView();
  const disabled = cache?.pending || cache?.saving ? 'disabled' : '';
  const views = [...(cache?.data || [])].sort((a, b) => a.name.localeCompare(b.name, language) || a.id.localeCompare(b.id));
  target.innerHTML = `<label class="field saved-view-select"><span>${t('viewSelector')}</span><select id="saved-view-select" ${disabled}><option value="">${t('viewNone')}</option>${views.map(item => `<option value="${esc(item.id)}" ${item.id === selectedViewId ? 'selected' : ''}>${esc(item.name)}${item.shared ? ` · ${t('viewShared')}` : ''}</option>`).join('')}</select></label>
    <div class="saved-view-actions">${canCreateView() ? button('viewSaveAs', 'view-create', disabled) : ''}${canEditView(selected) ? button('viewUpdate', 'view-update', disabled) + button('viewRename', 'view-rename', disabled) + button('viewDelete', 'view-delete', disabled) : ''}</div>
    <span id="saved-view-dirty" class="note" role="status"></span>${selected && !canEditView(selected) ? `<span class="note">${t('viewReadOnly')}</span>` : ''}
    ${cache?.pending ? `<span class="note" role="status">${t('loading')}</span>` : ''}${cache?.error ? `<div class="saved-view-error" role="alert">${esc(errorMessage(cache.error))} ${button('retry', 'views-retry')}</div>` : ''}`;
  renderViewDirty();
}
function taskListControls() {
  return `<div class="toolbar task-list-controls"><label class="field"><span>${t('viewSortKey')}</span><select id="task-sort-key">${TASK_COLUMNS.map(key => `<option value="${key}" ${taskSort.key === key ? 'selected' : ''}>${t(key)}</option>`).join('')}</select></label>
    <label class="field"><span>${t('viewSortDirection')}</span><select id="task-sort-direction">${['asc', 'desc'].map(direction => `<option value="${direction}" ${taskSort.direction === direction ? 'selected' : ''}>${t(direction === 'asc' ? 'viewAscending' : 'viewDescending')}</option>`).join('')}</select></label>
    <fieldset class="task-column-options"><legend>${t('viewColumns')}</legend>${TASK_COLUMNS.map(key => `<label class="view-checkbox"><input type="checkbox" data-task-column="${key}" ${taskColumns.includes(key) ? 'checked' : ''} ${taskColumns.length === 1 && taskColumns.includes(key) ? 'disabled' : ''}>${t(key)}</label>`).join('')}</fieldset></div>`;
}
function showSavedViewForm(action) {
  const item = selectedSavedView();
  if (savedViewsCache?.saving || (action === 'create' ? !canCreateView() : !canEditView(item))) return;
  const title = { create: 'viewSaveAs', rename: 'viewRename', delete: 'viewDelete' }[action];
  showModal(t(title), `<form id="saved-view-form" data-action="${action}" data-id="${esc(item?.id || '')}"><div class="form-error" role="alert" tabindex="-1" hidden></div>
    ${action === 'delete' ? `<p>${t('viewDeleteConfirm')}</p><p class="prewrap">${esc(item.name)}</p>` : field('viewName', 'name', action === 'rename' ? item.name : '', { required: true, max: 80 })}
    ${action === 'create' ? `<label class="view-checkbox saved-view-sharing"><input type="checkbox" name="shared">${t('viewShareWithSite')}</label>` : ''}
    <div class="form-actions">${button('cancel', 'close-modal')}<button type="submit" class="${action === 'delete' ? 'danger' : 'primary'}">${t(action === 'delete' ? 'viewDelete' : 'save')}</button></div></form>`);
}
async function saveViewChange(action, { id = selectedViewId, name, shared = false } = {}) {
  const cache = savedViewsCache, selected = siteId, user = session?.user.id;
  if (!cache || cache.saving) return;
  const item = cache.data.find(row => row.id === id);
  if (action === 'create' ? !canCreateView() : !canEditView(item)) throw new Error('forbidden');
  if (['create', 'rename'].includes(action) && !name?.trim()) throw new Error('viewInvalid');
  cache.saving = true; renderSavedViews();
  try {
    const result = action === 'create' ? await api.createView({ site_id: selected, module: 'tasks', name: name.trim(), shared, payload: currentViewState() })
      : action === 'delete' ? await api.deleteView(id)
        : await api.updateView(id, action === 'rename' ? { name: name.trim() } : { payload: currentViewState() });
    // Ignore responses from a previous site/session, including a switch away and back.
    if (savedViewsCache !== cache || siteId !== selected || session?.user.id !== user) return;
    if (action === 'delete') {
      cache.data = cache.data.filter(row => row.id !== id);
      if (selectedViewId === id) selectedViewId = '';
    } else {
      cache.data = [...cache.data.filter(row => row.id !== result.id), result];
      if (action === 'create') selectedViewId = result.id;
    }
    toast(t(action === 'delete' ? 'viewDeleted' : 'viewSaved'));
  } finally {
    cache.saving = false;
    if (savedViewsCache === cache && view === 'tasks') renderSavedViews();
  }
}
async function updateSelectedView() {
  try { await saveViewChange('update'); } catch (error) { toast(errorMessage(error)); }
}
function renderTasks() {
  loadSavedViews();
  $('#main').innerHTML = `<div class="notebook notebook-records">
    <header class="notebook-page-head">
      <div><h1>${t('tasksTitle')}</h1><p id="task-summary" class="notebook-meta num" role="status"></p></div>
      ${canWriteTask() ? `<div class="notebook-actions">${button('newTask', 'new-task', '', 'notebook-primary')}</div>` : ''}
    </header>
    <div class="notebook-tools">
      <div class="toolbar">
        <input class="search" id="filter-search" maxlength="512" aria-label="${t('search')}" placeholder="${t('search')}" value="${esc(filters.search)}">
        <select id="filter-status" aria-label="${t('status')}"><option value="">${t('allStatuses')}</option>${STATUSES.map(status => `<option value="${status}" ${filters.status === status ? 'selected' : ''}>${t(status)}</option>`).join('')}</select>
        <select id="filter-person" aria-label="${t('assignee')}"><option value="">${t('allPeople')}</option>${[...new Set([...siteTasks().map(task => task.assignee), ...(filters.person ? [filters.person] : [])])].map(person => `<option value="${esc(person)}" ${filters.person === person ? 'selected' : ''}>${personName(person)}</option>`).join('')}</select>
        <select id="filter-priority" aria-label="${t('priority')}"><option value="">${t('allPriorities')}</option>${PRIORITIES.map(priority => `<option value="${priority}" ${filters.priority === priority ? 'selected' : ''}>${t(priority)}</option>`).join('')}</select>
        <select id="filter-kind" aria-label="${t('kind')}"><option value="">${t('allKinds')}</option>${TASK_KINDS.map(kind => `<option value="${kind}" ${filters.kind === kind ? 'selected' : ''}>${t(taskKindLabelKey(kind))}</option>`).join('')}</select>
        <div class="view-toggle">${['board', 'list', 'light'].map(value => button(value, 'task-view', `data-value="${value}" aria-pressed="${taskView === value}"`)).join('')}</div>
      </div>
      <div id="saved-views" class="toolbar saved-views"></div>
      ${taskView === 'list' ? taskListControls() : ''}
      <div class="notebook-actions">
        ${button('exportCsv', 'csv')}
        ${button(`${t('evidenceWaiverView')} (${siteTasks().filter(task => task.closed_with_waiver).length})`, 'task-waiver-view', `aria-pressed="${Boolean(filters.waiver)}"`, 'num')}
      </div>
    </div>
    <div id="task-results"></div>
  </div>`;
  renderSavedViews(); renderTaskResults();
}
function taskCard(task, progressWarnings = '') {
  const transitions = taskTransitions(task);
  // The card is a wrapper because a status menu cannot be nested inside the detail button.
  const menu = transitions.length
    ? `<button type="button" class="task-card-menu" data-command="task-status-menu" data-id="${esc(task.id)}" aria-label="${t('changeStatus')}" title="${t('changeStatus')}">⋯</button>`
    : '';
  const context = [task.company, taskWbsText(task), task.assignee || '—'].filter(Boolean);
  return `<div class="task-card">${menu}
    <button type="button" class="task-card-main" data-command="detail" data-id="${esc(task.id)}">
      <span class="notebook-meta">${esc(task.area || t('noArea'))}</span>
      <span class="notebook-card-title">${esc(task.title)}</span>
      <span class="notebook-meta">${esc(context.join(' · '))}</span>
      <span class="notebook-card-meta">${task.kind === 'corrective' ? `<span class="notebook-meta">${t('kindCorrective')}</span>` : ''}${notebookPriority(task.priority)}${notebookSync(task)}</span>
      <span class="card-footer">${notebookState(task.status)}${notebookDue(task)}<span aria-hidden="true">→</span></span>
    </button>${progressWarnings}</div>`;
}
const lightTransitions = new Set();
function canRunLightTransition(task) {
  const to = task?.status === 'closed' ? 'todo' : 'closed';
  return Boolean(task?.kind === 'ordinary' && taskTransitions(task).includes(to) && !lightTransitions.has(task.id));
}
function lightTaskButton(task) {
  if (!canTransitionTask()) return '—';
  const key = task.status === 'closed' ? 'lightReopen' : 'lightClose';
  return button(key, 'light-transition', `data-id="${esc(task.id)}" ${canRunLightTransition(task) ? '' : `disabled title="${esc(t('noTransitions'))}"`}`, 'mobile-card-action');
}
async function runLightTransition(taskId) {
  const task = state.tasks.find(item => item.id === taskId);
  if (!canRunLightTransition(task)) return;
  const to = task.status === 'closed' ? 'todo' : 'closed';
  if (transitionNeedsDialog(transitionRequirements(task, to))) {
    showTransition(taskId, to); return;
  }
  lightTransitions.add(taskId); renderTaskResults();
  try {
    const input = transitionPayload(task, { to, actor });
    await writeOperation('transition_task', { task, input }, task.id);
    toast(t('actionSaved'));
  } catch (error) { toast(errorMessage(error)); }
  finally {
    lightTransitions.delete(taskId);
    if (view === 'tasks') renderTaskResults();
  }
}
function renderTaskResults() {
  const filtered = filteredTasks();
  const tasks = taskView === 'light' ? lightTaskRows(filtered) : filtered;
  const verificationWbs = new Set(tasks.filter(task => task.status === 'to_verify' && task.wbsId).map(task => task.wbsId));
  const warnings = new Map();
  if (verificationWbs.size && moduleVisible('progress')) {
    const progress = offline ? todayResource('progress') : coreResource('progress').data ?? [];
    for (const item of progress) {
      if (item.siteId !== siteId || !verificationWbs.has(item.wbsId) || item.verificationConflict !== true) continue;
      const label = offline ? esc(progressLabel(item)) : coreDetailButton('progress', item);
      warnings.set(item.wbsId, (warnings.get(item.wbsId) ?? '') + `<div class="task-progress-conflict">${label}${progressVerificationWarning(item, false)}</div>`);
    }
  }
  const taskWarning = task => task.status === 'to_verify' ? warnings.get(task.wbsId) ?? '' : '';
  const active = [
    filters.search?.trim(),
    filters.person,
    filters.priority && t(filters.priority),
    filters.kind && t(taskKindLabelKey(filters.kind)),
    filters.waiver && t('evidenceWaiverView'),
  ].filter(Boolean).map(esc);
  const scope = filters.openVerification ? 'progressVerificationFilter' : filters.id || filters.closable ? 'todayFiltered' : '';
  if (scope) active.push(t(scope));
  $('#task-summary').innerHTML = [
    notebookState(filters.status),
    ...active,
    notebookCount(tasks.length, 'resultCountOne', 'resultCount'),
    `<strong class="num">${siteTasks().length - counts(siteTasks()).closed}</strong> ${t('nonClosed')}`,
  ].filter(Boolean).join(' · ');
  let html = '';
  if (!tasks.length) html += `<section class="panel">${empty(taskView === 'light' ? 'lightEmpty' : 'noResults', 'noResultsHint', button('clearFilters', 'clear-filters'))}</section>`;
  else if (taskView === 'board') {
    const columns = STATUSES.map(status => ({ status, column: tasks.filter(task => task.status === status) }));
    const card = task => taskCard(task, taskWarning(task));
    // On a phone the columns would need horizontal panning: one status open at a time, by thumb.
    html += compactNavigation()
      ? `<div class="board-accordion">${columns.map(({ status, column }, index) => `<details class="board-status" ${index === 0 ? 'open' : ''}>
          <summary class="notebook-section-head">${notebookBoardHead(notebookState(status), column.length)}</summary>
          ${column.length ? column.map(card).join('') : `<div class="mini-empty">${t('emptyColumn')}</div>`}</details>`).join('')}</div>`
      : `<div class="board">${columns.map(({ status, column }) => `<section class="board-column" aria-labelledby="task-column-${status}"><h2 class="notebook-section-head" id="task-column-${status}">${notebookBoardHead(notebookState(status), column.length)}</h2>${column.length ? column.map(card).join('') : `<div class="mini-empty">${t('emptyColumn')}</div>`}</section>`).join('')}</div>`;
  }
  else if (taskView === 'light') {
    html += `<div class="table-scroll mobile-card-wrap"><table class="mobile-card-table"><thead><tr>${['title', 'area', 'assignee', 'due', 'status', 'lightAction'].map(key => `<th scope="col">${t(key)}</th>`).join('')}</tr></thead>
      <tbody>${tasks.map(task => `<tr>
        <td data-label="${t('title')}"><div><button type="button" data-command="detail" data-id="${esc(task.id)}">${esc(task.title)}</button>${taskWarning(task)}</div></td>
        <td data-label="${t('area')}">${esc(task.area || '—')}</td><td data-label="${t('assignee')}">${personName(task.assignee)}</td>
        <td data-label="${t('due')}">${notebookDue(task)}</td><td data-label="${t('status')}"><span>${notebookState(task.status)} ${notebookSync(task)}</span></td>
        <td data-label="${t('lightAction')}" class="mobile-card-actions">${lightTaskButton(task)}</td>
      </tr>`).join('')}</tbody></table></div>`;
  }
  else {
    const sorted = filterSortRecords(tasks, {}, [{ key: taskSort.key, descending: taskSort.direction === 'desc' }]);
    const cell = (task, key) => key === 'status' ? `${notebookState(task.status)} ${notebookSync(task)}` : key === 'due' ? notebookDue(task)
      : ['assignee', 'reviewer'].includes(key) ? personName(task[key]) : esc(task[key] || '—') + (key === 'title' ? `<br><small class="notebook-meta">${esc(taskWbsText(task))}</small>` : '');
    html += `<div class="table-scroll"><table><thead><tr>${taskColumns.map(key => `<th scope="col" ${key === taskSort.key ? `aria-sort="${taskSort.direction === 'asc' ? 'ascending' : 'descending'}"` : ''}>${t(key)}</th>`).join('')}</tr></thead><tbody>${sorted.map(task => `<tr>${taskColumns.map((key, index) => `<td>${index === 0 ? `<button data-command="detail" data-id="${esc(task.id)}" aria-label="${esc(task.title)}">${cell(task, key)}</button>${taskWarning(task)}` : cell(task, key)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  }
  if (scope) html = `<div class="notebook-actions">${button('clearFilters', 'clear-filters')}</div>` + html;
  renderViewDirty();
  $('#task-results').innerHTML = html;
}
const diaryContentFields = { plan: 'plan', actual: 'actual', blockers: 'impediments', next: 'next_step' };
function diaryDayAge(day) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timeZoneForSite(currentSite()), year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const { year, month, day: localDay } = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return (Date.parse(`${year}-${month}-${localDay}`) - Date.parse(day)) / 86_400_000;
}
const canCorrectDiary = entry => !offline && !entry.syncStatus && moduleVisible('diary') &&
  (role() === 'owner' || (role() === 'editor' && entry.date === operationalDay().date));
const diaryTimestamp = (instant, entry) => new Intl.DateTimeFormat(language === 'it' ? 'it-IT' : 'en-GB', {
  dateStyle: 'medium', timeStyle: 'short', timeZone: entry.time_zone || timeZoneForSite(currentSite()),
}).format(new Date(instant));

function renderDiary() {
  const recordedAt = entry => {
    const timestamp = Date.parse(entry.createdAt);
    return Number.isFinite(timestamp) ? timestamp : Infinity;
  };
  const entries = state.diary.filter(item => item.siteId === siteId && item.date === reportDate)
    .sort((a, b) => recordedAt(a) - recordedAt(b) || String(a.id).localeCompare(String(b.id)));
  const shifts = [...new Set(entries.map(entry => entry.shift).filter(shift => ['day', 'night'].includes(shift)))];
  const filesByEntry = new Map(entries.map(entry => [entry.id, []]));
  for (const file of state.attachments || []) {
    if (file.entity_type === 'diary') filesByEntry.get(file.entity_id)?.push(file);
  }
  const fileCount = [...filesByEntry.values()].reduce((total, files) => total + files.length, 0);
  const current = operationalDay();
  const availableShifts = ['day', 'night'].filter(shift => !shifts.includes(shift));
  const shownShifts = shifts.length || current.date !== reportDate ? shifts : [current.shift];
  const age = diaryDayAge(reportDate);
  const canWrite = canWriteTask() && availableShifts.length > 0 && age >= 0 && (age <= 7 || role() === 'owner');
  const canAttach = canAttachDiary();
  const count = (number, single, multiple) => `<span class="num">${number} ${t(number === 1 ? single : multiple)}</span>`;
  $('#main').innerHTML = `<div class="notebook diary-notebook">
    <header class="notebook-page-head">
      <div><h1>${t('diaryTitle')}</h1><div class="notebook-meta diary-summary">
        <time datetime="${esc(reportDate)}" class="num">${esc(dateLabel(reportDate))}</time>
        ${shownShifts.map(shift => `<span>${t(shift)}</span>`).join('')}
        ${count(entries.length, 'entriesOne', 'entries')}
        ${count(fileCount, 'diaryAttachmentOne', 'attachments')}
      </div></div>
      <div class="notebook-actions">
        ${button('print', 'print')}
        ${canWrite ? `<button type="button" class="notebook-primary" data-command="new-entry" data-shift="${availableShifts.length === 1 ? availableShifts[0] : ''}">${t('diaryCloseShift')}<span aria-hidden="true">→</span></button>` : ''}
      </div>
    </header>
    <div class="diary-toolbar"><label for="report-date">${t('reportDate')}</label>
      <div class="field">${dateInput('report-date', reportDate, 'required')}</div>
    </div>
    <section aria-labelledby="diary-register">
      <div class="notebook-section-head"><h2 id="diary-register">${t('diaryRegister')}</h2></div>
      ${entries.length ? `<ol>${entries.map(entry => {
        const files = filesByEntry.get(entry.id);
        const clock = notebookTime(entry.createdAt, entry.time_zone);
        return `<li class="diary-entry">
          <span class="diary-entry-time">${clock || '<span aria-hidden="true">—</span>'}</span>
          <div class="diary-entry-context">${t(entry.shift)}${entry.syncStatus ? `<span class="notebook-meta sync-${esc(entry.syncStatus)}">${t(entry.syncStatus === 'failed' ? 'syncFailed' : 'syncPending')}</span>` : ''}</div>
          <div class="diary-entry-text">
            ${entry.recorded_late ? `<p class="notebook-meta">${esc(t('diaryRecordedLate').replace('{date}', diaryTimestamp(entry.createdAt, entry)))}</p>` : ''}
            ${entry.updated_at ? `<p class="notebook-meta">${esc(t('diaryCorrected').replace('{date}', diaryTimestamp(entry.updated_at, entry))
              .replace('{author}', () => entry.updated_by_name || entry.updated_by))}</p>` : ''}
            ${['plan', 'actual', 'blockers', 'next'].filter(key => entry[key]).map(key =>
              `<section><h3>${t(key)}</h3><p class="prewrap">${esc(entry[key])}</p></section>`).join('')}
            ${canCorrectDiary(entry) ? button('diaryCorrect', 'diary-correct', `data-id="${esc(entry.id)}"`) : ''}
            ${entry.updated_at && !offline ? button('diaryVersions', 'diary-versions', `data-id="${esc(entry.id)}"`) : ''}
            ${files.length || canAttach ? `<div class="diary-attachments">${files.map(diaryAttachment).join('')}
              ${canAttach ? button('addAttachment', 'new-attachment', `data-entity-type="diary" data-id="${esc(entry.id)}"`) : ''}</div>` : ''}
          </div>
        </li>`;
      }).join('')}</ol>` : `<div class="diary-empty"><strong>${t('diaryEmpty')}</strong>${canWrite ? `<p class="notebook-meta">${t('diaryEmptyHint')}</p>` : ''}</div>`}
    </section>
    <details class="diary-rule"><summary>${t('dayRule')}</summary>
      <p class="notebook-meta">${t('dayRuleNote')}</p><p class="notebook-meta">${t('diaryLimit')}</p>
    </details>
  </div>`;
}
function diaryAttachment(file) {
  const image = file.mime?.startsWith('image/') || file.blob?.type?.startsWith('image/');
  const preview = image && !offline && !file.blob
    ? `<img src="${esc(attachmentUrl(file))}" alt="" width="30" height="30" loading="lazy">` : '';
  const bytes = file.size ?? file.blob?.size;
  const unit = bytes >= 1048576 ? 'MiB' : bytes >= 1024 ? 'KiB' : 'B';
  const divisor = { B: 1, KiB: 1024, MiB: 1048576 }[unit];
  const size = bytes == null ? '' : `${formatDisplayNumber(bytes / divisor, { language })} ${unit}`;
  const sync = file.syncStatus && t(file.syncStatus === 'failed' ? 'syncFailed' : 'syncPending');
  return `<button type="button" class="diary-file" data-command="open-attachment" data-id="${esc(file.id)}">
    <span class="diary-file-preview" aria-hidden="true">${icon(image ? 'photo' : 'document')}${preview}</span>
    <span><strong>${esc(file.filename)}</strong>
      ${size || sync ? `<small class="num">${esc([size, sync].filter(Boolean).join(' · '))}</small>` : ''}</span>
  </button>`;
}
async function loadWbs() {
  const selected = siteId, scope = offlineScope, token = {};
  wbsLoad = token;
  token.promise = (async () => {
  try {
    let nodes;
    try {
      nodes = await api.listWbs(selected);
      if (storageReady) await setMirror(`wbs:${scope}:${selected}`, nodes);
    } catch (error) {
      nodes = storageReady && error.code === 'NETWORK_ERROR' ? await getMirror(`wbs:${scope}:${selected}`) : undefined;
      if (!nodes) throw error;
    }
    if (wbsLoad === token) wbsCache.set(selected, { nodes });
  } catch (error) {
    if (wbsLoad === token) wbsCache.set(selected, { error });
  } finally {
    if (wbsLoad === token) {
      wbsLoad = null;
      if (view === 'wbs' && siteId === selected) render();
    }
  }
  })();
  return token.promise;
}
const canWriteWbs = () => ['owner', 'editor'].includes(role()) && moduleVisible('wbs') && !offline;
function wbsState(node) {
  return `${node.archived_at ? ` <span class="badge">${t('wbsArchived')}</span>` : ''}${node.missing_from_source ? ` <span class="badge">${t('wbsMissing')}</span>` : ''}${Object.keys(node.conflicts || {}).length ? ` <span class="badge">${t('wbsConflict')}</span>` : ''}`;
}
function wbsNodeControl(node) {
  return button(canWriteWbs() ? 'edit' : 'details', 'wbs-edit', `data-id="${esc(node.id)}"`, 'small');
}
async function showWbsForm(id = '') {
  const selected = siteId, user = session?.user.id;
  showModal(t(id ? 'wbsEdit' : 'wbsCreate'), `<p role="status">${t('loading')}</p>`);
  const version = modalVersion;
  try {
    const nodes = await freshApi.listWbs(selected, true), node = nodes.find(row => row.id === id);
    if (version !== modalVersion || selected !== siteId || user !== session?.user.id) return;
    const editable = canWriteWbs(), value = node || {};
    const origin = node?.is_synthetic ? 'synthetic' : node?.provenance?.origin;
    const originLabel = { source: 'wbsImported', native: 'wbsNative', synthetic: 'wbsSyntheticOrigin' }[origin] || 'coreUnknown';
    const source = origin === 'source' ? node.source_values : null;
    const descendants = new Set(id ? [id] : []);
    for (let n = 0; n < nodes.length; n++) for (const row of nodes) if (descendants.has(row.parent_id)) descendants.add(row.id);
    const parentOptions = `<option value="">${t('wbsNoParent')}</option>` + nodes.filter(row => !descendants.has(row.id)).map(row => `<option value="${esc(row.id)}" ${row.id === value.parent_id ? 'selected' : ''}>${esc(row.wbs_code)} · ${esc(row.description ?? '')}</option>`).join('');
    const sourceRows = source ? ['wbs_code', 'description', 'parent_id', 'sort_order', 'planned_start', 'planned_finish'].map(key => {
      const label = ({ wbs_code: 'wbsCode', description: 'wbsDescription', parent_id: 'wbsParent', sort_order: 'wbsOrder', planned_start: 'wbsPlannedStart', planned_finish: 'wbsPlannedFinish' })[key];
      const text = key === 'parent_id' ? nodes.find(row => row.id === source[key])?.wbs_code : source[key];
      return `<div><dt>${t(label)}</dt><dd>${esc(text ?? '—')}</dd></div>`;
    }).join('') : '';
    const resolutions = ['description', 'parent_id', 'sort_order'].filter(key => Object.hasOwn(node?.local_overrides || {}, key)).map(key =>
      field(({ description: 'wbsDescription', parent_id: 'wbsParent', sort_order: 'wbsOrder' })[key], `resolve_${key}`, '', { options: `<option value="">${t('wbsLeaveLocal')}</option><option value="source">${t(source ? 'wbsUseSource' : 'wbsUseInitial')}</option><option value="keep">${t('wbsKeepLocal')}</option>` })).join('');
    showModal(t(id ? 'wbsEdit' : 'wbsCreate'), `<form id="wbs-form" data-id="${esc(id)}" data-site="${esc(selected)}" data-user="${esc(user)}"><div class="form-error" role="alert" tabindex="-1" hidden></div>
      ${Object.keys(node?.conflicts || {}).length ? `<p role="alert" class="note">${t('wbsConflictHint')}</p>` : ''}
      ${node ? `<p>${t('wbsOrigin')}: ${t(originLabel)}${wbsState(node)}</p><p>${t('wbsUpdated')}: ${esc(node.provenance?.updated_at ?? node.created_at)} UTC</p>` : ''}
      ${source ? `<details><summary>${t('wbsSource')}</summary><dl class="detail-grid" data-wbs-source>${sourceRows}</dl></details>` : ''}
      <fieldset ${editable ? '' : 'disabled'}><legend>${t('wbsLocal')}</legend><div class="form-grid">
      ${!id ? field('wbsCode', 'wbs_code', '', { required: true, max: 100 }) : ''}${field('wbsDescription', 'description', value.description ?? '')}${field('wbsParent', 'parent_id', '', { options: parentOptions })}${field('wbsOrder', 'sort_order', value.sort_order ?? '', { type: 'number' })}${resolutions}</div>
      ${id ? `<label class="view-checkbox"><input type="checkbox" name="archived" ${value.archived_at ? 'checked' : ''}>${t('wbsArchive')}</label>` : ''}</fieldset>
      ${editable ? formActions() : button('cancel', 'close-modal')}</form>`);
    $('#wbs-form').wbsOriginal = node;
  } catch (error) { if (version === modalVersion) showModal(t('wbs'), `<p role="alert">${esc(errorMessage(error))}</p>`); }
}
async function submitWbs(form, data) {
  if (form.dataset.site !== siteId || form.dataset.user !== session?.user.id || !canWriteWbs()) throw new Error('forbidden');
  const node = form.wbsOriginal, values = { description: data.description || null, parent_id: data.parent_id || null, sort_order: data.sort_order === '' ? null : Number(data.sort_order) };
  const input = {};
  for (const [key, value] of Object.entries(values)) if (!node || value !== node[key]) input[key] = value;
  if (node) {
    input.archived = data.archived === 'on';
    input.reset_fields = Object.keys(values).filter(key => data[`resolve_${key}`] === 'source');
    input.keep_fields = Object.keys(values).filter(key => data[`resolve_${key}`] === 'keep');
    await api.updateWbs(node.id, input);
  } else await api.createWbs({ ...input, site_id: siteId, wbs_code: data.wbs_code });
  wbsCache.delete(siteId); coreCache.delete(siteId);
  await loadData();
  closeModal(); render();
}
const taskWbsText = task => task.wbsId ? [task.wbsCode, task.wbsDescription].filter(Boolean).join(' · ') || t('poWbsUnavailable') : t('wbsUnassigned');
async function taskWbsOptions(selected, selectedId = '') {
  const nodes = await freshApi.listWbs(selected, true);
  return `<option value="">${t('wbsUnassigned')}</option>` + nodes.filter(node => !node.archived_at || node.id === selectedId).map(node => `<option value="${esc(node.id)}" ${node.id === selectedId ? 'selected' : ''}>${esc(node.wbs_code)} · ${esc(node.description ?? '')}</option>`).join('');
}
async function showTaskWbsForm(id) {
  const task = state.tasks.find(row => row.id === id), selected = siteId, user = session?.user.id;
  if (!task || !canEditTask() || !moduleVisible('wbs') || offline) return;
  showModal(t('wbsAssociate'), `<p role="status">${t('loading')}</p>`);
  const version = modalVersion;
  try {
    const options = await taskWbsOptions(selected, task.wbsId);
    if (version !== modalVersion || selected !== siteId || user !== session?.user.id) return;
    showModal(t('wbsAssociate'), `<form id="task-wbs-form" data-id="${esc(id)}" data-site="${esc(selected)}" data-user="${esc(user)}"><div class="form-error" role="alert" tabindex="-1" hidden></div>${field('wbs', 'wbsId', '', { options })}${formActions()}</form>`);
  } catch (error) { if (version === modalVersion) toast(errorMessage(error)); }
}
function renderWbs() {
  const cached = wbsCache.get(siteId);
  $('#main').innerHTML = heading('wbs', 'wbsSub',
    button('wbsTree', 'wbs-view', `data-value="tree" aria-pressed="${wbsView === 'tree'}"`) +
    button('wbsFlat', 'wbs-view', `data-value="flat" aria-pressed="${wbsView === 'flat'}"`) + button('retry', 'wbs-reload') + (canWriteWbs() ? button('wbsCreate', 'wbs-create', '', 'primary') : ''));
  if (!cached) {
    $('#main').insertAdjacentHTML('beforeend', `<div class="skeleton-list" role="status" aria-label="${t('loading')}">${Array.from({ length: 6 }, () => '<span></span>').join('')}</div>`);
    $('#main').setAttribute('aria-busy', 'true');
    if (!wbsLoad) void loadWbs();
    return;
  }
  if (cached.error) {
    $('#main').insertAdjacentHTML('beforeend', `<p role="alert">${esc(errorMessage(cached.error))}</p>`); return;
  }
  if (!cached.nodes.length) { $('#main').insertAdjacentHTML('beforeend', empty('wbsEmpty', 'wbsEmptyHint')); return; }
  const label = node => `<strong>${esc(node.wbs_code)}</strong> ${esc(node.description ?? '—')}${wbsState(node)} ${wbsNodeControl(node)}${node.is_synthetic ? ` <span class="badge">${t('wbsSynthetic')}</span>` : ''}${node.progress_pct == null ? '' : ` <span class="badge wbs-progress">${esc(node.progress_pct)}%</span>`}`;
  const branches = nodes => `<ul class="wbs-tree">${nodes.map(node => `<li>${node.children.length
    ? `<details open><summary>${label(node)}</summary>${branches(node.children)}</details>`
    : `<div class="wbs-leaf">${label(node)}</div>`}</li>`).join('')}</ul>`;
  if (wbsView === 'tree') {
    $('#main').insertAdjacentHTML('beforeend', `<section class="panel panel-body">${button('wbsExpand', 'wbs-expand')}${button('wbsCollapse', 'wbs-collapse')}${branches(cached.nodes)}</section>`);
  } else {
    const rows = [];
    const flatten = nodes => { for (const node of nodes) { rows.push(node); flatten(node.children); } };
    flatten(cached.nodes);
    rows.sort((a, b) => a.level - b.level || (a.sort_order ?? Infinity) - (b.sort_order ?? Infinity) || a.wbs_code.localeCompare(b.wbs_code) || a.id.localeCompare(b.id));
    const byId = new Map(rows.map(node => [node.id, node]));
    $('#main').insertAdjacentHTML('beforeend', `<div class="table-scroll"><table><thead><tr>${['wbsCode', 'wbsDescription', 'wbsParent', 'wbsLevel', 'wbsOrder', 'wbsProgress', 'wbsPlannedStart', 'wbsPlannedFinish'].map(key => `<th scope="col">${t(key)}</th>`).join('')}</tr></thead><tbody>${rows.map(node => `<tr><td>${esc(node.wbs_code)}${node.is_synthetic ? ` <span class="badge">${t('wbsSynthetic')}</span>` : ''}</td><td>${esc(node.description ?? '—')}${wbsState(node)} ${wbsNodeControl(node)}</td><td>${esc(byId.get(node.parent_id)?.wbs_code ?? '—')}</td><td>${node.level}</td><td>${esc(node.sort_order ?? '—')}</td><td>${node.progress_pct === null ? '—' : `${esc(node.progress_pct)}%`}</td><td>${esc(node.planned_start ?? '—')}</td><td>${esc(node.planned_finish ?? '—')}</td></tr>`).join('')}</tbody></table></div>`);
  }
}
// Core modules are online-only and never write to the offline operation queue.
const role = () => session?.roles?.find(member => member.site_id === siteId)?.role;
const ownerModules = { logistics: true, workforce_names: true, workforce_presence: true };
const currentModules = () => role() === 'owner' ? ownerModules : state.memberAccess?.[siteId]?.members?.find(member => member.user_id === session?.user.id)?.modules || {};
const moduleVisible = module => visibleModules([module], currentModules()).length > 0;

const permissions = () => corePermissions(role());
const moduleResources = { deviations: ['deviations', 'reconciliation'], progress: ['progress', 'wbs', 'progressTypes'], bookings: ['bookings', 'workDays', 'employees', 'progress', 'workforceSummary'], workforce_presence: ['workforcePresence'], impacts: ['impacts'], tools: ['tools'], certifications: ['certifications', 'employees'], hse: ['hse', 'hseAssets'], logistics: ['purchaseOrders', 'packages', 'shipments'] };
// Mobile keeps four destinations reachable with the thumb; the rest lives behind «Altro».
const NAV_ITEMS = ['overview', 'sites', 'tasks', 'wbs', 'deviations', 'progress', 'bookings', 'workforce_presence', 'impacts', 'diary', 'tools', 'certifications', 'hse', 'logistics', 'reporting'];
const MOBILE_PRIMARY = ['today', 'tasks', 'diary', 'deviations', 'progress'];
const TABLET_PRIMARY = [...MOBILE_PRIMARY, 'bookings'];
const headerNavItems = () => window.matchMedia('(width < 640px)').matches ? MOBILE_PRIMARY : TABLET_PRIMARY;
const compactNavigation = () => window.matchMedia('(width < 800px)').matches;
const NAV_OPEN_KEY = 'sa-nav-open';
const navGroupId = group => group.label.slice(3).toLowerCase();
let navOpen = null, navRoute;
function saveNavOpen() {
  try { localStorage.setItem(NAV_OPEN_KEY, JSON.stringify(navOpen)); } catch { /* storage unavailable */ }
}
function desktopNavigation(navLink) {
  if (!navOpen) {
    let saved;
    try { saved = JSON.parse(localStorage.getItem(NAV_OPEN_KEY) || '{}'); } catch { /* storage unavailable */ }
    navOpen = Object.fromEntries(navGroups().map(group => {
      const id = navGroupId(group);
      return [id, typeof saved?.[id] === 'boolean' ? saved[id] : window.innerHeight >= 1000 || group.items.includes(view)];
    }));
  }
  const groups = navGroups(currentModules());
  if (navRoute !== view) {
    const active = groups.find(group => group.items.includes(view));
    if (active && !navOpen[navGroupId(active)]) {
      navOpen[navGroupId(active)] = true;
      saveNavOpen();
    }
    navRoute = view;
  }
  return navLink('today')
    + groups.map(group => `<details class="nav-group" data-group="${navGroupId(group)}"${navOpen[navGroupId(group)] ? ' open' : ''}><summary class="nav-section">${t(group.label)}</summary><div class="nav-group-items">${group.items.map(navLink).join('')}</div></details>`).join('');
}
function bindDesktopNavigation() {
  for (const section of $('#navigation').querySelectorAll('details[data-group]')) {
    section.addEventListener('toggle', () => {
      // Ignore initial toggle notifications and events from a replaced navigation tree.
      if (!section.isConnected || navOpen[section.dataset.group] === section.open) return;
      navOpen[section.dataset.group] = section.open;
      saveNavOpen();
    });
  }
}
const coreCache = new Map();
let workforceSummaryFilters;
let coreFilters = { deviations: { status: '', priority: '' }, progress: { wbsId: '' }, bookings: { date: '' }, impacts: { status: '', result: '' }, tools: { company: '', status: '' }, certifications: { employee: '', category: '', status: '' }, hse: { type: '', severity: '', from: '', to: '' }, logistics: { status: '', supplier: '' } };
let purchaseOrderDetailId = '';
let packageDetailId = '', packageFilters = { status: '', purchaseOrderId: '' };
let shipmentDetailId = '', shipmentFilters = { status: '' };
let logisticsView = (() => {
  try { const value = sessionStorage.getItem('sa-logistics-view'); return ['orders', 'packages', 'shipments'].includes(value) ? value : 'orders'; }
  catch { return 'orders'; }
})();
function selectLogisticsView(value) {
  logisticsView = ['orders', 'packages', 'shipments'].includes(value) ? value : 'orders';
  try { sessionStorage.setItem('sa-logistics-view', logisticsView); } catch { /* private mode */ }
  render();
}
function renderLogisticsViewToggle() {
  return `<div class="logistics-tabs"><div class="view-toggle">${[['orders', 'logisticsOrders'], ['packages', 'logisticsPackages'], ['shipments', 'logisticsShipments']].map(([value, key]) => button(key, 'logistics-view', `data-value="${value}" aria-pressed="${logisticsView === value}"`, logisticsView === value ? 'selected' : '')).join('')}</div></div>`;
}
let reconciliationFilter = '', reconciliationOpen = true;
let deviationView = 'board', toolEditingId = '', certEditingId = '', hseEditingId = '';
let hseView = (() => {
  try { return sessionStorage.getItem('siteassistant-hse-view') === 'inspections' ? 'inspections' : 'register'; }
  catch { return 'register'; }
})();
let hseAssetFilters = { category: '', status: '' }, hseAssetOrder = 'due';
function selectHseView(value, assetId = '', inspectionId = '') {
  hseView = value === 'inspections' ? 'inspections' : 'register';
  hseAssetDetail.id = hseView === 'inspections' ? assetId : '';
  hseAssetDetail.expanded.clear();
  if (hseAssetDetail.id && inspectionId) hseAssetDetail.expanded.add(inspectionId);
  try { sessionStorage.setItem('siteassistant-hse-view', hseView); } catch { /* private mode */ }
  render();
}
function resetCore() {
  coreCache.clear();
  workforceSummaryFilters = undefined;
  coreFilters = { deviations: { status: '', priority: '' }, progress: { wbsId: '' }, bookings: { date: '' }, impacts: { status: '', result: '' }, tools: { company: '', status: '' }, certifications: { employee: '', category: '', status: '' }, hse: { type: '', severity: '', from: '', to: '' }, logistics: { status: '', supplier: '' } };
  shipmentDetailId = ''; shipmentFilters = { status: '' };
  purchaseOrderDetailId = ''; packageDetailId = ''; packageFilters = { status: '', purchaseOrderId: '' };
  reconciliationFilter = ''; reconciliationOpen = true;
  toolEditingId = ''; certEditingId = ''; hseEditingId = '';
  hseAssetFilters = { category: '', status: '' }; hseAssetOrder = 'due';
  hseAssetDetail.id = ''; hseAssetDetail.expanded.clear();
}
async function loadBookingRows(selected) {
  const rows = [], limit = 200;
  for (let offset = 0; ; offset += limit) {
    const page = await freshApi.listBookings({ siteId: selected, limit, offset });
    rows.push(...page);
    if (page.length < limit) return rows;
  }
}
function coreResource(name, loader) {
  const selected = siteId;
  if (!coreCache.has(selected)) coreCache.set(selected, new Map());
  const cache = coreCache.get(selected);
  if (cache.has(name)) return cache.get(name);
  const entry = { pending: true };
  cache.set(name, entry);
  const loaders = {
    deviations: () => loadPages(page => freshApi.listDeviations({ siteId: selected, ...page })),
    progress: () => loadPages(page => freshApi.listProgress({ siteId: selected, ...page })),
    reconciliation: () => freshApi.deviationReconciliation(selected),
    progressTypes: () => freshApi.listProgressTypes(selected),
    bookings: () => loadBookingRows(selected), impacts: () => freshApi.listImpacts({ siteId: selected }),
    tools: () => freshApi.listTools({ siteId: selected }),
    shipments: () => freshApi.listShipments({ siteId: selected }),
    packages: () => freshApi.listPackages({ siteId: selected }),
    purchaseOrders: () => freshApi.listPurchaseOrders({ siteId: selected }),
    certifications: () => freshApi.listCertifications({ siteId: selected }),
    hse: () => freshApi.listHseEvents({ siteId: selected }),
    hseAssets: () => freshApi.listHseAssets({ siteId: selected }),
    workDays: () => freshApi.listWorkDays({ siteId: selected }), employees: () => freshApi.listEmployees({ siteId: selected }),
    workforceSummary: () => freshApi.workforceSummary({ siteId: selected, ...summaryFilters() }),
    workforcePresence: () => freshApi.workforcePresence({ siteId: selected, date: operationalDay().date }),
    wbs: async () => {
      if (wbsLoad?.promise) await wbsLoad.promise;
      if (siteId !== selected || coreCache.get(selected) !== cache) return [];
      if (!wbsCache.has(selected)) await loadWbs();
      const result = wbsCache.get(selected);
      if (result?.error) throw result.error;
      return flattenWbs(result?.nodes || []);
    },
  };
  const resourceUser = session?.user.id;
  const dependencyModule = ({ progressTypes: 'progress', wbs: 'wbs', progress: 'progress' })[name];
  entry.promise = (dependencyModule && !moduleVisible(dependencyModule) ? Promise.resolve([]) : (loader || loaders[name])()).then(data => {
    entry.data = data;
    if (!loader && coreCache.get(selected) === cache && cache.get(name) === entry && session?.user.id === resourceUser) rememberTodayResource(name, data, selected);
  }, error => { entry.error = error; }).finally(() => {
    entry.pending = false;
    if (coreCache.get(selected) !== cache || cache.get(name) !== entry || siteId !== selected) return;
    if (name === 'progress' && view === 'tasks' && $('#task-results')) renderTaskResults();
    else if (moduleResources[view]?.includes(name) || view === 'today' || (loader && ((view === 'hse' && hseAssetDetail.id) || view === 'logistics')) || (name === 'wbs' && view === 'logistics')) render();
  });
  return entry;
}
const coreData = name => coreCache.get(siteId)?.get(name)?.data || [];
const coreValue = value => esc(value ?? t('coreUnknown'));
const coreStatus = (value, label = t(value || 'coreUnknown')) => `<span class="badge core-status core-status-${esc(value || 'unknown')}">${esc(label)}</span>`;
// Impact statuses have their own vocabulary: the tasks labels would say «Chiuse» for a claim.
const impactLabel = status => t({ open: 'impactOpen', notification_sent: 'impactNotification', submitted: 'impactSubmitted', closed: 'impactClosed' }[status] || status || 'coreUnknown');
const coreNumber = (value, kind = 'number') => value == null ? t('coreUnknown') : `<span class="mono">${esc(formatDisplayNumber(value, { kind, language }))}</span>`;
const employeeLabel = employee => employee ? [employee.employeeNo, employee.firstName, employee.lastName].filter(Boolean).join(' · ') || employee.id : t('coreUnknown');
const progressLabel = item => item?.description || item?.id || t('coreUnknown');
function coreSelect(key, label, options, value, allLabel) {
  return `<label class="field core-filter"><span>${t(label)}</span><select data-core-filter="${key}">${allLabel ? `<option value="">${t(allLabel)}</option>` : ''}${options.map(([id, text]) => `<option value="${esc(id)}" ${id === value ? 'selected' : ''}>${esc(text)}</option>`).join('')}</select></label>`;
}
function coreTable(columns, rows, rowAttributes = []) {
  return `<div class="core-table-wrap"><table class="core-table"><thead><tr>${columns.map(key => `<th scope="col">${t(key)}</th>`).join('')}</tr></thead><tbody>${rows.map((cells, rowIndex) => `<tr${rowAttributes[rowIndex] ? ` ${rowAttributes[rowIndex]}` : ''}>${cells.map((cell, index) => `<td data-label="${t(columns[index])}">${cell}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}
const coreDetailButton = (module, row, label = row.title || row.description || row.id) => `<button type="button" data-command="core-detail" data-module="${module}" data-id="${esc(row.id)}">${esc(label)}</button>`;
function progressBar(value) {
  if (value == null) return t('coreUnknown');
  return `<div class="core-progress"><span>${coreNumber(value, 'percent')}%</span><progress max="100" value="${Math.min(100, Math.max(0, Number(value)))}" aria-label="${t('coreProgressPct')}"></progress></div>`;
}
function renderCore() {
  const deviations = view === 'deviations';
  const inspections = view === 'hse' && hseView === 'inspections';
  const summary = view === 'bookings' && !moduleVisible('workforce_names');
  const subjectDetail = inspections && hseAssetDetail.id;
  const tools = (inspections ? '' : button(columnFiltersOn ? 'columnFiltersHide' : 'columnFiltersShow', 'column-filters', `aria-pressed="${columnFiltersOn}"`)) + button('coreRefresh', 'core-reload');
  $('#main').innerHTML = deviations ? `<div class="notebook notebook-records">
    <header class="notebook-page-head"><div><h1>${t('deviations')}</h1><p id="deviation-summary" class="notebook-meta num" role="status">${t('deviationsSub')}</p></div></header>
    <div class="notebook-actions">${tools}</div>
    <div id="deviation-content"></div>
  </div>` : heading(view, inspections ? 'hseInspectionsSub' : summary ? 'workforceSummarySub' : `${view}Sub`,
    (view === 'progress' ? button('reportPrint', 'open-report') : '')
    + (view === 'logistics' && purchaseOrderCanWrite() ? button(logisticsView === 'shipments' ? 'shpNew' : logisticsView === 'packages' ? 'pkgNew' : 'poNew', logisticsView === 'shipments' ? 'shp-new' : logisticsView === 'packages' ? 'pkg-new' : 'po-new', '', 'primary') : '')
    + (view === 'tools' && permissions().tools ? button('toolAdd', 'tool-new', '', 'primary') : '')
    + (view === 'certifications' && permissions().certificationWrite && moduleVisible('workforce_names') ? button('certAdd', 'cert-new', '', 'primary') : '')
    + (view === 'hse' && !inspections && permissions().hseWrite ? button('hseAdd', 'hse-new', '', 'primary') : '')
    + (subjectDetail ? button('hseAssetBack', 'hse-asset-back') : inspections && permissions().hseWrite ? button('hseAssetAdd', 'hse-asset-new', '', 'primary') : '')
    + tools);
  const target = $(deviations ? '#deviation-content' : '#main');
  if (view === 'logistics') target.insertAdjacentHTML('beforeend', renderLogisticsViewToggle());
  if (view === 'hse') target.insertAdjacentHTML('beforeend', renderHseViewToggle());
  if (offline || !navigator.onLine) {
    target.insertAdjacentHTML('beforeend', empty('coreOnlineOnly', 'coreOnlineHint')); return;
  }
  if (view === 'hse' && !permissions().hse) { target.insertAdjacentHTML('beforeend', empty('forbidden', 'hseRestricted')); return; }
  if (!inspections && coreFilters[view]?.id) target.insertAdjacentHTML('beforeend', deviations
    ? `<div class="notebook-actions">${button('clearFilters', 'today-clear-filter')}</div>`
    : `<p class="note">${t('todayFiltered')} ${button('clearFilters', 'today-clear-filter')}</p>`);
  let resourceNames = view === 'logistics' ? (logisticsView === 'shipments' ? (shipmentDetailId ? [] : ['shipments']) : logisticsView === 'packages' ? (packageDetailId ? [] : ['packages', 'purchaseOrders']) : (purchaseOrderDetailId ? [] : ['purchaseOrders'])) : view === 'hse' ? [inspections ? 'hseAssets' : 'hse'] : moduleResources[view];
  if (view === 'bookings') {
    resourceNames = summary ? ['workforceSummary'] : resourceNames.filter(name => name !== 'workforceSummary');
    if (summary) target.insertAdjacentHTML('beforeend', renderWorkforceSummaryFilters());
  }
  if (view === 'certifications' && !moduleVisible('workforce_names')) resourceNames = ['certifications'];
  const presenceDate = view === 'workforce_presence' ? operationalDay().date : null;
  if (presenceDate && coreCache.get(siteId)?.get('workforcePresence')?.date !== presenceDate) {
    coreCache.get(siteId)?.delete('workforcePresence');
  }
  // Not `.map(coreResource)`: map would pass the index as the custom loader.
  const resources = resourceNames.map(name => coreResource(name));
  if (presenceDate) resources[0].date = presenceDate;
  if (resources.some(entry => entry.pending)) {
    $('#main').setAttribute('aria-busy', 'true');
    target.insertAdjacentHTML('beforeend', `<p role="status">${t('loading')}</p>`); return;
  }
  const error = resources.find(entry => entry.error)?.error;
  if (error) { target.insertAdjacentHTML('beforeend', `<p role="alert">${esc(errorMessage(error))}</p>`); return; }
  const content = { logistics: () => logisticsView === 'shipments' ? renderShipments() : logisticsView === 'packages' ? renderPackages() : renderPurchaseOrders(), deviations: renderDeviations, progress: renderProgress, bookings: () => summary ? renderWorkforceSummary() : renderBookings(), workforce_presence: () => renderWorkforcePresence(presenceDate), impacts: renderImpacts, tools: renderTools, certifications: renderCertifications, hse: subjectDetail ? renderHseAssetDetail : inspections ? renderHseAssets : renderHse }[view]();
  target.insertAdjacentHTML('beforeend', `<div class="core-view">${content}${inspections ? '' : renderAuditPanel()}</div>`);
  const reconciliationPanel = $('#deviation-reconciliation');
  if (reconciliationPanel) reconciliationPanel.addEventListener('toggle', () => { reconciliationOpen = reconciliationPanel.open; });
  if (!inspections) enhanceCoreTables();
  if (deviations) {
    updateDeviationBoardScroll();
    $('#deviation-board')?.addEventListener('scroll', updateDeviationBoardScroll, { passive: true });
  }
  bindAuditPanel();
}

function auditEntityType() {
  return ({ hse: 'hse_event', certifications: 'certification', tools: 'tool' })[view];
}
function canReadAudit() { return ['owner', 'verifier'].includes(role()); }
function renderAuditPanel() {
  if (!auditEntityType() || !canReadAudit()) return '';
  return `<details id="audit-panel" class="panel audit-panel"><summary>${t('auditTitle')}</summary><div class="panel-body" aria-live="polite"></div></details>`;
}
function auditFieldLabel(entityType, field) {
  const labels = {
    tool: { name: 'toolName', code: 'toolCode', company: 'toolCompany', status: 'toolStatus', location: 'toolLocation', notes: 'toolNotes' },
    certification: { employee_id: 'coreEmployee', name: 'certName', category: 'certCategory', issuer: 'certIssuer', issued_on: 'certIssuedOn', expires_on: 'certExpiresOn', outcome: 'certOutcome', notes: 'certNotes' },
    hse_event: { event_no: 'hseEventNo', type: 'hseType', severity: 'hseSeverity', occurred_on: 'hseOccurredOn', location: 'hseLocation', persons_involved: 'hsePersons', measures: 'hseMeasures', notes: 'hseNotes', deviation_id: 'deviations' },
  };
  return t(labels[entityType]?.[field] || field);
}
function auditValue(value) {
  if (value === null) return 'null';
  if (value === '') return '""';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}
function renderAuditEvents(events) {
  if (!events.length) return `<p role="status">${t('auditEmpty')}</p>`;
  const rows = events.map(event => {
    const changes = typeof event.changes === 'string' ? JSON.parse(event.changes) : event.changes;
    const name = event.action === 'read' ? changes.attachment?.filename : ['name', 'event_no', 'title', 'deviation_no'].map(field => {
      const value = changes[field];
      return event.action === 'update' && value && typeof value === 'object' ? value.to || value.from : value;
    }).find(value => value != null && value !== '');
    const fields = event.action === 'update' ? Object.entries(changes) : [];
    const summary = fields.length ? `<ul class="audit-changes">${fields.slice(0, 4).map(([field, change]) =>
      `<li>${esc(auditFieldLabel(event.entity_type, field))}: ${esc(auditValue(change.from))} → ${esc(auditValue(change.to))}</li>`).join('')}</ul>` : '';
    const more = fields.length > 4 ? `<p class="note">${esc(t('auditMore').replace('{count}', String(fields.length - 4)))}</p>` : '';
    return `<li><div class="audit-event-heading"><strong>${esc(t({ create: 'auditCreated', update: 'auditUpdated', delete: 'auditDeleted', read: 'auditRead' }[event.action]))}</strong><span>${esc(event.actor_name || t('auditUnknownUser'))}</span><time datetime="${esc(event.at)}">${esc(timeLabel(event.at))}</time></div><p class="audit-record">${esc(name ?? event.entity_id.slice(0, 8))}</p>${summary}${more}</li>`;
  }).join('');
  return `<ol class="audit-events">${rows}</ol>${events.length === 20 ? `<p class="note">${t('auditRecentOnly')}</p>` : ''}`;
}
function bindAuditPanel() {
  const panel = $('#audit-panel');
  if (!panel || !canReadAudit() || !auditEntityType()) return;
  const selected = siteId, entityType = auditEntityType(), userId = session?.user.id;
  const body = panel.querySelector('.panel-body');
  let opened = false, version = 0;
  panel.addEventListener('toggle', async () => {
    if (panel.open === opened) return;
    opened = panel.open;
    const requestVersion = ++version;
    const current = () => panel.isConnected && panel.open && version === requestVersion
      && siteId === selected && auditEntityType() === entityType && session?.user.id === userId && canReadAudit();
    if (!opened || !current()) return;
    body.innerHTML = `<p role="status">${t('auditLoading')}</p>`;
    try {
      const events = await freshApi.listAuditEvents({ siteId: selected, entityType, limit: 20 });
      if (current()) body.innerHTML = renderAuditEvents(events);
    } catch (error) {
      if (current()) body.innerHTML = `<p role="alert">${esc(t('auditError'))}: ${esc(errorMessage(error))}</p>`;
    }
  });
}

// Sorting and per-column filters work on the rendered table: every core view gets them the same way,
// without teaching each view a new data shape. Filters stay off by default: six inputs above a board
// would be noise, so they appear only when the user asks for them and never on phones.
let columnFiltersOn = false;
const cellNumber = value => {
  const cleaned = String(value).replace(/ /g, ' ').replace(/[^\d,.-]/g, '');
  if (!cleaned) return null;
  const normalized = cleaned.replace(/\.(?=\d{3})/g, '').replace(',', '.');
  return Number.isFinite(Number(normalized)) ? Number(normalized) : null;
};
const coreCellText = cell => cell?.firstElementChild?.getAttribute('data-column-text') ?? cell?.innerText ?? '';
function enhanceCoreTables() {
  document.querySelectorAll('.core-table').forEach(table => {
    if (table.dataset.enhanced) return;
    table.dataset.enhanced = '1';
    const headers = [...table.querySelectorAll('thead th')];
    headers.forEach((th, index) => {
      th.classList.add('sortable');
      th.setAttribute('tabindex', '0');
      th.setAttribute('role', 'button');
      const toggle = () => {
        const current = table.dataset.sortColumn === String(index) ? table.dataset.sortDirection : null;
        const direction = current === 'asc' ? 'desc' : 'asc';
        table.dataset.sortColumn = String(index); table.dataset.sortDirection = direction;
        headers.forEach(header => { header.dataset.sort = ''; header.removeAttribute('aria-sort'); });
        th.dataset.sort = direction; th.setAttribute('aria-sort', direction === 'asc' ? 'ascending' : 'descending');
        const body = table.tBodies[0];
        [...body.rows].sort((left, right) => {
          const a = coreCellText(left.cells[index]).trim(), b = coreCellText(right.cells[index]).trim();
          const na = cellNumber(a), nb = cellNumber(b);
          const compared = na != null && nb != null ? na - nb : a.localeCompare(b, language === 'it' ? 'it' : 'en');
          return direction === 'asc' ? compared : -compared;
        }).forEach(row => body.append(row));
        applyColumnFilters(table);
      };
      th.addEventListener('click', toggle);
      th.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(); } });
    });
    if (columnFiltersOn && window.matchMedia('(min-width: 801px)').matches) {
      const row = document.createElement('tr');
      row.className = 'column-filters';
      headers.forEach((th, index) => {
        const cell = document.createElement('th');
        cell.innerHTML = `<input type="search" aria-label="${esc(th.innerText)}" data-column="${index}" placeholder="…">`;
        row.append(cell);
      });
      table.tHead.append(row);
      row.querySelectorAll('input').forEach(input => input.addEventListener('input', () => applyColumnFilters(table)));
    }
    applyColumnFilters(table);
  });
}
function applyColumnFilters(table) {
  const inputs = [...table.querySelectorAll('.column-filters input')];
  const rows = [...table.tBodies[0].rows];
  for (const row of rows) {
    row.hidden = inputs.some(input => {
      const needle = input.value.trim().toLowerCase();
      if (!needle) return false;
      return !coreCellText(row.cells[Number(input.dataset.column)]).toLowerCase().includes(needle);
    });
  }
  if (view === 'deviations' && table.closest('#deviation-list')) {
    const active = inputs.filter(input => input.value.trim()).map(input => `${input.getAttribute('aria-label')} · ${input.value.trim()}`);
    renderDeviationSummary(rows.filter(row => !row.hidden).length, active);
  }
}
const deviationGlyphs = {
  open: '○', approved: '○', in_progress: '▶', work_completed: '◆', rejected: '▲', closed: '✓',
  deviationsGroupOpen: '○', deviationsGroupInProgress: '▶', deviationsGroupToClose: '◆', deviationsGroupClosed: '✓',
};
function deviationState(status) {
  const glyph = Object.hasOwn(deviationGlyphs, status) ? deviationGlyphs[status] : '○';
  return notebookState(status, [glyph, status === 'closed' ? 'notebookClosed' : status || 'coreUnknown']);
}
// Column controls still match the original status label, including for imported records.
const deviationStatusCell = status => `<span data-column-text="${esc(t(status || 'coreUnknown'))}">${deviationState(status)}</span>`;
const deviationCode = value => `<span class="notebook-meta num">${coreValue(value)}</span>`;
const RECONCILIATION_KINDS = ['closed_without_date', 'close_before_approval'];
const reconciliationColumns = ['coreReference', 'title', 'reconciliationOfficial', 'reconciliationDays', 'reconciliationReason'];
function reconciliationCells(row, interactive = false) {
  return [interactive ? deviationCode(row.deviation_no) : coreValue(row.deviation_no), interactive
    ? coreDetailButton('deviations', row, row.title || row.deviation_no || row.id) : coreValue(row.title),
  interactive ? deviationStatusCell(row.official_status) : coreStatus(row.official_status), coreNumber(row.disagreement_days, 'count'),
  esc(t(`reconciliation_${row.kind}`))];
}
function reconciliationNotes() {
  return `<p class="note">${t('reconciliationReadOnly')}</p><p class="note">${t('reconciliationImported')}</p>`;
}
function renderReconciliation() {
  const data = coreData('reconciliation');
  const items = data.items.filter(row => !reconciliationFilter || row.kind === reconciliationFilter);
  const body = !data.items.length ? `<p role="status">${t('reconciliationAligned')}</p>`
    : items.length ? coreTable(reconciliationColumns, items.map(row => reconciliationCells(row, true)),
      items.map(row => `data-command="core-detail" data-module="deviations" data-id="${esc(row.id)}"`))
      : `<p role="status">${t('noResults')}</p>`;
  return `<details id="deviation-reconciliation" class="panel reconciliation-panel" ${reconciliationOpen ? 'open' : ''}>
    <summary>${t('reconciliationTitle')}</summary><div class="panel-body">${reconciliationNotes()}
    <div class="toolbar reconciliation-counts">${RECONCILIATION_KINDS.map(kind => `<button type="button" data-command="reconciliation-filter"
      data-kind="${kind}" aria-controls="reconciliation-results" aria-pressed="${reconciliationFilter === kind}">
      ${t(`reconciliation_${kind}`)}: <strong>${coreNumber(data.counts[kind], 'count')}</strong></button>`).join('')}</div>
    <div id="reconciliation-results" aria-live="polite">${body}</div></div></details>`;
}
function reconciliationReport(data) {
  const first = data.items.slice(0, 10);
  return `<section class="reconciliation-report"><h3>${t('reconciliationReportTitle')}</h3>${reconciliationNotes()}
    ${data.items.length ? `<p>${RECONCILIATION_KINDS.map(kind => `${t(`reconciliation_${kind}`)}: ${coreNumber(data.counts[kind], 'count')}`).join(' · ')}</p>
      <div class="report-table-wrap"><table class="report-table"><thead><tr>${reconciliationColumns.map(key => `<th scope="col">${t(key)}</th>`).join('')}</tr></thead>
      <tbody>${first.map(row => `<tr>${reconciliationCells(row).map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
      <p class="note">${t('reconciliationFirstRows')}: ${first.length} / ${data.items.length}</p>`
      : `<p>${t('reconciliationAligned')}</p>`}</section>`;
}
function updateDeviationBoardScroll() {
  const board = $('#deviation-board');
  if (!board) return;
  const overflow = board.scrollWidth > board.clientWidth + 1;
  $('#deviation-board-scroll-hint').hidden = !overflow;
  board.parentElement.classList.toggle('scroll-left', overflow && board.scrollLeft > 1);
  board.parentElement.classList.toggle('scroll-right', overflow && board.scrollLeft + board.clientWidth < board.scrollWidth - 1);
}
function renderDeviationSummary(count, columnFilters = []) {
  const { status, priority, withoutOwner, absent, id } = coreFilters.deviations;
  const active = [
    priority && t(priority),
    deviationView === 'list' && withoutOwner && t('evidenceWithoutOwner'),
    deviationView === 'list' && absent && t('evidenceAbsentFilter'),
    id && t('todayFiltered'),
    ...columnFilters,
  ].filter(Boolean).map(esc);
  $('#deviation-summary').innerHTML = [
    status && deviationState(status === '__unknown' ? null : status),
    ...active,
    notebookCount(count, 'deviationCountOne', 'deviationCount'),
  ].filter(Boolean).join(' · ');
}
function renderDeviations() {
  const all = coreData('deviations'), { status, priority, withoutOwner, absent } = coreFilters.deviations;
  const priorities = [...new Set(all.map(row => row.priority).filter(value => value != null))].sort();
  let html = `<div class="notebook-tools"><div class="toolbar core-toolbar">${coreSelect('status', 'status', [...DEVIATION_STATUSES.map(value => [value, t(value)]), ['__unknown', t('coreUnknown')]], status, 'allStatuses')}${coreSelect('priority', 'priority', priorities.map(value => [value, t(value)]), priority, 'allPriorities')}<div class="view-toggle">${['board', 'list'].map(value => button(value, 'deviation-view', `data-value="${value}" aria-pressed="${deviationView === value}"`)).join('')}</div></div>`;
  const source = deviationView === 'list'
    ? all.filter(row => (!withoutOwner || !row.internalOwnerId) && (!absent || row.absence === true)) : all;
  const visible = filterSortRecords(source, { status: status === '__unknown' ? null : status, priority },
    [{ key: 'creationDate', descending: true }, { key: 'deviationNo' }]);
  renderDeviationSummary(visible.length);
  if (deviationView === 'list') {
    html += `<div class="toolbar core-toolbar">
      ${button('evidenceWithoutOwner', 'deviation-filter', `data-key="withoutOwner" aria-pressed="${Boolean(withoutOwner)}"`, withoutOwner ? 'selected' : '')}
      ${button('evidenceAbsentFilter', 'deviation-filter', `data-key="absent" aria-pressed="${Boolean(absent)}"`, absent ? 'selected' : '')}
      ${role() === 'owner' && !offline ? button('evidenceImport', 'deviation-import') : ''}</div>`;
  }
  html += '</div>';
  const priorityText = priority => coreValue(priority == null ? null : t(priority));
  const card = row => `<button type="button" class="task-card" data-command="core-detail" data-module="deviations" data-id="${esc(row.id)}">
    ${deviationCode(row.deviationNo)}<span class="notebook-card-title">${esc(row.title || row.id)}</span>
    <span class="notebook-meta">${t('priority')}: ${priorityText(row.priority)}</span>
    <span class="notebook-meta">${coreValue(row.assignedTo)}</span>
    <span class="card-footer">${deviationState(row.status)}</span>
  </button>`;
  if (deviationView === 'board') {
    const columns = groupDeviationRows(visible);
    html += compactNavigation()
      ? `<div class="board-accordion core-board-accordion">${columns.map(({ label, rows: column }, index) => `<details class="board-status" ${index === 0 ? 'open' : ''}>
          <summary class="notebook-section-head">${notebookBoardHead(deviationState(label), column.length)}</summary>
          ${column.length ? column.map(card).join('') : `<p class="mini-empty">${t('coreEmptyColumn')}</p>`}</details>`).join('')}</div>`
      : `<div class="deviation-board-frame"><div id="deviation-board" class="core-board" tabindex="0" role="region" aria-label="${t('coreDeviationBoard')}" aria-describedby="deviation-board-scroll-hint">${columns.map(({ label, rows: column }) => `<section class="core-column"><h2 class="notebook-section-head">${notebookBoardHead(deviationState(label), column.length)}</h2>${column.length ? column.map(card).join('') : `<p class="mini-empty">${t('coreEmptyColumn')}</p>`}</section>`).join('')}</div></div><p id="deviation-board-scroll-hint" class="board-scroll-hint" hidden>${t('deviationsScroll')} ↔</p>`;
  } else html += visible.length ? `<div id="deviation-list">${coreTable(
    ['coreReference', 'title', 'status', 'priority', 'coreAssignedTo', 'coreCreated', 'coreClosed', 'evidenceLastSeen'],
    visible.map(row => [deviationCode(row.deviationNo), coreDetailButton('deviations', row), deviationStatusCell(row.status),
      priorityText(row.priority), coreValue(row.assignedTo), coreDate(row.creationDate), coreDate(row.closedDate), coreDate(row.lastSeenInExportDate)]),
  )}</div>` : empty('noResults', 'noResultsHint');
  return window.matchMedia('(max-width: 520px)').matches ? html + renderReconciliation() : renderReconciliation() + html;
}
function renderProgress() {
  const { wbsId, includeDescendants, id } = coreFilters.progress;
  const nodes = coreData('wbs');
  const selected = nodes.find(node => node.id === wbsId);
  const scope = new Set(includeDescendants && selected ? flattenWbs([selected]).map(node => node.id) : [wbsId]);
  const all = coreData('progress');
  const rows = filterSortRecords(all.filter(row => !wbsId || scope.has(row.wbsId)), { id },
    [{ key: 'section' }, { key: 'plcArea' }, { key: 'description' }]);
  const scopeLabel = t(!wbsId ? 'coreAllWbs' : includeDescendants ? 'wbsScopeSubtree' : 'wbsScopeExact');
  return `<div class="toolbar core-toolbar">${coreSelect('wbsId', 'wbsFilterNode', nodes.map(node => [node.id, `${node.wbs_code} · ${node.description ?? ''}`]), wbsId, 'coreAllWbs')}
      <label><input type="checkbox" data-core-filter="includeDescendants" ${includeDescendants ? 'checked' : ''} ${wbsId ? '' : 'disabled'}> ${t('wbsIncludeDescendants')}</label></div>
    <p class="note" role="status">${scopeLabel} · ${t(rows.length === 1 ? 'wbsVisibleItem' : 'wbsVisibleItems').replace('{count}', coreNumber(rows.length, 'count'))}</p>` +
    (rows.length ? coreTable(['wbsDescription', 'coreSection', 'area', 'coreProgressPct', 'coreBookedHours'], rows.map(row => [coreDetailButton('progress', row), coreValue(row.section), coreValue(row.plcArea),
      `<div>${progressValue(row)}${progressVerificationWarning(row)}</div>`, coreNumber(row.bookedHours, 'hours')]))
      : all.length ? empty('noResults', 'noResultsHint') : empty('progressEmpty', 'progressEmptyHint'));
}
function progressValue(row) {
  const source = { imported: 'coreImported', computed: 'coreComputed' }[row.progressPctSource];
  return progressBar(row.progressPct) + (row.progressPct != null && source ? ` <span class="badge">${t(source)}</span>` : '');
}
function progressVerificationWarning(row, linkToTasks = true) {
  if (row.verificationConflict !== true) return '';
  const count = row.verificationOpenTasks;
  const countLabel = t(count === 1 ? 'progressVerificationTask' : 'progressVerificationTasks').replace('{count}', count);
  const message = esc(t('progressVerificationWarning').replace('{count}', countLabel));
  const link = linkToTasks && moduleVisible('tasks') && row.wbsId
    ? `<a href="#tasks" data-command="progress-verifications" data-id="${esc(row.wbsId)}">${message}</a>` : message;
  return `<p class="note progress-verification-warning">${link}</p>`;
}
function openProgressVerifications(wbsId) {
  if (!wbsId || !moduleVisible('tasks')) return;
  closeModal();
  resetSavedViews();
  filters = { ...filters, wbsId, openVerification: true };
  taskView = 'list';
  go('tasks');
}
function summaryFilters() {
  if (workforceSummaryFilters) return workforceSummaryFilters;
  const to = operationalDay().date, start = new Date(`${to}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - 29);
  return { groupBy: 'day', from: start.toISOString().slice(0, 10), to };
}
const workforceGroups = { company: 'workforceCompany', day: 'workforceDay', period: 'workforcePeriod' };
function renderWorkforceSummaryFilters() {
  const { groupBy, from, to } = summaryFilters();
  const options = Object.entries(workforceGroups).map(([key, label]) =>
    `<option value="${key}"${key === groupBy ? ' selected' : ''}>${t(label)}</option>`).join('');
  return `<form id="workforce-summary-form" class="toolbar core-toolbar">
    <div class="form-error" role="alert" tabindex="-1" hidden></div>
    ${field('workforceGroup', 'groupBy', groupBy, { options, required: true })}
    ${field('hseFrom', 'from', from, { type: 'date', required: true })}
    ${field('hseTo', 'to', to, { type: 'date', required: true })}
    <button type="submit">${t('workforceApply')}</button></form>`;
}
function renderWorkforceSummary() {
  const { groupBy, from, to } = summaryFilters(), rows = coreData('workforceSummary');
  if (!rows.length) return empty('noResults', 'noResultsHint');
  const groupLabel = key => {
    if (groupBy === 'day') return coreDate(key);
    if (groupBy === 'period') return `${coreDate(from)} – ${coreDate(to)}`;
    return coreValue(key);
  };
  return coreTable([workforceGroups[groupBy], 'coreSourceWorkTime', 'coreSourceOpenHours', 'coreSourceBookedHours'],
    rows.map(row => [groupLabel(row.groupKey), coreNumber(row.workTime, 'hours'), coreNumber(row.openHours, 'hours'), coreNumber(row.bookedHours, 'hours')]));
}
function renderWorkforcePresence(date) {
  const rows = coreData('workforcePresence');
  return `<h2>${coreDate(date)}</h2>` + (rows.length
    ? coreTable(['coreEmployee', 'workforceCompany', 'shift', 'workforceStart', 'workforceFinish'],
      rows.map(row => [coreValue([row.firstName, row.lastName].filter(Boolean).join(' ') || null), coreValue(row.company),
        t(row.shift || 'coreUnknown'), coreValue(row.startTime), coreValue(row.finishTime)]))
    : empty('noResults', 'noResultsHint'));
}
function renderBookings() {
  const days = coreData('workDays'), employees = coreData('employees'), items = coreData('progress');
  const { date, from, to, company } = coreFilters.bookings;
  const allGroups = groupBookings(coreData('bookings'), days, employees, items);
  const companyName = group => group.employee?.company || null;
  const companyKey = group => JSON.stringify(companyName(group));
  const companies = [...new Map(allGroups.map(group => [companyKey(group), companyName(group) ?? t('coreUnknown')]))]
    .sort((a, b) => a[1].localeCompare(b[1], language));
  const groups = allGroups.filter(group => (!company || companyKey(group) === company) && (!date || group.date === date)
    && (!from || (group.date && group.date >= from)) && (!to || (group.date && group.date <= to)));
  const dates = [...new Set(days.map(day => day.operationalDate).filter(Boolean))].sort().reverse();
  const choices = dates.map(day => [day, dateLabel(day)]);
  let html = `<div class="toolbar core-toolbar">${coreSelect('company', 'workforceCompany', companies, company, 'bookingAllCompanies')}
    ${coreSelect('date', 'reportDate', choices, date, 'coreAllDays')}
    ${coreSelect('from', 'hseFrom', choices, from, 'coreAllDays')}${coreSelect('to', 'hseTo', choices, to, 'coreAllDays')}</div>`;
  if (from && to && from > to) return html + `<p role="alert">${t('hsePeriodInvalid')}</p>`;
  const total = groups.reduce((sum, group) => sum + group.appBookedHours, 0);
  html += `<p class="note" role="status">${t('bookingFilteredTotal')} <strong>${coreNumber(total, 'hours')} h</strong></p><p class="note">${t('bookingCompanySource')}</p>`;
  if (permissions().book) {
    if (!days.length || !items.length) html += `<p class="blank-message">${t('coreBookingPrerequisites')}</p>`;
    else html += `<form id="booking-form" class="panel panel-body core-booking-form"><h2>${t('coreBookHours')}</h2><div class="form-error" role="alert" tabindex="-1" hidden></div><div class="core-entry-grid"><label class="field">${t('coreWorkDay')}<select name="workDayId" required><option value="">${t('coreChoose')}</option>${filterSortRecords(days, {}, [{ key: 'operationalDate', descending: true }, { key: 'employeeId' }]).map(day => `<option value="${esc(day.id)}">${esc(`${day.operationalDate} · ${employeeLabel(employees.find(employee => employee.id === day.employeeId))} · ${t(day.shift || 'coreUnknown')} · ${day.startTime ?? t('coreUnknown')}`)}</option>`).join('')}</select></label><label class="field">${t('coreProgressItem')}<select name="siteProgressItemId" required><option value="">${t('coreChoose')}</option>${items.map(item => `<option value="${esc(item.id)}">${esc(progressLabel(item))}</option>`).join('')}</select></label><label class="field">${t('coreAppBookedHours')}<input name="hours" type="number" min="0" step="0.5" value="1" required></label><div class="core-stepper">${button('coreMinusHalf', 'booking-step', 'data-step="-0.5"')}${button('corePlusHalf', 'booking-step', 'data-step="0.5"')}${button('corePlusOne', 'booking-step', 'data-step="1"')}</div></div><div class="form-actions"><button type="submit" class="primary">${t('coreBookHours')}</button></div></form>`;
  }
  html += `<p class="note booking-legend">${t('coreHoursLegendSource')}<br>${t('coreHoursLegendApp')}</p>`;
  html += groups.length ? groups.map(group => `<section class="core-day"><h2>${group.date ? dateLabel(group.date) : t('coreUnknown')} · ${esc(employeeLabel(group.employee))} · ${coreValue(companyName(group))}</h2>`
    + '<div class="booking-summary">' + coreTable(['coreSourceWorkTime', 'coreSourceBookedHours', 'coreAppBookedHours', 'coreSourceOpenHours', 'coreVariance'], [[
      coreNumber(group.sourceWorkTime, 'hours'), coreNumber(group.sourceBookedHours, 'hours'), coreNumber(group.appBookedHours, 'hours'), coreNumber(group.sourceOpenHours, 'hours'), bookingVariance(group.variance),
    ]]) + '</div>'
    + (group.rows.length ? coreTable(['coreEmployee', 'coreProgressItem', 'coreAppBookedHours', ...(permissions().book ? ['coreActions'] : [])], group.rows.map(row => [esc(employeeLabel(row.employee)), esc(row.item ? progressLabel(row.item) : row.siteProgressItemId), coreNumber(row.hours, 'hours'), ...(permissions().book ? [button('coreDelete', 'booking-delete', `data-id="${esc(row.id)}"`, 'danger small')] : [])])) : '')
    + '</section>').join('') : empty('noResults', 'noResultsHint');
  return html;
}
function bookingVariance(value) {
  if (value == null) return `<strong class="booking-variance">${t('coreNotCalculable')}</strong>`;
  const direction = value > 0 ? 'positive' : value < 0 ? 'negative' : 'zero';
  const label = value > 0 ? 'coreVariancePositive' : value < 0 ? 'coreVarianceNegative' : 'coreVarianceBalanced';
  const formatted = formatDisplayNumber(value, { kind: 'hours', language, signed: true });
  return `<strong class="booking-variance booking-variance-${direction}"><span class="mono">${esc(formatted)}</span><small>${t(label)}</small></strong>`;
}
const PURCHASE_ORDER_STATUSES = ['open', 'template_generated', 'in_execution', 'completed', 'not_relevant'];
const purchaseOrderCanWrite = () => moduleVisible('logistics') && ['owner', 'editor'].includes(role());
const purchaseOrderStatus = status => coreStatus(status, t(`poStatus_${status}`));
const purchaseOrderQuantity = value => esc(formatDisplayNumber(value, { kind: 'number', language }));
function purchaseOrderTransitions(order) {
  if (order.closedAt != null || !['open', 'template_generated', 'in_execution'].includes(order.status) || !Array.isArray(order.items)) return [];
  return [
    ...(order.status === 'open' ? ['template_generated'] : []),
    ...(order.items.every(item => ['completed', 'not_relevant'].includes(item.status)) ? ['completed'] : []),
    ...(order.items.every(item => item.status === 'not_relevant') ? ['not_relevant'] : []),
  ];
}
function purchaseOrderItemTransitions(item) {
  return item.status === 'open' ? ['in_execution', 'not_relevant']
    : item.status === 'in_execution' ? ['completed', 'not_relevant'] : [];
}
function purchaseOrderResource(id) {
  return coreResource(`purchaseOrder:${id}`, () => freshApi.getPurchaseOrder(id));
}
function renderPurchaseOrders() {
  if (!moduleVisible('logistics')) return empty('moduleUnavailable', 'moduleUnavailableHint');
  if (purchaseOrderDetailId) {
    const entry = purchaseOrderResource(purchaseOrderDetailId);
    const back = button('poBack', 'po-back');
    if (entry.pending) return `${back}<p role="status">${t('loading')}</p>`;
    if (entry.error) return `${back}<p role="alert">${esc(errorMessage(entry.error))}</p>${button('retry', 'po-detail-reload', `data-id="${esc(purchaseOrderDetailId)}"`)}`;
    if (entry.data.siteId !== siteId) return empty('forbidden', 'moduleUnavailableHint');
    return back + renderPurchaseOrderDetail(entry.data);
  }
  const filter = coreFilters.logistics, canWrite = purchaseOrderCanWrite();
  const rows = coreData('purchaseOrders').filter(row => (!filter.status || row.status === filter.status)
    && String(row.supplierName ?? '').toLowerCase().includes(filter.supplier.trim().toLowerCase()))
    .sort((a, b) => String(b.orderedOn).localeCompare(String(a.orderedOn)) || a.poNo.localeCompare(b.poNo));
  let html = `<div class="toolbar core-toolbar">${coreSelect('status', 'status', PURCHASE_ORDER_STATUSES.map(status => [status, t(`poStatus_${status}`)]), filter.status, 'allStatuses')}<label class="field core-filter"><span>${t('poSupplier')}</span><input type="search" data-core-filter="supplier" value="${esc(filter.supplier)}" placeholder="${t('poSupplierFilter')}"></label></div><p class="note">${t('poQuantityHint')}</p>`;
  html += rows.length ? coreTable(['poNumber', 'poSupplier', 'poOrderedOn', 'status', 'poLines', 'poTotalQuantity', ...(canWrite ? ['coreActions'] : [])], rows.map(row => {
    // The list endpoint has no aggregates: cache details and never present missing totals as zero.
    const entry = purchaseOrderResource(row.id), items = entry.data?.siteId === siteId ? entry.data.items : null;
    const pending = entry.error ? `${t('poTotalsUnavailable')} ${button('retry', 'po-detail-reload', `data-id="${esc(row.id)}"`, 'small')}` : t('loading');
    return [
      `<button type="button" data-command="po-open" data-id="${esc(row.id)}">${esc(row.poNo)}</button>`, coreValue(row.supplierName), coreDate(row.orderedOn), purchaseOrderStatus(row.status),
      items ? coreNumber(items.length, 'count') : pending,
      items ? purchaseOrderQuantity(items.reduce((sum, item) => sum + Math.round(Number(item.quantity) * 1000), 0) / 1000) : t(entry.error ? 'poTotalsUnavailable' : 'loading'),
      ...(canWrite ? [button('edit', 'po-edit', `data-id="${esc(row.id)}"`, 'small')] : []),
    ];
  }), rows.map(row => `data-command="po-open" data-id="${esc(row.id)}"`)) : empty('poEmpty', 'poEmptyHint');
  return html;
}
function renderPurchaseOrderDetail(order) {
  const canWrite = purchaseOrderCanWrite(), items = [...order.items].sort((a, b) => a.lineNo - b.lineNo);
  const wbs = items.some(item => item.wbsId) ? coreResource('wbs') : null;
  const nodes = new Map((wbs?.data || []).filter(node => node.site_id === siteId).map(node => [node.id, node.wbs_code]));
  let html = `<section class="panel panel-body po-detail"><h2>${esc(order.poNo)}</h2><dl class="detail-grid core-details">${[
    ['poSupplier', coreValue(order.supplierName)], ['poOrderedOn', coreDate(order.orderedOn)], ['status', purchaseOrderStatus(order.status)],
    ['poNotes', coreValue(order.notes)], ...(order.closedAt ? [['poClosedAt', coreDate(order.closedAt)]] : []),
  ].map(([label, value]) => `<div><dt>${t(label)}</dt><dd>${value}</dd></div>`).join('')}</dl>`;
  if (canWrite) html += `<div class="heading-actions">${button('pkgCreate', 'pkg-new', `data-id="${esc(order.id)}"`)}${button('edit', 'po-edit', `data-id="${esc(order.id)}"`)}${purchaseOrderTransitions(order).length ? button('poChangeStatus', 'po-transition', `data-id="${esc(order.id)}"`) : ''}${button('poAddItem', 'po-item-new', `data-id="${esc(order.id)}"`, 'primary')}</div>`;
  html += `<h3>${t('poItems')}</h3>`;
  if (wbs?.error) html += `<p role="alert">${t('poWbsUnavailable')}</p>`;
  html += items.length ? coreTable(['poLineNo', 'poMaterialNo', 'poDescription', 'poUnit', 'poQuantity', 'wbsCode', 'status', 'poExecutionStartedOn', 'poCompletedOn', ...(canWrite ? ['coreActions'] : [])], items.map(item => [
    coreNumber(item.lineNo, 'count'), coreValue(item.materialNo), coreValue(item.description), coreValue(item.unit), purchaseOrderQuantity(item.quantity),
    item.wbsId ? coreValue(nodes.get(item.wbsId) ?? (wbs?.pending ? t('loading') : t('poWbsUnavailable'))) : coreValue(null),
    purchaseOrderStatus(item.status), coreDate(item.executionStartedOn), coreDate(item.completedOn),
    ...(canWrite ? [`<div class="tool-actions po-item-actions">${button('edit', 'po-item-edit', `data-id="${esc(order.id)}" data-item-id="${esc(item.id)}"`, 'small')}${purchaseOrderItemTransitions(item).length ? button('poChangeStatus', 'po-transition', `data-id="${esc(order.id)}" data-item-id="${esc(item.id)}"`, 'small') : ''}</div>`] : []),
  ])) : empty('poItemsEmpty', 'poItemsEmptyHint');
  return html + '</section>';
}
function purchaseOrderFormMarkup(kind, selected, user, poId, itemId, content) {
  return `<form id="${kind}" data-site="${esc(selected)}" data-user="${esc(user)}" data-id="${esc(poId)}" data-item-id="${esc(itemId)}"><div class="form-error" role="alert" tabindex="-1" hidden></div>${content}${formActions()}</form>`;
}
async function purchaseOrderDialog(title, build) {
  if (!purchaseOrderCanWrite()) return toast(t('forbidden'));
  if (offline || !navigator.onLine) return toast(t('coreOnlineOnly'));
  const selected = siteId, user = session?.user.id;
  showModal(t(title), `<p role="status">${t('loading')}</p>`);
  const version = modalVersion;
  const current = () => selected === siteId && session?.user.id === user && version === modalVersion && purchaseOrderCanWrite();
  try {
    const html = await build(selected, user);
    if (!current()) return;
    showModal(t(title), html);
    $('#modal').classList.add('core-modal');
  } catch (error) {
    if (current()) showModal(t(title), `<p role="alert">${esc(errorMessage(error))}</p>`);
  }
}
function showPurchaseOrderForm(id = '') {
  return purchaseOrderDialog(id ? 'poEdit' : 'poNew', async (selected, user) => {
    const order = id ? await freshApi.getPurchaseOrder(id) : null;
    if (order && order.siteId !== selected) throw new Error('forbidden');
    return purchaseOrderFormMarkup('po-form', selected, user, id, '', `<div class="form-grid">${order ? `<p>${t('poNumber')}: ${esc(order.poNo)}</p>` : field('poNumber', 'poNo', '', { required: true, max: 80 })}${field('poSupplier', 'supplierName', order?.supplierName ?? '', { required: true, max: 200 })}${field('poOrderedOn', 'orderedOn', order?.orderedOn ?? '', { type: 'date', required: true })}${field('poNotes', 'notes', order?.notes ?? '', { type: 'textarea', full: true, max: 10000 })}</div>`);
  });
}
function showPurchaseOrderItemForm(poId, itemId = '') {
  return purchaseOrderDialog(itemId ? 'poEditItem' : 'poAddItem', async (selected, user) => {
    const order = await freshApi.getPurchaseOrder(poId);
    if (order.siteId !== selected) throw new Error('forbidden');
    const item = itemId ? order.items.find(row => row.id === itemId) : null;
    if (itemId && !item) throw new Error('poItemNotFound');
    const resource = coreResource('wbs');
    if (resource.pending) await resource.promise;
    // project_structure is returned by the current site's WBS resource, with raw keys.
    const nodes = (resource.data || []).filter(node => node.site_id === selected);
    const unavailable = resource.error || !moduleVisible('wbs');
    const options = `<option value="">${t('poNoWbs')}</option>` + nodes.map(node => `<option value="${esc(node.id)}" ${node.id === item?.wbsId ? 'selected' : ''}>${esc(`${node.wbs_code} · ${node.description ?? ''}`)}</option>`).join('');
    const wbsField = unavailable || (item?.wbsId && !nodes.some(node => node.id === item.wbsId))
      ? `<p class="note">${t('poWbsUnavailable')}</p>`
      : field('wbsCode', 'wbsId', item?.wbsId ?? '', { options });
    return purchaseOrderFormMarkup('po-item-form', selected, user, poId, itemId, `<div class="form-grid"><label class="field"><span>${t('poLineNo')} *</span><input type="number" name="lineNo" required min="1" max="2147483647" step="1" value="${esc(item?.lineNo ?? order.items.reduce((max, row) => Math.max(max, row.lineNo), 0) + 1)}"></label>${field('poMaterialNo', 'materialNo', item?.materialNo ?? '', { max: 10000 })}${field('poDescription', 'description', item?.description ?? '', { required: true, max: 500 })}${field('poUnit', 'unit', item?.unit ?? '', { max: 20 })}<label class="field"><span>${t('poQuantity')} *</span><input type="number" name="quantity" required min="0.001" max="999999999.999" step="0.001" value="${esc(item?.quantity ?? '')}"><small>${t('poQuantityValidation')}</small></label>${wbsField}</div>`);
  });
}
function showPurchaseOrderTransition(poId, itemId = '') {
  return purchaseOrderDialog('poChangeStatus', async (selected, user) => {
    const order = await freshApi.getPurchaseOrder(poId);
    if (order.siteId !== selected) throw new Error('forbidden');
    const item = itemId ? order.items.find(row => row.id === itemId) : null;
    if (itemId && !item) throw new Error('poItemNotFound');
    const transitions = item ? purchaseOrderItemTransitions(item) : purchaseOrderTransitions(order);
    if (!transitions.length) return `<p>${t('noTransitions')}</p>`;
    return purchaseOrderFormMarkup('po-status-form', selected, user, poId, itemId, `<p>${esc(order.poNo)}${item ? ` · ${t('poLineNo')} ${esc(item.lineNo)}` : ''} ${purchaseOrderStatus((item || order).status)}</p><p class="note">${t('poTransitionConfirm')}</p>${field('poNextStatus', 'status', '', { required: true, options: transitions.map(status => `<option value="${status}">${t(`poStatus_${status}`)}</option>`).join('') })}`);
  });
}
async function submitPurchaseOrder(form, data) {
  const selected = form.dataset.site, user = session?.user.id, version = modalVersion;
  if (offline || !navigator.onLine) throw new Error('coreOnlineOnly');
  if (!purchaseOrderCanWrite() || selected !== siteId || form.dataset.user !== user) throw new Error('forbidden');
  let id = form.dataset.id;
  try {
    if (form.id === 'po-form') {
      if (!data.supplierName.trim() || !validDate(data.orderedOn) || (!id && !data.poNo.trim())) throw new Error('poHeaderInvalid');
      const input = { supplierName: data.supplierName, orderedOn: data.orderedOn, notes: data.notes || null };
      const saved = id ? await api.updatePurchaseOrder(id, input) : await api.createPurchaseOrder({ siteId: selected, poNo: data.poNo, ...input });
      id = saved.id;
    } else if (form.id === 'po-item-form') {
      if (!Number.isInteger(Number(data.lineNo)) || Number(data.lineNo) < 1 || Number(data.lineNo) > 2147483647 || !data.description.trim()) throw new Error('poItemInvalid');
      if (!/^\d+(?:\.\d{1,3})?$/.test(data.quantity) || Number(data.quantity) <= 0 || Number(data.quantity) > 999999999.999) throw new Error('poQuantityValidation');
      const input = { lineNo: Number(data.lineNo), materialNo: data.materialNo || null, description: data.description, unit: data.unit || null, quantity: data.quantity };
      if (Object.hasOwn(data, 'wbsId')) {
        if (data.wbsId && !coreData('wbs').some(node => node.id === data.wbsId && node.site_id === selected)) throw new Error('poWbsUnavailable');
        input.wbsId = data.wbsId || null;
      }
      if (form.dataset.itemId) await api.updatePurchaseOrderItem(id, form.dataset.itemId, input);
      else await api.addPurchaseOrderItem(id, input);
    } else if (form.id === 'po-status-form') {
      if (form.dataset.itemId) await api.transitionPurchaseOrderItem(id, form.dataset.itemId, data.status);
      else await api.transitionPurchaseOrder(id, data.status);
    }
  } catch (error) {
    if (error.code !== 'PO_STATUS_CONFLICT') throw error;
    if (session?.user.id !== user) return;
    coreCache.get(selected)?.delete('purchaseOrders');
    coreCache.get(selected)?.delete(`purchaseOrder:${id}`);
    if (selected === siteId && version === modalVersion && moduleVisible('logistics')) {
      closeModal(); purchaseOrderDetailId = id; render(); toast(t('poStatusConflict'));
    }
    return;
  }
  if (session?.user.id !== user) return;
  coreCache.get(selected)?.delete('purchaseOrders');
  coreCache.get(selected)?.delete(`purchaseOrder:${id}`);
  if (selected !== siteId || version !== modalVersion || !moduleVisible('logistics')) return;
  closeModal(); purchaseOrderDetailId = id; render(); toast(t('poSaved'));
}

const packageStatus = status => coreStatus(status, t(`pkgStatus_${status}`));
const packageThousandths = value => BigInt(Math.round(Number(value) * 1000));
function packageResource(id) {
  return coreResource(`package:${id}`, () => freshApi.getPackage(id));
}
function renderPackages() {
  if (!moduleVisible('logistics')) return empty('moduleUnavailable', 'moduleUnavailableHint');
  if (packageDetailId) {
    const entry = packageResource(packageDetailId), back = button('pkgBack', 'pkg-back');
    if (entry.pending) return `${back}<p role="status">${t('loading')}</p>`;
    if (entry.error) return `${back}<p role="alert">${esc(errorMessage(entry.error))}</p>${button('retry', 'pkg-detail-reload', `data-id="${esc(packageDetailId)}"`)}`;
    if (entry.data.siteId !== siteId) return empty('forbidden', 'moduleUnavailableHint');
    return back + renderPackageDetail(entry.data);
  }
  const orders = coreData('purchaseOrders'), filter = packageFilters;
  const rows = coreData('packages').filter(row => (!filter.status || row.status === filter.status)
    && (!filter.purchaseOrderId || row.purchaseOrderId === filter.purchaseOrderId));
  const html = `<div class="toolbar core-toolbar">${coreSelect('status', 'status', ['open', 'closed'].map(status => [status, t(`pkgStatus_${status}`)]), filter.status, 'allStatuses')}${coreSelect('purchaseOrderId', 'pkgOrder', orders.map(order => [order.id, order.poNo]), filter.purchaseOrderId, 'pkgAllOrders')}</div><p class="note">${t('poQuantityHint')}</p>`;
  return html + (rows.length ? coreTable(['pkgNumber', 'pkgOrder', 'status', 'poLines', 'pkgQuantityPacked', 'pkgCreatedAt'], rows.map(row => {
    const entry = packageResource(row.id), items = entry.data?.siteId === siteId ? entry.data.items : null;
    const unavailable = entry.error ? `${t('poTotalsUnavailable')} ${button('retry', 'pkg-detail-reload', `data-id="${esc(row.id)}"`, 'small')}` : t('loading');
    return [
      `<button type="button" data-command="pkg-open" data-id="${esc(row.id)}">${esc(row.packageNo)}</button>`,
      coreValue(orders.find(order => order.id === row.purchaseOrderId)?.poNo ?? row.purchaseOrderId), packageStatus(row.status),
      items ? coreNumber(items.length, 'count') : unavailable,
      items ? purchaseOrderQuantity(Number(items.reduce((sum, item) => sum + packageThousandths(item.quantityPacked), 0n)) / 1000) : t(entry.error ? 'poTotalsUnavailable' : 'loading'),
      coreValue(row.createdAt ? dateLabel(String(row.createdAt).slice(0, 10)) : null),
    ];
  }), rows.map(row => `data-command="pkg-open" data-id="${esc(row.id)}"`)) : empty('pkgEmpty', 'pkgEmptyHint'));
}
function renderPackageDetail(pkg) {
  const resource = purchaseOrderResource(pkg.purchaseOrderId);
  const order = resource.data?.siteId === siteId ? resource.data : null;
  const lines = new Map((order?.items || []).map(item => [item.id, item.lineNo]));
  return `<section class="panel panel-body po-detail"><h2>${esc(pkg.packageNo)}</h2><dl class="detail-grid core-details">${[
    ['pkgOrder', coreValue(order?.poNo ?? pkg.purchaseOrderId)], ['status', packageStatus(pkg.status)],
    ['poNotes', coreValue(pkg.notes)], ['poClosedAt', coreDate(pkg.closedAt)],
  ].map(([label, value]) => `<div><dt>${t(label)}</dt><dd>${value}</dd></div>`).join('')}</dl>
    ${purchaseOrderCanWrite() && pkg.status === 'open' ? button('pkgClose', 'pkg-close', `data-id="${esc(pkg.id)}"`) : ''}
    ${resource.error ? `<p role="alert">${t('pkgOrderUnavailable')} ${button('retry', 'po-detail-reload', `data-id="${esc(pkg.purchaseOrderId)}"`)}</p>` : ''}
    <h3>${t('pkgItems')}</h3>${coreTable(['poLineNo', 'poDescription', 'pkgQuantityPacked', 'poUnit'], pkg.items.map(item => [
      coreValue(lines.get(item.purchaseOrderItemId) ?? (resource.pending ? t('loading') : null)),
      coreValue(item.description), purchaseOrderQuantity(item.quantityPacked), coreValue(item.unit),
    ]))}</section>`;
}
async function packagePackingRows(orderId, selected) {
  const [order, headers] = await Promise.all([
    freshApi.getPurchaseOrder(orderId), freshApi.listPackages({ siteId: selected, purchaseOrderId: orderId }),
  ]);
  if (order.siteId !== selected || headers.some(pkg => pkg.siteId !== selected || pkg.purchaseOrderId !== orderId)) throw new Error('forbidden');
  const packages = await Promise.all(headers.map(pkg => freshApi.getPackage(pkg.id)));
  const packed = new Map();
  for (const pkg of packages) {
    if (pkg.siteId !== selected || pkg.purchaseOrderId !== orderId) throw new Error('forbidden');
    for (const item of pkg.items) packed.set(item.purchaseOrderItemId, (packed.get(item.purchaseOrderItemId) || 0n) + packageThousandths(item.quantityPacked));
  }
  return `<p class="note">${t('pkgPackingHint')}</p>` + (order.items.length ? coreTable(['poLineNo', 'poDescription', 'poUnit', 'pkgOrderedQuantity', 'pkgAlreadyPacked', 'pkgQuantityPacked'], [...order.items].sort((a, b) => a.lineNo - b.lineNo).map(item => {
    const already = Number(packed.get(item.id) || 0n) / 1000;
    return [coreNumber(item.lineNo, 'count'), coreValue(item.description), coreValue(item.unit), purchaseOrderQuantity(item.quantity), purchaseOrderQuantity(already),
      `<label class="field"><span>${t('pkgQuantityPacked')} · ${t('poLineNo')} ${esc(item.lineNo)}</span><input type="number" name="packed-${esc(item.id)}" data-package-item="${esc(item.id)}" data-ordered="${esc(item.quantity)}" data-packed="${esc(already)}" min="0" max="999999999.999" step="0.001"></label>`];
  })) : `<p>${t('poItemsEmpty')}</p>`);
}
function showPackageForm(orderId = '') {
  return purchaseOrderDialog('pkgNew', async (selected, user) => {
    const orders = await freshApi.listPurchaseOrders({ siteId: selected });
    if (orderId && !orders.some(order => order.id === orderId && order.siteId === selected)) throw new Error('poNotFound');
    const rows = orderId ? await packagePackingRows(orderId, selected) : `<p>${t('pkgChooseOrder')}</p>`;
    return purchaseOrderFormMarkup('pkg-form', selected, user, orderId, '', `<div class="form-grid">${field('pkgOrder', 'purchaseOrderId', orderId, { required: true, options: `<option value="">${t('pkgChooseOrder')}</option>` + orders.map(order => `<option value="${esc(order.id)}" ${order.id === orderId ? 'selected' : ''}>${esc(order.poNo)}</option>`).join('') })}${field('pkgNumber', 'packageNo', '', { max: 80 })}${field('poNotes', 'notes', '', { type: 'textarea', full: true, max: 10000 })}</div><div data-package-rows aria-live="polite">${rows}</div>`);
  });
}
async function loadPackageOrder(form) {
  if (!form || !purchaseOrderCanWrite() || form.dataset.site !== siteId || form.dataset.user !== session?.user.id) return;
  const orderId = form.elements.purchaseOrderId.value, selected = siteId, user = session?.user.id, version = modalVersion;
  const request = form.packageLoadVersion = (form.packageLoadVersion || 0) + 1;
  const rows = form.querySelector('[data-package-rows]'), submit = form.querySelector('[type=submit]');
  form.dataset.id = ''; submit.disabled = true;
  rows.innerHTML = `<p role="status">${t(orderId ? 'loading' : 'pkgChooseOrder')}</p>`;
  const current = () => form.isConnected && request === form.packageLoadVersion && version === modalVersion && selected === siteId && user === session?.user.id && purchaseOrderCanWrite();
  if (!orderId) return;
  try {
    const html = await packagePackingRows(orderId, selected);
    if (!current()) return;
    rows.innerHTML = html; form.dataset.id = orderId; submit.disabled = false;
  } catch (error) {
    if (current()) rows.innerHTML = `<p role="alert">${esc(errorMessage(error))}</p>${button('retry', 'pkg-order-reload')}`;
  }
}
function showPackageClose(id) {
  return purchaseOrderDialog('pkgClose', async (selected, user) => {
    const pkg = await freshApi.getPackage(id);
    if (pkg.siteId !== selected) throw new Error('forbidden');
    if (pkg.status !== 'open') throw new Error('pkgStatusConflict');
    return purchaseOrderFormMarkup('pkg-close-form', selected, user, id, '', `<p>${esc(pkg.packageNo)}</p><p class="note">${t('pkgCloseConfirm')}</p>`);
  });
}
async function submitPackage(form, data) {
  const selected = form.dataset.site, user = session?.user.id, version = modalVersion;
  if (offline || !navigator.onLine) throw new Error('coreOnlineOnly');
  if (!purchaseOrderCanWrite() || selected !== siteId || form.dataset.user !== user) throw new Error('forbidden');
  let saved;
  try {
    if (form.id === 'pkg-form') {
      if (!data.purchaseOrderId || data.purchaseOrderId !== form.dataset.id) throw new Error('pkgChooseOrder');
      const items = [...form.querySelectorAll('[data-package-item]')].flatMap(input => {
        const value = input.value.trim();
        if (!value) return [];
        if (!/^\d+(?:\.\d{1,3})?$/.test(value) || Number(value) > 999999999.999) throw new Error('poQuantityValidation');
        if (Number(value) === 0) return [];
        if (packageThousandths(value) + packageThousandths(input.dataset.packed) > packageThousandths(input.dataset.ordered)) throw new Error('pkgQuantityExceeded');
        return [{ purchaseOrderItemId: input.dataset.packageItem, quantityPacked: value }];
      });
      if (!items.length) throw new Error('pkgItemsRequired');
      saved = await api.createPackage({ siteId: selected, purchaseOrderId: data.purchaseOrderId,
        ...(data.packageNo.trim() ? { packageNo: data.packageNo.trim() } : {}), notes: data.notes || null, items });
    } else if (form.id === 'pkg-close-form') saved = await api.closePackage(form.dataset.id);
    else return;
  } catch (error) {
    // Concurrent packing/closing can still be refused by the server; keep the form and its error visible.
    if (session?.user.id === user && ['PACKAGE_QUANTITY_EXCEEDED', 'PACKAGE_STATUS_CONFLICT'].includes(error.code)) {
      const cache = coreCache.get(selected);
      cache?.delete('packages');
      if (form.id === 'pkg-close-form') cache?.delete(`package:${form.dataset.id}`);
      else cache?.delete(`purchaseOrder:${data.purchaseOrderId}`);
    }
    throw error;
  }
  if (session?.user.id !== user) return;
  const cache = coreCache.get(selected);
  cache?.delete('packages'); cache?.delete(`package:${saved.id}`);
  cache?.delete('purchaseOrders'); cache?.delete(`purchaseOrder:${saved.purchaseOrderId}`);
  if (selected !== siteId || version !== modalVersion || !moduleVisible('logistics')) return;
  closeModal(); coreResource('packages'); render(); toast(t('pkgSaved'));
}

const SHIPMENT_STATUSES = ['planned', 'in_transit', 'arrived', 'received'];
const shipmentStatus = status => coreStatus(status, t(`shpStatus_${status}`));
function shipmentNextStatus(shipment) {
  const index = SHIPMENT_STATUSES.indexOf(shipment.status);
  const next = index < 0 ? null : SHIPMENT_STATUSES[index + 1];
  return next === 'received' && !shipment.receipts.length ? null : next;
}
function shipmentResource(id) {
  return coreResource(`shipment:${id}`, () => freshApi.getShipment(id));
}
function shipmentDependency(entry, command, id) {
  return entry.error ? `${t('poTotalsUnavailable')} ${button('retry', command, `data-id="${esc(id)}"`, 'small')}` : t('loading');
}
function renderShipments() {
  if (!moduleVisible('logistics')) return empty('moduleUnavailable', 'moduleUnavailableHint');
  if (shipmentDetailId) {
    const entry = shipmentResource(shipmentDetailId), back = button('shpBack', 'shp-back');
    if (entry.pending) return `${back}<p role="status">${t('loading')}</p>`;
    if (entry.error) return `${back}<p role="alert">${esc(errorMessage(entry.error))}</p>${button('retry', 'shp-detail-reload', `data-id="${esc(shipmentDetailId)}"`)}`;
    if (entry.data.siteId !== siteId) return empty('forbidden', 'moduleUnavailableHint');
    return back + renderShipmentDetail(entry.data);
  }
  const rows = coreData('shipments').filter(row => !shipmentFilters.status || row.status === shipmentFilters.status);
  return `<div class="toolbar core-toolbar">${coreSelect('status', 'status', SHIPMENT_STATUSES.map(status => [status, t(`shpStatus_${status}`)]), shipmentFilters.status, 'allStatuses')}</div>`
    + (rows.length ? coreTable(['shpNumber', 'shpCarrier', 'shpShippedOn', 'shpExpectedOn', 'shpArrivedOn', 'status', 'logisticsPackages'], rows.map(row => {
      const entry = shipmentResource(row.id);
      return [`<button type="button" data-command="shp-open" data-id="${esc(row.id)}">${esc(row.shipmentNo)}</button>`,
        coreValue(row.carrier), coreDate(row.shippedOn), coreDate(row.expectedOn), coreDate(row.arrivedOn), shipmentStatus(row.status),
        entry.data?.siteId === siteId ? coreNumber(entry.data.packages.length, 'count') : shipmentDependency(entry, 'shp-detail-reload', row.id)];
    }), rows.map(row => `data-command="shp-open" data-id="${esc(row.id)}"`)) : empty('shpEmpty', 'shpEmptyHint'));
}
function renderShipmentDetail(shipment) {
  const orders = new Map([...new Set(shipment.packages.map(pkg => pkg.purchaseOrderId))].map(id => [id, purchaseOrderResource(id)]));
  const orderData = id => orders.get(id)?.data?.siteId === siteId ? orders.get(id).data : null;
  const orderLabel = id => orderData(id)?.poNo ?? id;
  const canWrite = purchaseOrderCanWrite(), next = shipmentNextStatus(shipment);
  let html = `<section class="panel panel-body po-detail"><h2>${esc(shipment.shipmentNo)}</h2><dl class="detail-grid core-details">${[
    ['shpCarrier', coreValue(shipment.carrier)], ['shpShippedOn', coreDate(shipment.shippedOn)],
    ['shpExpectedOn', coreDate(shipment.expectedOn)], ['shpArrivedOn', coreDate(shipment.arrivedOn)],
    ['status', shipmentStatus(shipment.status)], ['poNotes', coreValue(shipment.notes)],
  ].map(([label, value]) => `<div><dt>${t(label)}</dt><dd>${value}</dd></div>`).join('')}</dl>`;
  if (canWrite && shipment.status !== 'received') html += `<div class="heading-actions">${next ? button('shpAdvance', 'shp-transition', `data-id="${esc(shipment.id)}"`) : ''}${button('shpReceipt', 'shp-receipt', `data-id="${esc(shipment.id)}"`)}</div>${shipment.status === 'arrived' && !next ? `<p class="note">${t('shpReceiptRequired')}</p>` : ''}`;
  for (const [id, entry] of orders) if (entry.error) html += `<p role="alert">${t('pkgOrderUnavailable')} ${button('retry', 'po-detail-reload', `data-id="${esc(id)}"`)}</p>`;
  html += `<h3>${t('logisticsPackages')}</h3><p class="note">${t('poQuantityHint')}</p>${coreTable(['pkgNumber', 'pkgOrder', 'status', 'pkgQuantityPacked'], shipment.packages.map(pkg => {
    const entry = packageResource(pkg.id), items = entry.data?.siteId === siteId ? entry.data.items : null;
    return [coreValue(pkg.packageNo), coreValue(orderLabel(pkg.purchaseOrderId)), packageStatus(pkg.status),
      items ? purchaseOrderQuantity(Number(items.reduce((sum, item) => sum + packageThousandths(item.quantityPacked), 0n)) / 1000) : shipmentDependency(entry, 'pkg-detail-reload', pkg.id)];
  }))}<h3>${t('shpReceipts')}</h3>`;
  html += shipment.receipts.length ? coreTable(['shpOrderLine', 'shpQuantityReceived', 'shpReceiptNote', 'pkgCreatedAt'], shipment.receipts.map(receipt => {
    let label;
    for (const [id] of orders) {
      const item = orderData(id)?.items.find(row => row.id === receipt.purchaseOrderItemId);
      if (item) { label = `${orderLabel(id)} · ${t('poLineNo')} ${item.lineNo} · ${item.description}`; break; }
    }
    return [coreValue(label ?? receipt.purchaseOrderItemId), purchaseOrderQuantity(receipt.quantityReceived), coreValue(receipt.note), coreValue(receipt.createdAt ? dateLabel(String(receipt.createdAt).slice(0, 10)) : null)];
  })) : `<p>${t('shpReceiptsEmpty')}</p>`;
  return html + '</section>';
}
function showShipmentForm() {
  return purchaseOrderDialog('shpNew', async (selected, user) => {
    // The list contract has no package membership; read every shipment detail, without a status filter.
    const [packages, headers] = await Promise.all([freshApi.listPackages({ siteId: selected }), freshApi.listShipments({ siteId: selected })]);
    const shipments = await Promise.all(headers.map(row => freshApi.getShipment(row.id)));
    if (packages.some(row => row.siteId !== selected) || shipments.some(row => row.siteId !== selected)) throw new Error('forbidden');
    const taken = new Set(shipments.flatMap(row => row.packages.map(pkg => pkg.id)));
    const available = packages.filter(pkg => !taken.has(pkg.id));
    if (!available.length) return `<p>${t('shpNoPackages')}</p>`;
    return purchaseOrderFormMarkup('shp-form', selected, user, '', '', `<div class="form-grid">${field('shpNumber', 'shipmentNo', '', { required: true, max: 80 })}${field('shpCarrier', 'carrier', '', { max: 200 })}${field('shpShippedOn', 'shippedOn', '', { type: 'date' })}${field('shpExpectedOn', 'expectedOn', '', { type: 'date' })}${field('poNotes', 'notes', '', { type: 'textarea', full: true, max: 10000 })}</div><fieldset class="shipment-packages"><legend>${t('shpChoosePackages')}</legend>${available.map(pkg => `<label><input type="checkbox" name="packageIds" value="${esc(pkg.id)}" data-shipment-package> ${esc(pkg.packageNo)}</label>`).join('')}</fieldset><p class="note">${t('shpPackagesRequired')}</p>`);
  });
}
function showShipmentTransition(id) {
  return purchaseOrderDialog('shpAdvance', async (selected, user) => {
    const shipment = await freshApi.getShipment(id);
    if (shipment.siteId !== selected) throw new Error('forbidden');
    const next = shipmentNextStatus(shipment);
    if (!next) return `<p>${t(shipment.status === 'arrived' ? 'shpReceiptRequired' : 'noTransitions')}</p>`;
    return purchaseOrderFormMarkup('shp-status-form', selected, user, id, '', `<p>${esc(shipment.shipmentNo)} ${shipmentStatus(shipment.status)}</p><p>${t('shpTransitionConfirm')}</p>${field('poNextStatus', 'status', next, { required: true, options: `<option value="${next}">${t(`shpStatus_${next}`)}</option>` })}${field('shpReceiptNote', 'note', '', { type: 'textarea', max: 10000 })}`);
  });
}
function showShipmentReceipt(id) {
  return purchaseOrderDialog('shpReceipt', async (selected, user) => {
    const shipment = await freshApi.getShipment(id);
    if (shipment.siteId !== selected) throw new Error('forbidden');
    if (shipment.status === 'received') return `<p>${t('shpStatusConflict')}</p>`;
    const packages = await Promise.all(shipment.packages.map(pkg => freshApi.getPackage(pkg.id)));
    if (packages.some(row => row.siteId !== selected)) throw new Error('forbidden');
    const orders = await Promise.all([...new Set(packages.map(pkg => pkg.purchaseOrderId))].map(orderId => freshApi.getPurchaseOrder(orderId)));
    if (orders.some(row => row.siteId !== selected)) throw new Error('forbidden');
    const packed = new Set(packages.flatMap(pkg => pkg.items.map(item => item.purchaseOrderItemId)));
    const options = orders.flatMap(order => order.items.filter(item => packed.has(item.id)).sort((a, b) => a.lineNo - b.lineNo).map(item => `<option value="${esc(item.id)}">${esc(`${order.poNo} · ${t('poLineNo')} ${item.lineNo} · ${item.description}`)}</option>`));
    if (!options.length) return `<p>${t('poItemsEmpty')}</p>`;
    return purchaseOrderFormMarkup('shp-receipt-form', selected, user, id, '', `<p>${esc(shipment.shipmentNo)}</p><div class="form-grid">${field('shpOrderLine', 'purchaseOrderItemId', '', { required: true, options: `<option value="">${t('shpChooseItem')}</option>` + options.join('') })}<label class="field"><span>${t('shpQuantityReceived')} *</span><input type="number" name="quantityReceived" required min="0" max="999999999.999" step="0.001"><small>${t('shpQuantityValidation')}</small></label>${field('shpReceiptNote', 'note', '', { type: 'textarea', full: true, max: 10000 })}</div>`);
  });
}
async function submitShipment(form, data) {
  const selected = form.dataset.site, user = session?.user.id, version = modalVersion;
  if (offline || !navigator.onLine) throw new Error('coreOnlineOnly');
  if (!purchaseOrderCanWrite() || selected !== siteId || form.dataset.user !== user) throw new Error('forbidden');
  let id = form.dataset.id;
  if (form.id === 'shp-form') {
    const packageIds = [...form.querySelectorAll('[data-shipment-package]:checked')].map(input => input.value);
    if (!packageIds.length) throw new Error('shpPackagesRequired');
    if (!data.shipmentNo.trim()) throw new Error('shpNumberRequired');
    if ((data.shippedOn && !validDate(data.shippedOn)) || (data.expectedOn && !validDate(data.expectedOn))) throw new Error('invalidDate');
    const saved = await api.createShipment({ siteId: selected, shipmentNo: data.shipmentNo.trim(), carrier: data.carrier.trim() || null,
      shippedOn: data.shippedOn || null, expectedOn: data.expectedOn || null, notes: data.notes || null, packageIds });
    id = saved.id;
  } else if (form.id === 'shp-status-form') {
    if (!SHIPMENT_STATUSES.includes(data.status)) throw new Error('shpStatusConflict');
    await api.transitionShipment(id, data.status, data.note || null);
  } else if (form.id === 'shp-receipt-form') {
    if (!data.purchaseOrderItemId) throw new Error('shpChooseItem');
    if (!/^\d+(?:\.\d{1,3})?$/.test(data.quantityReceived) || Number(data.quantityReceived) > 999999999.999) throw new Error('shpQuantityValidation');
    await api.addShipmentReceipt(id, { purchaseOrderItemId: data.purchaseOrderItemId, quantityReceived: data.quantityReceived, note: data.note || null });
  } else return;
  if (session?.user.id !== user) return;
  const cache = coreCache.get(selected);
  cache?.delete('shipments'); cache?.delete(`shipment:${id}`);
  cache?.delete('packages');
  if (selected !== siteId || version !== modalVersion || !moduleVisible('logistics')) return;
  closeModal(); coreResource('shipments'); coreResource('packages'); render(); toast(t('shpSaved'));
}

function renderTools() {
  const all = coreData('tools'), filter = coreFilters.tools, canWrite = permissions().tools;
  const rows = filterTools(all, filter), companies = toolCompanies(all);
  let html = `<div class="toolbar core-toolbar">${coreSelect('company', 'toolCompany', companies.map(company => [company, company]), filter.company, 'toolAllCompanies')}${coreSelect('status', 'status', TOOL_STATUSES.map(status => [status, t(toolStatusLabelKey(status))]), filter.status, 'allStatuses')}</div>`;
  html += rows.length ? coreTable(['toolName', 'toolCode', 'toolCompany', 'toolStatus', 'toolLocation', ...(canWrite ? ['coreActions'] : [])], rows.map(row => [
    `<strong>${esc(row.name)}</strong>`, coreValue(row.code), coreValue(row.company), coreStatus(row.status, t(toolStatusLabelKey(row.status))), coreValue(row.location),
    ...(canWrite ? [`<div class="tool-actions">${button('edit', 'tool-edit', `data-id="${esc(row.id)}"`, 'small')}${button('coreDelete', 'tool-delete', `data-id="${esc(row.id)}"`, 'danger small')}</div>`] : []),
  ])) : empty('toolEmpty', 'toolEmptyHint');
  return html;
}
function certificationStatusBadge(status) {
  return `<span class="badge cert-status cert-status-${esc(status)}">${esc(t(certStatusLabelKey(status)))}</span>`;
}
function certDaysLeft(row) {
  if (row.daysLeft == null) return t('coreUnknown');
  if (row.daysLeft < 0) return `<span class="cert-overdue">${esc(t('certDaysOverdue').replace('{days}', String(Math.abs(row.daysLeft))))}</span>`;
  return esc(t('certDaysLeft').replace('{days}', String(row.daysLeft)));
}
function renderCertifications() {
  const names = moduleVisible('workforce_names');
  const all = coreData('certifications'), employees = names ? coreData('employees') : [];
  const filter = { ...coreFilters.certifications, ...(!names && { employee: '' }) }, canWrite = permissions().certificationWrite;
  const rows = filterCertifications(all, filter), counts = certificationCounts(all);
  const byEmployee = new Map(employees.map(employee => [employee.id, employee]));
  const kpis = [['certExpired', counts.expired, 'cert-count-expired'], ['certExpiring', counts.expiring, 'cert-count-expiring'],
    ['certValid', counts.valid, 'cert-count-valid'], ['certNoExpiry', counts.no_expiry, 'cert-count-no_expiry']]
    .map(([label, value, css]) => `<div class="panel panel-body"><span>${t(label)}</span><strong class="cert-count ${css}">${value}</strong></div>`).join('');
  let html = `<div class="core-kpis" role="status">${kpis}</div><p class="note">${t('certHint')}</p>`;
  html += `<div class="toolbar core-toolbar">${names ? coreSelect('employee', 'coreEmployee', employees.map(employee => [employee.id, employeeLabel(employee)]), filter.employee, 'coreAllEmployees') : ''}${coreSelect('category', 'certCategory', CERT_CATEGORIES.map(category => [category, t(certCategoryLabelKey(category))]), filter.category, 'certAllCategories')}${coreSelect('status', 'status', CERT_STATUSES.map(status => [status, t(certStatusLabelKey(status))]), filter.status, 'allStatuses')}</div>`;
  html += rows.length ? coreTable([...(names ? ['coreEmployee'] : []), 'certCategory', 'certName', 'certIssuer', 'certIssuedOn', 'certExpiresOn', 'certDays', 'status', ...(canWrite ? ['coreActions'] : [])],
    rows.map(row => [...(names ? [esc(employeeLabel(byEmployee.get(row.employeeId)))] : []), t(certCategoryLabelKey(row.category)), `<strong>${esc(row.name)}</strong>`,
      coreValue(row.issuer), coreDate(row.issuedOn), coreDate(row.expiresOn), certDaysLeft(row), certificationStatusBadge(row.status),
      ...(canWrite ? [`<div class="tool-actions">${button('edit', 'cert-edit', `data-id="${esc(row.id)}"`, 'small')}${button('coreDelete', 'cert-delete', `data-id="${esc(row.id)}"`, 'danger small')}</div>`] : [])])) : empty('certEmpty', 'certEmptyHint');
  return html;
}
function showCertificationForm() {
  if (!permissions().certificationWrite) return toast(t('forbidden'));
  const editing = certEditingId ? coreData('certifications').find(cert => cert.id === certEditingId) : null;
  const names = moduleVisible('workforce_names');
  if (!editing && !names) return toast(t('forbidden'));
  const employees = names ? coreData('employees') : [];
  const employeeOptions = employees.map(employee => `<option value="${esc(employee.id)}" ${(editing?.employeeId || '') === employee.id ? 'selected' : ''}>${esc(employeeLabel(employee))}</option>`).join('');
  const categoryOptions = CERT_CATEGORIES.map(category => `<option value="${category}" ${(editing?.category || 'qualification') === category ? 'selected' : ''}>${t(certCategoryLabelKey(category))}</option>`).join('');
  showModal(t(editing ? 'certEdit' : 'certAdd'), `<form id="cert-form" data-id="${esc(editing?.id || '')}"><div class="form-error" role="alert" tabindex="-1" hidden></div><div class="form-grid">${names ? field('coreEmployee', 'employeeId', editing?.employeeId || '', { required: true, options: employeeOptions }) : ''}${field('certCategory', 'category', editing?.category || 'qualification', { required: true, options: categoryOptions })}${field('certName', 'name', editing?.name || '', { required: true, max: 120 })}${field('certIssuer', 'issuer', editing?.issuer || '', { max: 200 })}${field('certIssuedOn', 'issuedOn', editing?.issuedOn || '', { type: 'date' })}${field('certExpiresOn', 'expiresOn', editing?.expiresOn || '', { type: 'date' })}${field('certOutcome', 'outcome', editing?.outcome || '', { max: 500, full: true })}${field('certNotes', 'notes', editing?.notes || '', { type: 'textarea', full: true, max: 2000 })}</div><div class="form-actions">${button('cancel', 'close-modal')}<button type="submit" class="primary">${t(editing ? 'certSaveChanges' : 'certSave')}</button></div></form>`);
}
function showCertificationDelete(id) {
  if (!permissions().certificationWrite) return toast(t('forbidden'));
  const row = coreData('certifications').find(cert => cert.id === id);
  if (!row) return toast(t('certNotFound'));
  const employee = moduleVisible('workforce_names') && coreData('employees').find(candidate => candidate.id === row.employeeId);
  showModal(t('certDelete'), `<form id="cert-delete-form" data-id="${esc(id)}"><div class="form-error" role="alert" tabindex="-1" hidden></div><p>${t('certDeleteConfirm')}</p><p><strong>${esc(row.name)}</strong>${employee ? ` · ${esc(employeeLabel(employee))}` : ''}${row.expiresOn ? ` · ${coreDate(row.expiresOn)}` : ''}</p><div class="form-actions">${button('cancel', 'close-modal')}<button type="submit" class="danger">${t('coreDelete')}</button></div></form>`);
}
async function submitCertification(form, data) {
  const selected = siteId, user = session?.user.id, version = modalVersion;
  if (offline || !navigator.onLine) throw new Error('coreOnlineOnly');
  if (!permissions().certificationWrite) throw new Error('forbidden');
  if (form.id === 'cert-delete-form') {
    await api.deleteCertification(form.dataset.id);
  } else {
    const input = { siteId: selected, employeeId: data.employeeId, category: data.category, name: data.name,
      issuer: data.issuer, issuedOn: data.issuedOn, expiresOn: data.expiresOn, outcome: data.outcome, notes: data.notes };
    if (form.dataset.id) await api.updateCertification(form.dataset.id, input);
    else await api.createCertification(input);
  }
  if (session?.user.id !== user) return;
  coreCache.get(selected)?.delete('certifications');
  if (selected !== siteId) return;
  if (version === modalVersion) closeModal();
  certEditingId = '';
  render();
  toast(t(form.id === 'cert-delete-form' ? 'certDeleted' : 'certSaved'));
}
function renderHseViewToggle() {
  return `<div class="toolbar"><div class="view-toggle">${[['register', 'hseRegister'], ['inspections', 'hseInspections']].map(([value, key]) => button(key, 'hse-view', `data-value="${value}" aria-pressed="${hseView === value}"`, hseView === value ? 'selected' : '')).join('')}</div></div>`;
}
const hseAssetDetail = { id: '', expanded: new Set() };
function openHseAssetDetail(id) {
  hseAssetDetail.id = id; hseAssetDetail.expanded.clear();
  render();
}
function backToHseInspections() {
  hseAssetDetail.id = ''; hseAssetDetail.expanded.clear();
  render();
}
function toggleHseInspection(id) {
  if (hseAssetDetail.expanded.has(id)) hseAssetDetail.expanded.delete(id);
  else hseAssetDetail.expanded.add(id);
  render();
}
function hseInspectionStatus(status) {
  const styles = { ok: ['closed', 'closed'], due_soon: ['high', 'review'], overdue: ['cert-status-expired', 'overdue'], failed: ['urgent', 'inspectionFailed'], never: ['inspection-never', 'inspectionNever'] };
  const [css, symbol] = styles[status] || styles.never;
  return `<span class="badge core-status inspection-status ${css}">${icon(symbol)}<span>${esc(t(inspectionStatusLabelKey(status)))}</span></span>`;
}
function hseReadBlock(entry) {
  if (entry.error) return `<p role="alert">${esc(errorMessage(entry.error))}</p>`;
  if (entry.pending) return `<p role="status">${t('loading')}</p>`;
  return '';
}
function renderHseAssetDetail() {
  const asset = coreData('hseAssets').find(row => row.id === hseAssetDetail.id);
  if (!asset) return `<p role="alert">${t('hseAssetNotFound')}</p>`;
  const selected = siteId;
  const templates = coreResource('hseInspectionTemplates', () => freshApi.listInspectionTemplates(selected));
  const family = templates.data?.templates.find(row => row.code === asset.templateCode);
  const history = coreResource(`hseInspectionHistory:${asset.id}`, () => freshApi.listInspections({ siteId: selected, assetId: asset.id }));
  const date = value => value ? esc(dateLabel(value)) : '—';
  let html = `<section class="panel hse-subject"><div class="panel-body"><h2>${esc(asset.name)}</h2>${asset.code ? `<small class="note hse-asset-code">${esc(asset.code)}</small>` : ''}
    <p class="note">${esc(family?.title ?? asset.templateTitle ?? '—')}${family?.reference ? `<br>${esc(family.reference)}` : ''}</p>
    ${family?.draft ? `<p class="note">${t('hseAssetChecklistReview')}</p>` : ''}${hseReadBlock(templates)}
    <dl class="detail-grid"><div><dt>${t('status')}</dt><dd>${hseInspectionStatus(asset.status)}</dd></div><div><dt>${t('hseAssetLastInspection')}</dt><dd>${date(asset.lastInspectionOn)}</dd></div><div><dt>${t('hseAssetNextDue')}</dt><dd>${date(asset.nextDueOn)}</dd></div></dl>
    ${family ? `<p class="note">${family.items.length} ${t(family.items.length === 1 ? 'hseAssetCheck' : 'hseAssetChecks')}</p>` : ''}
    ${permissions().hseWrite ? button('hseInspectionNew', 'hse-inspection-new', '', 'primary') : ''}</div></section>
    <section class="panel section-gap hse-history" aria-labelledby="hse-history-title"><div class="panel-header"><h2 id="hse-history-title">${t('hseInspectionHistory')}</h2></div><div class="panel-body">`;
  html += hseReadBlock(history);
  if (history.data && !history.data.length) html += `<p>${t('hseInspectionEmpty')}</p>`;
  if (history.data?.length) html += sortInspections(history.data).map(row => {
    // List headers have no items: fetch the stored snapshot for the tally and reuse it on expansion.
    const detail = coreResource(`hseInspection:${row.id}`, () => freshApi.getInspection(row.id));
    const expanded = hseAssetDetail.expanded.has(row.id);
    const tally = detail.data ? inspectionTally(detail.data.items) : null;
    const outcomeStyle = { pass: 'closed', pass_with_notes: 'high', fail: 'urgent' }[row.outcome] || '';
    return `<article class="hse-history-row"><h3><button type="button" data-command="hse-inspection-toggle" data-id="${esc(row.id)}" aria-expanded="${expanded}" aria-controls="hse-inspection-${esc(row.id)}">${date(row.performedOn)}</button></h3>
      <dl class="detail-grid"><div><dt>${t('hseInspectionPerformer')}</dt><dd>${coreValue(row.performedBy)}</dd></div><div><dt>${t('hseInspectionRole')}</dt><dd>${coreValue(row.performerRole)}</dd></div><div><dt>${t('hseInspectionMode')}</dt><dd>${esc(t(inspectionModeLabelKey(row.mode)))}</dd></div><div><dt>${t('hseInspectionOutcome')}</dt><dd><span class="badge ${outcomeStyle}">${esc(t(inspectionOutcomeLabelKey(row.outcome)))}</span></dd></div><div><dt>${t('hseAssetNextDue')}</dt><dd>${date(row.nextDueOn)}</dd></div></dl>
      ${row.notes ? `<p class="prewrap">${esc(row.notes)}</p>` : ''}
      ${tally ? `<p class="note hse-inspection-tally">${[['ok', tally.ok], ['not_ok', tally.notOk], ['na', tally.na]].map(([result, count]) => `${esc(t(inspectionItemResultLabelKey(result)))}: ${count}`).join(' · ')}</p>` : hseReadBlock(detail)}
      <div id="hse-inspection-${esc(row.id)}"${expanded ? '' : ' hidden'}>${expanded && detail.data ? `<ol class="hse-inspection-items">${detail.data.items.map(item => `<li><span>${esc(item.label)}</span> <span class="badge ${item.result === 'not_ok' ? 'urgent' : item.result === 'ok' ? 'closed' : ''}">${esc(t(inspectionItemResultLabelKey(item.result)))}</span>${item.note ? `<p class="prewrap">${esc(item.note)}</p>` : ''}</li>`).join('')}</ol>${attachmentSection('hse_inspection', row.id)}` : ''}</div></article>`;
  }).join('');
  return html + '</div></section>';
}
function hseAssetCategoryLabel(category) {
  const key = `inspectionCategory_${category}`;
  return Object.hasOwn(messages[language], key) ? t(key) : category || '—';
}
function renderHseAssets() {
  const all = coreData('hseAssets'), canWrite = permissions().hseWrite;
  const rows = sortHseAssets(filterHseAssets(all, hseAssetFilters), hseAssetOrder);
  const counts = hseAssetCounts(rows);
  const categories = [...new Set(all.map(row => row.category).filter(Boolean))]
    .map(category => [category, hseAssetCategoryLabel(category)])
    .sort((a, b) => a[1].localeCompare(b[1], language));
  const summary = ['overdue', 'due_soon', 'failed', 'never', 'ok'].filter(status => counts[status])
    .map(status => `${counts[status]} ${t(`inspectionCount_${status}${counts[status] === 1 ? 'One' : 'Many'}`)}`).join(', ');
  let html = `<div class="toolbar core-toolbar">${coreSelect('category', 'hseAssetCategory', categories, hseAssetFilters.category, 'hseAssetAllCategories')}${coreSelect('status', 'status', INSPECTION_STATUSES.map(status => [status, t(inspectionStatusLabelKey(status))]), hseAssetFilters.status, 'hseAssetAllStatuses')}${coreSelect('order', 'hseAssetOrder', [['due', t('hseAssetOrderDue')], ['name', t('hseAssetOrderName')], ['last', t('hseAssetOrderLast')]], hseAssetOrder)}</div>`;
  html += `<p class="note" role="status">${counts.total} ${t(counts.total === 1 ? 'hseAssetSubject' : 'hseAssetSubjects')}${summary ? ` — ${summary}` : ''}</p>`;
  if (!all.length) return html + `<p class="empty">${t('hseAssetEmpty')} ${canWrite ? button('hseAssetAdd', 'hse-asset-new', '', 'primary') : ''}</p>`;
  if (!rows.length) return html + `<p class="empty">${t('hseAssetFilteredEmpty')} ${button('clearFilters', 'hse-assets-clear')}</p>`;
  // The category repeats the family name in almost every case: it stays in the filter, not in a column.
  return html + coreTable(['hseAssetName', 'hseAssetFamily', 'hseAssetLastInspection', 'hseAssetNextDue', 'status', ...(canWrite ? ['coreActions'] : [])], rows.map(row => {
    return [
      `<div>${coreDetailButton('hseAssets', row, row.name)}${row.code ? `<small class="note hse-asset-code">${esc(row.code)}</small>` : ''}${row.active === false || row.active === 0 ? `<span class="badge">${t('hseAssetInactive')}</span>` : ''}</div>`,
      `<small class="note">${esc(row.templateTitle ?? '—')}</small>`,
      row.lastInspectionOn ? esc(dateLabel(row.lastInspectionOn)) : '—', row.nextDueOn ? esc(dateLabel(row.nextDueOn)) : '—',
      hseInspectionStatus(row.status),
      ...(canWrite ? [button('edit', 'hse-asset-edit', `data-id="${esc(row.id)}"`, 'small')] : []),
    ];
  }));
}
function hseInspectionMessage(error) {
  return error.code === 'INSPECTION_ITEMS_INCOMPLETE' ? t('hseInspectionIncomplete') : t(error.message);
}
async function showHseInspectionForm() {
  if (!permissions().hseWrite) return toast(t('forbidden'));
  if (offline || !navigator.onLine) return toast(t('coreOnlineOnly'));
  const selected = siteId, user = session?.user.id;
  const asset = coreData('hseAssets').find(row => row.id === hseAssetDetail.id);
  if (!asset) return toast(t('hseAssetNotFound'));
  showModal(t('hseInspectionNew'), `<p role="status">${t('loading')}</p>`);
  const version = modalVersion;
  try {
    const { templates } = await freshApi.listInspectionTemplates(selected);
    if (selected !== siteId || session?.user.id !== user || version !== modalVersion) return;
    const family = templates.find(row => row.code === asset.templateCode);
    if (!family?.items.length) throw new Error('hseInspectionTemplateMissing');
    const options = (values, labelKey) => values.map(value => `<option value="${value}">${esc(t(labelKey(value)))}</option>`).join('');
    showModal(t('hseInspectionNew'), `<form id="hse-inspection-form" data-site="${esc(selected)}">
      <div class="form-error" role="alert" tabindex="-1" hidden></div><div class="form-grid">
      ${field('hseInspectionDate', 'performedOn', today(), { type: 'date', required: true })}
      ${field('hseInspectionPerformer', 'performedBy', session.user.name, { required: true, max: 200 })}
      <label class="field" for="field-performerRole"><span>${t('hseInspectionRole')} <small>(${t('optional')})</small></span><input id="field-performerRole" name="performerRole" maxlength="120" list="hse-inspection-roles"></label>
      <datalist id="hse-inspection-roles"><option value="${esc(t('hseInspectionRoleManager'))}"></option><option value="${esc(t('hseInspectionRoleTechnician'))}"></option></datalist>
      ${field('hseInspectionMode', 'mode', 'internal', { required: true, options: options(['internal', 'external'], inspectionModeLabelKey) })}
      <p class="note full" id="hse-inspection-external" hidden>${t('hseInspectionExternalHint')}</p>
      ${field('hseInspectionOutcome', 'outcome', 'pass', { required: true, options: options(['pass', 'pass_with_notes', 'fail'], inspectionOutcomeLabelKey) })}</div>
      <p id="hse-inspection-progress" role="status" aria-live="polite"></p>
      <div class="hse-inspection-checklist">${family.items.map((item, index) => `<div class="hse-inspection-check" data-inspection-row="${index}">
        <span id="hse-check-label-${index}" class="hse-check-label">${esc(item.label)}</span>
        <div class="hse-check-choices" role="group" aria-labelledby="hse-check-label-${index}">${['ok', 'not_ok', 'na'].map(result => button(inspectionItemResultLabelKey(result), 'hse-inspection-result', `data-index="${index}" data-result="${result}" aria-pressed="false"`)).join('')}</div>
        <label class="field hse-check-note" hidden for="hse-check-note-${index}">${t('hseInspectionItemNote')}<textarea id="hse-check-note-${index}" data-inspection-note="${index}" maxlength="2000" disabled></textarea></label>
      </div>`).join('')}</div>
      ${field('hseInspectionNotes', 'notes', '', { type: 'textarea', full: true, max: 2000 })}
      <p id="hse-inspection-missing" role="status" aria-live="polite"></p>
      <div class="form-actions">${button('cancel', 'close-modal')}<button type="submit" class="primary" aria-describedby="hse-inspection-missing" disabled>${t('save')}</button></div></form>`);
    const form = $('#hse-inspection-form');
    form.inspectionAsset = asset;
    form.inspectionUser = user;
    form.inspectionItems = family.items.map(item => ({ code: item.code, result: '', note: '' }));
    form.inspectionOutcomeTouched = false;
    form.addEventListener('change', event => {
      if (event.target.name === 'outcome') form.inspectionOutcomeTouched = true;
      updateHseInspectionForm(form);
    });
    form.addEventListener('input', event => {
      const index = event.target.dataset.inspectionNote;
      if (index !== undefined) form.inspectionItems[Number(index)].note = event.target.value;
    });
    updateHseInspectionForm(form);
  } catch (error) {
    if (selected === siteId && session?.user.id === user && version === modalVersion) showModal(t('hseInspectionNew'), `<p role="alert">${esc(hseInspectionMessage(error))}</p>${button('retry', 'hse-inspection-new')}`);
  }
}
function updateHseInspectionForm(form) {
  const { answered, total, missing } = inspectionProgress(form.inspectionItems);
  form.querySelector('#hse-inspection-progress').textContent = t('hseInspectionProgress').replace('{answered}', answered).replace('{total}', total);
  form.querySelector('#hse-inspection-missing').textContent = missing.length ? t('hseInspectionMissing').replace('{count}', missing.length) : t('hseInspectionComplete');
  form.elements.outcome.value = inspectionSuggestion(form.inspectionItems, form.elements.outcome.value, form.inspectionOutcomeTouched);
  form.querySelector('#hse-inspection-external').hidden = form.elements.mode.value !== 'external';
  form.querySelector('[type=submit]').disabled = Boolean(form.dataset.saving) || missing.length > 0;
}
function setHseInspectionResult(target) {
  const form = target.closest('#hse-inspection-form');
  if (!form || form.dataset.saving) return;
  const index = Number(target.dataset.index), result = target.dataset.result;
  if (!form.inspectionItems[index] || !['ok', 'not_ok', 'na'].includes(result)) return;
  form.inspectionItems[index].result = result;
  const row = target.closest('[data-inspection-row]');
  row.querySelectorAll('[data-result]').forEach(control => control.setAttribute('aria-pressed', String(control.dataset.result === result)));
  row.querySelector('.hse-check-note').hidden = result !== 'not_ok';
  row.querySelector('textarea').disabled = result !== 'not_ok';
  updateHseInspectionForm(form);
}
async function submitHseInspection(form) {
  if (form.dataset.saving) return;
  const selected = form.dataset.site, user = form.inspectionUser, version = modalVersion;
  const errorBox = form.querySelector('.form-error');
  try {
    if (offline || !navigator.onLine) throw new Error('coreOnlineOnly');
    if (selected !== siteId || user !== session?.user.id || !permissions().hseWrite) throw new Error('forbidden');
    if (inspectionProgress(form.inspectionItems).missing.length) {
      updateHseInspectionForm(form); return;
    }
    const fields = typeof dateFormData === 'function' ? dateFormData(form) : Object.fromEntries(new FormData(form));
    if (!fields) return;
    form.dataset.saving = 'true'; errorBox.hidden = true;
    updateHseInspectionForm(form);
    const saved = await api.createInspection(inspectionPayload({ asset: form.inspectionAsset, siteId: selected, fields, items: form.inspectionItems }));
    if (session?.user.id !== user) return;
    const cache = coreCache.get(selected);
    for (const key of ['hseAssets', 'hse', `hseInspectionHistory:${form.inspectionAsset.id}`]) cache?.delete(key);
    if (selected !== siteId) return;
    if (version === modalVersion) closeModal();
    render();
    toast(t('hseInspectionSaved').replace('{date}', saved.nextDueOn ? dateLabel(saved.nextDueOn) : t('noDue')));
  } catch (error) {
    if (version === modalVersion && form.isConnected) {
      errorBox.textContent = hseInspectionMessage(error); errorBox.hidden = false; errorBox.focus();
    }
  } finally {
    delete form.dataset.saving;
    if (form.isConnected) updateHseInspectionForm(form);
  }
}
async function showHseAssetForm(id = '') {
  if (!permissions().hseWrite) return toast(t('forbidden'));
  if (offline || !navigator.onLine) return toast(t('coreOnlineOnly'));
  const selected = siteId, user = session?.user.id;
  const editing = id ? coreData('hseAssets').find(row => row.id === id) : null;
  if (id && !editing) return toast(t('hseAssetNotFound'));
  showModal(t(editing ? 'hseAssetEdit' : 'hseAssetAdd'), `<p role="status">${t('loading')}</p>`);
  const version = modalVersion;
  try {
    const { templates } = await freshApi.listInspectionTemplates(selected);
    if (selected !== siteId || session?.user.id !== user || version !== modalVersion) return;
    const families = `<option value="">${t('coreChoose')}</option>` + templates.map(template => `<option value="${esc(template.code)}" ${editing?.templateCode === template.code ? 'selected' : ''}>${esc(template.title)}</option>`).join('');
    showModal(t(editing ? 'hseAssetEdit' : 'hseAssetAdd'), `<form id="hse-asset-form" data-id="${esc(id)}" data-site="${esc(selected)}"><div class="form-error" role="alert" tabindex="-1" hidden></div><div class="form-grid"><div>${field('name', 'name', editing?.name || '', { required: true, max: 200 })}<p id="hse-asset-name-error" class="form-error" role="alert" hidden></p></div>${field('hseAssetCode', 'code', editing?.code || '', { max: 60 })}${field('hseAssetFamily', 'templateCode', editing?.templateCode || '', { required: true, options: families })}${field('hseAssetNotes', 'notes', editing?.notes || '', { type: 'textarea', full: true, max: 2000 })}${editing ? `<label><input type="checkbox" name="active" ${editing.active ? 'checked' : ''}> ${t('hseAssetActive')}</label>` : ''}</div>${formActions()}</form>`);
    const form = $('#hse-asset-form');
    form.elements.name.setAttribute('aria-describedby', 'hse-asset-name-error');
    form.hseAssetOriginal = editing ? { name: editing.name, code: editing.code ?? '', templateCode: editing.templateCode, notes: editing.notes ?? '', active: Boolean(editing.active) } : null;
  } catch (error) {
    if (selected === siteId && session?.user.id === user && version === modalVersion) showModal(t(editing ? 'hseAssetEdit' : 'hseAssetAdd'), `<p role="alert">${esc(errorMessage(error))}</p>${button('retry', id ? 'hse-asset-edit' : 'hse-asset-new', `data-id="${esc(id)}"`)}`);
  }
}
function hseAssetFormError(form, error) {
  if (['VALIDATION_ERROR', 'TEMPLATE_JURISDICTION_MISMATCH'].includes(error.code)) {
    const target = form.querySelector('.form-error');
    target.textContent = error.message; target.hidden = false; target.focus();
    return;
  }
  if (error.code !== 'DUPLICATE_ASSET_NAME') return formError(form, error);
  const name = form.elements.name, target = form.querySelector('#hse-asset-name-error');
  target.textContent = t('hseAssetDuplicateName'); target.hidden = false;
  name.setAttribute('aria-invalid', 'true'); name.focus();
}
async function submitHseAsset(form, data) {
  const selected = form.dataset.site, user = session?.user.id, version = modalVersion;
  if (offline || !navigator.onLine) throw new Error('coreOnlineOnly');
  if (!permissions().hseWrite || selected !== siteId) throw new Error('forbidden');
  form.querySelector('.form-error').hidden = true;
  form.querySelector('#hse-asset-name-error').hidden = true;
  form.elements.name.removeAttribute('aria-invalid');
  const input = { name: data.name, code: data.code, templateCode: data.templateCode, notes: data.notes };
  if (form.dataset.id) {
    input.active = data.active === 'on';
    const changes = Object.fromEntries(Object.entries(input).filter(([key, value]) => value !== form.hseAssetOriginal[key]));
    await api.updateHseAsset(form.dataset.id, changes);
  } else await api.createHseAsset({ siteId: selected, ...input });
  form.reset(); delete form.hseAssetOriginal;
  if (session?.user.id !== user) return;
  coreCache.get(selected)?.delete('hseAssets');
  if (selected !== siteId) return;
  if (version === modalVersion) closeModal();
  render();
  toast(t('hseAssetSaved'));
}
function renderHse() {
  const all = coreData('hse'), filter = coreFilters.hse, canWrite = permissions().hseWrite;
  const rows = filterHseEvents(all, filter), counts = hseCounts(all);
  const kpis = [...HSE_TYPES, 'total'].map(type => `<div class="panel panel-body"><span>${t(type === 'total' ? 'hseTotal' : `hseType_${type}`)}</span><strong class="cert-count">${counts[type]}</strong></div>`).join('');
  const period = [['from', 'hseFrom'], ['to', 'hseTo']].map(([key, label]) => `<label class="field core-filter"><span>${t(label)}</span>${dateInput(`hse-date-${key}`, filter[key], `data-core-filter="${key}"`)}</label>`).join('');
  let html = `<p class="note">${t('hsePrivacy')}</p><div class="core-kpis" role="status">${kpis}</div><p class="note">${t('hseSummaryHint')}</p>`;
  html += `<div class="toolbar core-toolbar">${coreSelect('type', 'hseType', HSE_TYPES.map(type => [type, t(`hseType_${type}`)]), filter.type, 'hseAllTypes')}${coreSelect('severity', 'hseSeverity', HSE_SEVERITIES.map(severity => [severity, t(`hseSeverity_${severity}`)]), filter.severity, 'hseAllSeverities')}<div class="hse-period-filters">${period}</div></div>`;
  if (filter.from && filter.to && filter.from > filter.to) return html + `<p role="alert">${t('hsePeriodInvalid')}</p>`;
  html += rows.length ? coreTable(['hseOccurredOn', 'hseEventNo', 'hseType', 'hseSeverity', 'hseLocation', 'hsePersons', 'hseMeasures', 'coreActions'], rows.map(row => [
    coreDate(row.occurredOn), coreValue(row.eventNo), t(`hseType_${row.type}`)
      + (['inspection', 'external_visit'].includes(row.type) && row.inspectionId && row.assetId
        ? ` ${button('hseInspectionOpen', 'hse-inspection-open', `data-inspection-id="${esc(row.inspectionId)}" data-asset-id="${esc(row.assetId)}"`, 'small')}` : ''),
    coreStatus(row.severity, t(`hseSeverity_${row.severity}`)),
    coreValue(row.location), row.personsInvolved == null ? '—' : coreNumber(row.personsInvolved, 'count'), coreValue(row.measures),
    canWrite ? `<div class="tool-actions hse-actions">${button('edit', 'hse-edit', `data-id="${esc(row.id)}"`, 'small')}<span aria-hidden="true">·</span>${button('coreDelete', 'hse-delete', `data-id="${esc(row.id)}"`, 'danger small')}</div>`
      : button('attachments', 'hse-attachments', `data-id="${esc(row.id)}"`, 'small'),
  ])) : empty('hseEmpty', 'hseEmptyHint');
  return html;
}
function showHseAttachments(id) {
  if (!permissions().hse || !moduleVisible('hse') || !coreData('hse').some(row => row.id === id)) return;
  showModal(t('attachments'), attachmentSection('hse_event', id));
}
function showHseForm() {
  if (!permissions().hseWrite) return toast(t('forbidden'));
  const editing = hseEditingId ? coreData('hse').find(row => row.id === hseEditingId) : null;
  if (hseEditingId && !editing) return toast(t('hseNotFound'));
  const options = (values, prefix, selected) => values.map(value => `<option value="${value}" ${selected === value ? 'selected' : ''}>${t(`${prefix}_${value}`)}</option>`).join('');
  showModal(t(editing ? 'hseEdit' : 'hseAdd'), `<form id="hse-form" data-id="${esc(editing?.id || '')}"><div class="form-error" role="alert" tabindex="-1" hidden></div><p class="note">${t('hsePrivacy')}</p><div class="form-grid">${field('hseOccurredOn', 'occurredOn', editing?.occurredOn || '', { type: 'date', required: true })}${field('hseEventNo', 'eventNo', editing?.eventNo || '', { max: 120 })}${field('hseType', 'type', editing?.type || 'near_miss', { required: true, options: options(HSE_MANUAL_TYPES, 'hseType', editing?.type || 'near_miss') })}${field('hseSeverity', 'severity', editing?.severity || 'low', { required: true, options: options(HSE_SEVERITIES, 'hseSeverity', editing?.severity || 'low') })}${field('hseLocation', 'location', editing?.location || '', { max: 200 })}<label class="field"><span>${t('hsePersons')} <small>(${t('optional')})</small></span><input type="number" name="personsInvolved" min="0" max="2147483647" step="1" value="${esc(editing?.personsInvolved ?? '')}"><small>${t('hsePersonsHint')}</small></label>${field('hseMeasures', 'measures', editing?.measures || '', { type: 'textarea', full: true, max: 2000 })}${field('hseNotes', 'notes', editing?.notes || '', { type: 'textarea', full: true, max: 2000 })}</div>${formActions()}</form>${editing ? attachmentSection('hse_event', editing.id) : ''}`);
}
function showHseDelete(id) {
  if (!permissions().hseWrite) return toast(t('forbidden'));
  const row = coreData('hse').find(candidate => candidate.id === id);
  if (!row) return toast(t('hseNotFound'));
  showModal(t('hseDelete'), `<form id="hse-delete-form" data-id="${esc(id)}"><div class="form-error" role="alert" tabindex="-1" hidden></div><p>${t('hseDeleteConfirm')}</p><p><strong>${coreDate(row.occurredOn)}</strong> · ${esc(t(`hseType_${row.type}`))}${row.eventNo ? ` · ${esc(row.eventNo)}` : ''}</p><div class="form-actions">${button('cancel', 'close-modal')}<button type="submit" class="danger">${t('coreDelete')}</button></div></form>`);
}
async function submitHse(form, data) {
  const selected = siteId, user = session?.user.id, version = modalVersion;
  if (offline || !navigator.onLine) throw new Error('coreOnlineOnly');
  if (!permissions().hseWrite) throw new Error('forbidden');
  if (form.id === 'hse-delete-form') await api.deleteHseEvent(form.dataset.id);
  else {
    const input = { siteId: selected, eventNo: data.eventNo, type: data.type, severity: data.severity,
      occurredOn: data.occurredOn, location: data.location, personsInvolved: data.personsInvolved === '' ? null : Number(data.personsInvolved),
      measures: data.measures, notes: data.notes };
    if (form.dataset.id) await api.updateHseEvent(form.dataset.id, input);
    else await api.createHseEvent(input);
  }
  if (session?.user.id !== user) return;
  coreCache.get(selected)?.delete('hse');
  if (selected !== siteId) return;
  if (version === modalVersion) closeModal();
  hseEditingId = '';
  render(); toast(t(form.id === 'hse-delete-form' ? 'hseDeleted' : 'hseSaved'));
}
function renderImpacts() {
  const rows = filterSortRecords(coreData('impacts'), coreFilters.impacts, [{ key: 'createdAt', descending: true }]), totals = impactTotals(rows);
  return `<div class="core-kpis" role="status">${[['coreTotalClaim', totals.claimAmount, totals.missingClaim], ['coreTotalSettlement', totals.settlementAmount, totals.missingSettlement]].map(([label, amount, missing]) => `<div class="panel panel-body"><span>${t(label)}</span><strong class="money">${money(amount)}</strong>${missing ? `<small>${missing} ${t(missing === 1 ? 'coreMissingAmountOne' : 'coreMissingAmounts')}</small>` : ''}</div>`).join('')}</div><p class="note">${t('coreAmountsHint')}</p><div class="toolbar core-toolbar">${coreSelect('status', 'status', IMPACT_STATUSES.map(value => [value, t(value)]), coreFilters.impacts.status, 'allStatuses')}${coreSelect('result', 'coreResult', IMPACT_RESULTS.map(value => [value, t(value)]), coreFilters.impacts.result, 'coreAllResults')}</div>` +
    (rows.length ? coreTable(['title', 'status', 'coreClaimAmount', 'coreSettlementAmount', 'coreResult'], rows.map(row => [coreDetailButton('impacts', row), coreStatus(row.status, impactLabel(row.status)), money(row.claimAmount), money(row.settlementAmount), coreValue(row.result == null ? null : t(row.result))])) : empty('noResults', 'noResultsHint'));
}
function coreFields(row, fields) {
  return `<dl class="detail-grid core-details">${fields.map(([key, label = key, format]) => {
    const value = row[key];
    const content = format ? format(value) : ['status', 'result', 'priority'].includes(key) && value != null
      ? esc(t(value)) : typeof value === 'boolean' ? t(value ? 'coreYes' : 'coreNo') : coreValue(value);
    return `<div><dt>${t(label)}</dt><dd>${content}</dd></div>`;
  }).join('')}</dl>`;
}
function progressStepsSection(row) {
  const types = coreData('progressTypes') || [];
  const type = types.find(candidate => candidate.id === row.progressTypeId);
  const steps = row.steps || [], rights = permissions();
  let html = rights.steps ? `<form id="progress-hours-form" data-id="${esc(row.id)}"><div class="form-error" role="alert" tabindex="-1" hidden></div><label class="field">${t('corePlannedHours')}<input name="planned_hours" type="number" min="0" max="1000000" step="any" value="${row.plannedHours == null ? '' : esc(row.plannedHours)}"></label><p class="note">${t('corePlannedHoursHint')}</p><div class="form-actions"><button type="submit" class="primary">${t('save')}</button></div></form>`
    : `<p>${t('corePlannedHours')}: ${coreNumber(row.plannedHours, 'hours')}</p>`;
  html += `<h3>${t('coreProgressType')}</h3>`;
  html += type ? `<p><strong>${esc(type.name)}</strong> <span class="badge">${esc(type.code)}</span></p>` : `<p>${t('coreNoProgressType')}</p>`;
  if (steps.length) html += coreTable(['coreStep', 'coreDescription', 'coreWeight', 'coreStepPercent'],
    steps.map(step => [esc(step.code), coreValue(step.description), coreNumber(step.weight),
      step.percent == null ? t('coreUnknown') : `${coreNumber(step.percent, 'percent')}%`]));
  if (rights.steps && steps.length) html += `<form id="progress-steps-form" data-id="${esc(row.id)}"><div class="form-error" role="alert" tabindex="-1" hidden></div><h3>${t('coreRecordSteps')}</h3><div class="core-entry-grid">${steps.map(step => `<label class="field">${esc(step.code)}<input name="percent-${esc(step.id)}" type="number" min="0" max="100" step="1" value="${step.percent == null ? '' : esc(step.percent)}" placeholder="0"></label>`).join('')}</div><div class="form-actions"><button type="submit" class="primary">${t('coreSaveSteps')}</button></div></form>`;
  if (rights.assign) html += `<form id="progress-type-form" data-id="${esc(row.id)}"><div class="form-error" role="alert" tabindex="-1" hidden></div><label class="field">${t('coreAssignType')}<select name="progress_type_id"><option value="">${t('coreNoProgressType')}</option>${types.map(candidate => `<option value="${esc(candidate.id)}" ${candidate.id === row.progressTypeId ? 'selected' : ''}>${esc(`${candidate.code} · ${candidate.name}`)}</option>`).join('')}</select></label><div class="form-actions"><button type="submit" class="primary">${t('coreSaveType')}</button></div></form>`;
  return html;
}
// Assistant: one conversation at a time, kept in memory for the session.
const AI_SUGGESTIONS = {
  overview: ['aiSuggestOverview', 'aiSuggestOverviewHours', 'aiSuggestOverviewClaims'],
  tasks: ['aiSuggestTasks', 'aiSuggestTasksDue', 'aiSuggestTasksBlocked'],
  deviations: ['aiSuggestDeviations', 'aiSuggestDeviationsByArea', 'aiSuggestDeviationsOld'],
  progress: ['aiSuggestProgress', 'aiSuggestProgressBooked', 'aiSuggestProgressSections'],
  bookings: ['aiSuggestBookings', 'aiSuggestBookingsWeek', 'aiSuggestBookingsMissing'],
  impacts: ['aiSuggestImpacts', 'aiSuggestImpactsOpen', 'aiSuggestImpactsSettled'],
  diary: ['aiSuggestDiary', 'aiSuggestDiaryBlockers', 'aiSuggestDiaryWeek'],
};
const AI_MODULES = { deviations: 'deviations', site_progress_items: 'progress', cost_impacts: 'impacts' };
const assistantErrorKeys = {
  ASSISTANT_DISABLED: 'aiErrorDisabled', ASSISTANT_TIMEOUT: 'aiErrorTimeout',
  ASSISTANT_AUTH: 'aiErrorAuth', ASSISTANT_RATE_LIMITED: 'aiErrorRate',
  ASSISTANT_UNAVAILABLE: 'aiErrorUnavailable', ASSISTANT_NOT_CONFIGURED: 'aiErrorUnavailable', NETWORK_ERROR: 'aiErrorUnavailable',
};
function renderAssistant() {
  const panel = $('#ai-panel');
  panel.setAttribute('aria-label', t('aiTitle'));
  $('#ai-title').textContent = t('aiTitle');
  $('[data-command="ai-close"]').setAttribute('aria-label', t('close'));
  $('#ai-form [name=message]').placeholder = t('aiPlaceholder');
  const send = $('#ai-form button');
  send.textContent = t('aiSend');
  send.disabled = aiBusy;
  const error = $('#ai-error');
  error.hidden = !aiError;
  error.textContent = aiError ? (assistantErrorKeys[aiError.code] ? t(assistantErrorKeys[aiError.code]) : errorMessage(aiError)) : '';
  $('#ai-log').innerHTML = aiMessages.map(message => message.role === 'user'
    ? `<p class="ai-msg ai-user">${esc(message.content)}</p>`
    : `<div class="ai-msg ai-bot"><p>${esc(message.content).replace(/\n/g, '<br>')}</p>${
      (message.citations || []).length ? `<p class="ai-cites">${message.citations.map(cite => AI_MODULES[cite.family]
        ? `<button type="button" class="badge" data-command="core-detail" data-module="${AI_MODULES[cite.family]}" data-id="${esc(cite.id)}">${esc(cite.label)}</button>`
        : `<span class="badge">${esc(cite.label)}</span>`).join(' ')}</p>` : ''}</div>`).join('');
  $('#ai-log').scrollTop = $('#ai-log').scrollHeight;
  const suggestions = (AI_SUGGESTIONS[view] || []).map(key => t(key));
  $('#ai-suggestions').innerHTML = aiBusy ? `<p class="note">${t('aiThinking')}</p>`
    : (aiMessages.length ? '' : suggestions.map(text => `<button type="button" class="ai-chip" data-command="ai-suggest" data-text="${esc(text)}">${esc(text)}</button>`).join(''));
}
async function askAssistant(text) {
  if (!text || aiBusy || !assistantAvailable()) return;
  const transcript = aiMessages, selected = siteId, user = session.user.id;
  const isCurrent = () => transcript === aiMessages && selected === siteId && user === session?.user.id && assistantAvailable();
  transcript.push({ role: 'user', content: text });
  aiError = null;
  aiBusy = true; renderAssistant();
  try {
    const result = await api.assistantChat({ site_id: selected, view, language, messages: transcript.slice(-6) });
    if (isCurrent()) transcript.push({ role: 'assistant', content: result.reply, citations: result.citations });
  } catch (error) {
    if (!isCurrent()) return;
    if (error.code === 'ASSISTANT_DISABLED') {
      currentSite().assistant_enabled = false;
      renderAssistantChrome();
      toast(t('aiErrorDisabled'));
      return;
    }
    aiError = error;
  } finally {
    if (isCurrent()) { aiBusy = false; renderAssistant(); }
  }
}

// Import runs in two steps: a preview that writes nothing, then a confirmation bound to that preview.
let importPreview = null;
const canImport = () => ['owner', 'editor'].includes(role());
const IMPORT_FAMILIES = ['employees', 'work_days', 'time_schedule', 'site_progress_items', 'deviations', 'daily_log'];
const formatImportAliases = aliases => aliases.map(alias => alias.replaceAll('\\', '\\\\').replaceAll(',', '\\,')).join(', ');
function parseImportAliases(input) {
  const aliases = [''];
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (char === '\\' && [',', '\\'].includes(input[i + 1])) aliases[aliases.length - 1] += input[++i];
    else if (char === ',') aliases.push('');
    else aliases[aliases.length - 1] += char;
  }
  return aliases.map(alias => alias.trim());
}
const fileToBase64 = file => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
  reader.onerror = () => reject(new Error('invalidData'));
  reader.readAsDataURL(file);
});
function passkeyError(error) {
  const key = { WEBAUTHN_NOT_CONFIGURED: 'passkeyNotConfigured', LAST_CREDENTIAL: 'passkeyLastCredential', INVALID_CREDENTIALS: 'passkeyInvalid', NOT_FOUND: 'passkeyNotFound' }[error.code];
  if (key) return t(key);
  if (error.message?.startsWith('passkey')) return t(error.message);
  // Preserve unknown server failures, including their diagnostic code.
  return error.code && !['NETWORK_ERROR', 'INVALID_RESPONSE'].includes(error.code)
    ? `${errorMessage(error)} (${error.code}): ${error.message}` : errorMessage(error);
}
function passkeyFormError(form, error) {
  formError(form, error, passkeyError);
}

function localizeLogin(form) {
  $('#main').querySelectorAll('[data-login-text]').forEach(element => {
    element.textContent = t(element.dataset.loginText);
  });
  form.querySelector('.password-toggle').setAttribute('aria-label',
    t(form.elements.password.type === 'password' ? 'showPassword' : 'hidePassword'));
  const error = form.querySelector('.form-error');
  if (!error.hidden) error.textContent = error.localizedMessage();
  updateLoginRetry(form);
}

let loginRetryUntil = 0, loginRetryTimer;
function updateLoginRetry(form = $('#login-form')) {
  clearTimeout(loginRetryTimer);
  if (!form) return;
  const submit = form.querySelector('[type=submit]');
  const notice = form.querySelector('#login-rate-limit');
  const remainingMs = loginRetryUntil - Date.now();
  const remaining = Math.max(0, Math.ceil(remainingMs / 1000));
  submit.disabled = Boolean(form.dataset.saving) || remaining > 0;
  notice.hidden = remaining === 0;
  if (!remaining) {
    submit.textContent = t('login');
    return;
  }
  const minutes = Math.ceil(remaining / 60);
  const message = t(minutes === 1 ? 'loginRetryMinute' : 'loginRetryMinutes').replace('{minutes}', minutes);
  if (notice.textContent !== message) notice.textContent = message;
  const time = `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`;
  submit.textContent = `${t('login')} (${time})`;
  loginRetryTimer = setTimeout(updateLoginRetry, remainingMs % 1000 || 1000);
}

async function passkeyLogin(discoverable) {
  const form = $('#login-form');
  if (!form || form.dataset.saving) return;
  const email = form.elements.email;
  if (!discoverable && !email.reportValidity()) return;
  form.dataset.saving = 'true';
  const controls = [...form.querySelectorAll('button')];
  controls.forEach(control => { control.disabled = true; });
  try {
    await accountLock(async () => {
      await flushLogout();
      await runPasskey(api, 'login', discoverable ? { discoverable: true } : { email: email.value.trim() });
      await forgetActive(); clearSession(); accountChannel?.postMessage('changed');
    });
    await loadData({ signedIn: true }); await syncQueue();
  } catch (error) { if (form.isConnected) passkeyFormError(form, error); }
  finally {
    delete form.dataset.saving;
    controls.forEach(control => { control.disabled = false; });
    if (form.isConnected) updateLoginRetry(form);
  }
}
async function showPasskeySecurity() {
  if (!session) return;
  showModal(t('passkeySecurity'), `<div id="passkey-panel"><div class="form-error" role="alert" tabindex="-1" hidden></div><p role="status">${t('loading')}</p></div>`);
  const panel = $('#passkey-panel'), version = modalVersion, user = session.user.id;
  try {
    const rows = await api.listCredentials();
    if (!panel.isConnected || version !== modalVersion || session?.user.id !== user) return;
    panel.innerHTML = `<form data-passkey-action="register"><div class="form-error" role="alert" tabindex="-1" hidden></div><button type="submit" ${supportsPasskeys() ? '' : 'disabled'}>${t('passkeyAdd')}</button></form>${!supportsPasskeys() ? `<p>${t('passkeyUnsupported')}</p>` : ''}${rows.length ? rows.map(row => `<section class="passkey-card"><form data-passkey-action="rename" data-id="${esc(row.id)}"><div class="form-error" role="alert" tabindex="-1" hidden></div><label class="field">${t('passkeyName')}<input name="name" value="${esc(row.name)}" required maxlength="100"></label><p>${t('passkeyCreated')}: ${esc(timeLabel(row.created_at))}</p><p>${t('passkeyLastUsed')}: ${row.last_used_at ? esc(timeLabel(row.last_used_at)) : t('passkeyNever')}</p><button type="submit">${t('passkeyRename')}</button></form><form data-passkey-action="delete" data-id="${esc(row.id)}"><div class="form-error" role="alert" tabindex="-1" hidden></div><button type="submit" class="danger" aria-label="${esc(t('passkeyDelete') + ': ' + row.name)}">${t('passkeyDelete')}</button></form></section>`).join('') : `<p>${t('passkeyEmpty')}</p>`}<div class="heading-actions">${button('retry', 'passkey-refresh')}${button('close', 'close-modal')}</div>`;
    $('#modal').initialFormState = modalFormState();
    panel.querySelector('button:not(:disabled)')?.focus();
  } catch (error) {
    if (panel.isConnected && version === modalVersion) {
      panel.innerHTML = `<div class="form-error" role="alert" tabindex="-1">${esc(passkeyError(error))}</div>${button('retry', 'passkey-refresh')}`;
      panel.querySelector('[role=alert]').focus();
    }
  }
}
async function submitPasskeyForm(event) {
  const form = event.target;
  if (!form.dataset.passkeyAction) return;
  event.preventDefault();
  const panel = form.closest('#passkey-panel');
  if (panel.dataset.saving) return;
  const action = form.dataset.passkeyAction;
  if (action === 'delete' && !confirm(t('passkeyDeleteConfirm'))) return;
  panel.dataset.saving = 'true';
  const version = modalVersion, user = session?.user.id;
  const controls = [...panel.querySelectorAll('button, input')].filter(control => !control.disabled);
  const name = form.elements.name?.value.trim();
  controls.forEach(control => { control.disabled = true; });
  try {
    if (action === 'register') await runPasskey(api, 'register');
    else if (action === 'rename') await api.renameCredential(form.dataset.id, name);
    else await api.deleteCredential(form.dataset.id);
    if (version === modalVersion && session?.user.id === user && panel.isConnected) await showPasskeySecurity();
  } catch (error) { if (version === modalVersion && panel.isConnected) passkeyFormError(form, error); }
  finally { delete panel.dataset.saving; controls.forEach(control => { control.disabled = false; }); }
}


function showSettingsForm() {
  let account = '';
  if (session) {
    const siteRole = role();
    account = `<section class="account-summary" aria-labelledby="account-heading">
      <h3 id="account-heading">${t('accountSection')}</h3>
      <p><strong>${esc(session.user.name)}</strong><br>${esc(session.user.email)}</p>
      <dl>
        <dt>${t('accountUserType')}</dt>
        <dd>${t(siteRole ? `responsibleRole_${siteRole}` : 'accountNoRole')} <small>${t('accountCurrentSite')}</small></dd>
      </dl>
      <div class="account-actions">${button('changePassword', 'change-password')}${button('passkeySecurity', 'passkey-security')}</div>
    </section>`;
  }
  const site = currentSite();
  const siteSettings = site && role() === 'owner' ? `<form id="site-settings-form" data-site="${esc(site.id)}">
    <h3>${t('siteSettings')} · ${esc(site.name)}</h3>
    <div class="form-error" role="alert" tabindex="-1" hidden></div>
    <div class="form-grid">
      <label class="field">${t('siteTimeZone')}<input name="time_zone" list="site-time-zones" value="${esc(timeZoneForSite(site))}" required ${offline ? 'disabled' : ''}></label>
      <datalist id="site-time-zones"><option value="Europe/Rome">${t('siteZoneRome')}</option><option value="Europe/London">${t('siteZoneLondon')}</option><option value="UTC"></option></datalist>
      <label class="field">${t('siteDayCutoff')}<input type="time" name="day_cutoff_time" value="${esc(site.day_cutoff_time ?? '06:00')}" required ${offline ? 'disabled' : ''}></label>
    </div><div class="form-actions"><button type="submit" class="primary" ${offline ? 'disabled' : ''}>${t('siteSettingsSave')}</button></div></form>` : '';
  const assistantSettings = site && role() ? `<section aria-labelledby="ai-settings-heading">
    <h3 id="ai-settings-heading">${t('aiSettings')} · ${esc(site.name)}</h3>
    ${role() === 'owner' ? `<form id="site-assistant-form" data-site="${esc(site.id)}">
      <div class="form-error" role="alert" tabindex="-1" hidden></div>
      <div class="form-grid">
        <label class="view-checkbox"><input type="checkbox" name="enabled" role="switch" ${site.assistant_enabled === true ? 'checked' : ''} ${offline ? 'disabled' : ''}>${t('aiEnable')}</label>
        <label class="field">${t('aiTimeoutSetting')}<input type="number" name="timeout_ms" min="5000" max="60000" step="1" value="${esc(site.assistant_timeout_ms ?? 20000)}" required ${offline ? 'disabled' : ''}></label>
      </div><div class="form-actions"><button type="submit" class="primary" ${offline ? 'disabled' : ''}>${t('aiSettingsSave')}</button></div></form>`
    : `<p>${t(site.assistant_enabled === true ? 'aiEnabled' : 'aiDisabled')}</p>`}
    </section>` : '';
  showModal(t('settingsTitle'), `${account}${siteSettings}${assistantSettings}<form id="settings-form"><p class="note">${t('settingsHint')}</p><div class="form-grid">
    <label class="field">${t('settingsCurrency')}<select name="currency">${['EUR', 'USD', 'GBP', 'CHF'].map(code => `<option value="${code}" ${prefs.currency === code ? 'selected' : ''}>${code}</option>`).join('')}</select></label>
    <label class="field">${t('settingsSeparators')}<select name="separators"><option value="auto" ${prefs.separators === 'auto' ? 'selected' : ''}>${t('settingsSeparatorsAuto')}</option><option value="it" ${prefs.separators === 'it' ? 'selected' : ''}>1.234,56 (IT)</option><option value="en" ${prefs.separators === 'en' ? 'selected' : ''}>1,234.56 (EN)</option></select></label>
    </div>${formActions()}</form>`);
}

async function showImportForm() {
  if (!canImport()) return;
  importPreview = null;
  showModal(t('importTitle'), `<form id="import-form"><div class="form-error" role="alert" tabindex="-1" hidden></div>` +
    `<p class="note">${t('importHint')}</p>` +
    `<div class="form-grid"><label class="field">${t('importFamily')}<select name="family" required>${IMPORT_FAMILIES.map(family => `<option value="${family}">${t(`importFamily_${family}`)}</option>`).join('')}</select></label>` +
    `<div class="field">${button('importTemplateDownload', 'import-template-download')}</div>` +
    `<label class="field">${t('importFile')}<input name="file" type="file" accept=".xlsx" required></label></div>` +
    `<p class="note">${t('importTemplateHint')}</p>` +
    `<details id="import-mapping"><summary>${t('importMappingTitle')}</summary><p class="note">${t('importMappingHint')}</p><fieldset disabled><div id="import-mapping-fields"></div>` +
    `<p id="import-identity-order" class="note" aria-live="polite"></p><div class="form-actions">${button('importMappingSave', 'import-mapping-save')}${button('importMappingReset', 'import-mapping-reset')}</div></fieldset></details>` +
    `<p id="import-preview-hint" class="note" role="status">${t('importPreviewRequired')}</p><div id="import-result" class="import-result"></div><div class="form-actions">${button('importClose', 'close-modal')}<button type="submit" class="primary" disabled>${t('importPreview')}</button></div></form>`);
  const form = $('#import-form'), selected = siteId, version = modalVersion;
  form.dataset.siteId = selected;
  try {
    const mappings = await freshApi.listImportMappings(selected);
    if (!form.isConnected || version !== modalVersion || siteId !== selected) return;
    const pristine = modalFormState() === $('#modal').initialFormState;
    form.importMappings = mappings;
    renderImportMapping(form);
    if (pristine) $('#modal').initialFormState = modalFormState();
  } catch (error) { if (form.isConnected && version === modalVersion) formError(form, error); }
}
async function downloadImportTemplate(target) {
  const form = target.closest('form');
  if (!canImport() || !form || target.disabled) return;
  target.disabled = true;
  try {
    const file = await api.importTemplate(form.elements.family.value);
    download(file.blob, file.blob.type, file.filename);
  } catch (error) { if (form.isConnected) formError(form, error); }
  finally { target.disabled = false; }
}
function renderImportMapping(form) {
  const mapping = form.importMappings.find(item => item.family === form.elements.family.value);
  form.importIdentity = [...mapping.identity];
  form.mappingDirty = false;
  form.querySelector('#import-mapping-fields').innerHTML = mapping.fields.map(field =>
    `<div class="form-grid"><label class="field">${esc(field)} — ${t('importMappingAliases')}<input type="text" data-import-alias="${esc(field)}" value="${esc(formatImportAliases(mapping.aliases[field] || []))}"></label>` +
    `<label><input type="checkbox" data-import-identity="${esc(field)}" ${mapping.identity.includes(field) ? 'checked' : ''}> ${t('importMappingIdentity')} (${esc(field)})</label></div>`).join('');
  form.querySelector('#import-mapping fieldset').disabled = false;
  updateImportIdentityOrder(form);
  invalidateImportPreview(form);
}
function updateImportIdentityOrder(form) {
  form.querySelector('#import-identity-order').textContent = `${t('importMappingOrder')}: ${form.importIdentity.join(' → ')}`;
}
function invalidateImportPreview(form) {
  importPreview = null;
  form.importRevision = (form.importRevision || 0) + 1;
  form.querySelector('#import-result').innerHTML = '';
  form.querySelector('#import-preview-hint').textContent = t(form.mappingDirty ? 'importMappingUnsaved' : 'importPreviewRequired');
  const submit = form.querySelector('[type=submit]');
  submit.textContent = t('importPreview'); delete submit.dataset.step;
  submit.disabled = !!form.dataset.saving || !form.importMappings || form.mappingDirty;
}
async function changeImportMapping(reset = false) {
  const form = $('#import-form');
  if (!form || form.dataset.saving || !form.importMappings) return;
  form.dataset.saving = 'true';
  const family = form.elements.family.value, selected = form.dataset.siteId, version = modalVersion;
  const aliases = Object.fromEntries([...form.querySelectorAll('[data-import-alias]')]
    .filter(input => input.value.trim()).map(input => [input.dataset.importAlias, parseImportAliases(input.value)]));
  const identity = [...form.importIdentity];
  invalidateImportPreview(form);
  form.querySelector('#import-mapping fieldset').disabled = true;
  form.elements.family.disabled = true; form.elements.file.disabled = true;
  try {
    const mapping = reset ? await api.deleteImportMapping(selected, family) : await api.saveImportMapping({ site_id: selected, family, aliases, identity });
    if (!form.isConnected || version !== modalVersion || siteId !== selected) return;
    form.importMappings = form.importMappings.map(item => item.family === family ? mapping : item);
    form.querySelector('.form-error').hidden = true;
    renderImportMapping(form);
  } catch (error) { if (form.isConnected && version === modalVersion) formError(form, error); }
  finally {
    delete form.dataset.saving;
    form.querySelector('#import-mapping fieldset').disabled = false;
    form.elements.family.disabled = false; form.elements.file.disabled = false;
    form.querySelector('[type=submit]').disabled = !form.importMappings || form.mappingDirty;
  }
}
function renderImportPreview(preview) {
  const counts = preview.counts || {};
  const rows = [['added', 'importAdded'], ['updated', 'importUpdated'], ['unchanged', 'importUnchanged'], ['removed', 'importRemoved'], ['rejected', 'importRejected']]
    .map(([key, label]) => `<li><strong>${counts[key] ?? 0}</strong> ${t(label)}</li>`).join('');
  const rejected = (preview.samples?.rejected || []).slice(0, 8)
    .map(row => {
      const reason = row.rejected === 'AMBIGUOUS_NUMBER' ? t('importAmbiguousNumber') : row.reason;
      return `<li>${esc(row.source_row ?? '')} — ${esc(row.rejected || '')}${reason ? `: ${esc(reason)}` : ''}</li>`;
    }).join('');
  return `<h3>${t('importPreviewTitle')}</h3><ul class="import-counts">${rows}</ul>` +
    (rejected ? `<h4>${t('importRejectedRows')}</h4><ul class="import-rejected">${rejected}</ul>` : '');
}
async function handleImport(form) {
  if (!form.importMappings || form.mappingDirty) throw new Error('importMappingUnsaved');
  const revision = form.importRevision, version = modalVersion, selected = form.dataset.siteId;
  const current = () => form.isConnected && modalVersion === version && siteId === selected && form.importRevision === revision;
  const data = Object.fromEntries(new FormData(form));
  const file = form.elements.file.files[0];
  if (!(file instanceof File) || !file.size) throw new Error('invalidData');
  if (file.size > 20 * 1024 * 1024) throw new Error('importTooBig');
  form.querySelector('.form-error').hidden = true;
  const previous = importPreview;
  const base64 = await fileToBase64(file);
  if (!current()) return;
  const input = { site_id: selected, family: data.family, filename: file.name, data_base64: base64 };
  if (!previous) {
    const preview = await api.previewImport(input);
    if (!current()) return;
    importPreview = { token: preview.preview_token, family: data.family, file, revision };
    form.querySelector('#import-result').innerHTML = renderImportPreview(preview);
    form.querySelector('#import-preview-hint').textContent = t('importPreviewCurrent');
    const submit = form.querySelector('button[type=submit]');
    submit.textContent = t('importApply'); submit.dataset.step = 'apply';
    return;
  }
  if (previous.family !== data.family || previous.file !== file || previous.revision !== revision) {
    invalidateImportPreview(form); throw new Error('importPreviewStale');
  }
  let applied;
  form.elements.family.disabled = true; form.elements.file.disabled = true;
  form.querySelector('#import-mapping fieldset').disabled = true;
  try { applied = await api.applyImport({ ...input, preview_token: previous.token }); }
  catch (error) {
    if (current() && ['PREVIEW_MISMATCH', 'PREVIEW_EXPIRED'].includes(error.code)) {
      invalidateImportPreview(form);
      try {
        const mappings = await freshApi.listImportMappings(selected);
        if (form.isConnected && version === modalVersion && siteId === selected) { form.importMappings = mappings; renderImportMapping(form); }
      } catch { form.importMappings = null; }
    }
    throw error;
  } finally {
    form.elements.family.disabled = false; form.elements.file.disabled = false;
    form.querySelector('#import-mapping fieldset').disabled = !form.importMappings;
  }
  if (!current()) return;
  importPreview = null;
  closeModal();
  coreCache.clear(); overviewCache.clear();
  await loadData();
  toast(t('importApplied'));
  return applied;
}

const deviationWrite = () => ['owner', 'editor'].includes(role()) && moduleVisible('deviations') && !offline;
const deviationSourceLabels = new Map([
  ['internal', 'evidenceSourceInternal'], ['other', 'evidenceSourceOther'],
]);
const attributionLabels = { not_determined: 'evidenceUndetermined', agreed: 'evidenceAgreed', disputed: 'evidenceDisputed' };
const deviationActions = { owner: 'evidenceOwner', attribution: 'evidenceAttribution', import: 'evidenceImported', reopen: 'evidenceReopened' };
function absenceText(row) {
  if (typeof row.absence === 'boolean') {
    return t(row.absence ? 'evidenceAbsent' : 'evidencePresent')
      .replace('{date}', dateLabel(row.absenceExportDate)).replace('{scope}', () => row.absenceScope);
  }
  const reason = { incomplete_export: 'evidenceIncomplete', different_scope: 'evidenceDifferentScope',
    single_export: 'evidenceSingleExport', same_export_date: 'evidenceSameDate', untracked: 'evidenceUntracked',
    no_export: 'evidenceNoExport', outside_comparison: 'evidenceOutsideComparison' }[row.absenceReason];
  return [t('evidenceCompareUnavailable'), reason && t(reason)].filter(Boolean).join(' · ');
}
function deviationHistory(events) {
  return `<section class="timeline"><h3>${t('history')}</h3>${events.length ? [...events].reverse().map(event => {
    let context;
    try { context = JSON.parse(event.note || 'null'); } catch { context = null; }
    const values = event.action === 'attribution' ? [context?.causingCompany, context?.resolvingCompany, t(attributionLabels[context?.attributionState] || 'evidenceUndetermined')]
      : [context?.fromName ?? context?.from, context?.toName ?? context?.to];
    return `<div class="event"><strong>${t(deviationActions[event.action] || 'history')}${event.from_status !== event.to_status
      ? ` · ${deviationState(event.from_status)} → ${deviationState(event.to_status)}` : ''}</strong>
      <div class="event-meta">${esc(event.source === 'import' ? t('evidenceImported') : event.actor)} · ${timeLabel(event.at)}</div>
      ${context ? `<p>${values.map(value => coreValue(value)).join(event.action === 'attribution' ? ' · ' : ' → ')}</p>` : ''}</div>`;
  }).join('') : `<p>${t('coreNoReferences')}</p>`}</section>`;
}
function deviationGovernance(row, events, members) {
  const write = deviationWrite(), id = esc(row.id);
  const sourceLabel = deviationSourceLabels.get(row.sourceSystem);
  const sourceSystemLabel = sourceLabel ? t(sourceLabel) : row.sourceSystem || null;
  const attribution = t(attributionLabels[row.attributionState] || 'evidenceUndetermined');
  const formError = '<div class="form-error" role="alert" tabindex="-1" hidden></div>';
  const save = `<div class="form-actions"><button type="submit" class="primary">${t('save')}</button></div>`;
  const owners = `<option value="">—</option>${row.internalOwnerId && !members.some(member => member.user_id === row.internalOwnerId)
    ? `<option selected disabled value="${esc(row.internalOwnerId)}">${esc(row.internalOwnerName)}</option>` : ''}
    ${members.map(member => `<option value="${esc(member.user_id)}" ${member.user_id === row.internalOwnerId ? 'selected' : ''}>${esc(member.name)}</option>`).join('')}`;
  return `<section><h3>${t('evidenceProvenance')}</h3>${coreFields({ ...row, sourceSystemLabel,
    traceabilityLabel: t({ full: 'evidenceFull', partial: 'evidencePartial', none: 'evidenceNone' }[row.traceability] || 'evidenceNone'), absenceLabel: absenceText(row) },
    [['sourceSystemLabel', 'evidenceSource'], ['sourceId', 'evidenceSourceId'], ['sourceStatus', 'evidenceSourceStatus'],
      ['sourceExportDate', 'evidenceExportDate', coreDate], ['lastSeenInExportDate', 'evidenceLastSeen', coreDate], ['traceabilityLabel', 'evidenceTraceability'],
      ['absenceLabel', 'evidenceAbsence'], ['reopenCount', 'evidenceReopenCount']])}</section>
    <section><h3>${t('evidenceOwner')}</h3>${coreFields({ ...row, ownerSince: row.internalOwnerSince ? timeLabel(row.internalOwnerSince) : null },
      [['internalOwnerName', 'evidenceOwner'], ['ownerSince', 'evidenceOwnerSince']])}
      ${write ? `<form id="deviation-owner-form" data-id="${id}">${formError}${field('evidenceOwner', 'userId', '', { options: owners })}${save}</form>` : ''}</section>
    <section><h3>${t('evidenceAttribution')}</h3>${write ? `<form id="deviation-attribution-form" data-id="${id}">${formError}<div class="form-grid">
      ${field('evidenceCausing', 'causingCompany', row.causingCompany, { max: 200 })}
      ${field('evidenceResolving', 'resolvingCompany', row.resolvingCompany, { max: 200 })}
      ${field('status', 'attributionState', '', { required: true, options: Object.entries(attributionLabels).map(([value, label]) =>
        `<option value="${value}" ${value === row.attributionState ? 'selected' : ''}>${t(label)}</option>`).join('') })}</div>${save}</form>`
    : coreFields({ ...row, attribution }, [['causingCompany', 'evidenceCausing'], ['resolvingCompany', 'evidenceResolving'], ['attribution', 'status']])}</section>
    ${deviationHistory(events)}${attachmentSection('deviation', row.id)}`;
}
function showDeviationImport() {
  if (role() !== 'owner' || offline) return;
  const options = [...deviationSourceLabels].map(([value, label]) => `<option value="${value}">${esc(t(label))}</option>`).join('');
  showModal(t('evidenceImport'), `<form id="deviation-import-form"><div class="form-error" role="alert" tabindex="-1" hidden></div>
    <p>${t('evidenceImportHint')}</p><div class="form-grid">
    ${field('evidenceSource', 'sourceSystem', '', { required: true, options })}
    ${field('evidenceExportDate', 'exportDate', '', { type: 'date', required: true })}
    ${field('evidenceScope', 'scope', '', { max: 240, required: true })}
    <label class="field"><span><input type="checkbox" name="complete"> ${t('evidenceComplete')}</span></label>
    <label class="field full">${t('attachmentFile')}<input name="file" type="file" accept=".xlsx" required></label></div>${formActions()}</form>`, { notebook: true });
}

async function showCoreDetail(module, id) {
  const selected = siteId;
  const modalStyle = { notebook: module === 'deviations' };
  showModal(t('coreDetails'), `<p role="status">${t('loading')}</p>`, modalStyle);
  $('#modal').classList.add('core-modal');
  const version = modalVersion;
  try {
    if (offline || !navigator.onLine) throw new Error('coreOnlineOnly');
    const [row, events, files, members] = await Promise.all([
      ({ deviations: freshApi.getDeviation, progress: freshApi.getProgress, impacts: freshApi.getImpact }[module])(id),
      module === 'deviations' ? freshApi.listDeviationEvents(id) : [],
      module === 'deviations' ? freshApi.listAttachments({ site_id: selected, entity_type: 'deviation', entity_id: id }) : [],
      module === 'deviations' && deviationWrite() ? freshApi.listAssignable(selected, 'deviation') : [],
    ]);
    if (version !== modalVersion || siteId !== selected || !$('#modal').open) return;
    if (row.siteId !== selected) throw new Error('forbidden');
    if (['progress', 'deviations'].includes(module)) {
      const previous = todayResource(module);
      const { impacts, ...record } = row;
      const updated = { ...previous.find(item => item.id === row.id), ...record };
      rememberTodayResource(module, [...previous.filter(item => item.id !== row.id), updated]);
    }
    let content;
    if (module === 'deviations') {
      state.attachments = [...state.attachments.filter(file => file.entity_type !== 'deviation' || file.entity_id !== id || file.localOnly), ...files];
      const typeLabels = { site_progress_item: 'coreProgressItem', task: 'tasks', diary: 'diary' };
      const details = coreFields(row, [['deviationNo', 'coreReference', deviationCode], ['status', 'status', deviationState], ['priority', 'priority'], ['problemDescription', 'coreDescription'], ['author', 'coreAuthor'], ['assignedTo', 'coreAssignedTo'], ['plcArea', 'area'], ['creationDate', 'coreCreated', coreDate], ['dueDate', 'due', coreDate], ['approvedDate', 'coreApprovedDate', coreDate], ['closedDate', 'coreClosed', coreDate], ['actualCost', 'coreActualCost'], ['claimQuantity', 'coreClaimQuantity'], ['laborHours', 'coreLaborHours'], ['completedTasksPct', 'coreCompletedPct']]);
      const references = row.links?.length ? `<ul class="core-links">${row.links.map(link => `<li>${esc(t(typeLabels[link.entityType] || 'coreReference'))}: ${esc(link.entityId)}</li>`).join('')}</ul>` : `<p>${t('coreNoReferences')}</p>`;
      const linkedImpacts = moduleVisible('impacts') && row.impacts?.length
        ? `<h3>${t('coreLinkedImpacts')}</h3><ul class="core-links">${row.impacts.map(impact =>
          `<li>${coreDetailButton('impacts', impact)} ${coreStatus(impact.status, impactLabel(impact.status))}</li>`).join('')}</ul>` : '';
      // Two tabs keep the sheet readable: everything about the record, then what it points to.
      content = `<div class="detail-tabs" role="tablist">
        <button type="button" role="tab" aria-selected="true" class="selected" data-command="detail-tab" data-panel="data">${t('coreDetails')}</button>
        <button type="button" role="tab" aria-selected="false" data-command="detail-tab" data-panel="refs">${t('coreReferences')}</button>
      </div><div class="detail-panel" data-detail-panel="data">${details}${deviationGovernance(row, events, members)}</div><div class="detail-panel" data-detail-panel="refs" hidden>${references}${linkedImpacts}</div>`;
    } else if (module === 'progress') {
      const day = value => value ? dateLabel(String(value).slice(0, 10)) : null;
      content = progressValue(row) + progressVerificationWarning(row) + coreFields({ ...row, wbsId: [row.wbsCode, row.wbsDescription].filter(Boolean).join(' · ') || '—',
        plannedStart: day(row.plannedStart), plannedFinish: day(row.plannedFinish), actualStart: day(row.actualStart) },
      [['description', 'coreDescription'], ['section', 'coreSection'], ['plcArea', 'area'], ['wbsId', 'wbs'], ['assignedTo', 'coreAssignedTo'], ['progressPct', 'coreProgressPct'], ['plannedProgressPct', 'corePlannedPct'], ['deltaProgressSource', 'coreDeltaPct'], ['bookedHours', 'coreBookedHours'], ['plannedStart', 'wbsPlannedStart'], ['plannedFinish', 'wbsPlannedFinish'], ['actualStart', 'coreActualStart'], ['expectedDelay', 'coreExpectedDelay'], ['hasFiles', 'coreHasFiles'], ['hasNotes', 'coreHasNotes'], ['hasDeviations', 'coreHasDeviations']]);
      content += progressStepsSection(row);
    } else {
      content = coreFields({ ...row, status: impactLabel(row.status), claimAmount: row.claimAmount == null ? null : money(row.claimAmount),
        settlementAmount: row.settlementAmount == null ? null : money(row.settlementAmount) },
      [['status', 'status'], ['claimAmount', 'coreClaimAmount'], ['settlementAmount', 'coreSettlementAmount'], ['result', 'coreResult'], ['createdAt', 'coreCreated'], ['closedAt', 'coreClosed']]);
      content += `<h3>${t('coreLinkedDeviations')}</h3>${row.deviations?.length ? `<ul class="core-links">${row.deviations.map(deviation => `<li>${coreDetailButton('deviations', deviation, [deviation.deviationNo, deviation.title || deviation.id].filter(Boolean).join(' · '))} ${coreStatus(deviation.status)}</li>`).join('')}</ul>` : `<p>${t('coreNoReferences')}</p>`}`;
      const transitions = impactTransitions(row.status);
      if (permissions().transition && transitions.length) content += `<form id="impact-transition-form" data-id="${esc(id)}"><div class="form-error" role="alert" tabindex="-1" hidden></div><div class="form-grid"><label class="field">${t('transitionTo')}<select name="to" required>${transitions.map(status => `<option value="${status}">${t(status)}</option>`).join('')}</select></label><label class="field core-result" id="impact-result-field" ${transitions[0] !== 'closed' ? 'hidden' : ''}>${t('coreResult')}<select name="result" ${transitions[0] === 'closed' ? 'required' : 'disabled'}><option value="">${t('coreChoose')}</option>${IMPACT_RESULTS.map(result => `<option value="${result}">${t(result)}</option>`).join('')}</select></label></div>${formActions()}</form>`;
    }
    showModal(row.title || row.description || t('coreDetails'), content, modalStyle);
    $('#modal').classList.add('core-modal');
  } catch (error) {
    if (version === modalVersion && $('#modal').open) showModal(t('coreDetails'), `<p role="alert">${esc(errorMessage(error))}</p>${button('retry', 'core-detail', `data-module="${module}" data-id="${esc(id)}"`)}`, modalStyle);
  }
}
function showBookingDelete(id) {
  if (!permissions().book || !moduleVisible('workforce_names')) return toast(t('forbidden'));
  const row = coreData('bookings').find(booking => booking.id === id);
  if (!row) return;
  showModal(t('coreDeleteBooking'), `<form id="booking-delete-form" data-id="${esc(id)}"><div class="form-error" role="alert" tabindex="-1" hidden></div><p>${t('coreDeleteConfirm')}</p><p>${coreNumber(row.hours, 'hours')} ${t('coreAppBookedHours')} · ${esc(progressLabel(coreData('progress').find(item => item.id === row.siteProgressItemId)))}</p><div class="form-actions">${button('cancel', 'close-modal')}<button type="submit" class="danger">${t('coreDelete')}</button></div></form>`);
}
function showToolForm() {
  if (!permissions().tools) return toast(t('forbidden'));
  const editing = toolEditingId ? coreData('tools').find(tool => tool.id === toolEditingId) : null;
  const statusOptions = TOOL_STATUSES.map(status => `<option value="${status}" ${(editing?.status || 'available') === status ? 'selected' : ''}>${t(toolStatusLabelKey(status))}</option>`).join('');
  showModal(t(editing ? 'toolEdit' : 'toolAdd'), `<form id="tool-form" data-id="${esc(editing?.id || '')}"><div class="form-error" role="alert" tabindex="-1" hidden></div><div class="form-grid">${field('toolName', 'name', editing?.name || '', { required: true, max: 120 })}${field('toolCode', 'code', editing?.code || '', { max: 200 })}${field('toolCompany', 'company', editing?.company || '', { max: 200 })}${field('toolStatus', 'status', editing?.status || 'available', { required: true, options: statusOptions })}${field('toolLocation', 'location', editing?.location || '', { max: 200 })}${field('toolNotes', 'notes', editing?.notes || '', { type: 'textarea', full: true, max: 10000 })}</div><div class="form-actions">${button('cancel', 'close-modal')}<button type="submit" class="primary">${t(editing ? 'toolSaveChanges' : 'toolSave')}</button></div></form>`);
}
function showToolDelete(id) {
  if (!permissions().tools) return toast(t('forbidden'));
  const row = coreData('tools').find(tool => tool.id === id);
  if (!row) return toast(t('toolNotFound'));
  showModal(t('toolDelete'), `<form id="tool-delete-form" data-id="${esc(id)}"><div class="form-error" role="alert" tabindex="-1" hidden></div><p>${t('toolDeleteConfirm')}</p><p><strong>${esc(row.name)}</strong>${row.code ? ` · ${esc(row.code)}` : ''}${row.company ? ` · ${esc(row.company)}` : ''}</p><div class="form-actions">${button('cancel', 'close-modal')}<button type="submit" class="danger">${t('coreDelete')}</button></div></form>`);
}
async function submitTool(form, data) {
  const selected = siteId, user = session?.user.id, version = modalVersion;
  if (offline || !navigator.onLine) throw new Error('coreOnlineOnly');
  if (!permissions().tools) throw new Error('forbidden');
  if (form.id === 'tool-delete-form') {
    await api.deleteTool(form.dataset.id);
  } else {
    const input = { siteId: selected, name: data.name, code: data.code, company: data.company,
      status: data.status, location: data.location, notes: data.notes };
    if (form.dataset.id) await api.updateTool(form.dataset.id, input);
    else await api.createTool(input);
  }
  if (session?.user.id !== user) return;
  coreCache.get(selected)?.delete('tools');
  if (selected !== siteId) return;
  if ((form.id === 'tool-delete-form' || form.id === 'tool-form') && version === modalVersion) closeModal();
  toolEditingId = '';
  render();
  toast(t(form.id === 'tool-delete-form' ? 'toolDeleted' : 'toolSaved'));
}
async function submitCore(form, data) {
  const selected = siteId, user = session?.user.id, version = modalVersion;
  if (offline || !navigator.onLine) throw new Error('coreOnlineOnly');
  const isImpact = form.id === 'impact-transition-form';
  const isSteps = form.id === 'progress-steps-form', isType = form.id === 'progress-type-form';
  const isHours = form.id === 'progress-hours-form';
  if (isSteps || isHours) { if (!permissions().steps) throw new Error('forbidden'); }
  else if (isType) { if (!permissions().assign) throw new Error('forbidden'); }
  else if (!(isImpact ? permissions().transition : permissions().book && moduleVisible('workforce_names'))) throw new Error('forbidden');
  if (isHours) {
    const hours = data.planned_hours === '' ? null : Number(data.planned_hours);
    if (hours !== null && (!Number.isFinite(hours) || hours < 0 || hours > 1e6)) throw new Error('invalidData');
    await api.updateProgress(form.dataset.id, { planned_hours: hours });
  } else if (form.id === 'booking-form') {
    const hours = Number(data.hours);
    if (!data.hours || !Number.isFinite(hours) || hours < 0) throw new Error('invalidData');
    await api.createBooking({ workDayId: data.workDayId, siteProgressItemId: data.siteProgressItemId, hours });
  } else if (form.id === 'booking-delete-form') await api.deleteBooking(form.dataset.id);
  else if (isSteps) {
    const steps = Object.entries(data).filter(([key]) => key.startsWith('percent-'))
      .map(([key, value]) => ({ step_id: key.slice('percent-'.length), percent: value === '' ? 0 : Number(value) }))
      .filter(step => Number.isFinite(step.percent) && step.percent >= 0 && step.percent <= 100);
    if (!steps.length) throw new Error('invalidData');
    await api.setStepProgress(form.dataset.id, steps);
  } else if (isType) {
    await api.assignProgressType(form.dataset.id, data.progress_type_id || null);
  } else {
    if (data.to === 'closed' && !IMPACT_RESULTS.includes(data.result)) throw new Error('coreResultRequired');
    await api.transitionImpact(form.dataset.id, data);
  }
  if (session?.user.id !== user) return;
  const cache = coreCache.get(selected);
  if (!isImpact && state.todayResources?.[selected]) { delete state.todayResources[selected].progress; void accountLock(persistState).catch(() => { storageError = true; }); }
  overviewCache.delete(selected);
  for (const key of isImpact ? ['impacts'] : ['bookings', 'progress']) cache?.delete(key);
  if (selected !== siteId) return;
  if (form.id !== 'booking-form' && version === modalVersion) closeModal();
  render(); toast(t('actionSaved'));
  if (isImpact || isSteps || isType || isHours) void showCoreDetail(isImpact ? 'impacts' : 'progress', form.dataset.id);
}

function render() {
  document.body.classList.toggle('report-view', view === 'report');
  renderChrome();
  $('#main').setAttribute('aria-busy', String(loading));
  if (loading) {
    $('#main').innerHTML = view === 'today' ? `<div role="status" aria-label="${t('loading')}">${todaySkeleton(3)}</div>` : `<p role="status">${t('loading')}</p>`;
    return;
  }
  if (session?.password_change_required) { $('#main').innerHTML = ''; return; }
  if (!session && (!loadError || loadError.status === 401)) {
    const passkeys = supportsPasskeys();
    $('#main').innerHTML = `<section class="panel"><div class="panel-body">
      <h1 data-login-text="login"></h1>
      <form id="login-form">
        <div class="form-error" role="alert" tabindex="-1" hidden></div>
        <div id="login-rate-limit" class="form-error" role="alert" tabindex="-1" hidden></div>
        <div class="form-grid">
          <label class="field"><span data-login-text="email"></span><input name="email" type="email" autocomplete="username" required></label>
          <label class="field"><span data-login-text="password"></span><span class="password-row">
            <input name="password" type="password" autocomplete="current-password" required maxlength="1024">
            <button type="button" class="text-button password-toggle" data-command="toggle-password">◉</button>
          </span></label>
        </div>
        <div class="form-actions">
          <button type="submit" class="primary"></button>${button('passkeyLogin', 'passkey-login', `data-login-text="passkeyLogin" ${passkeys ? '' : 'disabled'}`)}
        </div>
        ${button('passkeyDiscoverable', 'passkey-discoverable', `data-login-text="passkeyDiscoverable" ${passkeys ? '' : 'disabled'}`)}
        ${passkeys ? '' : '<p class="note" data-login-text="passkeyUnsupported"></p>'}
      </form>
      <div class="heading-actions">${button('requestAccess', 'request-access', 'data-login-text="requestAccess"')}${button('forgotPassword', 'forgot-password', 'data-login-text="forgotPassword"')}</div>
    </div></section>`;
    if (typeof localizeLogin === 'function') localizeLogin($('#login-form'));
    else if (typeof updateLoginRetry === 'function') updateLoginRetry($('#login-form'));
    return;
  }
  if (loadError) { $('#main').innerHTML = `<div role="alert"><p>${esc(errorMessage(loadError))}</p>${button('retry', 'reload')}</div>`; return; }
  if (!state.sites.length && view !== 'sites') { $('#main').innerHTML = empty('noSites', 'noSitesHint', button('newSite', 'new-site', '', 'primary')); return; }
  if (!moduleVisible(view)) { $('#main').innerHTML = empty('moduleUnavailable', 'moduleUnavailableHint'); return; }
  ({ today: renderToday, report: renderReport, reporting: renderReporting, overview: renderOverview, sites: renderSites, tasks: renderTasks, diary: renderDiary, wbs: renderWbs, deviations: renderCore, progress: renderCore, bookings: renderCore, workforce_presence: renderCore, impacts: renderCore, tools: renderCore, certifications: renderCore, hse: renderCore, logistics: renderCore })[view]();
}
function go(next) { if (location.hash !== `#${next}`) location.hash = next; else { view = next; render(); } }
function selectSite(id) {
  reportPrintIntent = null;
  if (!state.sites.some(site => site.id === id)) return;
  wbsLoad = null; wbsCache.clear(); resetCore(); resetSavedViews(); closeModal();
  siteId = id; reportDate = operationalDay().date;
  filters = { search: '', status: '', person: '', priority: '', kind: '' }; render();
  if (!offline) void loadData();
}
function showModal(title, content, { notebook = false } = {}) {
  $('#modal').classList.remove('core-modal');
  $('#modal').classList.toggle('notebook-detail', notebook);
  delete $('#modal').evidenceDownload;
  modalVersion++;
  $('#modal-content').innerHTML = `<div class="modal-header"><h2 id="modal-title">${esc(title)}</h2><button class="close" type="button" data-command="close-modal" aria-label="${t('close')}">×</button></div><div class="modal-body">${content}</div>`;
  $('#modal').initialFormState = modalFormState();
  if (!$('#modal').open) $('#modal').showModal();
  $('#modal').scrollTop = 0;
  const first = $('#modal-content input:not([type=hidden]):not(:disabled), #modal-content textarea:not(:disabled), #modal-content select:not(:disabled)');
  const safe = $('#modal-content button.danger') && $('#modal-content .form-actions [data-command="close-modal"]');
  (safe || first || $('#modal')).focus();
}
function closeModal() { modalVersion++; delete $('#modal').evidenceDownload; $('#modal').close(); }
function modalFormState() {
  // Read live controls as some values (file drops, step buttons) change without input events.
  return JSON.stringify(Array.from($('#modal').querySelectorAll('form input, form textarea, form select, form button[aria-pressed]'), control => {
    if (control.type === 'file') return [control.name, Array.from(control.files, file => [file.name, file.size, file.type, file.lastModified])];
    if (control.hasAttribute('aria-pressed')) return [control.name, control.getAttribute('aria-pressed')];
    return [control.name, control.type, control.type === 'select-multiple'
      ? Array.from(control.selectedOptions, option => option.value) : control.value, control.checked];
  }));
}
function field(label, name, value = '', { type = 'text', required = false, full = false, max = 4000, hint = '', options = null } = {}) {
  const attrs = `name="${name}" id="field-${name}" ${required ? 'required' : ''}${hint ? ` aria-describedby="field-hint-${name}"` : ''}`;
  const control = type === 'date' && options === null
    ? (typeof dateInput === 'function'
      ? dateInput(`field-${name}`, value, `name="${name}" ${required ? 'required' : ''}`, hint ? `field-hint-${name}` : '')
      : `<input ${attrs} type="date" lang="${language}" value="${esc(value)}" min="0001-01-01" max="9999-12-31">`)
    : options !== null ? `<select ${attrs}>${options}</select>` : type === 'textarea' ? `<textarea ${attrs} maxlength="${max}">${esc(value)}</textarea>` : `<input ${attrs} type="${type}" value="${esc(value)}" maxlength="${max}">`;
  return `<label class="field ${full ? 'full' : ''}" for="field-${name}"><span>${t(label)} ${required ? '*' : `<small>(${t('optional')})</small>`}</span>${control}${hint ? `<small id="field-hint-${name}">${t(hint)}</small>` : ''}</label>`;
}
function dateInput(id, value, attrs, hintId = '') {
  const descriptions = [`${id}-format`, `${id}-error`, hintId].filter(Boolean).join(' ');
  return `<input id="${id}" type="text" data-date-input ${attrs} inputmode="numeric" autocomplete="off" value="${esc(formatDateInput(value, language))}" placeholder="${t('dateFormat')}" aria-describedby="${descriptions}"><small id="${id}-format">${t('dateFormatHint')}</small><small id="${id}-error" class="date-error" role="alert"></small>`;
}
function validateDateInput(input) {
  const iso = parseDateInput(input.value, language);
  const message = iso === null ? t('dateFormatInvalid') : iso === '' && input.required ? t('dateRequired') : '';
  input.setCustomValidity(message);
  if (message) input.setAttribute('aria-invalid', 'true');
  else input.removeAttribute('aria-invalid');
  const error = $(`#${input.id}-error`);
  if (error.textContent !== message) error.textContent = message;
  return message ? null : iso;
}
function dateFormData(form) {
  const data = Object.fromEntries(new FormData(form));
  for (const input of form.querySelectorAll('[data-date-input]:enabled')) {
    const iso = validateDateInput(input);
    if (iso === null) {
      input.focus();
      return null;
    }
    data[input.name] = iso;
  }
  return data;
}
const formActions = (label = 'save') => `<div class="form-actions">${button('cancel', 'close-modal')}<button type="submit" class="primary">${t(label)}</button></div>`;
function formError(form, error, format = errorMessage) {
  const target = form.querySelector('.form-error');
  if (form.id === 'login-form') target.localizedMessage = () => format(error);
  target.textContent = format(error); target.hidden = false; target.focus();
}
function showPasswordForm() {
  showModal(t('changePassword'), `<form id="password-form"><div class="form-error" role="alert" tabindex="-1" hidden></div><p>${t('passwordPolicy')}</p><div class="form-grid">${['current_password', 'new_password', 'confirm_password'].map((name, index) => `<label class="field">${t(['currentPassword', 'newPassword', 'confirmPassword'][index])}<input name="${name}" type="password" autocomplete="${index ? 'new-password' : 'current-password'}" required maxlength="1024" ${index ? 'minlength="12"' : ''}></label>`).join('')}</div>${formActions()}</form>`);
}
function showEmailForm(kind) {
  showModal(t(kind === 'request' ? 'requestAccess' : 'forgotPassword'), `<form id="${kind}-form"><div class="form-error" role="alert" tabindex="-1" hidden></div><label class="field">${t('email')}<input name="email" type="email" autocomplete="email" required maxlength="254"></label>${formActions()}</form>`);
}
async function fillLocationSuggestions(input) {
  const query = input.value.trim();
  const list = document.querySelector('#location-options');
  const hint = document.querySelector('#location-hint');
  if (!list) return;
  if (query.length < 3) { list.innerHTML = ''; if (hint) hint.textContent = ''; return; }
  try {
    const response = await api.searchLocations(query);
    list.innerHTML = response.results.map(row => `<option value="${esc(row.label)}"></option>`).join('');
    if (hint) hint.textContent = response.results.length ? '' : t('locationNoResult');
  } catch { if (hint) hint.textContent = t('locationUnavailable'); }
}
function wireLocationLookup() {
  const input = document.querySelector('#field-location');
  if (!input) return;
  let timer;
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { void fillLocationSuggestions(input); }, 400); });
}
function showSiteForm() {
  showModal(t('newSite'), `<form id="site-form"><div class="form-error" role="alert" tabindex="-1" hidden></div><div class="form-grid">${field('code', 'code', '', { required: true, max: 30, hint: 'codeHint' })}${field('name', 'name', '', { required: true, max: 120 })}<label class="field full" for="field-location"><span>${t('location')} <small>(${t('optional')})</small></span><input name="location" id="field-location" list="location-options" autocomplete="off" maxlength="160" placeholder="${t('locationHint')}"><datalist id="location-options"></datalist><small id="location-hint" class="note"></small></label>${field('startDate', 'start', today(), { type: 'date' })}${field('endDate', 'end', '', { type: 'date' })}</div>${formActions()}</form>`);
  wireLocationLookup();
}
function taskResponsibleFields() {
  return [['executor', 'assignee'], ['verifier', 'reviewer']].map(([key, label]) => `
    <div class="field"><label for="${key}-account">${esc(t(label))} *</label>
      <select id="${key}-account" data-responsible="${key}" required aria-describedby="responsible-separate">
        <option value="">${esc(t('responsibleChoose'))}</option><option value="other">${esc(t('responsibleOther'))}</option>
      </select><input type="hidden" name="${key}_id" value="">
      <label data-free-name="${key}" hidden>${esc(t('responsibleName'))}
        <input type="hidden" name="${label}" maxlength="4000" required>
      </label>
    </div>`).join('') + `<p id="responsible-separate" class="note full">${esc(t('responsibleSeparate'))}</p>
    <p data-assignable-status class="note full" role="status">${esc(t('loading'))}</p>`;
}
function wireTaskResponsibles(form) {
  let members = [];
  const controls = [['executor', 'assignee'], ['verifier', 'reviewer']].map(([key, name]) => ({
    key, select: form.querySelector(`[data-responsible="${key}"]`),
    id: form.elements[`${key}_id`], name: form.elements[name], free: form.querySelector(`[data-free-name="${key}"]`),
  }));
  const update = () => {
    const [executor, verifier] = controls;
    for (const option of verifier.select.options) {
      option.disabled = option.value !== '' && option.value !== 'other' && option.value === executor.select.value;
      option.title = option.disabled ? t('responsibleSeparate') : '';
    }
    if (verifier.select.value !== 'other' && verifier.select.value && verifier.select.value === executor.select.value) verifier.select.value = '';
    for (const control of controls) {
      const member = members.find(item => item.user_id === control.select.value);
      const free = control.select.value === 'other';
      control.id.value = member?.user_id || '';
      control.free.hidden = !free;
      control.name.type = free ? 'text' : 'hidden';
      if (!free) control.name.value = member?.name || '';
    }
  };
  for (const control of controls) control.select.addEventListener('change', update);
  return rows => {
    members = rows;
    for (const control of controls) {
      // Keep placeholder and free-name choice, including a name typed while loading.
      while (control.select.options.length > 2) control.select.remove(1);
      for (const member of members) {
        if (control.key === 'verifier' && !['owner', 'verifier'].includes(member.role)) continue;
        const option = document.createElement('option');
        option.value = member.user_id;
        option.textContent = `${member.name} (${t(`responsibleRole_${member.role}`)})`;
        control.select.add(option, control.select.options.length - 1);
      }
    }
    update();
  };
}
async function showTaskForm() {
  showModal(t('newTask'), `<form id="task-form"><div class="form-error" role="alert" tabindex="-1" hidden></div><div class="form-grid">${field('title', 'title', '', { full: true, required: true, max: 180 })}${field('area', 'area', '', { max: 100 })}${field('company', 'company', '', { max: 100 })}<div data-task-wbs>${field('wbs', 'wbsId', '', { options: `<option value="">${t('wbsUnassigned')}</option>` })}</div>${taskResponsibleFields()}${field('priority', 'priority', 'normal', { options: PRIORITIES.map(priority => `<option value="${esc(priority)}"${priority === 'normal' ? ' selected' : ''}>${esc(t(priority))}</option>`).join(''), required: true })}${field('kind', 'kind', 'ordinary', { options: TASK_KINDS.map(kind => `<option value="${esc(kind)}">${esc(t(taskKindLabelKey(kind)))}</option>`).join('') })}${field('due', 'due', today(), { type: 'date' })}</div>${formActions()}</form>`);
  const version = modalVersion, selectedSite = siteId;
  const form = $('#task-form');
  if (moduleVisible('wbs') && !offline) void taskWbsOptions(selectedSite).then(options => {
    if (version === modalVersion && selectedSite === siteId && form.isConnected) form.querySelector('[data-task-wbs]').innerHTML = field('wbs', 'wbsId', '', { options });
  }).catch(() => {});
  const setMembers = wireTaskResponsibles(form);
  const status = form.querySelector('[data-assignable-status]');
  try {
    const members = await freshApi.listAssignable(selectedSite);
    if (version !== modalVersion || selectedSite !== siteId || !$('#modal').open) return;
    setMembers(members);
    status.textContent = '';
  } catch {
    if (version !== modalVersion || selectedSite !== siteId || !$('#modal').open) return;
    status.textContent = t('assignableUnavailable');
  }
}
function taskEvidence(task) {
  const files = state.attachments.filter(file => file.entity_type === 'task' && file.entity_id === task.id && !file.localOnly);
  const document = files.find(file => file.id === task.acceptance_document_id);
  const canAccept = canTransitionTask() && !offline && !task.localOnly && (role() === 'owner' || (role() === 'verifier' && task.verifier_id === session?.user.id));
  const outcome = { pending: 'evidenceVerificationPending', waived: 'evidenceWaiver', verified: 'evidenceVerificationRecorded', legacy: 'evidenceVerificationLegacy' };
  const form = canAccept && files.length ? `<form id="task-acceptance-form" data-id="${esc(task.id)}">
    <div class="form-error" role="alert" tabindex="-1" hidden></div><div class="form-grid">
    ${field('evidenceAcceptanceDocument', 'documentId', '', { required: true, options: `<option value="">${t('coreChoose')}</option>` +
      files.map(file => `<option value="${esc(file.id)}" ${file.id === document?.id ? 'selected' : ''}>${esc(file.filename)}</option>`).join('') })}
    ${field('evidenceAcceptanceDate', 'date', task.acceptance_date || '', { required: true, type: 'date' })}</div>
    <div class="form-actions"><button type="submit" class="primary">${t('evidenceAcceptance')}</button></div></form>` : '';
  return `<section><h3>${t('evidenceVerification')}</h3><p>${t(outcome[taskVerificationOutcome(task)])}</p>${coreFields({ declared: task.declared_at && timeLabel(task.declared_at),
    verified: task.verified_at && timeLabel(task.verified_at), reopenCount: task.reopen_count ?? 0 },
    [['declared', 'evidenceDeclared'], ['verified', 'evidenceVerified'], ['reopenCount', 'evidenceReopenCount']])}</section>
    <section><h3>${t('evidenceAcceptance')}</h3><p>${formalAcceptanceLabel(task)}</p>
    ${task.acceptance_date ? `<p>${dateLabel(task.acceptance_date)}${document ? ` · ${esc(document.filename)}` : ''}</p>` : ''}
    ${(task.acceptance_events || []).map(event => `<p class="event-meta">${esc(t('evidenceAcceptance'))} · ${personName(event.actor)} · ${timeLabel(event.at)}</p>`).join('')}${form}</section>`;
}
async function showDetail(taskId, { history = false } = {}) {
  const modalStyle = { notebook: true };
  showModal(t('details'), `<p role="status">${t('loading')}</p>`, modalStyle);
  const version = modalVersion;
  try {
    const local = state.tasks.find(item => item.id === taskId);
    let task = local;
    if (!offline && !local?.localOnly) {
      try { task = await freshApi.getTask(taskId); }
      catch (error) { if (error.code !== 'NETWORK_ERROR' || !local) throw error; offline = true; }
    }
    if (!task) throw new Error('apiUnavailable');
    task = { ...task, syncStatus: local?.syncStatus };
    if (version !== modalVersion || !$('#modal').open || task.siteId !== siteId) return;
    rememberTask(task);
    if (storageReady && !task.localOnly) await accountLock(async () => {
      const saved = await getMirror(`state:${offlineScope}`);
      if (saved) { saved.tasks = saved.tasks.map(item => item.id === task.id ? task : item); await setMirror(`state:${offlineScope}`, saved); }
    });
    render();
    const reviewDenied = task.status === 'to_verify' && !canReviewTask(task);
    const actions = reviewDenied ? [] : taskTransitions(task);
    showModal(task.title, `<p class="notebook-card-meta">${notebookState(task.status)}${notebookPriority(task.priority)}${notebookSync(task)}</p>
      <dl class="detail-grid"><div><dt>${t('wbs')}</dt><dd>${esc(taskWbsText(task))}${canEditTask() && moduleVisible('wbs') && !offline && !task.localOnly ? button('wbsAssociate', 'task-wbs', `data-id="${esc(task.id)}"`, 'small') : ''}</dd></div>${['area', 'company', 'assignee', 'reviewer', 'due', 'priority'].map(key => `<div><dt>${t(key)}</dt><dd>${['assignee', 'reviewer'].includes(key) ? personName(task[key]) : key === 'due' ? dateLabel(task[key]) : key === 'priority' ? esc(t(task[key])) : esc(task[key] || '—')}</dd></div>`).join('')}</dl>
      ${actions.length ? `<div class="detail-actions">${actions.map(to => taskActionButton(task.id, to, taskTransitionLabel(task, to), {
        primary: to === 'closed', resume: task.status === 'blocked',
      })).join('')}</div>` : ''}
      ${task.status === 'blocked' && actions.length ? '<div id="task-transition-error" class="form-error" role="alert" tabindex="-1" hidden></div>' : ''}
      ${reviewDenied ? `<p class="note">${t('verifyNoPermission')}</p>` : canTransitionTask() && !actions.length ? `<p class="note">${t('noTransitions')}</p>` : ''}${taskEvidence(task)}
      <section class="timeline"><h3 id="task-history" tabindex="-1">${t('history')}</h3>${[...(task.events || [])].reverse().map(event => `<div class="event"><strong>${event.from_status ? `${notebookState(event.from_status)} → ` : ''}${notebookState(event.to_status)}${event.waiver ? ` · ${t('evidenceWaiver')}` : ''}</strong><div class="event-meta num">${personName(event.actor)} · ${timeLabel(event.at)}</div>${event.note ? `<p>${t('note')}: ${esc(event.note)}</p>` : ''}${event.reason ? `<p>${t('reason')}: ${esc(event.reason)}</p>` : ''}${event.evidence_attachment_id &&
      state.attachments.some(file => file.id === event.evidence_attachment_id)
      ? button('openAttachment', 'open-attachment', `data-id="${esc(event.evidence_attachment_id)}"`) : ''}</div>`).join('')}</section>${attachmentSection('task', task.id)}`, modalStyle);
    if (history) $('#task-history').focus();
  } catch (error) {
    if (version === modalVersion && $('#modal').open) showModal(t('details'), `<p role="alert">${esc(errorMessage(error))}</p>${button('retry', 'detail', `data-id="${esc(taskId)}"`)}`, modalStyle);
  }
}
function showTransition(taskId, to, { todayReview = false } = {}) {
  const task = state.tasks.find(item => item.id === taskId);
  if (savingTaskTransitions.has(taskId) || !taskTransitions(task).includes(to) || task.status === 'blocked') return;
  const required = transitionRequirements(task, to);
  const hasAttachment = state.attachments.some(file => file.entity_type === 'task' && file.entity_id === taskId
    && file.syncStatus !== 'failed');
  const closing = to === 'closed';
  const rejecting = task.status === 'to_verify' && to === 'in_progress';
  const label = taskTransitionLabel(task, to);
  showModal(rejecting ? `${label} · ${task.title}` : label, `<form id="transition-form" data-task-id="${esc(taskId)}" data-to="${to}"${todayReview ? ' data-today-review="true"' : ''}>
    <div class="form-error" role="alert" tabindex="-1" hidden></div><p>${t('actor')}: ${esc(actor)}</p>
    <input type="hidden" name="actor" value="${esc(actor)}">
    ${rejecting ? `<p class="note">${t('taskRejectHint')}</p>` : ''}
    ${closing ? `<p class="note">${t('taskEvidenceRequired')}</p><label class="field"><span>
      <input type="checkbox" name="waiver" ${hasAttachment ? '' : 'checked'}> ${t('evidenceWaiver')}</span></label>` : ''}
    ${field('note', 'note', '', { type: 'textarea', required: closing ? hasAttachment : required.note })}
    ${rejecting ? '' : field(closing ? 'evidenceWaiverReason' : 'reason', 'reason', '',
      { type: 'textarea', required: closing ? !hasAttachment : required.reason })}${formActions(rejecting ? 'taskReject' : 'save')}</form>`, { notebook: true });
  if (closing) updateClosureForm($('#transition-form'));
}
function updateClosureForm(form) {
  const waiver = form.elements.waiver.checked;
  form.elements.note.required = !waiver;
  form.elements.reason.required = waiver;
  form.elements.reason.minLength = waiver ? 15 : 0;
}
function showTaskStatusMenu(taskId) {
  const task = state.tasks.find(item => item.id === taskId);
  if (!task || !canTransitionTask()) return;
  const targets = taskTransitions(task);
  showModal(`${t('changeStatus')} · ${t(task.status)}`, `<p class="notebook-card-meta">${notebookState(task.status)}${notebookPriority(task.priority)}</p>${targets.length
    ? `<div class="detail-actions">${targets.map(to => button(taskTransitionLabel(task, to), 'status-transition', `data-id="${esc(task.id)}" data-to="${to}"`)).join('')}</div>`
    : `<p class="note">${t('noTransitions')}</p>`}`, { notebook: true });
}
async function runStatusTransition(taskId, to, control) {
  const task = state.tasks.find(item => item.id === taskId);
  if (savingTaskTransitions.has(taskId) || !taskTransitions(task).includes(to)) return;
  if (transitionNeedsDialog(transitionRequirements(task, to))) { showTransition(taskId, to); return; }
  const fromDetail = control?.dataset.taskDetail === 'true';
  const fromToday = control?.dataset.todayReview === 'true';
  const version = fromDetail || fromToday ? modalVersion : null;
  const alert = fromDetail ? $('#task-transition-error') : null;
  if (alert) alert.hidden = true;
  savingTaskTransitions.add(taskId);
  if (control) { control.disabled = true; control.setAttribute('aria-busy', 'true'); }
  try {
    await writeOperation('transition_task', { task, input: transitionPayload(task, { to, actor }) }, task.id);
    toast(t('actionSaved'));
  } catch (error) {
    if (alert && version === modalVersion) {
      alert.textContent = errorMessage(error); alert.hidden = false; alert.focus();
    } else if (fromToday && version === modalVersion && siteId === task.siteId) {
      showModal(t('taskResume'), `<p id="task-transition-error" class="form-error" role="alert" tabindex="-1">${esc(errorMessage(error))}</p>`, { notebook: true });
      $('#task-transition-error').focus();
    } else toast(errorMessage(error));
    return;
  } finally {
    savingTaskTransitions.delete(taskId);
    if (control) { control.disabled = false; control.removeAttribute('aria-busy'); }
  }
  if (fromDetail || fromToday) render();
  if (fromDetail && version === modalVersion && siteId === task.siteId) await showDetail(taskId);
}
function diaryMotivationField() {
  return field('diaryMotivation', 'motivation', '', { type: 'textarea', required: true, full: true, hint: 'diaryMotivationHint' });
}
function showDiaryCorrection(id) {
  const entry = state.diary.find(item => item.id === id && item.siteId === siteId);
  if (!entry || !canCorrectDiary(entry)) return;
  showModal(t('diaryCorrect'), `<form id="diary-correction-form">
    <div class="form-error" role="alert" tabindex="-1" hidden></div>
    <p class="note">${esc(t('diaryCorrectionGuide'))}</p>
    <div class="form-grid">${Object.keys(diaryContentFields).map(key =>
      field(key, key, entry[key], { type: 'textarea', full: true, max: 10000 })).join('')}
      ${diaryMotivationField()}</div>${formActions()}</form>`, { notebook: true });
  $('#diary-correction-form').originalEntry = entry;
}
async function showDiaryVersions(id) {
  const entry = state.diary.find(item => item.id === id && item.siteId === siteId);
  if (!entry || offline) return;
  const selected = siteId, user = session?.user.id;
  showModal(t('diaryVersions'), `<p role="status">${t('loading')}</p>`, { notebook: true });
  const version = modalVersion;
  const current = () => version === modalVersion && selected === siteId && user === session?.user.id;
  try {
    const versions = await api.listDiaryVersions(id);
    if (!current()) return;
    showModal(t('diaryVersions'), `<p class="note">${t('diaryVersionsGuide')}</p><ol>${versions.map(item => `<li>
      <h3>${esc(t('diaryVersion').replace('{version}', item.version))}</h3>
      <p>${esc(t('diaryCorrected').replace('{date}', diaryTimestamp(item.created_at, entry))
        .replace('{author}', () => item.author_name))}</p>
      ${item.motivation ? `<p class="prewrap"><strong>${t('diaryMotivation')}</strong><br>${esc(item.motivation)}</p>` : ''}
      ${Object.entries(diaryContentFields).map(([label, key]) => `<p class="prewrap"><strong>${t(label)}</strong><br>${esc(item.snapshot[key] || '—')}</p>`).join('')}
    </li>`).join('')}</ol>`, { notebook: true });
  } catch (error) {
    if (current()) showModal(t('diaryVersions'), `<p role="alert">${esc(errorMessage(error))}</p>`, { notebook: true });
  }
}
function showEntryForm(preferredShift = '') {
  if (!canWriteTask() || !moduleVisible('diary')) return;
  const age = diaryDayAge(reportDate);
  if (age < 0 || (age > 7 && role() !== 'owner')) return;
  const current = operationalDay();
  const shift = preferredShift || (reportDate === current.date ? current.shift : 'day');
  const isCurrent = !offline && reportDate === current.date && shift === current.shift;
  const shiftField = isCurrent ? `<input type="hidden" name="shift" value="${shift}">` : field('shift', 'shift', '', {
    required: true, options: ['day', 'night'].map(value => `<option value="${value}"${value === shift ? ' selected' : ''}>${t(value)}</option>`).join(''),
  });
  showModal(t(view === 'diary' ? 'diaryCloseShift' : 'newEntry'), `<form id="entry-form" data-date="${esc(reportDate)}" data-current="${isCurrent}"><div class="form-error" role="alert" tabindex="-1" hidden></div><p class="note">${t('forDate')} ${dateLabel(reportDate)}${isCurrent ? ` · ${t(shift)}` : ''}</p><p class="note">${t('dayRuleNote')}</p><div class="form-grid">${shiftField}${field('plan', 'plan', '', { type: 'textarea', full: true })}${field('actual', 'actual', '', { type: 'textarea', full: true })}${field('blockers', 'blockers', '', { type: 'textarea', full: true })}${field('next', 'next', '', { type: 'textarea', full: true })}${age > 7 ? diaryMotivationField() : ''}</div>
      ${canAttachDiary() ? `<label class="dropzone" id="entry-drop" for="entry-photos"><strong>${t('diaryPhotos')}</strong><span>${t('diaryPhotosHint')}</span>
        <input id="entry-photos" name="photos" type="file" accept="image/*,application/pdf" multiple hidden></label>
      <p class="note" id="entry-photos-count" hidden></p>` : ''}${formActions()}</form>`);
  wireDropzone();
}
// Photos: pick from the dialog or drop files straight from the desktop (Windows/macOS).
function wireDropzone() {
  const zone = document.querySelector('#entry-drop');
  if (!zone) return;
  const input = zone.querySelector('input[type=file]');
  const count = () => {
    const label = document.querySelector('#entry-photos-count');
    if (!label) return;
    const files = input.files || [];
    label.hidden = !files.length;
    label.textContent = `${files.length} ${t('diaryPhotosSelected')}`;
  };
  input.addEventListener('change', count);
  const stop = event => { event.preventDefault(); event.stopPropagation(); };
  zone.addEventListener('dragover', event => { stop(event); zone.classList.add('dragging'); });
  zone.addEventListener('dragleave', event => { stop(event); zone.classList.remove('dragging'); });
  zone.addEventListener('drop', event => {
    stop(event); zone.classList.remove('dragging');
    const dropped = event.dataTransfer?.files;
    if (!dropped?.length) return;
    try {
      const transfer = new DataTransfer();
      for (const file of dropped) if (/^(image\/|application\/pdf$)/i.test(file.type)) transfer.items.add(file);
      input.files = transfer.files;
      count();
    } catch { /* older browsers cannot assign a file list */ }
  });
  // A file dropped anywhere else must not navigate away from the app.
  for (const type of ['dragover', 'drop']) document.addEventListener(type, event => {
    if (event.target.closest?.('#entry-drop')) return;
    if (event.dataTransfer?.types?.includes('Files')) event.preventDefault();
  });
}

function attachmentUrl(file) {
  return `${api.baseUrl}/api/attachments/${encodeURIComponent(file.id)}`;
}
function attachmentSection(entityType, entityId) {
  const inspection = entityType === 'hse_inspection';
  const hse = inspection || entityType === 'hse_event';
  const write = entityType === 'task' ? canEditTask()
    : entityType === 'deviation' ? deviationWrite()
    : entityType === 'diary' ? canAttachDiary() : !hse || permissions().hseWrite;
  const sync = entityType === 'task' || entityType === 'deviation' ? notebookSync : syncBadge;
  const files = (state.attachments || []).filter(file => file.entity_type === entityType && file.entity_id === entityId);
  return `<section class="attachment-section"><h3>${t('attachments')}</h3>${hse ? `<p class="note">${t('hseAttachmentRule')}</p><p class="note">${t('hseAttachmentAlternative')}</p>` : ''}${files.map(file => inspection && file.mime?.startsWith('image/') && !file.blob
    ? `<p><button type="button" class="attachment-photo" data-command="open-attachment" data-id="${esc(file.id)}"><img class="attachment-thumbnail" src="${esc(attachmentUrl(file))}" alt="${esc(file.filename)}" loading="lazy" width="72" height="72"><span>${esc(file.filename)}</span></button>${syncBadge(file)}</p>`
    : `<p>${button('openAttachment', 'open-attachment', `data-id="${esc(file.id)}"`)} ${esc(file.filename)} ${sync(file)}</p>`).join('')}${write ? button(inspection ? 'addPhoto' : 'addAttachment', 'new-attachment', `data-entity-type="${entityType}" data-id="${esc(entityId)}"`) : ''}</section>`;
}
function showAttachmentForm(entityType, entityId, { camera = false } = {}) {
  const hse = ['hse_event', 'hse_inspection'].includes(entityType);
  if ((entityType === 'task' && !canEditTask()) || (hse && !permissions().hseWrite) ||
      (entityType === 'diary' && !canAttachDiary()) || (entityType === 'deviation' && !deviationWrite())) return toast(t('forbidden'));
  showModal(t('addAttachment'), `<form id="attachment-form" data-entity-type="${entityType}" data-entity-id="${esc(entityId)}"><div class="form-error" role="alert" tabindex="-1" hidden></div>${hse ? `<p class="note">${t('hseAttachmentRule')}</p><p class="note">${t('hseAttachmentAlternative')}</p>` : ''}<label class="field">${t('attachmentFile')}<input type="file" name="file" accept="${camera ? 'image/*' : 'image/*,application/pdf'}" ${camera ? 'capture="environment"' : ''} required></label><p class="note">${t('attachmentHint')}</p>${hse ? `<label class="field">${t('hseAttachmentDescription')}<textarea name="description" maxlength="200"></textarea></label><p class="note" data-hse-attachment-warning role="status" aria-live="polite" hidden>${t('hseAttachmentWarning')} ${t('hseAttachmentRule')}</p>` : ''}${formActions()}</form>`);
  if (hse) {
    const form = $('#attachment-form');
    const update = () => {
      form.querySelector('[data-hse-attachment-warning]').hidden = !hseAttachmentNeedsReview(
        form.elements.file.files?.[0]?.name, form.elements.description.value);
    };
    form.elements.file.addEventListener('change', update);
    form.elements.description.addEventListener('input', update);
  }
}
async function openAttachment(id) {
  const file = state.attachments.find(item => item.id === id);
  if (!file) return;
  if (file.entity_type === 'hse_inspection' && file.mime?.startsWith('image/') && !file.blob) {
    showModal(file.filename, `<img class="attachment-full-image" src="${esc(attachmentUrl(file))}" alt="${esc(file.filename)}">`);
    return;
  }
  if (file.blob) download(file.blob, file.blob.type, file.filename);
  else {
    try {
      const response = await fetch(`${api.baseUrl}/api/attachments/${encodeURIComponent(id)}`, { credentials: 'include' });
      if (!response.ok) throw new Error('apiError');
      download(await response.blob(), file.mime, file.filename);
    } catch { toast(t('apiUnavailable')); }
  }
}
async function showEvidenceExport() {
  const selected = siteId;
  showModal(t('evidenceExport'), `<p role="status">${t('loading')}</p>`);
  const version = modalVersion;
  try {
    const { blob, sha256 } = await freshApi.evidenceExport(selected);
    if (version !== modalVersion || selected !== siteId) return;
    if (!/^[0-9a-f]{64}$/.test(sha256 || '')) throw new Error('apiError');
    showModal(t('evidenceExport'), `<p>${t('evidenceChecksumHint')}</p><div class="detail-actions">
      ${button('evidenceCsv', 'evidence-download', 'data-format="csv"', 'primary')}
      ${button('evidenceChecksum', 'evidence-download', 'data-format="sha256"')}</div>`);
    $('#modal').evidenceDownload = { blob, sha256 };
  } catch (error) {
    if (version === modalVersion) showModal(t('evidenceExport'), `<p role="alert">${esc(errorMessage(error))}</p>`);
  }
}
function downloadEvidence(format) {
  const file = $('#modal').evidenceDownload;
  if (!file) return;
  if (format === 'csv') download(file.blob, file.blob.type, 'site-evidence.csv');
  if (format === 'sha256') download(file.sha256, 'text/plain', 'site-evidence.sha256');
}

function download(content, type, name) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function exportReportCsv(kind) {
  if (!lastReport) return toast(t('emptyExport'));
  const progress = kind === 'progress';
  const columns = progress ? REPORT_PROGRESS_COLUMNS : REPORT_DEVIATION_COLUMNS;
  const rows = progress ? reportProgressRows(lastReport.progress)
    : reportDeviationRows(lastReport.deviations, status => t(status ?? 'coreUnknown'));
  if (!rows.length) return toast(t('emptyExport'));
  const body = [columns.map(t), ...rows.map(row => row.map((value, index) => progress && index === 4
    ? t(`reportSource_${value}`) : value))];
  download('\ufeff' + body.map(row => row.map(csvCell).join(',')).join('\r\n'), 'text/csv;charset=utf-8',
    `siteassistant-report-${kind}-${today()}.csv`);
  toast(t('csvDone'));
}
function exportCsv() {
  const tasks = filteredTasks();
  if (!tasks.length) return toast(t('emptyExport'));
  const header = ['title', 'area', 'company', 'assignee', 'reviewer', 'priority', 'kind', 'due', 'status'];
  const rows = [[...header.map(t), t('evidenceAcceptance')], ...tasks.map(task => [
    ...header.map(key => key === 'kind' ? t(taskKindLabelKey(task.kind ?? 'ordinary'))
      : key === 'status' ? taskStatusLabel(task.status) : key === 'priority' ? t(task.priority) : task[key]), formalAcceptanceLabel(task),
  ])];
  download('\ufeff' + rows.map(row => row.map(csvCell).join(',')).join('\r\n'), 'text/csv;charset=utf-8', `siteassistant-tasks-${today()}.csv`); toast(t('csvDone'));
}
document.addEventListener('click', event => {
  const target = event.target.closest('[data-command]'); if (!target) return;
  const command = target.dataset.command, id = target.dataset.id;
  const commands = {
    'go-diary': () => { if (moduleVisible('diary')) { reportDate = operationalDay().date; go('diary'); } },
    'today-open': () => openTodayAction(target),
    'today-diary': () => { if (moduleVisible('diary')) { reportDate = operationalDay().date; go('diary'); } },
    'task-history': () => showDetail(id, { history: true }),
    'progress-verifications': () => openProgressVerifications(id),
    'today-quick': () => runTodayQuick(target.dataset.action),
    'today-see-upcoming': () => {
      $('#today-upcoming')?.scrollIntoView({ block: 'start' });
      $('#today-upcoming-title')?.focus({ preventScroll: true });
    },
    'today-retry': () => {
      const name = target.dataset.resource;
      if (view !== 'today' || offline || !['progress', 'deviations'].includes(name) || !moduleVisible(name)) return;
      coreCache.get(siteId)?.delete(name); render();
    },
    'today-photo-target': () => openTodayPhoto(target.dataset.entityType, id),
    'today-clear-filter': () => { if (view === 'tasks') filters = { search: '', status: '', person: '', priority: '', kind: '' }; else if (coreFilters[view]) delete coreFilters[view].id; render(); },
    'sync-now': () => { offline = !navigator.onLine; void syncQueue(); },
    'discard-op': async () => { await accountLock(async () => { await removeOp(id); }); await refreshPending(); render(); },
    'new-attachment': () => showAttachmentForm(target.dataset.entityType, id),
    'open-attachment': () => openAttachment(id),
    'core-reload': () => { coreCache.delete(siteId); wbsCache.delete(siteId); render(); },
    'reconciliation-filter': () => { reconciliationFilter = reconciliationFilter === target.dataset.kind ? '' : target.dataset.kind; render(); },
    'evidence-export': showEvidenceExport,
    'evidence-download': () => downloadEvidence(target.dataset.format),
    'deviation-filter': () => {
      const key = target.dataset.key;
      coreFilters.deviations[key] = !coreFilters.deviations[key]; render();
    },
    'deviation-import': showDeviationImport,
    'task-waiver-view': () => { filters.waiver = !filters.waiver; renderTasks(); },
    'deviation-view': () => { deviationView = target.dataset.value; render(); },
    'hse-view': () => selectHseView(target.dataset.value),
    'hse-inspection-open': () => selectHseView('inspections', target.dataset.assetId, target.dataset.inspectionId),
    'hse-assets-clear': () => { hseAssetFilters = { category: '', status: '' }; render(); },
    'hse-asset-new': () => showHseAssetForm(),
    'hse-asset-edit': () => showHseAssetForm(id),
    'hse-asset-back': backToHseInspections,
    'hse-inspection-toggle': () => toggleHseInspection(id),
    'hse-inspection-new': showHseInspectionForm,
    'hse-inspection-result': () => setHseInspectionResult(target),
    'core-detail': () => target.dataset.module === 'hseAssets' ? openHseAssetDetail(id) : showCoreDetail(target.dataset.module, id),
    'booking-delete': () => showBookingDelete(id),
    'booking-step': () => { const input = $('#booking-form [name=hours]'); if (input) input.value = Math.max(0, (Number(input.value) || 0) + Number(target.dataset.step)); },
    'logistics-view': () => selectLogisticsView(target.dataset.value),
    'shp-new': () => showShipmentForm(),
    'shp-open': () => { if (moduleVisible('logistics')) { shipmentDetailId = id; render(); } },
    'shp-back': () => { shipmentDetailId = ''; render(); },
    'shp-transition': () => showShipmentTransition(id),
    'shp-receipt': () => showShipmentReceipt(id),
    'shp-detail-reload': () => { coreCache.get(siteId)?.delete(`shipment:${id}`); render(); },
    'pkg-new': () => showPackageForm(id),
    'pkg-open': () => { if (moduleVisible('logistics')) { packageDetailId = id; render(); } },
    'pkg-back': () => { packageDetailId = ''; render(); },
    'pkg-close': () => showPackageClose(id),
    'pkg-order-reload': () => loadPackageOrder(target.closest('form')),
    'pkg-detail-reload': () => { coreCache.get(siteId)?.delete(`package:${id}`); render(); },
    'po-new': () => showPurchaseOrderForm(),
    'po-open': () => { if (moduleVisible('logistics')) { purchaseOrderDetailId = id; render(); } },
    'po-back': () => { purchaseOrderDetailId = ''; render(); },
    'po-edit': () => showPurchaseOrderForm(id),
    'po-item-new': () => showPurchaseOrderItemForm(id),
    'po-item-edit': () => showPurchaseOrderItemForm(id, target.dataset.itemId),
    'po-transition': () => showPurchaseOrderTransition(id, target.dataset.itemId),
    'po-detail-reload': () => { coreCache.get(siteId)?.delete(`purchaseOrder:${id}`); render(); },
    'tool-new': () => { toolEditingId = ''; showToolForm(); },
    'tool-edit': () => { toolEditingId = id; showToolForm(); },
    'tool-delete': () => showToolDelete(id),
    'hse-new': () => { hseEditingId = ''; showHseForm(); },
    'hse-edit': () => { hseEditingId = id; showHseForm(); },
    'hse-attachments': () => showHseAttachments(id),
    'hse-delete': () => showHseDelete(id),
    'cert-new': () => { certEditingId = ''; showCertificationForm(); },
    'cert-edit': () => { certEditingId = id; showCertificationForm(); },
    'cert-delete': () => showCertificationDelete(id),
    'wbs-create': () => { void showWbsForm(); },
    'wbs-edit': () => { void showWbsForm(target.dataset.id); },
    'task-wbs': () => { void showTaskWbsForm(target.dataset.id); },
    'wbs-view': () => { wbsView = target.dataset.value; render(); },
    'wbs-reload': () => { wbsCache.delete(siteId); wbsLoad = null; render(); },
    'wbs-expand': () => { document.querySelectorAll('.wbs-tree details').forEach(node => { node.open = true; }); },
    'wbs-collapse': () => { document.querySelectorAll('.wbs-tree details').forEach(node => { node.open = false; }); },
    'change-password': showPasswordForm, 'request-access': () => showEmailForm('request'), 'forgot-password': () => showEmailForm('forgot'),
    logout, 'new-site': showSiteForm, 'new-task': showTaskForm, reload: loadData,
    'select-site': () => { selectSite(id); go('overview'); }, detail: () => showDetail(id),
    transition: () => showTransition(id, target.dataset.to, { todayReview: target.dataset.todayReview === 'true' }),
    'status-transition': () => runStatusTransition(id, target.dataset.to, target),
    'diary-correct': () => showDiaryCorrection(id), 'diary-versions': () => showDiaryVersions(id),
    'task-status-menu': () => showTaskStatusMenu(id), 'light-transition': () => runLightTransition(id), 'new-entry': () => showEntryForm(target.dataset.shift),
    'view-create': () => showSavedViewForm('create'), 'view-rename': () => showSavedViewForm('rename'),
    'view-delete': () => showSavedViewForm('delete'), 'view-update': updateSelectedView,
    'views-retry': () => { savedViewsCache = null; selectedViewId = ''; renderTasks(); },
    'report-csv-progress': () => exportReportCsv('progress'), 'report-csv-deviations': () => exportReportCsv('deviations'),
    'close-modal': closeModal, 'task-view': () => { taskView = target.dataset.value; renderTasks(); },
    'clear-filters': () => { filters = { search: '', status: '', person: '', priority: '', kind: '' }; renderTasks(); },
    csv: exportCsv, print: () => window.print(),
    'open-report': () => { reportPrintIntent = { site: siteId, user: session?.user.id }; go('report'); },
    'report-retry': () => render(),
    'layout-open': showDashboardLayoutForm,
    'layout-move': () => moveLayoutWidget(target),
    'layout-reset': () => submitDashboardLayout(target.closest('form'), true),
    'import-open': showImportForm,
    'import-template-download': () => downloadImportTemplate(target),
    'import-mapping-save': () => changeImportMapping(),
    'import-mapping-reset': () => changeImportMapping(true),
    'column-filters': () => { columnFiltersOn = !columnFiltersOn; render(); },
    'detail-tab': () => {
      const panel = target.dataset.panel;
      const modal = target.closest('#modal');
      if (!modal) return;
      modal.querySelectorAll('[data-command=detail-tab]').forEach(tab => {
        const active = tab.dataset.panel === panel;
        tab.classList.toggle('selected', active);
        tab.setAttribute('aria-selected', String(active));
      });
      modal.querySelectorAll('[data-detail-panel]').forEach(section => { section.hidden = section.dataset.detailPanel !== panel; });
    },
    'dismiss-demo-notice': dismissDemoNotice,
    'open-demo-info': showDemoInfo,
    'toggle-password': () => {
      const input = document.querySelector('#login-form [name=password]') || document.querySelector('form [name=password]');
      if (!input) return;
      input.type = input.type === 'password' ? 'text' : 'password';
      input.focus();
    },
    'open-settings': showSettingsForm,
    'passkey-login': () => passkeyLogin(false),
    'passkey-discoverable': () => passkeyLogin(true),
    'passkey-security': showPasskeySecurity,
    'passkey-refresh': showPasskeySecurity,
    'ai-open': () => { if (!assistantAvailable()) return; const panel = $('#ai-panel'); panel.hidden = false; for (const selector of ['#ai-fab', '#ai-top']) $(selector).setAttribute('aria-expanded', 'true'); renderAssistant(); $('#ai-form [name=message]').focus(); },
    'ai-close': () => { $('#ai-panel').hidden = true; for (const selector of ['#ai-fab', '#ai-top']) $(selector).setAttribute('aria-expanded', 'false'); $(window.matchMedia('(width < 1180px)').matches ? '#ai-top' : '#ai-fab').focus(); },
    'ai-suggest': () => { askAssistant(target.dataset.text); },
    'more-nav': () => {
      const rest = visibleModules(['today', ...NAV_ITEMS], currentModules()).filter(key => !headerNavItems().includes(key));
      showModal(t('more'), `<nav class="more-nav" aria-label="${t('more')}">${rest.map(key => `<a href="#${key}">${icon(key)}${t(key)}</a>`).join('')}</nav>`);
    },
    'reporting-refresh': () => { if (view === 'reporting' && session && moduleVisible('reporting')) renderReporting(); },
  };
  commands[command]?.();
});
document.addEventListener('submit', async event => {
  if (event.target?.dataset?.passkeyAction) return submitPasskeyForm(event);
  const form = event.target;
  if (form.id === 'workforce-summary-form') {
    event.preventDefault();
    const data = dateFormData(form);
    if (!data) return;
    const span = (Date.parse(data.to) - Date.parse(data.from)) / 86_400_000 + 1;
    if (!(span >= 1 && span <= 366)) { formError(form, new Error('workforceRange')); return; }
    workforceSummaryFilters = { groupBy: data.groupBy, from: data.from, to: data.to };
    coreCache.get(siteId)?.delete('workforceSummary');
    render();
    return;
  }
  if (form.id === 'hse-inspection-form') { event.preventDefault(); await submitHseInspection(form); return; }
  if (form.id === 'dashboard-layout-form') { event.preventDefault(); await submitDashboardLayout(form); return; }
  if (form.id === 'ai-form') {
    event.preventDefault();
    const text = String(new FormData(form).get('message') || '').trim();
    form.reset();
    void askAssistant(text);
    return;
  }
  if (!['deviation-owner-form', 'deviation-attribution-form', 'deviation-import-form', 'task-acceptance-form', 'wbs-form', 'task-wbs-form', 'saved-view-form', 'site-form', 'task-form', 'entry-form', 'diary-correction-form', 'transition-form', 'login-form', 'password-form', 'request-form', 'forgot-form', 'attachment-form', 'booking-form', 'booking-delete-form', 'impact-transition-form', 'progress-steps-form', 'progress-type-form', 'progress-hours-form', 'tool-form', 'tool-delete-form', 'cert-form', 'cert-delete-form', 'hse-asset-form', 'hse-form', 'hse-delete-form', 'import-form', 'settings-form', 'site-settings-form', 'site-assistant-form', 'shp-form', 'shp-status-form', 'shp-receipt-form', 'pkg-form', 'pkg-close-form', 'po-form', 'po-item-form', 'po-status-form'].includes(form.id)) return;
  event.preventDefault();
  if (form.dataset.saving) return;
  if (form.id === 'login-form' && loginRetryUntil > Date.now()) return;
  const data = typeof dateFormData === 'function' ? dateFormData(form) : Object.fromEntries(new FormData(form));
  if (!data) return;
  form.dataset.saving = 'true';
  const submit = form.querySelector('[type=submit]'); submit.disabled = true;
  const version = modalVersion;
  // Capture the selected context before waiting for the server.
  const selectedSite = siteId;
  try {
    if ((form.id === 'diary-correction-form' || (form.id === 'entry-form' && data.motivation !== undefined)) &&
        (data.motivation ?? '').trim().length < 10) {
      throw new Error('diaryMotivationHint');
    }
    if (form.id === 'deviation-owner-form' || form.id === 'deviation-attribution-form') {
      if (!deviationWrite()) throw new Error('forbidden');
      const id = form.dataset.id;
      if (form.id === 'deviation-owner-form') await api.updateDeviationOwner(id, data.userId || null);
      else await api.updateDeviationAttribution(id, data);
      coreCache.get(selectedSite)?.delete('deviations');
      if (siteId === selectedSite && view === 'deviations') render();
      if (version === modalVersion) await showCoreDetail('deviations', id);
      toast(t('actionSaved'));
      return;
    }
    if (form.id === 'deviation-import-form') {
      if (role() !== 'owner' || offline) throw new Error('forbidden');
      const { file, sourceSystem, exportDate, scope } = data;
      if (!file?.size || file.size > 20 * 1024 * 1024) throw new Error('evidenceImportError');
      const hash = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
      const fileSha256 = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
      await api.importDeviationWorkbook(selectedSite, file, { sourceSystem, exportDate, fileSha256, scope, complete: data.complete === 'on' });
      for (const resource of ['deviations', 'reconciliation']) coreCache.get(selectedSite)?.delete(resource);
      if (version === modalVersion) closeModal();
      if (siteId === selectedSite && view === 'deviations') render();
      toast(t('importApplied'));
      return;
    }
    if (form.id === 'task-acceptance-form') {
      if (!canTransitionTask()) throw new Error('forbidden');
      const task = await api.acceptTask(form.dataset.id, { ...data, acceptanceState: 'accepted' });
      rememberTask(task);
      if (siteId === selectedSite && version === modalVersion) await showDetail(task.id);
      toast(t('actionSaved'));
      return;
    }
    if (form.id === 'wbs-form') { await submitWbs(form, data); return; }
    if (form.id === 'task-wbs-form') {
      if (!canEditTask() || form.dataset.site !== siteId || form.dataset.user !== session?.user.id) throw new Error('forbidden');
      rememberTask(await api.updateTaskWbs(form.dataset.id, data.wbsId || null)); closeModal(); render(); return;
    }
    if (form.id === 'saved-view-form') {
      await saveViewChange(form.dataset.action, { id: form.dataset.id, name: data.name, shared: data.shared === 'on' });
      if (version === modalVersion) closeModal();
      return;
    }
    if (form.id === 'settings-form') {
      const data2 = Object.fromEntries(new FormData(form));
      prefs = { version: 2, currency: String(data2.currency || 'EUR'), separators: ['it', 'en'].includes(data2.separators) ? data2.separators : 'auto' };
      savePrefs(); closeModal(); render(); toast(t('settingsSaved')); return;
    }
    if (form.id === 'site-assistant-form') {
      if (role() !== 'owner' || offline || form.dataset.site !== selectedSite) throw new Error('forbidden');
      const user = session.user.id;
      const site = await api.updateSiteAssistant(selectedSite, {
        enabled: form.elements.enabled.checked, timeout_ms: Number(data.timeout_ms),
      });
      if (session?.user.id !== user) return;
      state.sites = state.sites.map(item => item.id === site.id ? {
        ...item, assistant_enabled: site.assistant_enabled, assistant_timeout_ms: site.assistant_timeout_ms,
      } : item);
      try { await accountLock(persistState); } catch { storageError = true; }
      if (version === modalVersion) closeModal();
      toast(t('settingsSaved')); render(); return;
    }
    if (form.id === 'site-settings-form') {
      if (role() !== 'owner' || offline || form.dataset.site !== selectedSite) throw new Error('forbidden');
      const user = session.user.id;
      const site = await api.updateSite(selectedSite, {
        time_zone: data.time_zone, day_cutoff_time: data.day_cutoff_time,
      });
      if (session?.user.id !== user) return;
      const wasCurrentDay = siteId === selectedSite && reportDate === operationalDay().date;
      state.sites = state.sites.map(item => item.id === site.id ? {
        ...item, time_zone: site.time_zone, day_cutoff_time: site.day_cutoff_time,
      } : item);
      if (wasCurrentDay) reportDate = operationalDay().date;
      coreCache.delete(site.id); overviewCache.delete(site.id);
      try { await accountLock(persistState); } catch { storageError = true; }
      if (version === modalVersion) closeModal();
      render(); toast(t('settingsSaved')); return;
    }
    if (form.id === 'import-form') { await handleImport(form); return; }
    if (['booking-form', 'booking-delete-form', 'impact-transition-form', 'progress-steps-form', 'progress-type-form', 'progress-hours-form'].includes(form.id)) { await submitCore(form, data); return; }
    if (['tool-form', 'tool-delete-form'].includes(form.id)) { await submitTool(form, data); return; }
    if (['shp-form', 'shp-status-form', 'shp-receipt-form'].includes(form.id)) { await submitShipment(form, data); return; }
    if (['pkg-form', 'pkg-close-form'].includes(form.id)) { await submitPackage(form, data); return; }
    if (['po-form', 'po-item-form', 'po-status-form'].includes(form.id)) { await submitPurchaseOrder(form, data); return; }
    if (form.id === 'hse-asset-form') { await submitHseAsset(form, data); return; }
    if (['hse-form', 'hse-delete-form'].includes(form.id)) { await submitHse(form, data); return; }
    if (['cert-form', 'cert-delete-form'].includes(form.id)) { await submitCertification(form, data); return; }
    if (form.id === 'login-form') {
      await accountLock(async () => { await flushLogout(); await api.login(data); await forgetActive(); clearSession(); accountChannel?.postMessage('changed'); });
      await loadData({ signedIn: true }); await syncQueue(); return;
    }
    if (form.id === 'password-form') {
      if (data.new_password !== data.confirm_password) throw new Error('passwordMismatch');
      if ([...data.new_password].length < 12 || data.new_password === data.current_password) throw new Error('passwordPolicy');
      await api.changePassword({ current_password: data.current_password, new_password: data.new_password });
      if (version === modalVersion) closeModal();
      await loadData(); await syncQueue(); toast(t('passwordChanged')); return;
    }
    if (['request-form', 'forgot-form'].includes(form.id)) {
      await (form.id === 'request-form' ? api.requestAccess({ ...data, language }) : api.forgotPassword({ ...data, language }));
      if (version === modalVersion) closeModal();
      toast(t('emailAccepted')); return;
    }
    let message, detail;
    if (form.id === 'site-form') { const site = await api.createSite(data); state.sites.push(site); resetSavedViews(); siteId = site.id; filters = { search: '', status: '', person: '', priority: '', kind: '' }; message = 'siteCreated'; }
    if (form.id === 'task-form') { const payload = { ...data, siteId: selectedSite }; taskPayload(payload); await writeOperation('create_task', payload); message = 'taskCreated'; }
    if (form.id === 'diary-correction-form') {
      const original = form.originalEntry;
      if (original.siteId !== selectedSite || !canCorrectDiary(original)) throw new Error('forbidden');
      const changes = Object.fromEntries(Object.entries(diaryContentFields)
        .filter(([label]) => data[label].trim() !== (original[label] ?? ''))
        .map(([label, key]) => [key, data[label]]));
      if (!Object.keys(changes).length) {
        closeModal();
        return;
      }
      changes.motivation = data.motivation;
      const user = session?.user.id;
      const entry = await api.updateDiary(original.id, changes);
      if (user !== session?.user.id) return;
      await accountLock(async () => {
        if (user !== session?.user.id) return;
        state.diary = state.diary.map(item => item.id === entry.id ? entry : item);
        try { await persistState(); } catch { storageError = true; }
      });
      if (user !== session?.user.id) return;
      message = 'entrySaved';
    }
    if (form.id === 'entry-form') {
      const photos = [...(form.querySelector('[name=photos]')?.files || [])];
      if (photos.length && !canAttachDiary()) throw new Error('forbidden');
      const payload = { ...data, siteId: selectedSite, date: form.dataset.date,
        useServerDay: form.dataset.current === 'true' && !offline };
      delete payload.photos;
      diaryPayload(payload);
      const entry = await writeOperation('create_diary', payload);
      if (entry?.date && siteId === selectedSite && version === modalVersion) reportDate = entry.date;
      for (const file of photos) {
        if (!file.size || file.size > 15 * 1024 * 1024 || !/^(image\/[a-z0-9.+-]+|application\/pdf)$/i.test(file.type)) throw new Error('attachmentInvalid');
      }
      if (photos.length && entry?.id) {
        for (const file of photos) {
          await writeOperation('create_attachment', { site_id: selectedSite, entity_type: 'diary', entity_id: entry.id, filename: file.name, blob: file });
        }
      } else if (photos.length) {
        // Queued offline: the entry has no id yet, so the photos wait for the next online save.
        toast(t('attachmentsOnlineOnly'));
      }
      message = 'entrySaved';
    }
    if (form.id === 'transition-form') {
      const task = state.tasks.find(item => item.id === form.dataset.taskId);
      const input = { ...data, to: form.dataset.to, waiver: data.waiver === 'on' };
      if (savingTaskTransitions.has(form.dataset.taskId)) return;
      if (!taskTransitions(task).includes(input.to)) throw new Error('forbidden');
      transitionPayload(task, input);
      savingTaskTransitions.add(task.id);
      if (input.to !== 'blocked') submit.setAttribute('aria-busy', 'true');
      form.querySelector('.form-error').hidden = true;
      try {
        await writeOperation('transition_task', { task, input }, task.id);
      } finally {
        savingTaskTransitions.delete(task.id);
        if (input.to !== 'blocked') submit.removeAttribute('aria-busy');
      }
      if (form.dataset.todayReview !== 'true') detail = state.tasks.find(item => item.id === task.id);
      message = 'actionSaved';
    }
    if (form.id === 'attachment-form') {
      const { entityType } = form.dataset;
      if ((entityType === 'task' && !canEditTask()) || (['hse_event', 'hse_inspection'].includes(entityType) && !permissions().hseWrite) ||
          (entityType === 'diary' && !canAttachDiary()) || (entityType === 'deviation' && !deviationWrite())) throw new Error('forbidden');
      const blob = data.file;
      if (!blob?.size || blob.size > 15 * 1024 * 1024 || !/^(image\/[a-z0-9.+-]+|application\/pdf)$/i.test(blob.type)) throw new Error('attachmentInvalid');
      await writeOperation('create_attachment', { site_id: selectedSite, entity_type: form.dataset.entityType, entity_id: form.dataset.entityId, filename: blob.name, blob });
      message = 'attachmentSaved';
    }
    if (form.id === 'site-form') await accountLock(persistState);
    const sameModal = version === modalVersion;
    if (sameModal) closeModal();
    render();
    if (sameModal && detail && siteId === detail.siteId) showDetail(detail.id);
    if (sameModal && form.id === 'attachment-form' && selectedSite === siteId) {
      if (form.dataset.entityType === 'deviation') await showCoreDetail('deviations', form.dataset.entityId);
      if (form.dataset.entityType === 'task') await showDetail(form.dataset.entityId);
    }
    toast(t(message));
  } catch (error) {
    if (form.id === 'login-form' && error.status === 429 && error.retryAfter) {
      loginRetryUntil = Math.max(loginRetryUntil, Date.now() + error.retryAfter * 1000);
      const loginForm = $('#login-form');
      if (loginForm) {
        loginForm.querySelector('.form-error').hidden = true;
        updateLoginRetry(loginForm);
        loginForm.querySelector('#login-rate-limit').focus();
      }
    } else if (version === modalVersion && form.isConnected) {
      if (form.id === 'hse-asset-form') hseAssetFormError(form, error);
      else formError(form, error);
    }
    else toast(errorMessage(error));
  } finally {
    delete form.dataset.saving;
    if (form.id === 'login-form') {
      if (form.isConnected) updateLoginRetry(form);
    } else submit.disabled = form.id === 'import-form' && (!form.importMappings || form.mappingDirty);
  }
});
$('#modal').addEventListener('cancel', event => {
  if (modalFormState() !== $('#modal').initialFormState) { event.preventDefault(); return; }
  modalVersion++;
});
document.addEventListener('change', async event => {
  const input = event.target.closest('[data-member-access]');
  if (!input) return;
  const selected = input.dataset.site, memberId = input.dataset.member, module = input.dataset.module;
  const previous = !input.checked, allowed = input.checked;
  input.disabled = true;
  try {
    await api.saveModuleAccess({ site_id: selected, member_id: memberId, module, allowed });
    const member = state.memberAccess?.[selected]?.members.find(member => member.user_id === memberId);
    if (member) member.modules[module] = allowed;
    try { await persistState(); } catch { storageError = true; }
    toast(t('accessSaved'));
  } catch (error) { input.checked = previous; toast(errorMessage(error)); }
  finally { input.disabled = false; }
});
$('#site-select').addEventListener('change', event => selectSite(event.target.value));
document.addEventListener('change', event => {
  if (event.target.hasAttribute('data-date-input')) {
    const iso = validateDateInput(event.target);
    if (iso === null) return;
    if (event.target.id === 'report-date') {
      event.target.blur();
      reportDate = iso;
      renderDiary();
    } else if (event.target.dataset.coreFilter && view === 'hse') {
      event.target.blur();
      coreFilters.hse[event.target.dataset.coreFilter] = iso;
      render();
    }
    return;
  }
  const importForm = event.target.closest('#import-form');
  if (importForm) {
    if (event.target.name === 'family' && importForm.importMappings) renderImportMapping(importForm);
    else if (event.target.dataset.importIdentity) {
      const field = event.target.dataset.importIdentity;
      importForm.importIdentity = importForm.importIdentity.filter(value => value !== field);
      if (event.target.checked) importForm.importIdentity.push(field);
      importForm.mappingDirty = true; updateImportIdentityOrder(importForm); invalidateImportPreview(importForm);
    } else if (event.target.name === 'file') invalidateImportPreview(importForm);
  }
  if (event.target.id === 'saved-view-select') {
    selectedViewId = event.target.value;
    applyViewState(selectedSavedView()?.payload); renderTasks();
  }
  if (event.target.matches('#transition-form [name=waiver]')) updateClosureForm(event.target.form);
  if (event.target.id === 'filter-kind') { filters.kind = event.target.value; renderTasks(); }
  if (event.target.id === 'task-sort-key') { taskSort.key = event.target.value; renderTaskResults(); }
  if (event.target.id === 'task-sort-direction') { taskSort.direction = event.target.value; renderTaskResults(); }
  if (event.target.dataset.taskColumn) {
    const checked = [...document.querySelectorAll('[data-task-column]:checked')].map(input => input.dataset.taskColumn);
    if (checked.length) taskColumns = checked;
    document.querySelectorAll('[data-task-column]').forEach(input => { input.disabled = taskColumns.length === 1 && taskColumns.includes(input.dataset.taskColumn); });
    renderTaskResults();
  }
  if (event.target.matches('#pkg-form [name=purchaseOrderId]')) { void loadPackageOrder(event.target.closest('form')); return; }
  if (event.target.dataset.coreFilter && view === 'logistics' && logisticsView === 'shipments') {
    shipmentFilters[event.target.dataset.coreFilter] = event.target.value; render();
  } else if (event.target.dataset.coreFilter && view === 'logistics' && logisticsView === 'packages') {
    packageFilters[event.target.dataset.coreFilter] = event.target.value; render();
  } else if (event.target.dataset.coreFilter && view === 'hse' && hseView === 'inspections') {
    if (event.target.dataset.coreFilter === 'order') hseAssetOrder = event.target.value;
    else hseAssetFilters[event.target.dataset.coreFilter] = event.target.value;
    render();
  } else if (event.target.dataset.coreFilter && coreFilters[view]) {
    const key = event.target.dataset.coreFilter;
    coreFilters[view][key] = event.target.type === 'checkbox' ? event.target.checked : event.target.value;
    if (view === 'progress' && key === 'wbsId') coreFilters.progress.includeDescendants = false;
    render();
    if (view === 'progress') $(`[data-core-filter="${key}"]`)?.focus();
  }
  if (event.target.matches('#impact-transition-form [name=to]')) {
    const closing = event.target.value === 'closed', result = $('#impact-transition-form [name=result]');
    $('#impact-result-field').hidden = !closing; result.required = closing; result.disabled = !closing; if (!closing) result.value = '';
  }
  for (const [id, key] of [['filter-status', 'status'], ['filter-person', 'person'], ['filter-priority', 'priority']]) if (event.target.id === id) { filters[key] = event.target.value; renderTaskResults(); }
});
document.addEventListener('invalid', event => {
  if (event.target.hasAttribute('data-date-input')) validateDateInput(event.target);
}, true);
document.addEventListener('focusout', event => {
  if (event.target.hasAttribute('data-date-input') && event.target.isConnected) validateDateInput(event.target);
});
document.addEventListener('input', event => {
  if (event.target.hasAttribute('data-date-input')) {
    const input = event.target;
    // Some numeric keyboards only offer digits.
    if (/^\d{8}$/.test(input.value)) input.value = input.value.replace(/^(\d{2})(\d{2})(\d{4})$/, '$1/$2/$3');
    input.setCustomValidity('');
    input.removeAttribute('aria-invalid');
    $(`#${input.id}-error`).textContent = '';
  }
  const form = event.target.closest('#import-form');
  if (form) {
    if (event.target.dataset.importAlias) form.mappingDirty = true;
    invalidateImportPreview(form);
  }
  if (event.target.id === 'filter-search') { filters.search = event.target.value; renderTaskResults(); } });
$('#language').addEventListener('click', () => {
  if ($('#modal').open) return toast(t('saveDraftFirst'));
  language = deviceLanguage = language === 'it' ? 'en' : 'it';
  try { localStorage.setItem(LANGUAGE_KEY, deviceLanguage); } catch { /* keep the in-memory choice */ }
  const form = $('#login-form');
  if (form) {
    loginLanguage = language;
    renderChrome();
    localizeLogin(form);
  } else {
    render();
  }
  if (session) {
    pendingLanguage = { userId: session.user.id, language };
    if (session.user.shared_demo === false) void accountLock(saveLanguagePreference);
  }
});
window.addEventListener('resize', updateDeviationBoardScroll);
window.matchMedia('(max-width: 520px)').addEventListener('change', () => { if (view === 'deviations') render(); });
window.addEventListener('hashchange', () => { const next = location.hash.slice(1); view = initialView({ width: window.innerWidth, hash: next ? `#${next}` : '#overview' }); if (view !== 'report') reportPrintIntent = null; closeModal(); render(); $('#main').focus(); });
window.addEventListener('offline', () => { offline = true; renderOffline(); if (moduleResources[view] || view === 'today') { closeModal(); render(); } });
for (const breakpoint of ['(width < 640px)', '(min-width: 1180px)']) {
  window.matchMedia(breakpoint).addEventListener('change', renderChrome);
}
window.addEventListener('online', () => {
  offline = false; coreCache.clear(); renderOffline();
  if (moduleResources[view] || view === 'today' || view === 'tasks') render();
  if (session) void syncQueue();
  else void accountLock(flushLogout).catch(error => toast(errorMessage(error)));
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) void syncQueue(); });

accountChannel?.addEventListener('message', () => { clearSession(); void loadData(); });
navigator.serviceWorker?.addEventListener('message', event => {
  if (event.data?.scope !== offlineScope) return;
  if (event.data.type === 'offline-synced') void loadData();
  if (event.data.type === 'offline-access-denied') {
    if (event.data.status === 401) clearSession(true);
    else if (event.data.code === 'MODULE_FORBIDDEN') { wbsCache.clear(); void loadData(); }
    else { void forgetActive(); state = { sites: [], tasks: [], diary: [], attachments: [] }; loadError = { status: 403 }; render(); }
  }
});
setInterval(() => { if (pendingOps.some(op => op.status !== 'failed') && navigator.onLine) void syncQueue(); }, 30000);
async function start() {
  initDemoNotice();
  initLanguage();
  render();
  try { await openDb(); storageReady = true; } catch { storageError = true; }
  if ('serviceWorker' in navigator) {
    try {
      swRegistration = await navigator.serviceWorker.register('./sw.js', { type: 'module' });
      void navigator.serviceWorker.ready.then(registration => { swRegistration = registration; if (pendingOps.length) void registerSync(registration); });
    } catch (error) {
      // Without a worker the app stays usable online; offline features are simply absent.
      // The message is logged once, with the driver text only, and never shown as a banner.
      swUnavailable = true;
      console.warn('offline unavailable: service worker registration failed', error?.message || error);
    }
  }
  await loadData();
  if (pendingOps.length) { await registerSync(swRegistration); await syncQueue(); }
}
void start();
