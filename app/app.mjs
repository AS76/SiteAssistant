import { offlineBannerState, STATUSES, PRIORITIES, today, validDate, allowedTransitions, transitionRequirements, counts, csvCell, taskPayload, diaryPayload, transitionPayload, DEVIATION_STATUSES, IMPACT_STATUSES, IMPACT_RESULTS, impactTransitions, corePermissions, filterSortRecords, impactTotals, groupBookings, flattenWbs } from './domain.mjs';
import { createApi, DEFAULT_BASE_URL } from './api.mjs';
import { messages } from './i18n.mjs';
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
let view = ['overview', 'sites', 'tasks', 'wbs', 'deviations', 'progress', 'bookings', 'impacts', 'diary'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'overview';
let filters = { search: '', status: '', person: '', priority: '' };
let taskView = 'board';
let wbsView = 'tree', wbsLoad = null;
const wbsCache = new Map();
let reportDate = today();
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
const errorKeys = { VALIDATION_ERROR: 'invalidData', TIME_BOOKING_NOT_FOUND: 'coreRecordGone', WORK_DAY_NOT_FOUND: 'coreRecordGone', SITE_PROGRESS_ITEM_NOT_FOUND: 'coreRecordGone', DEVIATION_NOT_FOUND: 'coreRecordGone', COST_IMPACT_NOT_FOUND: 'coreRecordGone', TIME_BOOKING_DUPLICATE: 'coreDuplicateBooking', TIME_BOOKING_SITE_MISMATCH: 'coreSiteMismatch', COST_IMPACT_CONFLICT: 'coreImpactConflict', MAIL_NOT_CONFIGURED: 'mailUnavailable', MAIL_UNAVAILABLE: 'mailUnavailable', DUPLICATE_SITE_CODE: 'duplicateCode', DUPLICATE_DIARY: 'duplicateDiary', SEPARATE_PEOPLE_REQUIRED: 'separatePeople', INVALID_TRANSITION: 'actionDenied', VERIFIER_REQUIRED: 'verifierRequired', NOTE_REQUIRED: 'noteRequired', REASON_REQUIRED: 'reasonRequired' };
function errorMessage(error) { return t(({ 401: error.code === 'INVALID_CREDENTIALS' ? 'invalidCredentials' : 'authRequired', 403: 'forbidden', 429: 'rateLimited' })[error.status] || errorKeys[error.code] || (error.message in messages[language] ? error.message : 'apiError')); }
function clearSession(invalidate = false) {
  wbsCache.clear(); wbsLoad = null; resetCore();
  session = null; actor = ''; siteId = undefined; loadError = null; offlineScope = undefined; pendingOps = [];
  state = { sites: [], tasks: [], diary: [], attachments: [] };
  filters = { search: '', status: '', person: '', priority: '' };
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
  coreCache.clear();
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
          const saved = storageReady ? await getMirror(`state:${offlineScope}`) : null;
          state = { sites, tasks, diary, attachments: saved?.attachments || [] };
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
      if (!state.sites.some(site => site.id === siteId)) siteId = state.sites[0]?.id;
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
  $('#navigation').setAttribute('aria-label', t('nav'));
  $('#navigation').classList.add('core-navigation');
  $('.sidebar').classList.add('core-sidebar');
  const compact = compactNavigation();
  const navItems = compact ? MOBILE_PRIMARY : NAV_ITEMS;
  const more = compact && !MOBILE_PRIMARY.includes(view);
  const navLabel = key => t(compact && key === 'bookings' ? 'bookingsShort' : key);
  $('#navigation').innerHTML = navItems.map(key => `<a href="#${key}" ${view === key ? 'class="active" aria-current="page"' : ''}>${icon(key)}<span>${navLabel(key)}</span></a>`).join('')
    + (compactNavigation() ? `<button type="button" class="nav-more${more ? ' active' : ''}" data-command="more-nav">${icon('more')}${t('more')}</button>` : '');
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
  passwordBanner.hidden = !session?.password_change_required;
  passwordBanner.innerHTML = `<strong>${t('passwordChangeNotice')}</strong> ${button('changePassword', 'change-password')}`;
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
function renderOverview() {
  const tasks = siteTasks(), count = counts(tasks), total = tasks.length;
  const attention = tasks.filter(task => task.status !== 'closed').sort((a, b) => {
    const score = task => (task.status === 'blocked' ? 10 : task.status === 'to_verify' ? 6 : 0) + (task.due && task.due < today() ? 12 : 0) + PRIORITIES.indexOf(task.priority);
    return score(b) - score(a) || (a.due || '9999').localeCompare(b.due || '9999');
  }).slice(0, 5);
  const lastEntry = state.diary.filter(item => item.siteId === siteId && item.date === today()).at(-1);
  $('#main').innerHTML = heading('overviewTitle', 'overviewSub',
    (canImport() ? button('importOpen', 'import-open') : '') + button('newTask', 'new-task', '', 'primary')) +
    `<div class="date-caption">${t('today')} · ${new Intl.DateTimeFormat(language === 'it' ? 'it-IT' : 'en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date())}</div>` +
    `<div class="metrics">${['execution', 'review', 'closed', 'overdue'].map(key => `<div class="metric ${key === 'overdue' ? 'alert' : key === 'closed' ? 'complete' : key}"><div class="metric-top">${t(key)}${icon(key)}</div><strong data-metric="${key}">${count[key]}</strong><small>${t(`${key}Hint`)}</small></div>`).join('')}</div>` +
    `<div class="grid-overview"><section class="panel"><div class="panel-header"><h2>${t('priorityWork')}</h2><a class="subtitle" href="#tasks">${t('seeAll')} →</a></div>${attention.length ? attention.map(taskRow).join('') : empty('noTasks', 'noTasksHint')}</section><div class="summary-stack"><section class="panel"><div class="panel-header"><h2>${t('dailyPulse')}</h2></div><div class="panel-body"><div class="progress-label"><span>${t('verifiedProgress')}</span><strong>${count.closed} / ${total}</strong></div><div class="progress-track"><span style="width:${total ? count.closed / total * 100 : 0}%"></span></div><p class="note">${total - count.closed} ${t('nonClosed')}</p><div class="summary-stack"><div class="summary-line"><strong>${count.blocked} ${t('blockedPlural')}</strong><p>${count.review} ${t('reviewPlural')}</p></div><div class="summary-line"><strong>${t('workingRule')}</strong><p>${t('workingRuleNote')}</p></div></div></div></section><section class="panel"><div class="panel-header"><h2>${t('journalToday')}</h2><span class="badge">${t('draft')}</span></div><div class="panel-body"><p class="subtitle prewrap">${lastEntry ? esc(lastEntry.actual) : t('noDiary')}</p>${syncBadge(lastEntry)}<a class="subtitle" href="#diary">${t('openDiary')} →</a></div></section></div></div>`;
}
function renderSites() {
  $('#main').innerHTML = heading('sitesTitle', 'sitesSub', button('newSite', 'new-site', '', 'primary')) + `<div class="site-grid">${state.sites.map(site => {
    const tasks = state.tasks.filter(task => task.siteId === site.id), count = counts(tasks);
    return `<article class="site-card ${site.id === siteId ? 'selected' : ''}"><span class="site-code">${esc(site.code)}</span><h2>${esc(site.name)}</h2><p>${esc(site.location || '—')}</p><div class="site-counts"><span><strong>${tasks.length}</strong>${t('tasks')}</span><span><strong>${tasks.length - count.closed}</strong>${t('nonClosed')}</span></div><p>${site.start ? dateLabel(site.start) : '—'} → ${site.end ? dateLabel(site.end) : '—'}</p>${button(site.id === siteId ? 'selected' : 'openSite', 'select-site', `data-id="${esc(site.id)}"`, site.id === siteId ? 'small' : 'primary small')}</article>`;
  }).join('')}</div>`;
}
function filteredTasks() {
  const needle = filters.search.trim().toLocaleLowerCase();
  return siteTasks().filter(task => (!filters.status || task.status === filters.status) && (!filters.person || task.assignee === filters.person) && (!filters.priority || task.priority === filters.priority) && (!needle || `${task.title} ${task.area} ${task.company}`.toLocaleLowerCase().includes(needle)));
}
function renderTasks() {
  $('#main').innerHTML = heading('tasksTitle', 'tasksSub', button('exportCsv', 'csv') + button('newTask', 'new-task', '', 'primary')) +
    `<div class="toolbar"><input class="search" id="filter-search" aria-label="${t('search')}" placeholder="${t('search')}" value="${esc(filters.search)}"><select id="filter-status" aria-label="${t('status')}"><option value="">${t('allStatuses')}</option>${STATUSES.map(status => `<option value="${status}" ${filters.status === status ? 'selected' : ''}>${t(status)}</option>`).join('')}</select><select id="filter-person" aria-label="${t('assignee')}"><option value="">${t('allPeople')}</option>${[...new Set(siteTasks().map(task => task.assignee))].map(person => `<option value="${esc(person)}" ${filters.person === person ? 'selected' : ''}>${personName(person)}</option>`).join('')}</select><select id="filter-priority" aria-label="${t('priority')}"><option value="">${t('allPriorities')}</option>${PRIORITIES.map(priority => `<option value="${priority}" ${filters.priority === priority ? 'selected' : ''}>${t(priority)}</option>`).join('')}</select><div class="view-toggle">${button('board', 'task-view', `data-value="board" aria-pressed="${taskView === 'board'}"`, taskView === 'board' ? 'selected' : '')}${button('list', 'task-view', `data-value="list" aria-pressed="${taskView === 'list'}"`, taskView === 'list' ? 'selected' : '')}</div></div><div id="task-results"></div>`;
  renderTaskResults();
}
function taskCard(task) {
  return `<button type="button" class="task-card" data-command="detail" data-id="${esc(task.id)}"><span class="card-code">${esc(task.area || t('noArea'))}</span><h2>${esc(task.title)}</h2>${priorityBadge(task.priority)} ${syncBadge(task)}<p>${esc(task.company)}</p><p>${personName(task.assignee)}</p><div class="card-footer">${dueMarkup(task)}<span>→</span></div></button>`;
}
function renderTaskResults() {
  const tasks = filteredTasks();
  let html = `<p class="note" role="status">${tasks.length} ${t('resultCount')} · ${siteTasks().length - counts(siteTasks()).closed} ${t('nonClosed')}</p>`;
  if (!tasks.length) html += `<section class="panel">${empty('noResults', 'noResultsHint', button('clearFilters', 'clear-filters'))}</section>`;
  else if (taskView === 'board') html += `<div class="board">${STATUSES.map(status => {
    const column = tasks.filter(task => task.status === status);
    return `<section class="board-column" aria-label="${t(status)}"><div class="column-heading"><span>${t(status)}</span><span>${column.length}</span></div>${column.length ? column.map(taskCard).join('') : `<div class="mini-empty">${t('emptyColumn')}</div>`}</section>`;
  }).join('')}</div>`;
  else html += `<div class="table-scroll"><table><thead><tr>${['title', 'area', 'status', 'company', 'assignee', 'reviewer', 'due'].map(key => `<th scope="col">${t(key)}</th>`).join('')}</tr></thead><tbody>${tasks.map(task => `<tr><td><button data-command="detail" data-id="${esc(task.id)}">${esc(task.title)}</button></td><td>${esc(task.area || '—')}</td><td>${badge(task.status)} ${syncBadge(task)}</td><td>${esc(task.company)}</td><td>${personName(task.assignee)}</td><td>${personName(task.reviewer)}</td><td>${dueMarkup(task)}</td></tr>`).join('')}</tbody></table></div>`;
  $('#task-results').innerHTML = html;
}
function renderDiary() {
  const entries = state.diary.filter(item => item.siteId === siteId && item.date === reportDate);
  $('#main').innerHTML = heading('diaryTitle', 'diarySub', button('print', 'print') + button('newEntry', 'new-entry', '', 'primary')) +
    `<div class="diary-toolbar"><label for="report-date">${t('reportDate')}</label><input id="report-date" type="date" min="0001-01-01" max="9999-12-31" value="${reportDate}"><span class="badge">${t('draft')}</span><span class="subtitle">${entries.length} ${t('entries')}</span></div><div class="diary-grid"><section class="panel">${entries.length ? entries.map(entry => {
      return `<article class="diary-entry"><div class="entry-heading"><strong>${t(entry.shift)} ${syncBadge(entry)}</strong><span>${t('recordedAt')} ${timeLabel(entry.createdAt)}</span></div><div class="entry-grid">${['plan', 'actual', 'blockers', 'next'].map(key => `<section class="entry-section ${key === 'blockers' && entry[key] ? 'entry-blocker' : ''}"><h3>${t(key)}</h3><p>${esc(entry[key] || '—')}</p></section>`).join('')}</div>${attachmentSection('diary', entry.id)}</article>`;
    }).join('') : empty('diaryEmpty', 'diaryEmptyHint', button('newEntry', 'new-entry', '', 'primary'))}</section><aside class="panel diary-aside"><div class="panel-body"><h3>${t('dayRule')}</h3><p>${t('dayRuleNote')}</p><div class="blank-message">${t('diaryLimit')}</div></div></aside></div><p class="note">${t('forDate')} ${dateLabel(reportDate)} · ${t('draft')} · ${t('diaryLimit')}</p>`;
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
    $('#main').insertAdjacentHTML('beforeend', `<p role="status">${t('loading')}</p>`);
    $('#main').setAttribute('aria-busy', 'true');
    if (!wbsLoad) void loadWbs();
    return;
  }
  if (cached.error) {
    $('#main').insertAdjacentHTML('beforeend', `<p role="alert">${esc(errorMessage(cached.error))}</p>`); return;
  }
  if (!cached.nodes.length) { $('#main').insertAdjacentHTML('beforeend', empty('wbsEmpty', 'wbsEmptyHint')); return; }
  const label = node => `<strong>${esc(node.wbs_code)}</strong> ${esc(node.description ?? '—')}${node.is_synthetic ? ` <span class="badge">${t('wbsSynthetic')}</span>` : ''}`;
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
const permissions = () => corePermissions(role());
const moduleResources = { deviations: ['deviations'], progress: ['progress', 'wbs', 'progressTypes'], bookings: ['bookings', 'workDays', 'employees', 'progress'], impacts: ['impacts'] };
// Mobile keeps four destinations reachable with the thumb; the rest lives behind «Altro».
const NAV_ITEMS = ['overview', 'sites', 'tasks', 'wbs', 'deviations', 'progress', 'bookings', 'impacts', 'diary'];
const MOBILE_PRIMARY = ['overview', 'tasks', 'deviations', 'bookings'];
const compactNavigation = () => window.matchMedia('(max-width: 800px)').matches;
const coreCache = new Map();
let coreFilters = { deviations: { status: '', priority: '' }, progress: { wbsId: '' }, bookings: { date: '' }, impacts: { status: '', result: '' } };
let deviationView = 'board';
function resetCore() {
  coreCache.clear();
  coreFilters = { deviations: { status: '', priority: '' }, progress: { wbsId: '' }, bookings: { date: '' }, impacts: { status: '', result: '' } };
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
    progressTypes: () => freshApi.listProgressTypes(selected),
    bookings: () => freshApi.listBookings({ siteId: selected }), impacts: () => freshApi.listImpacts({ siteId: selected }),
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
  entry.promise = loaders[name]().then(data => { entry.data = data; }, error => { entry.error = error; }).finally(() => {
    entry.pending = false;
    if (coreCache.get(selected) === cache && cache.get(name) === entry && siteId === selected && moduleResources[view]?.includes(name)) render();
  });
  return entry;
}
const coreData = name => coreCache.get(siteId)?.get(name)?.data || [];
const coreValue = value => esc(value ?? t('coreUnknown'));
const coreStatus = value => `<span class="badge core-status core-status-${esc(value || 'unknown')}">${esc(t(value || 'coreUnknown'))}</span>`;
const coreNumber = value => value == null ? t('coreUnknown') : new Intl.NumberFormat(language === 'it' ? 'it-IT' : 'en-GB', { maximumFractionDigits: 4 }).format(Number(value));
const employeeLabel = employee => employee ? [employee.employeeNo, employee.firstName, employee.lastName].filter(Boolean).join(' · ') || employee.id : t('coreUnknown');
const progressLabel = item => item?.description || item?.id || t('coreUnknown');
function coreSelect(key, label, options, value, allLabel) {
  return `<label class="field core-filter"><span>${t(label)}</span><select data-core-filter="${key}">${allLabel ? `<option value="">${t(allLabel)}</option>` : ''}${options.map(([id, text]) => `<option value="${esc(id)}" ${id === value ? 'selected' : ''}>${esc(text)}</option>`).join('')}</select></label>`;
}
function coreTable(columns, rows) {
  return `<div class="core-table-wrap"><table class="core-table"><thead><tr>${columns.map(key => `<th scope="col">${t(key)}</th>`).join('')}</tr></thead><tbody>${rows.map(cells => `<tr>${cells.map((cell, index) => `<td data-label="${t(columns[index])}">${cell}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}
const coreDetailButton = (module, row, label = row.title || row.description || row.id) => `<button type="button" data-command="core-detail" data-module="${module}" data-id="${esc(row.id)}">${esc(label)}</button>`;
function progressBar(value) {
  if (value == null) return t('coreUnknown');
  return `<div class="core-progress"><span>${coreNumber(value)}%</span><progress max="100" value="${Math.min(100, Math.max(0, Number(value)))}" aria-label="${t('coreProgressPct')}"></progress></div>`;
}
function renderCore() {
  $('#main').innerHTML = heading(view, `${view}Sub`,
    button(columnFiltersOn ? 'columnFiltersHide' : 'columnFiltersShow', 'column-filters', `aria-pressed="${columnFiltersOn}"`) + button('coreRefresh', 'core-reload'));
  if (offline || !navigator.onLine) {
    $('#main').insertAdjacentHTML('beforeend', empty('coreOnlineOnly', 'coreOnlineHint')); return;
  }
  const resources = moduleResources[view].map(coreResource);
  if (resources.some(entry => entry.pending)) {
    $('#main').setAttribute('aria-busy', 'true');
    $('#main').insertAdjacentHTML('beforeend', `<p role="status">${t('loading')}</p>`); return;
  }
  const error = resources.find(entry => entry.error)?.error;
  if (error) { $('#main').insertAdjacentHTML('beforeend', `<p role="alert">${esc(errorMessage(error))}</p>`); return; }
  const content = { deviations: renderDeviations, progress: renderProgress, bookings: renderBookings, impacts: renderImpacts }[view]();
  $('#main').insertAdjacentHTML('beforeend', `<div class="core-view">${content}</div>`);
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
function renderDeviations() {
  const all = coreData('deviations'), filter = coreFilters.deviations;
  const rows = filterSortRecords(all, filter, [{ key: 'creationDate', descending: true }, { key: 'deviationNo' }]);
  const priorities = [...new Set(all.map(row => row.priority).filter(value => value != null))].sort();
  let html = `<div class="toolbar core-toolbar">${coreSelect('status', 'status', [...DEVIATION_STATUSES.map(value => [value, t(value)]), ['__unknown', t('coreUnknown')]], filter.status, 'allStatuses')}${coreSelect('priority', 'priority', priorities.map(value => [value, t(value)]), filter.priority, 'allPriorities')}<div class="view-toggle">${['board', 'list'].map(value => button(value, 'deviation-view', `data-value="${value}" aria-pressed="${deviationView === value}"`, deviationView === value ? 'selected' : '')).join('')}</div></div>`;
  const visible = filter.status === '__unknown' ? filterSortRecords(all, { ...filter, status: null }, [{ key: 'creationDate', descending: true }, { key: 'deviationNo' }]) : rows;
  const card = row => `<button type="button" class="task-card" data-command="core-detail" data-module="deviations" data-id="${esc(row.id)}"><span class="card-code">${coreValue(row.deviationNo)}</span><h2>${esc(row.title || row.id)}</h2>${coreStatus(row.status)}<p>${t('priority')}: ${coreValue(row.priority == null ? null : t(row.priority))}</p><p>${coreValue(row.assignedTo)}</p></button>`;
  if (deviationView === 'board') {
    html += `<div class="core-board" tabindex="0" role="region" aria-label="${t('coreDeviationBoard')}">${DEVIATION_STATUSES.map(status => {
      const column = visible.filter(row => row.status === status);
      return `<section class="core-column"><div class="column-heading"><span>${t(status)}</span><span>${column.length}</span></div>${column.length ? column.map(card).join('') : `<p class="mini-empty">${t('coreEmptyColumn')}</p>`}</section>`;
    }).join('')}</div>`;
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
    else html += `<form id="booking-form" class="panel panel-body core-booking-form"><h2>${t('coreBookHours')}</h2><div class="form-error" role="alert" tabindex="-1" hidden></div><div class="core-entry-grid"><label class="field">${t('coreWorkDay')}<select name="workDayId" required><option value="">${t('coreChoose')}</option>${filterSortRecords(days, {}, [{ key: 'operationalDate', descending: true }, { key: 'employeeId' }]).map(day => `<option value="${esc(day.id)}">${esc(`${day.operationalDate} · ${employeeLabel(employees.find(employee => employee.id === day.employeeId))} · ${t(day.shift || 'coreUnknown')} · ${day.startTime ?? t('coreUnknown')}`)}</option>`).join('')}</select></label><label class="field">${t('coreProgressItem')}<select name="siteProgressItemId" required><option value="">${t('coreChoose')}</option>${items.map(item => `<option value="${esc(item.id)}">${esc(progressLabel(item))}</option>`).join('')}</select></label><label class="field">${t('coreHours')}<input name="hours" type="number" min="0" step="0.5" value="1" required></label><div class="core-stepper">${button('coreMinusHalf', 'booking-step', 'data-step="-0.5"')}${button('corePlusHalf', 'booking-step', 'data-step="0.5"')}${button('corePlusOne', 'booking-step', 'data-step="1"')}</div></div><div class="form-actions"><button type="submit" class="primary">${t('coreBookHours')}</button></div></form>`;
  }
  html += groups.length ? groups.map(group => `<section class="core-day"><h2>${group.date ? dateLabel(group.date) : t('coreUnknown')} <small>${coreNumber(group.hours)} ${t('coreHours')}</small></h2>${coreTable(['coreEmployee', 'coreProgressItem', 'coreHours', ...(permissions().book ? ['coreActions'] : [])], group.rows.map(row => [esc(employeeLabel(row.employee)), esc(row.item ? progressLabel(row.item) : row.siteProgressItemId), coreNumber(row.hours), ...(permissions().book ? [button('coreDelete', 'booking-delete', `data-id="${esc(row.id)}"`, 'danger small')] : [])]))}</section>`).join('') : empty('noResults', 'noResultsHint');
  return html;
}
function renderImpacts() {
  const rows = filterSortRecords(coreData('impacts'), coreFilters.impacts, [{ key: 'createdAt', descending: true }]), totals = impactTotals(rows);
  return `<div class="core-kpis" role="status">${[['coreTotalClaim', totals.claimAmount, totals.missingClaim], ['coreTotalSettlement', totals.settlementAmount, totals.missingSettlement]].map(([label, amount, missing]) => `<div class="panel panel-body"><span>${t(label)}</span><strong class="money">${money(amount)}</strong>${missing ? `<small>${missing} ${t(missing === 1 ? 'coreMissingAmountOne' : 'coreMissingAmounts')}</small>` : ''}</div>`).join('')}</div><p class="note">${t('coreAmountsHint')}</p><div class="toolbar core-toolbar">${coreSelect('status', 'status', IMPACT_STATUSES.map(value => [value, t(value)]), coreFilters.impacts.status, 'allStatuses')}${coreSelect('result', 'coreResult', IMPACT_RESULTS.map(value => [value, t(value)]), coreFilters.impacts.result, 'coreAllResults')}</div>` +
    (rows.length ? coreTable(['title', 'status', 'coreClaimAmount', 'coreSettlementAmount', 'coreResult'], rows.map(row => [coreDetailButton('impacts', row), coreStatus(row.status), money(row.claimAmount), money(row.settlementAmount), coreValue(row.result == null ? null : t(row.result))])) : empty('noResults', 'noResultsHint'));
}
function coreFields(row, fields) {
  return `<dl class="detail-grid core-details">${fields.map(([key, label = key]) => `<div><dt>${t(label)}</dt><dd>${['status', 'result', 'priority'].includes(key) && row[key] != null ? esc(t(row[key])) : typeof row[key] === 'boolean' ? t(row[key] ? 'coreYes' : 'coreNo') : coreValue(row[key])}</dd></div>`).join('')}</dl>`;
}
function progressStepsSection(row) {
  const types = coreData('progressTypes') || [];
  const type = types.find(candidate => candidate.id === row.progressTypeId);
  const steps = row.steps || [], rights = permissions();
  let html = `<h3>${t('coreProgressType')}</h3>`;
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
  overview: ['aiSuggestOverview'], tasks: ['aiSuggestTasks'], deviations: ['aiSuggestDeviations'],
  progress: ['aiSuggestProgress'], bookings: ['aiSuggestBookings'], impacts: ['aiSuggestImpacts'], diary: ['aiSuggestDiary'],
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
    const result = await api.assistantChat({ site_id: siteId, view, messages: aiMessages.slice(-6) });
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

function showImportForm() {
  importPreview = null;
  showModal(t('importTitle'), `<form id="import-form"><div class="form-error" role="alert" tabindex="-1" hidden></div>` +
    `<p class="note">${t('importHint')}</p>` +
    `<div class="form-grid"><label class="field">${t('importFamily')}<select name="family" required>${IMPORT_FAMILIES.map(family => `<option value="${family}">${t(`importFamily_${family}`)}</option>`).join('')}</select></label>` +
    `<label class="field">${t('importFile')}<input name="file" type="file" accept=".xlsx" required></label></div>` +
    `<div id="import-result" class="import-result"></div><div class="form-actions">${button('importClose', 'close-modal')}<button type="submit" class="primary">${t('importPreview')}</button></div></form>`);
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
  const data = Object.fromEntries(new FormData(form));
  const file = data.file;
  if (!(file instanceof File) || !file.size) throw new Error('invalidData');
  if (file.size > 20 * 1024 * 1024) throw new Error('importTooBig');
  const base64 = await fileToBase64(file);
  const input = { site_id: siteId, family: data.family, filename: file.name, data_base64: base64 };
  const result = document.querySelector('#import-result');
  if (!importPreview) {
    const preview = await api.previewImport(input);
    importPreview = { token: preview.preview_token, family: data.family, name: file.name };
    result.innerHTML = renderImportPreview(preview);
    const submit = form.querySelector('button[type=submit]');
    submit.textContent = t('importApply');
    submit.dataset.step = 'apply';
    return;
  }
  const applied = await api.applyImport({ ...input, preview_token: importPreview.token });
  importPreview = null;
  closeModal();
  coreCache.clear();
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
    let content;
    if (module === 'deviations') {
      content = coreFields(row, [['deviationNo', 'coreReference'], ['status', 'status'], ['priority', 'priority'], ['problemDescription', 'coreDescription'], ['author', 'coreAuthor'], ['assignedTo', 'coreAssignedTo'], ['plcArea', 'area'], ['creationDate', 'coreCreated'], ['dueDate', 'due'], ['approvedDate', 'coreApprovedDate'], ['closedDate', 'coreClosed'], ['actualCost', 'coreActualCost'], ['claimQuantity', 'coreClaimQuantity'], ['laborHours', 'coreLaborHours'], ['completedTasksPct', 'coreCompletedPct']]);
      const typeLabels = { site_progress_item: 'coreProgressItem', task: 'tasks', diary: 'diary' };
      content += `<h3>${t('coreReferences')}</h3>${row.links?.length ? `<ul class="core-links">${row.links.map(link => `<li>${esc(t(typeLabels[link.entityType] || 'coreReference'))}: ${esc(link.entityId)}</li>`).join('')}</ul>` : `<p>${t('coreNoReferences')}</p>`}`;
    } else if (module === 'progress') {
      content = progressBar(row.progressPct) + coreFields(row, [['description', 'coreDescription'], ['section', 'coreSection'], ['plcArea', 'area'], ['wbsId', 'wbs'], ['assignedTo', 'coreAssignedTo'], ['progressPct', 'coreProgressPct'], ['plannedProgressPct', 'corePlannedPct'], ['deltaProgressSource', 'coreDeltaPct'], ['bookedHours', 'coreBookedHours'], ['plannedStart', 'wbsPlannedStart'], ['plannedFinish', 'wbsPlannedFinish'], ['actualStart', 'coreActualStart'], ['expectedDelay', 'coreExpectedDelay'], ['hasFiles', 'coreHasFiles'], ['hasNotes', 'coreHasNotes'], ['hasDeviations', 'coreHasDeviations']]);
      content += progressStepsSection(row);
    } else {
      content = coreFields({ ...row, claimAmount: row.claimAmount == null ? null : money(row.claimAmount),
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
  showModal(t('coreDeleteBooking'), `<form id="booking-delete-form" data-id="${esc(id)}"><div class="form-error" role="alert" tabindex="-1" hidden></div><p>${t('coreDeleteConfirm')}</p><p>${coreNumber(row.hours)} ${t('coreHours')} · ${esc(progressLabel(coreData('progress').find(item => item.id === row.siteProgressItemId)))}</p><div class="form-actions">${button('cancel', 'close-modal')}<button type="submit" class="danger">${t('coreDelete')}</button></div></form>`);
}
async function submitCore(form, data) {
  const selected = siteId, user = session?.user.id, version = modalVersion;
  if (offline || !navigator.onLine) throw new Error('coreOnlineOnly');
  const isImpact = form.id === 'impact-transition-form';
  const isSteps = form.id === 'progress-steps-form', isType = form.id === 'progress-type-form';
  if (isSteps) { if (!permissions().steps) throw new Error('forbidden'); }
  else if (isType) { if (!permissions().assign) throw new Error('forbidden'); }
  else if (!(isImpact ? permissions().transition : permissions().book)) throw new Error('forbidden');
  if (form.id === 'booking-form') {
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
  for (const key of isImpact ? ['impacts'] : ['bookings', 'progress']) cache?.delete(key);
  if (selected !== siteId) return;
  if (form.id !== 'booking-form' && version === modalVersion) closeModal();
  render(); toast(t('actionSaved'));
  if (isImpact || isSteps || isType) void showCoreDetail(isImpact ? 'impacts' : 'progress', form.dataset.id);
}

function render() {
  renderChrome();
  $('#main').setAttribute('aria-busy', String(loading));
  if (loading) { $('#main').innerHTML = `<p role="status">${t('loading')}</p>`; return; }
  if (!session && (!loadError || loadError.status === 401)) {
    $('#main').innerHTML = `<section class="panel"><div class="panel-body"><h1>${t('login')}</h1><form id="login-form"><div class="form-error" role="alert" tabindex="-1" hidden></div><div class="form-grid"><label class="field">${t('email')}<input name="email" type="email" autocomplete="username" required></label><label class="field">${t('password')}<input name="password" type="password" autocomplete="current-password" required maxlength="1024"></label></div><div class="form-actions"><button type="submit" class="primary">${t('login')}</button></div></form><div class="heading-actions">${button('requestAccess', 'request-access')}${button('forgotPassword', 'forgot-password')}</div></div></section>`;
    return;
  }
  if (loadError) { $('#main').innerHTML = `<div role="alert"><p>${esc(errorMessage(loadError))}</p>${button('retry', 'reload')}</div>`; return; }
  if (!state.sites.length && view !== 'sites') { $('#main').innerHTML = empty('noSites', 'noSitesHint', button('newSite', 'new-site', '', 'primary')); return; }
  ({ overview: renderOverview, sites: renderSites, tasks: renderTasks, diary: renderDiary, wbs: renderWbs, deviations: renderCore, progress: renderCore, bookings: renderCore, impacts: renderCore })[view]();
}
function go(next) { if (location.hash !== `#${next}`) location.hash = next; else { view = next; render(); } }
function selectSite(id) {
  if (!state.sites.some(site => site.id === id)) return;
  wbsLoad = null; wbsCache.clear(); resetCore(); closeModal();
  siteId = id; filters = { search: '', status: '', person: '', priority: '' }; render();
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
function showSiteForm() {
  showModal(t('newSite'), `<form id="site-form"><div class="form-error" role="alert" tabindex="-1" hidden></div><div class="form-grid">${field('code', 'code', '', { required: true, max: 30, hint: 'codeHint' })}${field('name', 'name', '', { required: true, max: 120 })}${field('location', 'location', '', { full: true, max: 160 })}${field('startDate', 'start', today(), { type: 'date' })}${field('endDate', 'end', '', { type: 'date' })}</div>${formActions()}</form>`);
}
function showTaskForm() {
  showModal(t('newTask'), `<form id="task-form"><div class="form-error" role="alert" tabindex="-1" hidden></div><div class="form-grid">${field('title', 'title', '', { full: true, required: true, max: 180 })}${field('area', 'area', '', { max: 100 })}${field('company', 'company', '', { max: 100 })}${field('assignee', 'assignee', '', { required: true })}${field('reviewer', 'reviewer', '', { required: true })}${field('priority', 'priority', '', { options: PRIORITIES.map(priority => `<option value="${esc(priority)}">${esc(t(priority))}</option>`).join(''), required: true })}${field('due', 'due', today(), { type: 'date' })}</div>${formActions()}</form>`);
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
function showAttachmentForm(entityType, entityId) {
  showModal(t('addAttachment'), `<form id="attachment-form" data-entity-type="${entityType}" data-entity-id="${esc(entityId)}"><div class="form-error" role="alert" tabindex="-1" hidden></div><label class="field">${t('attachmentFile')}<input type="file" name="file" accept="image/*,application/pdf" required></label><p class="note">${t('attachmentHint')}</p>${formActions()}</form>`);
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
function exportCsv() {
  const tasks = filteredTasks();
  if (!tasks.length) return toast(t('emptyExport'));
  const header = ['title', 'area', 'company', 'assignee', 'reviewer', 'priority', 'due', 'status'];
  const rows = [header.map(t), ...tasks.map(task => header.map(key => ['priority', 'status'].includes(key) ? t(task[key]) : task[key]))];
  download('\ufeff' + rows.map(row => row.map(csvCell).join(',')).join('\r\n'), 'text/csv;charset=utf-8', `siteassistant-tasks-${today()}.csv`); toast(t('csvDone'));
}
document.addEventListener('click', event => {
  const target = event.target.closest('[data-command]'); if (!target) return;
  const command = target.dataset.command, id = target.dataset.id;
  const commands = {
    'sync-now': () => { offline = !navigator.onLine; void syncQueue(); },
    'discard-op': async () => { await accountLock(async () => { await removeOp(id); }); await refreshPending(); render(); },
    'new-attachment': () => showAttachmentForm(target.dataset.entityType, id),
    'open-attachment': () => openAttachment(id),
    'core-reload': () => { coreCache.delete(siteId); wbsCache.delete(siteId); render(); },
    'deviation-view': () => { deviationView = target.dataset.value; render(); },
    'core-detail': () => showCoreDetail(target.dataset.module, id),
    'booking-delete': () => showBookingDelete(id),
    'booking-step': () => { const input = $('#booking-form [name=hours]'); if (input) input.value = Math.max(0, (Number(input.value) || 0) + Number(target.dataset.step)); },
    'wbs-view': () => { wbsView = target.dataset.value; render(); },
    'wbs-reload': () => { wbsCache.delete(siteId); wbsLoad = null; render(); },
    'wbs-expand': () => { document.querySelectorAll('.wbs-tree details').forEach(node => { node.open = true; }); },
    'wbs-collapse': () => { document.querySelectorAll('.wbs-tree details').forEach(node => { node.open = false; }); },
    'change-password': showPasswordForm, 'request-access': () => showEmailForm('request'), 'forgot-password': () => showEmailForm('forgot'),
    logout, 'new-site': showSiteForm, 'new-task': showTaskForm, reload: loadData,
    'select-site': () => { selectSite(id); go('overview'); }, detail: () => showDetail(id),
    transition: () => showTransition(id, target.dataset.to), 'new-entry': showEntryForm,
    'close-modal': closeModal, 'task-view': () => { taskView = target.dataset.value; renderTasks(); },
    'clear-filters': () => { filters = { search: '', status: '', person: '', priority: '' }; renderTasks(); },
    csv: exportCsv, print: () => window.print(),
    'import-open': showImportForm,
    'column-filters': () => { columnFiltersOn = !columnFiltersOn; render(); },
    'open-settings': showSettingsForm,
    'ai-open': () => { const panel = $('#ai-panel'); panel.hidden = false; $('#ai-fab').setAttribute('aria-expanded', 'true'); renderAssistant(); $('#ai-form [name=message]').focus(); },
    'ai-close': () => { $('#ai-panel').hidden = true; $('#ai-fab').setAttribute('aria-expanded', 'false'); $('#ai-fab').focus(); },
    'ai-suggest': () => { askAssistant(target.dataset.text); },
    'more-nav': () => {
      const rest = NAV_ITEMS.filter(key => !MOBILE_PRIMARY.includes(key));
      showModal(t('more'), `<nav class="more-nav" aria-label="${t('more')}">${rest.map(key => `<a href="#${key}">${icon(key)}${t(key)}</a>`).join('')}</nav>`);
    },
  };
  commands[command]?.();
});
document.addEventListener('submit', async event => {
  const form = event.target;
  if (form.id === 'ai-form') {
    event.preventDefault();
    const text = String(new FormData(form).get('message') || '').trim();
    form.reset();
    void askAssistant(text);
    return;
  }
  if (!['site-form', 'task-form', 'entry-form', 'transition-form', 'login-form', 'password-form', 'request-form', 'forgot-form', 'attachment-form', 'booking-form', 'booking-delete-form', 'impact-transition-form', 'progress-steps-form', 'progress-type-form', 'import-form', 'settings-form'].includes(form.id)) return;
  event.preventDefault();
  if (form.dataset.saving) return;
  const data = Object.fromEntries(new FormData(form));
  form.dataset.saving = 'true';
  const submit = form.querySelector('[type=submit]'); submit.disabled = true;
  const version = modalVersion;
  // Capture the selected context before waiting for the server.
  const selectedSite = siteId, selectedDate = reportDate;
  try {
    if (form.id === 'settings-form') {
      const data2 = Object.fromEntries(new FormData(form));
      prefs = { currency: String(data2.currency || 'EUR'), decimals: Number(data2.decimals) === 0 ? 0 : 2, separators: data2.separators === 'en' ? 'en' : 'it' };
      savePrefs(); closeModal(); render(); toast(t('settingsSaved')); return;
    }
    if (form.id === 'import-form') { await handleImport(form); return; }
    if (['booking-form', 'booking-delete-form', 'impact-transition-form', 'progress-steps-form', 'progress-type-form'].includes(form.id)) { await submitCore(form, data); return; }
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
    if (form.id === 'site-form') { const site = await api.createSite(data); state.sites.push(site); siteId = site.id; filters = { search: '', status: '', person: '', priority: '' }; message = 'siteCreated'; }
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
  } finally { delete form.dataset.saving; submit.disabled = false; }
});
$('#modal').addEventListener('cancel', () => { modalVersion++; });
$('#site-select').addEventListener('change', event => selectSite(event.target.value));
document.addEventListener('change', event => {
  if (event.target.dataset.coreFilter && coreFilters[view]) { coreFilters[view][event.target.dataset.coreFilter] = event.target.value; render(); }
  if (event.target.matches('#impact-transition-form [name=to]')) {
    const closing = event.target.value === 'closed', result = $('#impact-transition-form [name=result]');
    $('#impact-result-field').hidden = !closing; result.required = closing; result.disabled = !closing; if (!closing) result.value = '';
  }
  if (event.target.id === 'report-date') { if (validDate(event.target.value)) { reportDate = event.target.value; renderDiary(); } else event.target.value = reportDate; }
  for (const [id, key] of [['filter-status', 'status'], ['filter-person', 'person'], ['filter-priority', 'priority']]) if (event.target.id === id) { filters[key] = event.target.value; renderTaskResults(); }
});
document.addEventListener('input', event => { if (event.target.id === 'filter-search') { filters.search = event.target.value; renderTaskResults(); } });
$('#language').addEventListener('click', () => { if ($('#modal').open) return toast(t('saveDraftFirst')); language = language === 'it' ? 'en' : 'it'; render(); });
window.addEventListener('hashchange', () => { const next = location.hash.slice(1); view = ['overview', 'sites', 'tasks', 'wbs', 'deviations', 'progress', 'bookings', 'impacts', 'diary'].includes(next) ? next : 'overview'; closeModal(); render(); $('#main').focus(); });
window.addEventListener('offline', () => { offline = true; renderOffline(); if (moduleResources[view]) { closeModal(); render(); } });
window.matchMedia('(max-width: 800px)').addEventListener('change', () => renderChrome());
window.addEventListener('online', () => { offline = false; coreCache.clear(); renderOffline(); if (moduleResources[view]) render(); void syncQueue(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) void syncQueue(); });
accountChannel?.addEventListener('message', () => { clearSession(); void loadData(); });
navigator.serviceWorker?.addEventListener('message', event => {
  if (event.data?.scope !== offlineScope) return;
  if (event.data.type === 'offline-synced') void loadData();
  if (event.data.type === 'offline-access-denied') {
    if (event.data.status === 401) clearSession(true);
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
