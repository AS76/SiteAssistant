import { initialView, todayActions, recentActions, defaultViewState, sanitizeViewState, viewStatePayload, lightTaskRows, transitionNeedsDialog, TASK_COLUMNS, REPORT_PROGRESS_COLUMNS, REPORT_DEVIATION_COLUMNS, reportProgressRows, reportDeviationRows, offlineBannerState, STATUSES, PRIORITIES, today, validDate, allowedTransitions, transitionRequirements, counts, csvCell, taskPayload, diaryPayload, transitionPayload, DEVIATION_STATUSES, IMPACT_STATUSES, IMPACT_RESULTS, TOOL_STATUSES, TASK_KINDS, taskKindLabelKey, impactTransitions, corePermissions, filterSortRecords, impactTotals, groupBookings, weeklyBookingHours, flattenWbs, navGroups, visibleModules, toolCompanies, filterTools, toolStatusLabelKey, filterCertifications, certificationCounts, CERT_CATEGORIES, CERT_STATUSES, certCategoryLabelKey, certStatusLabelKey, HSE_TYPES, HSE_SEVERITIES, filterHseEvents, hseCounts } from './domain.mjs';
import { createApi, DEFAULT_BASE_URL } from './api.mjs';
import { messages } from './i18n.mjs';
import { DASHBOARD_WIDGETS, defaultDashboardLayout, validDashboardWidgets } from './dashboard-layout.mjs';
import { openDb, enqueue, listOps, replayOps, removeOp, getMirror, setMirror, overlayPending, scopeFor, registerSync, withSyncLock } from './offline.mjs';

const api = createApi({ baseUrl: new URL(document.querySelector('meta[name=siteassistant-api-base]')?.content || DEFAULT_BASE_URL, location.href).href, onUnauthorized: () => clearSession(true) });
const freshApi = createApi({ baseUrl: api.baseUrl, fresh: true, onUnauthorized: () => clearSession(true) });
// Display preferences live in this browser: currency and number formatting for money fields.
const PREF_KEY = 'siteassistant-prefs';
let prefs = (() => {
  try { return { currency: 'EUR', decimals: 2, separators: 'it', ...(JSON.parse(localStorage.getItem(PREF_KEY) || '{}')) }; }
  catch { return { currency: 'EUR', decimals: 2, separators: 'it' }; }
})();
const savePrefs = () => { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch { /* private mode */ } };
const money = value => {
  if (value == null || value === '') return t('coreUnknown');
  const locale = prefs.separators === 'en' ? 'en-GB' : 'it-IT';
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency: prefs.currency,
      minimumFractionDigits: prefs.decimals, maximumFractionDigits: prefs.decimals, useGrouping: 'always' }).format(Number(value));
  } catch { return String(value); }
};
let offlineScope, pendingOps = [], offline = !navigator.onLine, storageReady = false, storageError = false, swUnavailable = false, swRegistration, syncRun;
const accountChannel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('siteassistant-session') : null;
const accountLock = run => navigator.locks ? withSyncLock(run) : run();
const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
let session = null;
let state = { sites: [], tasks: [], diary: [], attachments: [] }, language = 'it', siteId, actor = '', loading = true, loadError = null, toastTimer, modalVersion = 0;
let view = initialView({ width: window.innerWidth, hash: location.hash });
let filters = { search: '', status: '', person: '', priority: '', kind: '' };
let taskView = 'board';
let taskSort = defaultViewState().sort, taskColumns = [...TASK_COLUMNS];
let selectedViewId = '', savedViewsCache = null;
let wbsView = 'tree', wbsLoad = null;
const wbsCache = new Map();
let reportDate = today();
let reportPrintIntent = null, lastReport = null;
const t = key => Object.hasOwn(messages[language], key) ? messages[language][key] : key;
const personName = name => esc(name || '—');
const currentSite = () => state.sites.find(site => site.id === siteId);
const siteTasks = () => state.tasks.filter(task => task.siteId === siteId);
const dateLabel = value => value && validDate(value) ? new Intl.DateTimeFormat(language === 'it' ? 'it-IT' : 'en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(`${value}T12:00:00`)) : t('noDue');
const timeLabel = value => new Intl.DateTimeFormat(language === 'it' ? 'it-IT' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
const paths = {
  overview:'<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  sites:'<path d="M3 21h18M5 21V7l7-4 7 4v14M9 9h1m4 0h1M9 13h1m4 0h1M10 21v-4h4v4"/>',
  tasks:'<rect x="4" y="3" width="16" height="18" rx="2"/><path d="m8 8 1 1 2-2m2 1h3M8 13h2m3 0h3M8 17h2m3 0h3"/>',
  diary:'<path d="M4 3h13a3 3 0 0 1 3 3v15H7a3 3 0 0 1-3-3V3Zm0 14h16M8 7h8M8 11h6"/>',
  tools:'<path d="m14.7 6.3-2.3 2.3-3-3 2.3-2.3a4 4 0 0 0-5.4 5.4L3 12l3 3 6.3-6.3a4 4 0 0 0 5.4 2.3Z"/><path d="m13 15 6 6M15 13l6 6"/>',
  execution:'<path d="m8 5 11 7-11 7V5Z"/>',review:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',closed:'<circle cx="12" cy="12" r="9"/><path d="m7 12 3 3 7-7"/>',overdue:'<path d="m12 3 10 18H2L12 3Zm0 6v5m0 3h.01"/>',
};
const icon = key => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[key] || paths.tasks}</svg>`;
const badge = status => `<span class="badge ${status}">${t(status)}</span>`;
const priorityBadge = priority => priority !== 'normal' ? `<span class="badge ${esc(priority)}">${esc(t(priority))}</span>` : '';
const button = (key, command, extra = '', css = '') => `<button type="button" class="${css}" data-command="${command}" ${extra}>${t(key)}</button>`;
function toast(message) {
  clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 5000);
}
const errorKeys = { HSE_INVALID: 'hseInvalid', HSE_FORBIDDEN: 'forbidden', HSE_NOT_FOUND: 'hseNotFound', MODULE_FORBIDDEN: 'moduleUnavailable', ACCESS_INVALID: 'accessInvalid', LAYOUT_INVALID: 'layoutInvalid', MAP_INVALID: 'importMappingInvalid', PREVIEW_MISMATCH: 'importPreviewStale', PREVIEW_EXPIRED: 'importPreviewStale', VIEW_NAME_TAKEN: 'viewNameTaken', VIEW_NOT_FOUND: 'viewNotFound', VIEW_FORBIDDEN: 'forbidden', VIEW_INVALID: 'viewInvalid', TOOL_NOT_FOUND: 'toolNotFound', TOOL_FORBIDDEN: 'forbidden', TOOL_INVALID: 'toolInvalid', VALIDATION_ERROR: 'invalidData', TIME_BOOKING_NOT_FOUND: 'coreRecordGone', WORK_DAY_NOT_FOUND: 'coreRecordGone', SITE_PROGRESS_ITEM_NOT_FOUND: 'coreRecordGone', DEVIATION_NOT_FOUND: 'coreRecordGone', COST_IMPACT_NOT_FOUND: 'coreRecordGone', TIME_BOOKING_DUPLICATE: 'coreDuplicateBooking', TIME_BOOKING_SITE_MISMATCH: 'coreSiteMismatch', COST_IMPACT_CONFLICT: 'coreImpactConflict', MAIL_NOT_CONFIGURED: 'mailUnavailable', MAIL_UNAVAILABLE: 'mailUnavailable', DUPLICATE_SITE_CODE: 'duplicateCode', DUPLICATE_DIARY: 'duplicateDiary', SEPARATE_PEOPLE_REQUIRED: 'separatePeople', INVALID_TRANSITION: 'actionDenied', VERIFIER_REQUIRED: 'verifierRequired', NOTE_REQUIRED: 'noteRequired', REASON_REQUIRED: 'reasonRequired' };
function errorMessage(error) { if (error.code === 'MODULE_FORBIDDEN') return t('moduleUnavailable'); return t(({ 401: error.code === 'INVALID_CREDENTIALS' ? 'invalidCredentials' : 'authRequired', 403: 'forbidden', 429: 'rateLimited' })[error.status] || errorKeys[error.code] || (error.message in messages[language] ? error.message : 'apiError')); }
function clearSession(invalidate = false) {
  reportPrintIntent = null; lastReport = null;
  resetSavedViews();
  overviewCache.clear();
  wbsCache.clear(); wbsLoad = null; resetCore();
  session = null; actor = ''; siteId = undefined; loadError = null; offlineScope = undefined; pendingOps = [];
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
async function logout() {
  try {
    await accountLock(async () => { await api.logout(); await forgetActive(); clearSession(); accountChannel?.postMessage('changed'); });
  } catch (error) { toast(errorMessage(error)); }
}
async function persistState() {
  if (!storageReady || !offlineScope) return;
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
async function loadData() {
  coreCache.clear(); overviewCache.clear();
  loading = true; loadError = null; render();
  try {
    await accountLock(async () => {
      let active = storageReady ? await getMirror('active') : null;
      try {
        session = await freshApi.me(); actor = session.user.name; offline = false;
        offlineScope = scopeFor(api.baseUrl, session.user.id);
        active = { scope: offlineScope, baseUrl: api.baseUrl, session };
        if (storageReady) await setMirror('active', active);
      } catch (error) {
        if (error.code !== 'NETWORK_ERROR' || active?.baseUrl !== api.baseUrl) throw error;
        const saved = await getMirror(`state:${active.scope}`);
        if (!saved) throw error;
        offline = true; session = active.session; actor = session.user.name; offlineScope = active.scope; state = saved;
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
      if (!state.sites.some(site => site.id === siteId)) { resetSavedViews(); siteId = state.sites[0]?.id; }
    });
  } catch (error) { loadError = error; }
  loading = false; render();
}
async function syncQueue() {
  if (syncRun || !navigator.onLine || !session || !storageReady) return syncRun;
  syncRun = (async () => {
    try {
      await replayOps(freshApi, { scope: offlineScope, userId: session.user.id });
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
  const op = await enqueue({ op_type, payload, entity_id, scope: offlineScope });
  await refreshPending();
  if (navigator.onLine && !offline) await syncQueue();
  if (pendingOps.some(item => item.status !== 'failed')) await registerSync(swRegistration);
  const current = pendingOps.find(item => item.id === op.id);
  if (current?.status === 'failed') throw Object.assign(new Error('syncFailed'), current.error);
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
function rememberTask(task) { state.tasks = state.tasks.map(item => item.id === task.id ? task : item); }
function heading(title, subtitle, actions = '') {
  return `<div class="page-heading"><div><div class="eyebrow">${esc(currentSite()?.code || '')} · ${esc(currentSite()?.name || '')}</div><h1>${t(title)}</h1><p>${t(subtitle)}</p></div><div class="heading-actions">${actions}</div></div>`;
}
function empty(title, subtitle, action = '') { return `<div class="empty"><strong>${t(title)}</strong>${t(subtitle)}${action ? `<div style="margin-top:16px">${action}</div>` : ''}</div>`; }
function renderChrome() {
  renderOffline();
  document.documentElement.lang = language;
  document.title = `SiteAssistant · ${t(view)}`;
  $('#brand-sub').textContent = t('brandSub'); $('#workspace-label').textContent = t('workspace');
  $('#local-label').innerHTML = `${t('local')}<small>${t('fiction')}</small>`;
  // The assistant only exists for a signed-in user: no fab, no panel on the login screen.
  const fab = $('#ai-fab'), aiPanel = $('#ai-panel');
  if (fab) fab.hidden = !session;
  if (aiPanel && !session) aiPanel.hidden = true;
  $('#navigation').setAttribute('aria-label', t('nav'));
  $('#navigation').classList.add('core-navigation');
  $('.sidebar').classList.add('core-sidebar');
  const compact = compactNavigation();
  const navItems = visibleModules(compact ? MOBILE_PRIMARY : NAV_ITEMS, currentModules());
  const more = compact && !MOBILE_PRIMARY.includes(view);
  const navLabel = key => t(compact && key === 'bookings' ? 'bookingsShort' : key);
  const navLink = key => `<a href="#${key}" ${view === key ? 'class="active" aria-current="page"' : ''}>${icon(key)}<span>${navLabel(key)}</span></a>`;
  $('#navigation').innerHTML = (compact
    ? navItems.map(navLink).join('') + `<button type="button" class="nav-more${more ? ' active' : ''}" data-command="more-nav">${icon('more')}${t('more')}</button>`
    : navGroups(currentModules()).map(group => `<div class="nav-group"><span class="nav-section">${t(group.label)}</span>${group.items.map(navLink).join('')}</div>`).join(''));
  $('#skip').textContent = t('skip'); $('#site-label').textContent = t('site'); $('#actor-label').textContent = t('actor'); $('#manual-link').textContent = t('manual');
  $('#site-select').innerHTML = state.sites.map(site => `<option value="${esc(site.id)}" ${site.id === siteId ? 'selected' : ''}>${esc(site.name)}</option>`).join('');
  $('#actor-input').value = actor;
  $('#actor-input').readOnly = true;
  $('#navigation').hidden = !session;
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
  const bannerDismissed = sessionStorage.getItem('sa-password-banner') === 'hidden';
  passwordBanner.hidden = !session?.password_change_required || bannerDismissed;
  passwordBanner.innerHTML = `<strong>${t('passwordChangeNotice')}</strong> ${button('changePassword', 'change-password')} <button type="button" class="text-button" data-command="dismiss-password-banner" aria-label="${t('close')}">×</button>`;
  logoutButton.hidden = !session; logoutButton.textContent = t('logout');
  $('#actor-input').placeholder = t('actorPlaceholder');
  $('#site-select').disabled = loading || !state.sites.length;
  $('#language').textContent = language === 'it' ? 'EN' : 'IT';
  $('#language').setAttribute('aria-label', language === 'it' ? 'Switch to English' : 'Passa all’italiano');
  $('#demo-banner').innerHTML = `<strong>${t('demo')}</strong> &nbsp; ${t('demoNote')}`;
  $('#footer-note').textContent = t('footer');
}
function dueMarkup(task) { return `<span class="due ${task.status !== 'closed' && task.due && task.due < today() ? 'overdue' : ''}">${dateLabel(task.due)}</span>`; }
function taskRow(task) {
  return `<div class="task-row"><div><h3><button data-command="detail" data-id="${esc(task.id)}">${esc(task.title)}</button></h3><p>${esc(task.area || t('noArea'))} · ${esc(task.company)}</p>${badge(task.status)} ${priorityBadge(task.priority)} ${syncBadge(task)}</div><div class="subtitle">${dueMarkup(task)}</div></div>`;
}
function todayResource(name) {
  return coreCache.get(siteId)?.get(name)?.data ?? state.todayResources?.[siteId]?.[name] ?? [];
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
function currentTodayActions() {
  return todayActions({ tasks: siteTasks(), progress: todayResource('progress'),
    diary: state.diary.filter(entry => entry.siteId === siteId), deviations: todayResource('deviations'),
    userId: session?.user.id, today: today(), modules: currentModules() });
}
function canCloseTodayTask(task) {
  const selfReview = task.submitted_by_id ? task.submitted_by_id === session?.user.id : task.submitted_by === actor;
  return canRunLightTransition(task) && task.status !== 'closed'
    && (role() === 'owner' || task.verifier_id === session?.user.id)
    && Boolean(task.submitted_by_id || task.submitted_by) && !selfReview;
}
function todayPhotoTargets() {
  const entries = moduleVisible('diary') ? state.diary.filter(entry => entry.siteId === siteId && entry.date === today())
    .map(entry => ({ type: 'diary', id: entry.id, title: `${t('journalToday')} · ${t(entry.shift)}` })) : [];
  const tasks = moduleVisible('tasks') ? filterSortRecords(siteTasks().filter(task => task.status !== 'closed'), {}, [{ key: 'due' }, { key: 'title' }, { key: 'id' }])
    .map(task => ({ type: 'task', id: task.id, title: task.title })) : [];
  return [...entries, ...tasks].slice(0, 5);
}
function renderToday() {
  const actions = currentTodayActions();
  const recent = moduleVisible('tasks') ? recentActions({ tasks: siteTasks() }) : [];
  const row = (item, kind = item.kind) => `<li><button type="button" class="today-row" data-command="today-open" data-kind="${kind}" data-id="${esc(item.id)}"><strong>${esc(item.title || (item.kind === 'diary' ? t('journalToday') : item.id))}</strong><span>${kind === 'recent'
    ? `${t('todayClosed')} · ${item.date ? esc(timeLabel(item.date)) : t('todayClosureUnknown')}`
    : `${t(item.meta.label)}${item.meta.status ? ` · ${t(item.meta.status)}` : ''}${item.meta.due ? ` · ${esc(dateLabel(item.meta.due))}` : ''}`}</span></button></li>`;
  const quick = (label, action, enabled) => button(label, 'today-quick', `data-action="${action}" ${enabled ? '' : 'disabled'}`);
  const quickActions = [
    moduleVisible('tasks') ? quick('todayCloseTask', 'close', canWriteTask()) : '',
    moduleVisible('diary') ? quick('todayWriteDiary', 'diary', canWriteTask()) : '',
    moduleVisible('tasks') || moduleVisible('diary') ? quick('todayTakePhoto', 'photo', canWriteTask()) : '',
    moduleVisible('progress') ? quick('todayUpdateProgress', 'progress', permissions().steps) : '',
  ].join('');
  $('#main').innerHTML = heading('today', 'todaySub') + `<div class="today-content">
    <section class="panel today-section" aria-labelledby="today-todo"><h2 id="today-todo">${t('todayTodo')}</h2>
      ${actions.length ? `<ul class="today-list">${actions.map(item => row(item)).join('')}</ul>` : `<p class="note">${t('todayEmpty')}</p>`}
      ${moduleVisible('progress') || moduleVisible('deviations') ? `<p class="note">${t('todayLoadedOnly')}</p>` : ''}</section>
    <section class="panel today-section" aria-labelledby="today-quick"><h2 id="today-quick">${t('todayQuick')}</h2><div class="today-quick">${quickActions}</div></section>
    <section class="panel today-section" aria-labelledby="today-recent"><h2 id="today-recent">${t('todayRecent')}</h2>
      ${recent.length ? `<ul class="today-list">${recent.map(item => row(item, 'recent')).join('')}</ul>` : `<p class="note">${t('todayRecentEmpty')}</p>`}</section>
    ${offline ? `<p class="today-connection" role="status">${t('todayOffline')} <strong>${pendingOps.length}</strong> ${t('todayQueued')}</p>` : ''}</div>`;
}
function openTodayAction(control) {
  const item = control.dataset.kind === 'recent'
    ? (moduleVisible('tasks') ? recentActions({ tasks: siteTasks() }).find(row => row.id === control.dataset.id) : null)
    : currentTodayActions().find(row => row.id === control.dataset.id && row.kind === control.dataset.kind);
  if (!item || !moduleVisible(item.target.view)) return;
  const target = item.target;
  if (target.view === 'tasks') { resetSavedViews(); filters = { ...filters, ...target.filters }; taskView = 'list'; }
  else if (target.view === 'diary') reportDate = target.date;
  else { coreFilters[target.view] = { ...Object.fromEntries(Object.keys(coreFilters[target.view]).map(key => [key, ''])), ...target.filters }; if (target.view === 'deviations') deviationView = 'list'; }
  go(target.view);
}
function runTodayQuick(action) {
  if (action === 'close' && moduleVisible('tasks') && canWriteTask()) {
    resetSavedViews(); filters = { ...filters, status: 'to_verify', kind: 'ordinary', closable: true }; taskView = 'light'; go('tasks');
  } else if (action === 'diary' && moduleVisible('diary') && canWriteTask()) {
    reportDate = today(); showEntryForm();
  } else if (action === 'progress' && moduleVisible('progress') && permissions().steps) {
    coreFilters.progress = { wbsId: '' }; go('progress');
  } else if (action === 'photo' && canWriteTask() && (moduleVisible('tasks') || moduleVisible('diary'))) {
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
  const lastEntry = state.diary.filter(item => item.siteId === siteId && item.date === today()).at(-1);
  return {
    priority_work: `<section class="panel"><div class="panel-header"><h2>${t('priorityWork')}</h2><a class="subtitle" href="#tasks">${t('seeAll')} →</a></div>${attention.length ? attention.map(taskRow).join('') : empty('noTasks', 'noTasksHint')}</section>`,
    daily_pulse: `<section class="panel"><div class="panel-header"><h2>${t('dailyPulse')}</h2></div><div class="panel-body"><div class="metrics">${['execution', 'review', 'closed', 'overdue'].map(key => `<div class="metric ${key === 'overdue' ? 'alert' : key === 'closed' ? 'complete' : key}"><div class="metric-top">${t(key)}${icon(key)}</div><strong data-metric="${key}">${count[key]}</strong><small>${t(`${key}Hint`)}</small></div>`).join('')}</div><div class="progress-label"><span>${t('verifiedProgress')}</span><strong>${count.closed} / ${total}</strong></div><div class="progress-track"><span style="width:${total ? count.closed / total * 100 : 0}%"></span></div><p class="note">${total - count.closed} ${t('nonClosed')}</p><div class="summary-stack"><div class="summary-line"><strong>${count.blocked} ${t('blockedPlural')}</strong><p>${count.review} ${t('reviewPlural')}</p></div><div class="summary-line"><strong>${t('workingRule')}</strong><p>${t('workingRuleNote')}</p></div></div></div></section>`,
    journal_today: `<section class="panel"><div class="panel-header"><h2>${t('journalToday')}</h2><span class="badge">${t('draft')}</span></div><div class="panel-body"><p class="subtitle prewrap">${lastEntry ? esc(lastEntry.actual) : t('noDiary')}</p>${syncBadge(lastEntry)}<a class="subtitle" href="#diary">${t('openDiary')} →</a></div></section>`,
  };
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
    const percent = value => value == null ? esc(t('coreUnknown')) : `<span>${coreNumber(value)}%</span>
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
        data.progress.map(row => [esc(row.area), coreNumber(row.items), percent(row.actual), percent(row.planned), esc(t(`reportSource_${row.source}`))]))
      + `<h3>${t('earnedValueTitle')}</h3>` + earnedValueSummary(data.earnedValue) + '</section>'
      + table('deviations', ['reportArea', 'reportTotal', 'reportOpen', 'reportClosed', 'reportByStatus'],
        data.deviations.map(row => [esc(row.area), coreNumber(row.total), coreNumber(row.open), coreNumber(row.closed),
          row.by_status.map(entry => `<span class="report-status">${esc(entry.status == null ? t('coreUnknown') : t(entry.status))}: ${coreNumber(entry.count)}</span>`).join(' ')]))
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
  return `<dl class="detail-grid core-details">${[
    ['earnedValueEV', value.ev_hours], ['earnedValuePV', value.pv_hours], ['earnedValueAC', value.ac_hours],
    ['earnedValueCPI', value.cpi], ['earnedValueSPI', value.spi],
  ].map(([label, number]) => `<div><dt>${t(label)}</dt><dd>${coreNumber(number)}</dd></div>`).join('')}</dl>`
    + (value.items_without_hours ? `<p class="note">${t('earnedValueMissingHours')}: ${coreNumber(value.items_without_hours)}</p>` : '');
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
  return `<ul class="mini-bars">${rows.map(row => `<li><span class="bar-label">${esc(row.section)}</span><span class="bar-track"><span class="bar-actual" style="width:${((row.actual ?? 0) / max * 100).toFixed(1)}%"></span>${row.planned == null ? '' : `<span class="bar-planned" style="left:${(row.planned / max * 100).toFixed(1)}%"></span>`}</span><span class="bar-value">${row.actual == null ? '—' : `${row.actual}%`}</span></li>`).join('')}</ul>`;
}
function renderOverviewWidgets(target, widgets, data, failed = false) {
  const content = localOverviewWidgets();
  const panel = (label, body) => `<section class="panel"><div class="panel-header"><h2>${t(label)}</h2></div><div class="panel-body">${body}</div></section>`;
  const unavailable = `<p class="note" role="status">${t(failed ? 'apiError' : 'loading')}</p>`;
  const kpis = {};
  if (data) {
    const total = data.deviations.reduce((sum, row) => sum + row.count, 0);
    kpis.kpi_open_deviations = data.deviations.filter(row => !['closed', 'rejected'].includes(row.status)).reduce((sum, row) => sum + row.count, 0);
    const number = value => new Intl.NumberFormat(language === 'it' ? 'it-IT' : 'en-GB', { maximumFractionDigits: 1 }).format(value);
    const weeks = weeklyBookingHours(data.hours, data.workDays || []);
    kpis.kpi_booked_hours = number(weeks.reduce((sum, row) => sum + row.appBookedHours, 0));
    kpis.kpi_open_claims = money(data.claims.open);
    kpis.kpi_settled_claims = money(data.claims.settled);
    const maxHours = Math.max(1, ...weeks.map(row => row.appBookedHours));
    content.deviations_by_status = panel('dashDeviations', `<div class="dash-donut">${donut(data.deviations, total)}
      <ul class="donut-legend">${data.deviations.map(row => `<li><i style="background:${STATUS_COLORS[row.status] || '#94a3a3'}"></i>${esc(t(row.status))}<strong>${row.count}</strong></li>`).join('')}</ul></div>`);
    content.progress_by_section = panel('dashProgress', data.progress.length ? sectionBars(data.progress) : `<p class="note">${t('noResults')}</p>`);
    content.hours_by_week = panel('dashHours', weeks.length ? `<ul class="mini-bars weekly-hours">${weeks.map(row => `<li><span class="bar-label">${esc(row.week)}</span><span class="bar-track"><span class="bar-actual" style="width:${(row.appBookedHours / maxHours * 100).toFixed(1)}%"></span></span><span class="bar-value"><span>${t('coreAppBookedHours')}: ${number(row.appBookedHours)}</span>${row.sourceWorkTime == null ? '' : `<span>${t('coreSourceWorkTime')}: ${number(row.sourceWorkTime)}</span>`}</span></li>`).join('')}</ul>` : `<p class="note">${t('noResults')}</p>`);
    content.earned_value = panel('earnedValueTitle', earnedValueSummary(data.earnedValue));
  }
  const chosen = widgets.map(id => DASHBOARD_WIDGETS.find(widget => widget.id === id));
  const cards = chosen.filter(widget => widget.kind === 'kpi').map(widget => `<div class="kpi-card" data-widget="${widget.id}"><span>${t(widget.label)}</span><strong>${data ? esc(String(kpis[widget.id])) : esc(t(failed ? 'apiError' : 'loading'))}</strong></div>`).join('');
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
    : Promise.all([freshApi.dashboard(selected), freshApi.listWorkDays({ siteId: selected }).catch(() => [])])
      .then(([data, workDays]) => ({ ...data, workDays }))).catch(() => null);
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
  if (role() === 'owner' && siteId) {
    const modules = navGroups().flatMap(group => group.items);
    const members = state.memberAccess?.[siteId]?.members || [];
    $('#main').insertAdjacentHTML('beforeend', `<section class="panel module-access"><div class="panel-body"><h2>${t('moduleAccess')}</h2><p>${t('moduleAccessHint')}</p><div class="table-scroll"><table><thead><tr><th scope="col">${t('accessMember')}</th>${modules.map(module => `<th scope="col">${t(module)}</th>`).join('')}</tr></thead><tbody>${members.map(member => `<tr><th scope="row">${esc(member.name)}<br><small>${esc(member.email)} · ${esc(member.role === 'owner' ? t('accessOwner') : member.role)}</small></th>${modules.map(module => {
      const locked = member.role === 'owner' || ['sites', 'overview'].includes(module);
      return `<td><input type="checkbox" data-member-access data-site="${esc(siteId)}" data-member="${esc(member.user_id)}" data-module="${module}" aria-label="${esc(member.name)} · ${t(module)}" ${locked || member.modules[module] !== false ? 'checked' : ''} ${locked || offline ? 'disabled' : ''}></td>`;
    }).join('')}</tr>`).join('')}</tbody></table></div></div></section>`);
  }
}
function filteredTasks() {
  const needle = filters.search.trim().toLocaleLowerCase();
  return siteTasks().filter(task => (!filters.id || task.id === filters.id)
    && (!filters.closable || canCloseTodayTask(task))
    && (!filters.status || task.status === filters.status) && (!filters.person || task.assignee === filters.person)
    && (!filters.priority || task.priority === filters.priority)
    && (!filters.kind || (task.kind ?? 'ordinary') === filters.kind)
    && (!needle || `${task.title} ${task.area} ${task.company}`.toLocaleLowerCase().includes(needle)));
}
const currentViewState = () => viewStatePayload({ filters, sort: taskSort, columns: taskColumns, layout: taskView });
const selectedSavedView = () => savedViewsCache?.data?.find(item => item.id === selectedViewId);
const canCreateView = () => ['owner', 'editor', 'verifier'].includes(role());
const canWriteTask = () => ['owner', 'editor', 'verifier'].includes(role());
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
  $('#main').innerHTML = heading('tasksTitle', 'tasksSub', button('exportCsv', 'csv') + (canWriteTask() ? button('newTask', 'new-task', '', 'primary') : '')) +
    `<div id="saved-views" class="toolbar saved-views"></div><div class="toolbar"><input class="search" id="filter-search" maxlength="512" aria-label="${t('search')}" placeholder="${t('search')}" value="${esc(filters.search)}"><select id="filter-status" aria-label="${t('status')}"><option value="">${t('allStatuses')}</option>${STATUSES.map(status => `<option value="${status}" ${filters.status === status ? 'selected' : ''}>${t(status)}</option>`).join('')}</select><select id="filter-person" aria-label="${t('assignee')}"><option value="">${t('allPeople')}</option>${[...new Set([...siteTasks().map(task => task.assignee), ...(filters.person ? [filters.person] : [])])].map(person => `<option value="${esc(person)}" ${filters.person === person ? 'selected' : ''}>${personName(person)}</option>`).join('')}</select><select id="filter-priority" aria-label="${t('priority')}"><option value="">${t('allPriorities')}</option>${PRIORITIES.map(priority => `<option value="${priority}" ${filters.priority === priority ? 'selected' : ''}>${t(priority)}</option>`).join('')}</select><select id="filter-kind" aria-label="${t('kind')}"><option value="">${t('allKinds')}</option>${TASK_KINDS.map(kind => `<option value="${kind}" ${filters.kind === kind ? 'selected' : ''}>${t(taskKindLabelKey(kind))}</option>`).join('')}</select><div class="view-toggle">${button('board', 'task-view', `data-value="board" aria-pressed="${taskView === 'board'}"`, taskView === 'board' ? 'selected' : '')}${button('list', 'task-view', `data-value="list" aria-pressed="${taskView === 'list'}"`, taskView === 'list' ? 'selected' : '')}${button('light', 'task-view', `data-value="light" aria-pressed="${taskView === 'light'}"`, taskView === 'light' ? 'selected' : '')}</div></div>${taskView === 'list' ? taskListControls() : ''}<div id="task-results"></div>`;
  renderSavedViews(); renderTaskResults();
}
function taskCard(task) {
  return `<button type="button" class="task-card" data-command="detail" data-id="${esc(task.id)}"><span class="card-code">${esc(task.area || t('noArea'))}</span><h2>${esc(task.title)}</h2>${task.kind === 'corrective' ? `<span class="badge">${t('kindCorrective')}</span> ` : ''}${priorityBadge(task.priority)} ${syncBadge(task)}<p>${esc(task.company)}</p><p>${personName(task.assignee)}</p><div class="card-footer">${dueMarkup(task)}<span>→</span></div></button>`;
}
const lightTransitions = new Set();
function canRunLightTransition(task) {
  const to = task?.status === 'closed' ? 'todo' : 'closed';
  return Boolean(task?.kind === 'ordinary' && canWriteTask() && allowedTransitions(task).includes(to)
    && !lightTransitions.has(task.id)
    && !pendingOps.some(op => op.entity_id === task.id && (op.op_type === 'transition_task' || op.status === 'failed')));
}
function lightTaskButton(task) {
  if (!canWriteTask()) return '—';
  const key = task.status === 'closed' ? 'lightReopen' : 'lightClose';
  return button(key, 'light-transition', `data-id="${esc(task.id)}" ${canRunLightTransition(task) ? '' : `disabled title="${esc(t('noTransitions'))}"`}`);
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
  let html = `<p class="note" role="status">${tasks.length} ${t('resultCount')} · ${siteTasks().length - counts(siteTasks()).closed} ${t('nonClosed')}</p>`;
  if (!tasks.length) html += `<section class="panel">${empty(taskView === 'light' ? 'lightEmpty' : 'noResults', 'noResultsHint', button('clearFilters', 'clear-filters'))}</section>`;
  else if (taskView === 'board') {
    const columns = STATUSES.map(status => ({ status, column: tasks.filter(task => task.status === status) }));
    // On a phone the columns would need horizontal panning: one status open at a time, by thumb.
    html += compactNavigation()
      ? `<div class="board-accordion">${columns.map(({ status, column }, index) => `<details class="board-status" ${index === 0 ? 'open' : ''}>
          <summary><span>${t(status)}</span><span class="count">${column.length}</span></summary>
          ${column.length ? column.map(taskCard).join('') : `<div class="mini-empty">${t('emptyColumn')}</div>`}</details>`).join('')}</div>`
      : `<div class="board">${columns.map(({ status, column }) => `<section class="board-column" aria-label="${t(status)}"><div class="column-heading"><span>${t(status)}</span><span>${column.length}</span></div>${column.length ? column.map(taskCard).join('') : `<div class="mini-empty">${t('emptyColumn')}</div>`}</section>`).join('')}</div>`;
  }
  else if (taskView === 'light') {
    html += `<div class="table-scroll"><table><thead><tr>${['title', 'area', 'assignee', 'due', 'status', 'lightAction'].map(key => `<th scope="col">${t(key)}</th>`).join('')}</tr></thead><tbody>${tasks.map(task => `<tr><td><button type="button" data-command="detail" data-id="${esc(task.id)}">${esc(task.title)}</button></td><td>${esc(task.area || '—')}</td><td>${personName(task.assignee)}</td><td>${dueMarkup(task)}</td><td>${badge(task.status)} ${syncBadge(task)}</td><td>${lightTaskButton(task)}</td></tr>`).join('')}</tbody></table></div>`;
  }
  else {
    const sorted = filterSortRecords(tasks, {}, [{ key: taskSort.key, descending: taskSort.direction === 'desc' }]);
    const cell = (task, key) => key === 'status' ? `${badge(task.status)} ${syncBadge(task)}` : key === 'due' ? dueMarkup(task)
      : ['assignee', 'reviewer'].includes(key) ? personName(task[key]) : esc(task[key] || '—');
    html += `<div class="table-scroll"><table><thead><tr>${taskColumns.map(key => `<th scope="col" ${key === taskSort.key ? `aria-sort="${taskSort.direction === 'asc' ? 'ascending' : 'descending'}"` : ''}>${t(key)}</th>`).join('')}</tr></thead><tbody>${sorted.map(task => `<tr>${taskColumns.map((key, index) => `<td>${index === 0 ? `<button data-command="detail" data-id="${esc(task.id)}" aria-label="${esc(task.title)}">${cell(task, key)}</button>` : cell(task, key)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  }
  if (filters.id || filters.closable) html = `<p class="note">${t('todayFiltered')} ${button('clearFilters', 'clear-filters')}</p>` + html;
  renderViewDirty();
  $('#task-results').innerHTML = html;
}
function renderDiary() {
  const entries = state.diary.filter(item => item.siteId === siteId && item.date === reportDate);
  const canWrite = ['owner', 'editor', 'verifier'].includes(role());
  $('#main').innerHTML = heading('diaryTitle', 'diarySub', button('print', 'print') + (canWrite ? button('newEntry', 'new-entry', '', 'primary') : '')) +
    `<div class="diary-toolbar"><label for="report-date">${t('reportDate')}</label><input id="report-date" type="date" min="0001-01-01" max="9999-12-31" value="${reportDate}"><span class="badge">${t('draft')}</span><span class="subtitle">${entries.length} ${t('entries')}</span></div><div class="diary-grid"><section class="panel">${entries.length ? entries.map(entry => {
      return `<article class="diary-entry"><div class="entry-heading"><strong>${t(entry.shift)} ${syncBadge(entry)}</strong><span>${t('recordedAt')} ${timeLabel(entry.createdAt)}</span></div><div class="entry-grid">${['plan', 'actual', 'blockers', 'next'].map(key => `<section class="entry-section ${key === 'blockers' && entry[key] ? 'entry-blocker' : ''}"><h3>${t(key)}</h3><p>${esc(entry[key] || '—')}</p></section>`).join('')}</div>${attachmentSection('diary', entry.id)}</article>`;
    }).join('') : empty('diaryEmpty', 'diaryEmptyHint', canWrite ? button('newEntry', 'new-entry', '', 'primary') : '')}</section><details class="panel diary-aside" open><summary>${t('dayRule')}</summary><div class="panel-body"><p>${t('dayRuleNote')}</p><div class="blank-message">${t('diaryLimit')}</div></div></details></div><p class="note">${t('forDate')} ${dateLabel(reportDate)} · ${t('draft')} · ${t('diaryLimit')}</p>`;
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
function renderWbs() {
  const cached = wbsCache.get(siteId);
  $('#main').innerHTML = heading('wbs', 'wbsSub',
    button('wbsTree', 'wbs-view', `data-value="tree" aria-pressed="${wbsView === 'tree'}"`) +
    button('wbsFlat', 'wbs-view', `data-value="flat" aria-pressed="${wbsView === 'flat'}"`) + button('retry', 'wbs-reload'));
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
  const label = node => `<strong>${esc(node.wbs_code)}</strong> ${esc(node.description ?? '—')}${node.is_synthetic ? ` <span class="badge">${t('wbsSynthetic')}</span>` : ''}${node.progress_pct == null ? '' : ` <span class="badge wbs-progress">${esc(node.progress_pct)}%</span>`}`;
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
    $('#main').insertAdjacentHTML('beforeend', `<div class="table-scroll"><table><thead><tr>${['wbsCode', 'wbsDescription', 'wbsParent', 'wbsLevel', 'wbsOrder', 'wbsProgress', 'wbsPlannedStart', 'wbsPlannedFinish'].map(key => `<th scope="col">${t(key)}</th>`).join('')}</tr></thead><tbody>${rows.map(node => `<tr><td>${esc(node.wbs_code)}${node.is_synthetic ? ` <span class="badge">${t('wbsSynthetic')}</span>` : ''}</td><td>${esc(node.description ?? '—')}</td><td>${esc(byId.get(node.parent_id)?.wbs_code ?? '—')}</td><td>${node.level}</td><td>${esc(node.sort_order ?? '—')}</td><td>${node.progress_pct === null ? '—' : `${esc(node.progress_pct)}%`}</td><td>${esc(node.planned_start ?? '—')}</td><td>${esc(node.planned_finish ?? '—')}</td></tr>`).join('')}</tbody></table></div>`);
  }
}
// Core modules are online-only and never write to the offline operation queue.
const role = () => session?.roles?.find(member => member.site_id === siteId)?.role;
const currentModules = () => role() === 'owner' ? {} : state.memberAccess?.[siteId]?.members?.find(member => member.user_id === session?.user.id)?.modules || {};
const moduleVisible = module => visibleModules([module], currentModules()).length > 0;

const permissions = () => corePermissions(role());
const moduleResources = { deviations: ['deviations', 'reconciliation'], progress: ['progress', 'wbs', 'progressTypes'], bookings: ['bookings', 'workDays', 'employees', 'progress'], impacts: ['impacts'], tools: ['tools'], certifications: ['certifications', 'employees'], hse: ['hse'] };
// Mobile keeps four destinations reachable with the thumb; the rest lives behind «Altro».
const NAV_ITEMS = ['overview', 'sites', 'tasks', 'wbs', 'deviations', 'progress', 'bookings', 'impacts', 'diary', 'tools', 'certifications', 'hse'];
const MOBILE_PRIMARY = ['today', 'tasks', 'deviations', 'bookings'];
const compactNavigation = () => window.matchMedia('(width < 800px)').matches;
const coreCache = new Map();
let coreFilters = { deviations: { status: '', priority: '' }, progress: { wbsId: '' }, bookings: { date: '' }, impacts: { status: '', result: '' }, tools: { company: '', status: '' }, certifications: { employee: '', category: '', status: '' }, hse: { type: '', severity: '', from: '', to: '' } };
let reconciliationFilter = '', reconciliationOpen = true;
let deviationView = 'board', toolEditingId = '', certEditingId = '', hseEditingId = '';
function resetCore() {
  coreCache.clear();
  coreFilters = { deviations: { status: '', priority: '' }, progress: { wbsId: '' }, bookings: { date: '' }, impacts: { status: '', result: '' }, tools: { company: '', status: '' }, certifications: { employee: '', category: '', status: '' }, hse: { type: '', severity: '', from: '', to: '' } };
  reconciliationFilter = ''; reconciliationOpen = true;
  toolEditingId = ''; certEditingId = ''; hseEditingId = '';
}
async function loadBookingRows(selected) {
  const rows = [], limit = 200;
  for (let offset = 0; ; offset += limit) {
    const page = await freshApi.listBookings({ siteId: selected, limit, offset });
    rows.push(...page);
    if (page.length < limit) return rows;
  }
}
function coreResource(name) {
  const selected = siteId;
  if (!coreCache.has(selected)) coreCache.set(selected, new Map());
  const cache = coreCache.get(selected);
  if (cache.has(name)) return cache.get(name);
  const entry = { pending: true };
  cache.set(name, entry);
  const loaders = {
    deviations: () => freshApi.listDeviations({ siteId: selected }), progress: () => freshApi.listProgress({ siteId: selected }),
    reconciliation: () => freshApi.deviationReconciliation(selected),
    progressTypes: () => freshApi.listProgressTypes(selected),
    bookings: () => loadBookingRows(selected), impacts: () => freshApi.listImpacts({ siteId: selected }),
    tools: () => freshApi.listTools({ siteId: selected }),
    certifications: () => freshApi.listCertifications({ siteId: selected }),
    hse: () => freshApi.listHseEvents({ siteId: selected }),
    workDays: () => freshApi.listWorkDays({ siteId: selected }), employees: () => freshApi.listEmployees({ siteId: selected }),
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
  entry.promise = (dependencyModule && !moduleVisible(dependencyModule) ? Promise.resolve([]) : loaders[name]()).then(data => {
    entry.data = data;
    if (coreCache.get(selected) === cache && cache.get(name) === entry && session?.user.id === resourceUser) rememberTodayResource(name, data, selected);
  }, error => { entry.error = error; }).finally(() => {
    entry.pending = false;
    if (coreCache.get(selected) === cache && cache.get(name) === entry && siteId === selected && (moduleResources[view]?.includes(name) || view === 'today')) render();
  });
  return entry;
}
const coreData = name => coreCache.get(siteId)?.get(name)?.data || [];
const coreValue = value => esc(value ?? t('coreUnknown'));
const coreStatus = (value, label = t(value || 'coreUnknown')) => `<span class="badge core-status core-status-${esc(value || 'unknown')}">${esc(label)}</span>`;
// Impact statuses have their own vocabulary: the tasks labels would say «Chiuse» for a claim.
const impactLabel = status => t({ open: 'impactOpen', notification_sent: 'impactNotification', submitted: 'impactSubmitted', closed: 'impactClosed' }[status] || status || 'coreUnknown');
const coreNumber = value => value == null ? t('coreUnknown') : `<span class="mono">${new Intl.NumberFormat(language === 'it' ? 'it-IT' : 'en-GB', { maximumFractionDigits: 4 }).format(Number(value))}</span>`;
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
  return `<div class="core-progress"><span>${coreNumber(value)}%</span><progress max="100" value="${Math.min(100, Math.max(0, Number(value)))}" aria-label="${t('coreProgressPct')}"></progress></div>`;
}
function renderCore() {
  $('#main').innerHTML = heading(view, `${view}Sub`,
    (view === 'progress' ? button('reportPrint', 'open-report') : '')
    + (view === 'tools' && permissions().tools ? button('toolAdd', 'tool-new', '', 'primary') : '')
    + (view === 'certifications' && permissions().certificationWrite ? button('certAdd', 'cert-new', '', 'primary') : '')
    + (view === 'hse' && permissions().hseWrite ? button('hseAdd', 'hse-new', '', 'primary') : '')
    + button(columnFiltersOn ? 'columnFiltersHide' : 'columnFiltersShow', 'column-filters', `aria-pressed="${columnFiltersOn}"`) + button('coreRefresh', 'core-reload'));
  if (offline || !navigator.onLine) {
    $('#main').insertAdjacentHTML('beforeend', empty('coreOnlineOnly', 'coreOnlineHint')); return;
  }
  if (view === 'hse' && !permissions().hse) { $('#main').insertAdjacentHTML('beforeend', empty('forbidden', 'hseRestricted')); return; }
  if (coreFilters[view]?.id) $('#main').insertAdjacentHTML('beforeend', `<p class="note">${t('todayFiltered')} ${button('clearFilters', 'today-clear-filter')}</p>`);
  const resources = moduleResources[view].map(coreResource);
  if (resources.some(entry => entry.pending)) {
    $('#main').setAttribute('aria-busy', 'true');
    $('#main').insertAdjacentHTML('beforeend', `<p role="status">${t('loading')}</p>`); return;
  }
  const error = resources.find(entry => entry.error)?.error;
  if (error) { $('#main').insertAdjacentHTML('beforeend', `<p role="alert">${esc(errorMessage(error))}</p>`); return; }
  const content = { deviations: renderDeviations, progress: renderProgress, bookings: renderBookings, impacts: renderImpacts, tools: renderTools, certifications: renderCertifications, hse: renderHse }[view]();
  $('#main').insertAdjacentHTML('beforeend', `<div class="core-view">${content}</div>`);
  const reconciliationPanel = $('#deviation-reconciliation');
  if (reconciliationPanel) reconciliationPanel.addEventListener('toggle', () => { reconciliationOpen = reconciliationPanel.open; });
  enhanceCoreTables();
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
          const a = left.cells[index]?.innerText.trim() ?? '', b = right.cells[index]?.innerText.trim() ?? '';
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
  if (!inputs.length) { [...table.tBodies[0].rows].forEach(row => { row.hidden = false; }); return; }
  for (const row of table.tBodies[0].rows) {
    row.hidden = inputs.some(input => {
      const needle = input.value.trim().toLowerCase();
      if (!needle) return false;
      return !(row.cells[Number(input.dataset.column)]?.innerText || '').toLowerCase().includes(needle);
    });
  }
}
const RECONCILIATION_KINDS = ['closed_without_date', 'close_before_approval'];
const reconciliationColumns = ['coreReference', 'title', 'reconciliationOfficial', 'reconciliationDays', 'reconciliationReason'];
function reconciliationCells(row, interactive = false) {
  return [coreValue(row.deviation_no), interactive
    ? coreDetailButton('deviations', row, row.title || row.deviation_no || row.id) : coreValue(row.title),
  coreStatus(row.official_status), coreNumber(row.disagreement_days),
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
      data-kind="${kind}" aria-pressed="${reconciliationFilter === kind}">
      ${t(`reconciliation_${kind}`)}: <strong>${coreNumber(data.counts[kind])}</strong></button>`).join('')}</div>
    ${body}</div></details>`;
}
function reconciliationReport(data) {
  const first = data.items.slice(0, 10);
  return `<section class="reconciliation-report"><h3>${t('reconciliationReportTitle')}</h3>${reconciliationNotes()}
    ${data.items.length ? `<p>${RECONCILIATION_KINDS.map(kind => `${t(`reconciliation_${kind}`)}: ${coreNumber(data.counts[kind])}`).join(' · ')}</p>
      <div class="report-table-wrap"><table class="report-table"><thead><tr>${reconciliationColumns.map(key => `<th scope="col">${t(key)}</th>`).join('')}</tr></thead>
      <tbody>${first.map(row => `<tr>${reconciliationCells(row).map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
      <p class="note">${t('reconciliationFirstRows')}: ${first.length} / ${data.items.length}</p>`
      : `<p>${t('reconciliationAligned')}</p>`}</section>`;
}
function renderDeviations() {
  const all = coreData('deviations'), filter = coreFilters.deviations;
  const rows = filterSortRecords(all, filter, [{ key: 'creationDate', descending: true }, { key: 'deviationNo' }]);
  const priorities = [...new Set(all.map(row => row.priority).filter(value => value != null))].sort();
  let html = renderReconciliation() + `<div class="toolbar core-toolbar">${coreSelect('status', 'status', [...DEVIATION_STATUSES.map(value => [value, t(value)]), ['__unknown', t('coreUnknown')]], filter.status, 'allStatuses')}${coreSelect('priority', 'priority', priorities.map(value => [value, t(value)]), filter.priority, 'allPriorities')}<div class="view-toggle">${['board', 'list'].map(value => button(value, 'deviation-view', `data-value="${value}" aria-pressed="${deviationView === value}"`, deviationView === value ? 'selected' : '')).join('')}</div></div>`;
  const visible = filter.status === '__unknown' ? filterSortRecords(all, { ...filter, status: null }, [{ key: 'creationDate', descending: true }, { key: 'deviationNo' }]) : rows;
  const card = row => `<button type="button" class="task-card" data-command="core-detail" data-module="deviations" data-id="${esc(row.id)}"><span class="card-code">${coreValue(row.deviationNo)}</span><h2>${esc(row.title || row.id)}</h2>${coreStatus(row.status)}<p>${t('priority')}: ${coreValue(row.priority == null ? null : t(row.priority))}</p><p>${coreValue(row.assignedTo)}</p></button>`;
  if (deviationView === 'board') {
    const columns = DEVIATION_STATUSES.map(status => ({ status, column: visible.filter(row => row.status === status) }));
    html += compactNavigation()
      ? `<div class="board-accordion core-board-accordion">${columns.map(({ status, column }, index) => `<details class="board-status" ${index === 0 ? 'open' : ''}>
          <summary><span>${t(status)}</span><span class="count">${column.length}</span></summary>
          ${column.length ? column.map(card).join('') : `<p class="mini-empty">${t('coreEmptyColumn')}</p>`}</details>`).join('')}</div>`
      : `<div class="core-board" tabindex="0" role="region" aria-label="${t('coreDeviationBoard')}">${columns.map(({ status, column }) => `<section class="core-column"><div class="column-heading"><span>${t(status)}</span><span>${column.length}</span></div>${column.length ? column.map(card).join('') : `<p class="mini-empty">${t('coreEmptyColumn')}</p>`}</section>`).join('')}</div>`;
    const unknown = visible.filter(row => !DEVIATION_STATUSES.includes(row.status));
    if (unknown.length) html += `<section class="core-unknown"><h2>${t('coreUnmappedStatus')}</h2>${unknown.map(card).join('')}</section>`;
  } else html += visible.length ? coreTable(['coreReference', 'title', 'status', 'priority', 'coreAssignedTo', 'coreCreated', 'coreClosed'], visible.map(row => [coreValue(row.deviationNo), coreDetailButton('deviations', row), coreStatus(row.status), coreValue(row.priority == null ? null : t(row.priority)), coreValue(row.assignedTo), coreValue(row.creationDate), coreValue(row.closedDate)])) : empty('noResults', 'noResultsHint');
  return html;
}
function renderProgress() {
  const rows = filterSortRecords(coreData('progress'), coreFilters.progress, [{ key: 'section' }, { key: 'plcArea' }, { key: 'description' }]);
  return `<div class="toolbar core-toolbar">${coreSelect('wbsId', 'wbs', coreData('wbs').map(node => [node.id, `${node.wbs_code} · ${node.description ?? ''}`]), coreFilters.progress.wbsId, 'coreAllWbs')}</div>` +
    (rows.length ? coreTable(['wbsDescription', 'coreSection', 'area', 'coreProgressPct', 'coreBookedHours'], rows.map(row => [coreDetailButton('progress', row), coreValue(row.section), coreValue(row.plcArea),
      progressBar(row.progressPct) + (row.progressPctSource === 'computed' ? ` <span class="badge">${t('coreComputed')}</span>` : ''), coreNumber(row.bookedHours)])) : empty('noResults', 'noResultsHint'));
}
function renderBookings() {
  const days = coreData('workDays'), employees = coreData('employees'), items = coreData('progress');
  const groups = groupBookings(coreData('bookings'), days, employees, items).filter(group => !coreFilters.bookings.date || group.date === coreFilters.bookings.date);
  const dates = [...new Set(days.map(day => day.operationalDate).filter(Boolean))].sort().reverse();
  let html = `<div class="toolbar core-toolbar">${coreSelect('date', 'reportDate', dates.map(date => [date, dateLabel(date)]), coreFilters.bookings.date, 'coreAllDays')}</div>`;
  if (permissions().book) {
    if (!days.length || !items.length) html += `<p class="blank-message">${t('coreBookingPrerequisites')}</p>`;
    else html += `<form id="booking-form" class="panel panel-body core-booking-form"><h2>${t('coreBookHours')}</h2><div class="form-error" role="alert" tabindex="-1" hidden></div><div class="core-entry-grid"><label class="field">${t('coreWorkDay')}<select name="workDayId" required><option value="">${t('coreChoose')}</option>${filterSortRecords(days, {}, [{ key: 'operationalDate', descending: true }, { key: 'employeeId' }]).map(day => `<option value="${esc(day.id)}">${esc(`${day.operationalDate} · ${employeeLabel(employees.find(employee => employee.id === day.employeeId))} · ${t(day.shift || 'coreUnknown')} · ${day.startTime ?? t('coreUnknown')}`)}</option>`).join('')}</select></label><label class="field">${t('coreProgressItem')}<select name="siteProgressItemId" required><option value="">${t('coreChoose')}</option>${items.map(item => `<option value="${esc(item.id)}">${esc(progressLabel(item))}</option>`).join('')}</select></label><label class="field">${t('coreAppBookedHours')}<input name="hours" type="number" min="0" step="0.5" value="1" required></label><div class="core-stepper">${button('coreMinusHalf', 'booking-step', 'data-step="-0.5"')}${button('corePlusHalf', 'booking-step', 'data-step="0.5"')}${button('corePlusOne', 'booking-step', 'data-step="1"')}</div></div><div class="form-actions"><button type="submit" class="primary">${t('coreBookHours')}</button></div></form>`;
  }
  html += `<p class="note booking-legend">${t('coreHoursLegendSource')}<br>${t('coreHoursLegendApp')}</p>`;
  html += groups.length ? groups.map(group => `<section class="core-day"><h2>${group.date ? dateLabel(group.date) : t('coreUnknown')} · ${esc(employeeLabel(group.employee))}</h2>`
    + '<div class="booking-summary">' + coreTable(['coreSourceWorkTime', 'coreSourceBookedHours', 'coreAppBookedHours', 'coreSourceOpenHours', 'coreVariance'], [[
      coreNumber(group.sourceWorkTime), coreNumber(group.sourceBookedHours), coreNumber(group.appBookedHours), coreNumber(group.sourceOpenHours), bookingVariance(group.variance),
    ]]) + '</div>'
    + (group.rows.length ? coreTable(['coreEmployee', 'coreProgressItem', 'coreAppBookedHours', ...(permissions().book ? ['coreActions'] : [])], group.rows.map(row => [esc(employeeLabel(row.employee)), esc(row.item ? progressLabel(row.item) : row.siteProgressItemId), coreNumber(row.hours), ...(permissions().book ? [button('coreDelete', 'booking-delete', `data-id="${esc(row.id)}"`, 'danger small')] : [])])) : '')
    + '</section>').join('') : empty('noResults', 'noResultsHint');
  return html;
}
function bookingVariance(value) {
  if (value == null) return `<strong class="booking-variance">${t('coreNotCalculable')}</strong>`;
  const direction = value > 0 ? 'positive' : value < 0 ? 'negative' : 'zero';
  const label = value > 0 ? 'coreVariancePositive' : value < 0 ? 'coreVarianceNegative' : 'coreVarianceBalanced';
  const formatted = new Intl.NumberFormat(language === 'it' ? 'it-IT' : 'en-GB', { maximumFractionDigits: 4, signDisplay: 'always' }).format(value);
  return `<strong class="booking-variance booking-variance-${direction}"><span class="mono">${esc(formatted)}</span><small>${t(label)}</small></strong>`;
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
  const all = coreData('certifications'), employees = coreData('employees');
  const filter = coreFilters.certifications, canWrite = permissions().certificationWrite;
  const rows = filterCertifications(all, filter), counts = certificationCounts(all);
  const byEmployee = new Map(employees.map(employee => [employee.id, employee]));
  const kpis = [['certExpired', counts.expired, 'cert-count-expired'], ['certExpiring', counts.expiring, 'cert-count-expiring'],
    ['certValid', counts.valid, 'cert-count-valid'], ['certNoExpiry', counts.no_expiry, 'cert-count-no_expiry']]
    .map(([label, value, css]) => `<div class="panel panel-body"><span>${t(label)}</span><strong class="cert-count ${css}">${value}</strong></div>`).join('');
  let html = `<div class="core-kpis" role="status">${kpis}</div><p class="note">${t('certHint')}</p>`;
  html += `<div class="toolbar core-toolbar">${coreSelect('employee', 'coreEmployee', employees.map(employee => [employee.id, employeeLabel(employee)]), filter.employee, 'coreAllEmployees')}${coreSelect('category', 'certCategory', CERT_CATEGORIES.map(category => [category, t(certCategoryLabelKey(category))]), filter.category, 'certAllCategories')}${coreSelect('status', 'status', CERT_STATUSES.map(status => [status, t(certStatusLabelKey(status))]), filter.status, 'allStatuses')}</div>`;
  html += rows.length ? coreTable(['coreEmployee', 'certCategory', 'certName', 'certIssuer', 'certIssuedOn', 'certExpiresOn', 'certDays', 'status', ...(canWrite ? ['coreActions'] : [])],
    rows.map(row => [esc(employeeLabel(byEmployee.get(row.employeeId))), t(certCategoryLabelKey(row.category)), `<strong>${esc(row.name)}</strong>`,
      coreValue(row.issuer), coreValue(row.issuedOn), coreValue(row.expiresOn), certDaysLeft(row), certificationStatusBadge(row.status),
      ...(canWrite ? [`<div class="tool-actions">${button('edit', 'cert-edit', `data-id="${esc(row.id)}"`, 'small')}${button('coreDelete', 'cert-delete', `data-id="${esc(row.id)}"`, 'danger small')}</div>`] : [])])) : empty('certEmpty', 'certEmptyHint');
  return html;
}
function showCertificationForm() {
  if (!permissions().certificationWrite) return toast(t('forbidden'));
  const editing = certEditingId ? coreData('certifications').find(cert => cert.id === certEditingId) : null;
  const employees = coreData('employees');
  const employeeOptions = employees.map(employee => `<option value="${esc(employee.id)}" ${(editing?.employeeId || '') === employee.id ? 'selected' : ''}>${esc(employeeLabel(employee))}</option>`).join('');
  const categoryOptions = CERT_CATEGORIES.map(category => `<option value="${category}" ${(editing?.category || 'qualification') === category ? 'selected' : ''}>${t(certCategoryLabelKey(category))}</option>`).join('');
  showModal(t(editing ? 'certEdit' : 'certAdd'), `<form id="cert-form" data-id="${esc(editing?.id || '')}"><div class="form-error" role="alert" tabindex="-1" hidden></div><div class="form-grid">${field('coreEmployee', 'employeeId', editing?.employeeId || '', { required: true, options: employeeOptions })}${field('certCategory', 'category', editing?.category || 'qualification', { required: true, options: categoryOptions })}${field('certName', 'name', editing?.name || '', { required: true, max: 120 })}${field('certIssuer', 'issuer', editing?.issuer || '', { max: 200 })}${field('certIssuedOn', 'issuedOn', editing?.issuedOn || '', { type: 'date' })}${field('certExpiresOn', 'expiresOn', editing?.expiresOn || '', { type: 'date' })}${field('certOutcome', 'outcome', editing?.outcome || '', { max: 500, full: true })}${field('certNotes', 'notes', editing?.notes || '', { type: 'textarea', full: true, max: 2000 })}</div><div class="form-actions">${button('cancel', 'close-modal')}<button type="submit" class="primary">${t(editing ? 'certSaveChanges' : 'certSave')}</button></div></form>`);
}
function showCertificationDelete(id) {
  if (!permissions().certificationWrite) return toast(t('forbidden'));
  const row = coreData('certifications').find(cert => cert.id === id);
  if (!row) return toast(t('certNotFound'));
  const employee = coreData('employees').find(candidate => candidate.id === row.employeeId);
  showModal(t('certDelete'), `<form id="cert-delete-form" data-id="${esc(id)}"><div class="form-error" role="alert" tabindex="-1" hidden></div><p>${t('certDeleteConfirm')}</p><p><strong>${esc(row.name)}</strong> · ${esc(employeeLabel(employee))}${row.expiresOn ? ` · ${esc(row.expiresOn)}` : ''}</p><div class="form-actions">${button('cancel', 'close-modal')}<button type="submit" class="danger">${t('coreDelete')}</button></div></form>`);
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
function renderHse() {
  const all = coreData('hse'), filter = coreFilters.hse, canWrite = permissions().hseWrite;
  const rows = filterHseEvents(all, filter), counts = hseCounts(all);
  const kpis = [...HSE_TYPES, 'total'].map(type => `<div class="panel panel-body"><span>${t(type === 'total' ? 'hseTotal' : `hseType_${type}`)}</span><strong class="cert-count">${counts[type]}</strong></div>`).join('');
  const period = [['from', 'hseFrom'], ['to', 'hseTo']].map(([key, label]) => `<label class="field core-filter"><span>${t(label)}</span><input type="date" min="0001-01-01" max="9999-12-31" data-core-filter="${key}" value="${esc(filter[key])}"></label>`).join('');
  let html = `<p class="note">${t('hsePrivacy')}</p><div class="core-kpis" role="status">${kpis}</div><p class="note">${t('hseSummaryHint')}</p>`;
  html += `<div class="toolbar core-toolbar">${coreSelect('type', 'hseType', HSE_TYPES.map(type => [type, t(`hseType_${type}`)]), filter.type, 'hseAllTypes')}${coreSelect('severity', 'hseSeverity', HSE_SEVERITIES.map(severity => [severity, t(`hseSeverity_${severity}`)]), filter.severity, 'hseAllSeverities')}${period}</div>`;
  if (filter.from && filter.to && filter.from > filter.to) return html + `<p role="alert">${t('hsePeriodInvalid')}</p>`;
  html += rows.length ? coreTable(['hseOccurredOn', 'hseEventNo', 'hseType', 'hseSeverity', 'hseLocation', 'hsePersons', 'hseMeasures', ...(canWrite ? ['coreActions'] : [])], rows.map(row => [
    coreValue(row.occurredOn), coreValue(row.eventNo), t(`hseType_${row.type}`), coreStatus(row.severity, t(`hseSeverity_${row.severity}`)),
    coreValue(row.location), coreNumber(row.personsInvolved), coreValue(row.measures),
    ...(canWrite ? [`<div class="tool-actions">${button('edit', 'hse-edit', `data-id="${esc(row.id)}"`, 'small')}${button('coreDelete', 'hse-delete', `data-id="${esc(row.id)}"`, 'danger small')}</div>`] : []),
  ])) : empty('hseEmpty', 'hseEmptyHint');
  return html;
}
function showHseForm() {
  if (!permissions().hseWrite) return toast(t('forbidden'));
  const editing = hseEditingId ? coreData('hse').find(row => row.id === hseEditingId) : null;
  if (hseEditingId && !editing) return toast(t('hseNotFound'));
  const options = (values, prefix, selected) => values.map(value => `<option value="${value}" ${selected === value ? 'selected' : ''}>${t(`${prefix}_${value}`)}</option>`).join('');
  showModal(t(editing ? 'hseEdit' : 'hseAdd'), `<form id="hse-form" data-id="${esc(editing?.id || '')}"><div class="form-error" role="alert" tabindex="-1" hidden></div><p class="note">${t('hsePrivacy')}</p><div class="form-grid">${field('hseOccurredOn', 'occurredOn', editing?.occurredOn || '', { type: 'date', required: true })}${field('hseEventNo', 'eventNo', editing?.eventNo || '', { max: 120 })}${field('hseType', 'type', editing?.type || 'near_miss', { required: true, options: options(HSE_TYPES, 'hseType', editing?.type || 'near_miss') })}${field('hseSeverity', 'severity', editing?.severity || 'low', { required: true, options: options(HSE_SEVERITIES, 'hseSeverity', editing?.severity || 'low') })}${field('hseLocation', 'location', editing?.location || '', { max: 200 })}<label class="field"><span>${t('hsePersons')} <small>(${t('optional')})</small></span><input type="number" name="personsInvolved" min="0" max="2147483647" step="1" value="${esc(editing?.personsInvolved ?? '')}"><small>${t('hsePersonsHint')}</small></label>${field('hseMeasures', 'measures', editing?.measures || '', { type: 'textarea', full: true, max: 2000 })}${field('hseNotes', 'notes', editing?.notes || '', { type: 'textarea', full: true, max: 2000 })}</div>${formActions()}</form>`);
}
function showHseDelete(id) {
  if (!permissions().hseWrite) return toast(t('forbidden'));
  const row = coreData('hse').find(candidate => candidate.id === id);
  if (!row) return toast(t('hseNotFound'));
  showModal(t('hseDelete'), `<form id="hse-delete-form" data-id="${esc(id)}"><div class="form-error" role="alert" tabindex="-1" hidden></div><p>${t('hseDeleteConfirm')}</p><p><strong>${esc(row.occurredOn)}</strong> · ${esc(t(`hseType_${row.type}`))}${row.eventNo ? ` · ${esc(row.eventNo)}` : ''}</p><div class="form-actions">${button('cancel', 'close-modal')}<button type="submit" class="danger">${t('coreDelete')}</button></div></form>`);
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
  return `<dl class="detail-grid core-details">${fields.map(([key, label = key]) => `<div><dt>${t(label)}</dt><dd>${['status', 'result', 'priority'].includes(key) && row[key] != null ? esc(t(row[key])) : typeof row[key] === 'boolean' ? t(row[key] ? 'coreYes' : 'coreNo') : coreValue(row[key])}</dd></div>`).join('')}</dl>`;
}
function progressStepsSection(row) {
  const types = coreData('progressTypes') || [];
  const type = types.find(candidate => candidate.id === row.progressTypeId);
  const steps = row.steps || [], rights = permissions();
  let html = rights.steps ? `<form id="progress-hours-form" data-id="${esc(row.id)}"><div class="form-error" role="alert" tabindex="-1" hidden></div><label class="field">${t('corePlannedHours')}<input name="planned_hours" type="number" min="0" max="1000000" step="any" value="${row.plannedHours == null ? '' : esc(row.plannedHours)}"></label><p class="note">${t('corePlannedHoursHint')}</p><div class="form-actions"><button type="submit" class="primary">${t('save')}</button></div></form>`
    : `<p>${t('corePlannedHours')}: ${coreNumber(row.plannedHours)}</p>`;
  html += `<h3>${t('coreProgressType')}</h3>`;
  html += type ? `<p><strong>${esc(type.name)}</strong> <span class="badge">${esc(type.code)}</span></p>` : `<p>${t('coreNoProgressType')}</p>`;
  if (steps.length) html += coreTable(['coreStep', 'coreDescription', 'coreWeight', 'coreStepPercent'],
    steps.map(step => [esc(step.code), coreValue(step.description), coreNumber(step.weight),
      step.percent == null ? t('coreUnknown') : `${coreNumber(step.percent)}%`]));
  if (rights.steps && steps.length) html += `<form id="progress-steps-form" data-id="${esc(row.id)}"><div class="form-error" role="alert" tabindex="-1" hidden></div><h3>${t('coreRecordSteps')}</h3><div class="core-entry-grid">${steps.map(step => `<label class="field">${esc(step.code)}<input name="percent-${esc(step.id)}" type="number" min="0" max="100" step="1" value="${step.percent == null ? '' : esc(step.percent)}" placeholder="0"></label>`).join('')}</div><div class="form-actions"><button type="submit" class="primary">${t('coreSaveSteps')}</button></div></form>`;
  if (rights.assign) html += `<form id="progress-type-form" data-id="${esc(row.id)}"><div class="form-error" role="alert" tabindex="-1" hidden></div><label class="field">${t('coreAssignType')}<select name="progress_type_id"><option value="">${t('coreNoProgressType')}</option>${types.map(candidate => `<option value="${esc(candidate.id)}" ${candidate.id === row.progressTypeId ? 'selected' : ''}>${esc(`${candidate.code} · ${candidate.name}`)}</option>`).join('')}</select></label><div class="form-actions"><button type="submit" class="primary">${t('coreSaveType')}</button></div></form>`;
  return html;
}
// Assistant: one conversation at a time, kept in memory for the session.
let aiMessages = [], aiBusy = false;
const AI_SUGGESTIONS = {
  overview: ['aiSuggestOverview', 'aiSuggestOverviewHours', 'aiSuggestOverviewClaims'],
  tasks: ['aiSuggestTasks', 'aiSuggestTasksBlocked', 'aiSuggestTasksDue'],
  deviations: ['aiSuggestDeviations', 'aiSuggestDeviationsByArea', 'aiSuggestDeviationsOld'],
  progress: ['aiSuggestProgress', 'aiSuggestProgressBooked', 'aiSuggestProgressSections'],
  bookings: ['aiSuggestBookings', 'aiSuggestBookingsWeek', 'aiSuggestBookingsMissing'],
  impacts: ['aiSuggestImpacts', 'aiSuggestImpactsOpen', 'aiSuggestImpactsSettled'],
  diary: ['aiSuggestDiary', 'aiSuggestDiaryBlockers', 'aiSuggestDiaryWeek'],
};
const AI_MODULES = { deviations: 'deviations', site_progress_items: 'progress', cost_impacts: 'impacts' };
function renderAssistant() {
  const panel = $('#ai-panel');
  if (!panel) return;
  $('#ai-title').textContent = t('aiTitle');
  $('#ai-form [name=message]').placeholder = t('aiPlaceholder');
  $('#ai-form button').textContent = t('aiSend');
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
  if (!text || aiBusy) return;
  aiMessages.push({ role: 'user', content: text });
  aiBusy = true; renderAssistant();
  try {
    const result = await api.assistantChat({ site_id: siteId, view, language, messages: aiMessages.slice(-6) });
    aiMessages.push({ role: 'assistant', content: result.reply, citations: result.citations });
  } catch (error) {
    aiMessages.push({ role: 'assistant', content: errorMessage(error) });
  }
  aiBusy = false; renderAssistant();
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
function showSettingsForm() {
  showModal(t('settingsTitle'), `<form id="settings-form"><p class="note">${t('settingsHint')}</p><div class="form-grid">
    <label class="field">${t('settingsCurrency')}<select name="currency">${['EUR', 'USD', 'GBP', 'CHF'].map(code => `<option value="${code}" ${prefs.currency === code ? 'selected' : ''}>${code}</option>`).join('')}</select></label>
    <label class="field">${t('settingsDecimals')}<select name="decimals">${[0, 2].map(value => `<option value="${value}" ${prefs.decimals === value ? 'selected' : ''}>${value}</option>`).join('')}</select></label>
    <label class="field">${t('settingsSeparators')}<select name="separators"><option value="it" ${prefs.separators === 'it' ? 'selected' : ''}>1.234,56 (IT)</option><option value="en" ${prefs.separators === 'en' ? 'selected' : ''}>1,234.56 (EN)</option></select></label>
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
    form.importMappings = mappings;
    renderImportMapping(form);
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
    .map(row => `<li>${esc(row.source_row ?? '')} — ${esc(row.rejected || '')}${row.reason ? `: ${esc(row.reason)}` : ''}</li>`).join('');
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

async function showCoreDetail(module, id) {
  const selected = siteId;
  showModal(t('coreDetails'), `<p role="status">${t('loading')}</p>`);
  $('#modal').classList.add('core-modal');
  const version = modalVersion;
  try {
    if (offline || !navigator.onLine) throw new Error('coreOnlineOnly');
    const row = await ({ deviations: freshApi.getDeviation, progress: freshApi.getProgress, impacts: freshApi.getImpact }[module])(id);
    if (version !== modalVersion || siteId !== selected || !$('#modal').open) return;
    if (row.siteId !== selected) throw new Error('forbidden');
    if (['progress', 'deviations'].includes(module)) {
      const previous = todayResource(module);
      const updated = { ...previous.find(item => item.id === row.id), ...row };
      rememberTodayResource(module, [...previous.filter(item => item.id !== row.id), updated]);
    }
    let content;
    if (module === 'deviations') {
      const typeLabels = { site_progress_item: 'coreProgressItem', task: 'tasks', diary: 'diary' };
      const details = coreFields(row, [['deviationNo', 'coreReference'], ['status', 'status'], ['priority', 'priority'], ['problemDescription', 'coreDescription'], ['author', 'coreAuthor'], ['assignedTo', 'coreAssignedTo'], ['plcArea', 'area'], ['creationDate', 'coreCreated'], ['dueDate', 'due'], ['approvedDate', 'coreApprovedDate'], ['closedDate', 'coreClosed'], ['actualCost', 'coreActualCost'], ['claimQuantity', 'coreClaimQuantity'], ['laborHours', 'coreLaborHours'], ['completedTasksPct', 'coreCompletedPct']]);
      const references = row.links?.length ? `<ul class="core-links">${row.links.map(link => `<li>${esc(t(typeLabels[link.entityType] || 'coreReference'))}: ${esc(link.entityId)}</li>`).join('')}</ul>` : `<p>${t('coreNoReferences')}</p>`;
      // Two tabs keep the sheet readable: everything about the record, then what it points to.
      content = `<div class="detail-tabs" role="tablist">
        <button type="button" role="tab" aria-selected="true" class="selected" data-command="detail-tab" data-panel="data">${t('coreDetails')}</button>
        <button type="button" role="tab" aria-selected="false" data-command="detail-tab" data-panel="refs">${t('coreReferences')}</button>
      </div><div class="detail-panel" data-detail-panel="data">${details}</div><div class="detail-panel" data-detail-panel="refs" hidden>${references}</div>`;
    } else if (module === 'progress') {
      const day = value => value ? dateLabel(String(value).slice(0, 10)) : null;
      content = progressBar(row.progressPct) + coreFields({ ...row, wbsId: [row.wbsCode, row.wbsDescription].filter(Boolean).join(' · ') || '—',
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
    showModal(row.title || row.description || t('coreDetails'), content);
    $('#modal').classList.add('core-modal');
  } catch (error) {
    if (version === modalVersion && $('#modal').open) showModal(t('coreDetails'), `<p role="alert">${esc(errorMessage(error))}</p>${button('retry', 'core-detail', `data-module="${module}" data-id="${esc(id)}"`)}`);
  }
}
function showBookingDelete(id) {
  if (!permissions().book) return toast(t('forbidden'));
  const row = coreData('bookings').find(booking => booking.id === id);
  if (!row) return;
  showModal(t('coreDeleteBooking'), `<form id="booking-delete-form" data-id="${esc(id)}"><div class="form-error" role="alert" tabindex="-1" hidden></div><p>${t('coreDeleteConfirm')}</p><p>${coreNumber(row.hours)} ${t('coreAppBookedHours')} · ${esc(progressLabel(coreData('progress').find(item => item.id === row.siteProgressItemId)))}</p><div class="form-actions">${button('cancel', 'close-modal')}<button type="submit" class="danger">${t('coreDelete')}</button></div></form>`);
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
  else if (!(isImpact ? permissions().transition : permissions().book)) throw new Error('forbidden');
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
  if (loading) { $('#main').innerHTML = `<p role="status">${t('loading')}</p>`; return; }
  if (!session && (!loadError || loadError.status === 401)) {
    $('#main').innerHTML = `<section class="panel"><div class="panel-body"><h1>${t('login')}</h1><form id="login-form"><div class="form-error" role="alert" tabindex="-1" hidden></div><div class="form-grid"><label class="field">${t('email')}<input name="email" type="email" autocomplete="username" required></label><label class="field">${t('password')}<span class="password-row"><input name="password" type="password" autocomplete="current-password" required maxlength="1024"><button type="button" class="text-button password-toggle" data-command="toggle-password" aria-label="${t('showPassword')}">◉</button></span></label></div><div class="form-actions"><button type="submit" class="primary">${t('login')}</button></div></form><div class="heading-actions">${button('requestAccess', 'request-access')}${button('forgotPassword', 'forgot-password')}</div></div></section>`;
    return;
  }
  if (loadError) { $('#main').innerHTML = `<div role="alert"><p>${esc(errorMessage(loadError))}</p>${button('retry', 'reload')}</div>`; return; }
  if (!state.sites.length && view !== 'sites') { $('#main').innerHTML = empty('noSites', 'noSitesHint', button('newSite', 'new-site', '', 'primary')); return; }
  if (!moduleVisible(view)) { $('#main').innerHTML = empty('moduleUnavailable', 'moduleUnavailableHint'); return; }
  ({ today: renderToday, report: renderReport, overview: renderOverview, sites: renderSites, tasks: renderTasks, diary: renderDiary, wbs: renderWbs, deviations: renderCore, progress: renderCore, bookings: renderCore, impacts: renderCore, tools: renderCore, certifications: renderCore, hse: renderCore })[view]();
}
function go(next) { if (location.hash !== `#${next}`) location.hash = next; else { view = next; render(); } }
function selectSite(id) {
  reportPrintIntent = null;
  if (!state.sites.some(site => site.id === id)) return;
  wbsLoad = null; wbsCache.clear(); resetCore(); resetSavedViews(); closeModal();
  siteId = id; filters = { search: '', status: '', person: '', priority: '', kind: '' }; render();
  if (!offline) void loadData();
}
function showModal(title, content) {
  $('#modal').classList.remove('core-modal');
  modalVersion++;
  $('#modal-content').innerHTML = `<div class="modal-header"><h2 id="modal-title">${esc(title)}</h2><button class="close" type="button" data-command="close-modal" aria-label="${t('close')}">×</button></div><div class="modal-body">${content}</div>`;
  if (!$('#modal').open) $('#modal').showModal();
  $('#modal').scrollTop = 0;
  const first = $('#modal-content input:not([type=hidden]), #modal-content textarea, #modal-content select');
  if (first) first.focus();
}
function closeModal() { modalVersion++; $('#modal').close(); }
function field(label, name, value = '', { type = 'text', required = false, full = false, max = 4000, hint = '', options = null } = {}) {
  const attrs = `name="${name}" id="field-${name}" ${required ? 'required' : ''}`;
  const control = options !== null ? `<select ${attrs}>${options}</select>` : type === 'textarea' ? `<textarea ${attrs} maxlength="${max}">${esc(value)}</textarea>` : `<input ${attrs} type="${type}" value="${esc(value)}" ${type === 'date' ? 'min="0001-01-01" max="9999-12-31"' : `maxlength="${max}"`}>`;
  return `<label class="field ${full ? 'full' : ''}" for="field-${name}"><span>${t(label)} ${required ? '*' : `<small>(${t('optional')})</small>`}</span>${control}${hint ? `<small>${t(hint)}</small>` : ''}</label>`;
}
const formActions = () => `<div class="form-actions">${button('cancel', 'close-modal')}<button type="submit" class="primary">${t('save')}</button></div>`;
function formError(form, error) {
  const target = form.querySelector('.form-error');
  target.textContent = errorMessage(error); target.hidden = false; target.focus();
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
  showModal(t('newTask'), `<form id="task-form"><div class="form-error" role="alert" tabindex="-1" hidden></div><div class="form-grid">${field('title', 'title', '', { full: true, required: true, max: 180 })}${field('area', 'area', '', { max: 100 })}${field('company', 'company', '', { max: 100 })}${taskResponsibleFields()}${field('priority', 'priority', '', { options: PRIORITIES.map(priority => `<option value="${esc(priority)}">${esc(t(priority))}</option>`).join(''), required: true })}${field('kind', 'kind', 'ordinary', { options: TASK_KINDS.map(kind => `<option value="${esc(kind)}">${esc(t(taskKindLabelKey(kind)))}</option>`).join('') })}${field('due', 'due', today(), { type: 'date' })}</div>${formActions()}</form>`);
  const version = modalVersion, selectedSite = siteId;
  const form = $('#task-form');
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
async function showDetail(taskId) {
  showModal(t('details'), `<p role="status">${t('loading')}</p>`);
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
    if (version !== modalVersion || !$('#modal').open) return;
    rememberTask(task);
    if (storageReady && !task.localOnly) await accountLock(async () => {
      const saved = await getMirror(`state:${offlineScope}`);
      if (saved) { saved.tasks = saved.tasks.map(item => item.id === task.id ? task : item); await setMirror(`state:${offlineScope}`, saved); }
    });
    render();
    const actions = pendingOps.some(op => op.entity_id === taskId && (op.op_type === 'transition_task' || op.status === 'failed')) ? [] : allowedTransitions(task);
    showModal(task.title, `<p>${badge(task.status)} ${priorityBadge(task.priority)} ${syncBadge(task)}</p><dl class="detail-grid">${['area', 'company', 'assignee', 'reviewer', 'due', 'priority'].map(key => `<div><dt>${t(key)}</dt><dd>${['assignee', 'reviewer'].includes(key) ? personName(task[key]) : key === 'due' ? dateLabel(task[key]) : key === 'priority' ? esc(t(task[key])) : esc(task[key] || '—')}</dd></div>`).join('')}</dl><div class="detail-actions">${actions.map(to => `<button type="button" data-command="transition" data-id="${esc(task.id)}" data-to="${to}">${t('transitionTo')} ${t(to)}</button>`).join('')}</div>${actions.length ? '' : `<p class="note">${t('noTransitions')}</p>`}<section class="timeline"><h3>${t('history')}</h3>${[...(task.events || [])].reverse().map(event => `<div class="event"><strong>${event.from_status ? `${esc(t(event.from_status))} → ` : ''}${esc(t(event.to_status))}</strong><div class="event-meta">${personName(event.actor)} · ${timeLabel(event.at)}</div>${event.note ? `<p>${t('note')}: ${esc(event.note)}</p>` : ''}${event.reason ? `<p>${t('reason')}: ${esc(event.reason)}</p>` : ''}</div>`).join('')}</section>${attachmentSection('task', task.id)}`);
  } catch (error) {
    if (version === modalVersion && $('#modal').open) showModal(t('details'), `<p role="alert">${esc(errorMessage(error))}</p>${button('retry', 'detail', `data-id="${esc(taskId)}"`)}`);
  }
}
function showTransition(taskId, to) {
  const task = state.tasks.find(item => item.id === taskId);
  if (!task || !allowedTransitions(task).includes(to)) return;
  const required = transitionRequirements(task, to);
  showModal(`${t('transitionTo')} ${t(to)}`, `<form id="transition-form" data-task-id="${esc(taskId)}" data-to="${to}"><div class="form-error" role="alert" tabindex="-1" hidden></div><p>${t('actor')}: ${esc(actor)}</p><input type="hidden" name="actor" value="${esc(actor)}">${field('note', 'note', '', { type: 'textarea', required: required.note })}${field('reason', 'reason', '', { type: 'textarea', required: required.reason })}${formActions()}</form>`);
}
function showEntryForm() {
  showModal(t('newEntry'), `<form id="entry-form"><div class="form-error" role="alert" tabindex="-1" hidden></div><p class="note">${t('forDate')} ${dateLabel(reportDate)}</p><p class="note">${t('dayRuleNote')}</p><div class="form-grid">${field('shift', 'shift', '', { required: true, options: `<option value="day">${t('day')}</option><option value="night">${t('night')}</option>` })}${field('plan', 'plan', '', { type: 'textarea', full: true })}${field('actual', 'actual', '', { type: 'textarea', full: true })}${field('blockers', 'blockers', '', { type: 'textarea', full: true })}${field('next', 'next', '', { type: 'textarea', full: true })}</div>
      <label class="dropzone" id="entry-drop" for="entry-photos"><strong>${t('diaryPhotos')}</strong><span>${t('diaryPhotosHint')}</span>
        <input id="entry-photos" name="photos" type="file" accept="image/*,application/pdf" multiple hidden></label>
      <p class="note" id="entry-photos-count" hidden></p>${formActions()}</form>`);
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

function attachmentSection(entityType, entityId) {
  const files = (state.attachments || []).filter(file => file.entity_type === entityType && file.entity_id === entityId);
  return `<section class="attachment-section"><h3>${t('attachments')}</h3>${files.map(file => `<p>${button('openAttachment', 'open-attachment', `data-id="${esc(file.id)}"`)} ${esc(file.filename)} ${syncBadge(file)}</p>`).join('')}${button('addAttachment', 'new-attachment', `data-entity-type="${entityType}" data-id="${esc(entityId)}"`)}</section>`;
}
function showAttachmentForm(entityType, entityId, { camera = false } = {}) {
  showModal(t('addAttachment'), `<form id="attachment-form" data-entity-type="${entityType}" data-entity-id="${esc(entityId)}"><div class="form-error" role="alert" tabindex="-1" hidden></div><label class="field">${t('attachmentFile')}<input type="file" name="file" accept="${camera ? 'image/*' : 'image/*,application/pdf'}" ${camera ? 'capture="environment"' : ''} required></label><p class="note">${t('attachmentHint')}</p>${formActions()}</form>`);
}
async function openAttachment(id) {
  const file = state.attachments.find(item => item.id === id);
  if (!file) return;
  if (file.blob) download(file.blob, file.blob.type, file.filename);
  else {
    try {
      const response = await fetch(`${api.baseUrl}/api/attachments/${encodeURIComponent(id)}`, { credentials: 'include' });
      if (!response.ok) throw new Error('apiError');
      download(await response.blob(), file.mime, file.filename);
    } catch { toast(t('apiUnavailable')); }
  }
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
  const rows = [header.map(t), ...tasks.map(task => header.map(key => key === 'kind' ? t(taskKindLabelKey(task.kind ?? 'ordinary')) : ['priority', 'status'].includes(key) ? t(task[key]) : task[key]))];
  download('\ufeff' + rows.map(row => row.map(csvCell).join(',')).join('\r\n'), 'text/csv;charset=utf-8', `siteassistant-tasks-${today()}.csv`); toast(t('csvDone'));
}
document.addEventListener('click', event => {
  const target = event.target.closest('[data-command]'); if (!target) return;
  const command = target.dataset.command, id = target.dataset.id;
  const commands = {
    'today-open': () => openTodayAction(target),
    'today-quick': () => runTodayQuick(target.dataset.action),
    'today-photo-target': () => openTodayPhoto(target.dataset.entityType, id),
    'today-clear-filter': () => { if (view === 'tasks') filters = { search: '', status: '', person: '', priority: '', kind: '' }; else if (coreFilters[view]) delete coreFilters[view].id; render(); },
    'sync-now': () => { offline = !navigator.onLine; void syncQueue(); },
    'discard-op': async () => { await accountLock(async () => { await removeOp(id); }); await refreshPending(); render(); },
    'new-attachment': () => showAttachmentForm(target.dataset.entityType, id),
    'open-attachment': () => openAttachment(id),
    'core-reload': () => { coreCache.delete(siteId); wbsCache.delete(siteId); render(); },
    'reconciliation-filter': () => { reconciliationFilter = reconciliationFilter === target.dataset.kind ? '' : target.dataset.kind; render(); },
    'deviation-view': () => { deviationView = target.dataset.value; render(); },
    'core-detail': () => showCoreDetail(target.dataset.module, id),
    'booking-delete': () => showBookingDelete(id),
    'booking-step': () => { const input = $('#booking-form [name=hours]'); if (input) input.value = Math.max(0, (Number(input.value) || 0) + Number(target.dataset.step)); },
    'tool-new': () => { toolEditingId = ''; showToolForm(); },
    'tool-edit': () => { toolEditingId = id; showToolForm(); },
    'tool-delete': () => showToolDelete(id),
    'hse-new': () => { hseEditingId = ''; showHseForm(); },
    'hse-edit': () => { hseEditingId = id; showHseForm(); },
    'hse-delete': () => showHseDelete(id),
    'cert-new': () => { certEditingId = ''; showCertificationForm(); },
    'cert-edit': () => { certEditingId = id; showCertificationForm(); },
    'cert-delete': () => showCertificationDelete(id),
    'wbs-view': () => { wbsView = target.dataset.value; render(); },
    'wbs-reload': () => { wbsCache.delete(siteId); wbsLoad = null; render(); },
    'wbs-expand': () => { document.querySelectorAll('.wbs-tree details').forEach(node => { node.open = true; }); },
    'wbs-collapse': () => { document.querySelectorAll('.wbs-tree details').forEach(node => { node.open = false; }); },
    'change-password': showPasswordForm, 'request-access': () => showEmailForm('request'), 'forgot-password': () => showEmailForm('forgot'),
    logout, 'new-site': showSiteForm, 'new-task': showTaskForm, reload: loadData,
    'select-site': () => { selectSite(id); go('overview'); }, detail: () => showDetail(id),
    transition: () => showTransition(id, target.dataset.to), 'light-transition': () => runLightTransition(id), 'new-entry': showEntryForm,
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
    'dismiss-password-banner': () => { sessionStorage.setItem('sa-password-banner', 'hidden'); renderChrome(); },
    'toggle-password': () => {
      const input = document.querySelector('#login-form [name=password]') || document.querySelector('form [name=password]');
      if (!input) return;
      input.type = input.type === 'password' ? 'text' : 'password';
      input.focus();
    },
    'open-settings': showSettingsForm,
    'ai-open': () => { const panel = $('#ai-panel'); panel.hidden = false; $('#ai-fab').setAttribute('aria-expanded', 'true'); renderAssistant(); $('#ai-form [name=message]').focus(); },
    'ai-close': () => { $('#ai-panel').hidden = true; $('#ai-fab').setAttribute('aria-expanded', 'false'); $('#ai-fab').focus(); },
    'ai-suggest': () => { askAssistant(target.dataset.text); },
    'more-nav': () => {
      const rest = visibleModules(['today', ...NAV_ITEMS], currentModules()).filter(key => !MOBILE_PRIMARY.includes(key));
      showModal(t('more'), `<nav class="more-nav" aria-label="${t('more')}">${rest.map(key => `<a href="#${key}">${icon(key)}${t(key)}</a>`).join('')}</nav>`);
    },
  };
  commands[command]?.();
});
document.addEventListener('submit', async event => {
  const form = event.target;
  if (form.id === 'dashboard-layout-form') { event.preventDefault(); await submitDashboardLayout(form); return; }
  if (form.id === 'ai-form') {
    event.preventDefault();
    const text = String(new FormData(form).get('message') || '').trim();
    form.reset();
    void askAssistant(text);
    return;
  }
  if (!['saved-view-form', 'site-form', 'task-form', 'entry-form', 'transition-form', 'login-form', 'password-form', 'request-form', 'forgot-form', 'attachment-form', 'booking-form', 'booking-delete-form', 'impact-transition-form', 'progress-steps-form', 'progress-type-form', 'progress-hours-form', 'tool-form', 'tool-delete-form', 'cert-form', 'cert-delete-form', 'import-form', 'settings-form'].includes(form.id)) return;
  event.preventDefault();
  if (form.dataset.saving) return;
  const data = Object.fromEntries(new FormData(form));
  form.dataset.saving = 'true';
  const submit = form.querySelector('[type=submit]'); submit.disabled = true;
  const version = modalVersion;
  // Capture the selected context before waiting for the server.
  const selectedSite = siteId, selectedDate = reportDate;
  try {
    if (form.id === 'saved-view-form') {
      await saveViewChange(form.dataset.action, { id: form.dataset.id, name: data.name, shared: data.shared === 'on' });
      if (version === modalVersion) closeModal();
      return;
    }
    if (form.id === 'settings-form') {
      const data2 = Object.fromEntries(new FormData(form));
      prefs = { currency: String(data2.currency || 'EUR'), decimals: Number(data2.decimals) === 0 ? 0 : 2, separators: data2.separators === 'en' ? 'en' : 'it' };
      savePrefs(); closeModal(); render(); toast(t('settingsSaved')); return;
    }
    if (form.id === 'import-form') { await handleImport(form); return; }
    if (['booking-form', 'booking-delete-form', 'impact-transition-form', 'progress-steps-form', 'progress-type-form', 'progress-hours-form'].includes(form.id)) { await submitCore(form, data); return; }
    if (['tool-form', 'tool-delete-form'].includes(form.id)) { await submitTool(form, data); return; }
    if (['hse-form', 'hse-delete-form'].includes(form.id)) { await submitHse(form, data); return; }
    if (['cert-form', 'cert-delete-form'].includes(form.id)) { await submitCertification(form, data); return; }
    if (form.id === 'login-form') {
      await accountLock(async () => { await api.login(data); await forgetActive(); clearSession(); accountChannel?.postMessage('changed'); });
      await loadData(); await syncQueue(); return;
    }
    if (form.id === 'password-form') {
      if (data.new_password !== data.confirm_password) throw new Error('passwordMismatch');
      if ([...data.new_password].length < 12 || data.new_password === data.current_password) throw new Error('passwordPolicy');
      await api.changePassword({ current_password: data.current_password, new_password: data.new_password });
      if (session) session.password_change_required = false;
      if (version === modalVersion) closeModal();
      render(); toast(t('passwordChanged')); return;
    }
    if (['request-form', 'forgot-form'].includes(form.id)) {
      await (form.id === 'request-form' ? api.requestAccess(data) : api.forgotPassword(data));
      if (version === modalVersion) closeModal();
      toast(t('emailAccepted')); return;
    }
    let message, detail;
    if (form.id === 'site-form') { const site = await api.createSite(data); state.sites.push(site); resetSavedViews(); siteId = site.id; filters = { search: '', status: '', person: '', priority: '', kind: '' }; message = 'siteCreated'; }
    if (form.id === 'task-form') { const payload = { ...data, siteId: selectedSite }; taskPayload(payload); await writeOperation('create_task', payload); message = 'taskCreated'; }
    if (form.id === 'entry-form') {
      const payload = { ...data, siteId: selectedSite, date: selectedDate };
      delete payload.photos;
      diaryPayload(payload);
      const entry = await writeOperation('create_diary', payload);
      const photos = [...(form.querySelector('[name=photos]')?.files || [])];
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
      const input = { ...data, to: form.dataset.to }; transitionPayload(task, input);
      await writeOperation('transition_task', { task, input }, task.id);
      detail = state.tasks.find(item => item.id === task.id); message = 'actionSaved';
    }
    if (form.id === 'attachment-form') {
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
    toast(t(message));
  } catch (error) {
    if (version === modalVersion && form.isConnected) formError(form, error);
    else toast(errorMessage(error));
  } finally { delete form.dataset.saving; submit.disabled = form.id === 'import-form' && (!form.importMappings || form.mappingDirty); }
});
$('#modal').addEventListener('cancel', () => { modalVersion++; });
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
  if (event.target.id === 'filter-kind') { filters.kind = event.target.value; renderTasks(); }
  if (event.target.id === 'task-sort-key') { taskSort.key = event.target.value; renderTaskResults(); }
  if (event.target.id === 'task-sort-direction') { taskSort.direction = event.target.value; renderTaskResults(); }
  if (event.target.dataset.taskColumn) {
    const checked = [...document.querySelectorAll('[data-task-column]:checked')].map(input => input.dataset.taskColumn);
    if (checked.length) taskColumns = checked;
    document.querySelectorAll('[data-task-column]').forEach(input => { input.disabled = taskColumns.length === 1 && taskColumns.includes(input.dataset.taskColumn); });
    renderTaskResults();
  }
  if (event.target.dataset.coreFilter && coreFilters[view]) { coreFilters[view][event.target.dataset.coreFilter] = event.target.value; render(); }
  if (event.target.matches('#impact-transition-form [name=to]')) {
    const closing = event.target.value === 'closed', result = $('#impact-transition-form [name=result]');
    $('#impact-result-field').hidden = !closing; result.required = closing; result.disabled = !closing; if (!closing) result.value = '';
  }
  if (event.target.id === 'report-date') { if (validDate(event.target.value)) { reportDate = event.target.value; renderDiary(); } else event.target.value = reportDate; }
  for (const [id, key] of [['filter-status', 'status'], ['filter-person', 'person'], ['filter-priority', 'priority']]) if (event.target.id === id) { filters[key] = event.target.value; renderTaskResults(); }
});
document.addEventListener('input', event => {
  const form = event.target.closest('#import-form');
  if (form) {
    if (event.target.dataset.importAlias) form.mappingDirty = true;
    invalidateImportPreview(form);
  }
  if (event.target.id === 'filter-search') { filters.search = event.target.value; renderTaskResults(); } });
$('#language').addEventListener('click', () => { if ($('#modal').open) return toast(t('saveDraftFirst')); language = language === 'it' ? 'en' : 'it'; render(); });
window.addEventListener('hashchange', () => { const next = location.hash.slice(1); view = initialView({ width: window.innerWidth, hash: next ? `#${next}` : '#overview' }); if (view !== 'report') reportPrintIntent = null; closeModal(); render(); $('#main').focus(); });
window.addEventListener('offline', () => { offline = true; renderOffline(); if (moduleResources[view] || view === 'today') { closeModal(); render(); } });
window.matchMedia('(width < 800px)').addEventListener('change', () => renderChrome());
window.addEventListener('online', () => { offline = false; coreCache.clear(); renderOffline(); if (moduleResources[view] || view === 'today') render(); void syncQueue(); });
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
