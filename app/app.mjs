import { STATUSES, PRIORITIES, today, validDate, allowedTransitions, transitionRequirements, counts, csvCell } from './domain.mjs';
import { createApi } from './api.mjs';
import { messages } from './i18n.mjs';

const api = createApi({ baseUrl: document.querySelector('meta[name=siteassistant-api-base]')?.content || undefined, onUnauthorized: clearSession });
const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
let session = null;
let state = { sites: [], tasks: [], diary: [] }, language = 'it', siteId, actor = '', loading = true, loadError = null, toastTimer, modalVersion = 0;
let view = ['overview', 'sites', 'tasks', 'wbs', 'diary'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'overview';
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
const errorKeys = { MAIL_NOT_CONFIGURED: 'mailUnavailable', MAIL_UNAVAILABLE: 'mailUnavailable', DUPLICATE_SITE_CODE: 'duplicateCode', DUPLICATE_DIARY: 'duplicateDiary', SEPARATE_PEOPLE_REQUIRED: 'separatePeople', INVALID_TRANSITION: 'actionDenied', VERIFIER_REQUIRED: 'verifierRequired', NOTE_REQUIRED: 'noteRequired', REASON_REQUIRED: 'reasonRequired' };
function errorMessage(error) { return t(({ 401: error.code === 'INVALID_CREDENTIALS' ? 'invalidCredentials' : 'authRequired', 403: 'forbidden', 429: 'rateLimited' })[error.status] || errorKeys[error.code] || (error.message in messages[language] ? error.message : 'apiError')); }
function clearSession() {
  wbsCache.clear(); wbsLoad = null;
  session = null; actor = ''; siteId = undefined; loadError = null;
  state = { sites: [], tasks: [], diary: [] };
  filters = { search: '', status: '', person: '', priority: '' };
  closeModal();
  if (!loading) render();
}
async function logout() {
  try { await api.logout(); clearSession(); }
  catch (error) { toast(errorMessage(error)); }
}
async function loadData() {
  wbsCache.clear(); wbsLoad = null;
  loading = true; loadError = null; render();
  try {
    session = await api.me(); actor = session.user.name;
    const [sites, tasks, diary] = await Promise.all([api.listSites(), api.listTasks(), api.listDiary()]);
    state = { sites, tasks, diary };
    if (!sites.some(site => site.id === siteId)) siteId = sites[0]?.id;
  } catch (error) { loadError = error; }
  loading = false; render();
}
function rememberTask(task) { state.tasks = state.tasks.map(item => item.id === task.id ? task : item); }
function heading(title, subtitle, actions = '') {
  return `<div class="page-heading"><div><div class="eyebrow">${esc(currentSite()?.code || '')} · ${esc(currentSite()?.name || '')}</div><h1>${t(title)}</h1><p>${t(subtitle)}</p></div><div class="heading-actions">${actions}</div></div>`;
}
function empty(title, subtitle, action = '') { return `<div class="empty"><strong>${t(title)}</strong>${t(subtitle)}${action ? `<div style="margin-top:16px">${action}</div>` : ''}</div>`; }
function renderChrome() {
  document.documentElement.lang = language;
  document.title = `SiteAssistant · ${t(view)}`;
  $('#brand-sub').textContent = t('brandSub'); $('#workspace-label').textContent = t('workspace');
  $('#local-label').innerHTML = `${t('local')}<small>${t('fiction')}</small>`;
  $('#navigation').setAttribute('aria-label', t('nav'));
  $('#navigation').innerHTML = ['overview', 'sites', 'tasks', 'wbs', 'diary'].map(key => `<a href="#${key}" ${view === key ? 'class="active" aria-current="page"' : ''}>${icon(key)}${t(key)}</a>`).join('');
  $('#skip').textContent = t('skip'); $('#site-label').textContent = t('site'); $('#actor-label').textContent = t('actor');
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
  return `<div class="task-row"><div><h3><button data-command="detail" data-id="${esc(task.id)}">${esc(task.title)}</button></h3><p>${esc(task.area || t('noArea'))} · ${esc(task.company)}</p>${badge(task.status)} ${priorityBadge(task.priority)}</div><div class="subtitle">${dueMarkup(task)}</div></div>`;
}
function renderOverview() {
  const tasks = siteTasks(), count = counts(tasks), total = tasks.length;
  const attention = tasks.filter(task => task.status !== 'closed').sort((a, b) => {
    const score = task => (task.status === 'blocked' ? 10 : task.status === 'to_verify' ? 6 : 0) + (task.due && task.due < today() ? 12 : 0) + PRIORITIES.indexOf(task.priority);
    return score(b) - score(a) || (a.due || '9999').localeCompare(b.due || '9999');
  }).slice(0, 5);
  const lastEntry = state.diary.filter(item => item.siteId === siteId && item.date === today()).at(-1);
  $('#main').innerHTML = heading('overviewTitle', 'overviewSub', button('newTask', 'new-task', '', 'primary')) +
    `<div class="date-caption">${t('today')} · ${new Intl.DateTimeFormat(language === 'it' ? 'it-IT' : 'en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date())}</div>` +
    `<div class="metrics">${['execution', 'review', 'closed', 'overdue'].map(key => `<div class="metric ${key === 'overdue' ? 'alert' : key === 'closed' ? 'complete' : key}"><div class="metric-top">${t(key)}${icon(key)}</div><strong data-metric="${key}">${count[key]}</strong><small>${t(`${key}Hint`)}</small></div>`).join('')}</div>` +
    `<div class="grid-overview"><section class="panel"><div class="panel-header"><h2>${t('priorityWork')}</h2><a class="subtitle" href="#tasks">${t('seeAll')} →</a></div>${attention.length ? attention.map(taskRow).join('') : empty('noTasks', 'noTasksHint')}</section><div class="summary-stack"><section class="panel"><div class="panel-header"><h2>${t('dailyPulse')}</h2></div><div class="panel-body"><div class="progress-label"><span>${t('verifiedProgress')}</span><strong>${count.closed} / ${total}</strong></div><div class="progress-track"><span style="width:${total ? count.closed / total * 100 : 0}%"></span></div><p class="note">${total - count.closed} ${t('nonClosed')}</p><div class="summary-stack"><div class="summary-line"><strong>${count.blocked} ${t('blockedPlural')}</strong><p>${count.review} ${t('reviewPlural')}</p></div><div class="summary-line"><strong>${t('workingRule')}</strong><p>${t('workingRuleNote')}</p></div></div></div></section><section class="panel"><div class="panel-header"><h2>${t('journalToday')}</h2><span class="badge">${t('draft')}</span></div><div class="panel-body"><p class="subtitle prewrap">${lastEntry ? esc(lastEntry.actual) : t('noDiary')}</p><a class="subtitle" href="#diary">${t('openDiary')} →</a></div></section></div></div>`;
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
  return `<button type="button" class="task-card" data-command="detail" data-id="${esc(task.id)}"><span class="card-code">${esc(task.area || t('noArea'))}</span><h2>${esc(task.title)}</h2>${priorityBadge(task.priority)}<p>${esc(task.company)}</p><p>${personName(task.assignee)}</p><div class="card-footer">${dueMarkup(task)}<span>→</span></div></button>`;
}
function renderTaskResults() {
  const tasks = filteredTasks();
  let html = `<p class="note" role="status">${tasks.length} ${t('resultCount')} · ${siteTasks().length - counts(siteTasks()).closed} ${t('nonClosed')}</p>`;
  if (!tasks.length) html += `<section class="panel">${empty('noResults', 'noResultsHint', button('clearFilters', 'clear-filters'))}</section>`;
  else if (taskView === 'board') html += `<div class="board">${STATUSES.map(status => {
    const column = tasks.filter(task => task.status === status);
    return `<section class="board-column" aria-label="${t(status)}"><div class="column-heading"><span>${t(status)}</span><span>${column.length}</span></div>${column.length ? column.map(taskCard).join('') : `<div class="mini-empty">${t('emptyColumn')}</div>`}</section>`;
  }).join('')}</div>`;
  else html += `<div class="table-scroll"><table><thead><tr>${['title', 'area', 'status', 'company', 'assignee', 'reviewer', 'due'].map(key => `<th scope="col">${t(key)}</th>`).join('')}</tr></thead><tbody>${tasks.map(task => `<tr><td><button data-command="detail" data-id="${esc(task.id)}">${esc(task.title)}</button></td><td>${esc(task.area || '—')}</td><td>${badge(task.status)}</td><td>${esc(task.company)}</td><td>${personName(task.assignee)}</td><td>${personName(task.reviewer)}</td><td>${dueMarkup(task)}</td></tr>`).join('')}</tbody></table></div>`;
  $('#task-results').innerHTML = html;
}
function renderDiary() {
  const entries = state.diary.filter(item => item.siteId === siteId && item.date === reportDate);
  $('#main').innerHTML = heading('diaryTitle', 'diarySub', button('print', 'print') + button('newEntry', 'new-entry', '', 'primary')) +
    `<div class="diary-toolbar"><label for="report-date">${t('reportDate')}</label><input id="report-date" type="date" min="0001-01-01" max="9999-12-31" value="${reportDate}"><span class="badge">${t('draft')}</span><span class="subtitle">${entries.length} ${t('entries')}</span></div><div class="diary-grid"><section class="panel">${entries.length ? entries.map(entry => {
      return `<article class="diary-entry"><div class="entry-heading"><strong>${t(entry.shift)}</strong><span>${t('recordedAt')} ${timeLabel(entry.createdAt)}</span></div><div class="entry-grid">${['plan', 'actual', 'blockers', 'next'].map(key => `<section class="entry-section ${key === 'blockers' && entry[key] ? 'entry-blocker' : ''}"><h3>${t(key)}</h3><p>${esc(entry[key] || '—')}</p></section>`).join('')}</div></article>`;
    }).join('') : empty('diaryEmpty', 'diaryEmptyHint', button('newEntry', 'new-entry', '', 'primary'))}</section><aside class="panel diary-aside"><div class="panel-body"><h3>${t('dayRule')}</h3><p>${t('dayRuleNote')}</p><div class="blank-message">${t('diaryLimit')}</div></div></aside></div><p class="note">${t('forDate')} ${dateLabel(reportDate)} · ${t('draft')} · ${t('diaryLimit')}</p>`;
}
async function loadWbs() {
  const selected = siteId, token = {};
  wbsLoad = token;
  try {
    const nodes = await api.listWbs(selected);
    if (wbsLoad === token) wbsCache.set(selected, { nodes });
  } catch (error) {
    if (wbsLoad === token) wbsCache.set(selected, { error });
  } finally {
    if (wbsLoad === token) {
      wbsLoad = null;
      if (view === 'wbs' && siteId === selected) render();
    }
  }
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
  ({ overview: renderOverview, sites: renderSites, tasks: renderTasks, diary: renderDiary, wbs: renderWbs })[view]();
}
function go(next) { if (location.hash !== `#${next}`) location.hash = next; else { view = next; render(); } }
function selectSite(id) {
  if (!state.sites.some(site => site.id === id)) return;
  wbsLoad = null;
  siteId = id; filters = { search: '', status: '', person: '', priority: '' }; render();
}
function showModal(title, content) {
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
    const task = await api.getTask(taskId);
    if (version !== modalVersion || !$('#modal').open) return;
    rememberTask(task); render();
    const actions = allowedTransitions(task);
    showModal(task.title, `<p>${badge(task.status)} ${priorityBadge(task.priority)}</p><dl class="detail-grid">${['area', 'company', 'assignee', 'reviewer', 'due', 'priority'].map(key => `<div><dt>${t(key)}</dt><dd>${['assignee', 'reviewer'].includes(key) ? personName(task[key]) : key === 'due' ? dateLabel(task[key]) : key === 'priority' ? esc(t(task[key])) : esc(task[key] || '—')}</dd></div>`).join('')}</dl><div class="detail-actions">${actions.map(to => `<button type="button" data-command="transition" data-id="${esc(task.id)}" data-to="${to}">${t('transitionTo')} ${t(to)}</button>`).join('')}</div>${actions.length ? '' : `<p class="note">${t('noTransitions')}</p>`}<section class="timeline"><h3>${t('history')}</h3>${[...(task.events || [])].reverse().map(event => `<div class="event"><strong>${event.from_status ? `${esc(t(event.from_status))} → ` : ''}${esc(t(event.to_status))}</strong><div class="event-meta">${personName(event.actor)} · ${timeLabel(event.at)}</div>${event.note ? `<p>${t('note')}: ${esc(event.note)}</p>` : ''}${event.reason ? `<p>${t('reason')}: ${esc(event.reason)}</p>` : ''}</div>`).join('')}</section>`);
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
  showModal(t('newEntry'), `<form id="entry-form"><div class="form-error" role="alert" tabindex="-1" hidden></div><p class="note">${t('forDate')} ${dateLabel(reportDate)}</p><p class="note">${t('dayRuleNote')}</p><div class="form-grid">${field('shift', 'shift', '', { required: true, options: `<option value="day">${t('day')}</option><option value="night">${t('night')}</option>` })}${field('plan', 'plan', '', { type: 'textarea', full: true })}${field('actual', 'actual', '', { type: 'textarea', full: true })}${field('blockers', 'blockers', '', { type: 'textarea', full: true })}${field('next', 'next', '', { type: 'textarea', full: true })}</div>${formActions()}</form>`);
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
  };
  commands[command]?.();
});
document.addEventListener('submit', async event => {
  const form = event.target;
  if (!['site-form', 'task-form', 'entry-form', 'transition-form', 'login-form', 'password-form', 'request-form', 'forgot-form'].includes(form.id)) return;
  event.preventDefault();
  if (form.dataset.saving) return;
  const data = Object.fromEntries(new FormData(form));
  form.dataset.saving = 'true';
  const submit = form.querySelector('[type=submit]'); submit.disabled = true;
  const version = modalVersion;
  // Capture the selected context before waiting for the server.
  const selectedSite = siteId, selectedDate = reportDate;
  try {
    if (form.id === 'login-form') { await api.login(data); await loadData(); return; }
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
    if (form.id === 'task-form') { state.tasks.push(await api.createTask({ ...data, siteId: selectedSite })); message = 'taskCreated'; }
    if (form.id === 'entry-form') { state.diary.push(await api.createDiary({ ...data, siteId: selectedSite, date: selectedDate })); message = 'entrySaved'; }
    if (form.id === 'transition-form') {
      const task = state.tasks.find(item => item.id === form.dataset.taskId);
      detail = await api.transitionTask(task, { ...data, to: form.dataset.to });
      rememberTask(detail); actor = data.actor.trim(); message = 'actionSaved';
    }
    const sameModal = version === modalVersion;
    if (sameModal) closeModal();
    render();
    if (sameModal && detail && siteId === detail.siteId) showDetail(detail.id);
    toast(t(message));
  } catch (error) {
    if (version === modalVersion) formError(form, error);
    else toast(errorMessage(error));
  } finally { delete form.dataset.saving; submit.disabled = false; }
});
$('#modal').addEventListener('cancel', () => { modalVersion++; });
$('#site-select').addEventListener('change', event => selectSite(event.target.value));
document.addEventListener('change', event => {
  if (event.target.id === 'report-date') { if (validDate(event.target.value)) { reportDate = event.target.value; renderDiary(); } else event.target.value = reportDate; }
  for (const [id, key] of [['filter-status', 'status'], ['filter-person', 'person'], ['filter-priority', 'priority']]) if (event.target.id === id) { filters[key] = event.target.value; renderTaskResults(); }
});
document.addEventListener('input', event => { if (event.target.id === 'filter-search') { filters.search = event.target.value; renderTaskResults(); } });
$('#language').addEventListener('click', () => { if ($('#modal').open) return toast(t('saveDraftFirst')); language = language === 'it' ? 'en' : 'it'; render(); });
window.addEventListener('hashchange', () => { const next = location.hash.slice(1); view = ['overview', 'sites', 'tasks', 'wbs', 'diary'].includes(next) ? next : 'overview'; closeModal(); render(); $('#main').focus(); });
void loadData();
