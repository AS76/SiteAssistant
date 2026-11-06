import { USERS, STATUSES, PRIORITIES, today, validDate, seedState, validateState, createSite, createTask, updateTask, transition, allowedActions, addDiaryEntry, counts, csvCell } from './domain.mjs';
import { messages } from './i18n.mjs';

const DATA_KEY = 'siteassistant.data.v1';
const PREF_KEY = 'siteassistant.preferences.v1';
const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
let state, language = 'it', siteId, actor = 'lead', storageIssue = '', toastTimer, lastData;
let view = ['overview', 'sites', 'tasks', 'diary'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'overview';
let filters = { search: '', status: '', person: '', priority: '' };
let taskView = 'board';
let reportDate = today();
try {
  lastData = localStorage.getItem(DATA_KEY);
  state = lastData ? validateState(JSON.parse(lastData)) : seedState();
  if (!lastData) { lastData = JSON.stringify(state); localStorage.setItem(DATA_KEY, lastData); }
} catch { state = seedState(); storageIssue = 'loadError'; }
try {
  const prefs = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
  language = prefs.language === 'en' ? 'en' : 'it';
  siteId = state.sites.some(site => site.id === prefs.siteId) ? prefs.siteId : state.sites[0].id;
} catch { siteId = state.sites[0].id; }
const t = key => messages[language][key] ?? key;
const personName = id => t(id === 'reviewer' ? 'reviewerPerson' : id);
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
const priorityBadge = priority => priority !== 'normal' ? `<span class="badge ${priority}">${t(priority)}</span>` : '';
const button = (key, command, extra = '', css = '') => `<button type="button" class="${css}" data-command="${command}" ${extra}>${t(key)}</button>`;
function preference() { try { localStorage.setItem(PREF_KEY, JSON.stringify({ language, siteId })); } catch {} }
function toast(message) {
  clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 5000);
}
function commit(next) {
  const clean = validateState(next);
  try {
    const current = localStorage.getItem(DATA_KEY);
    if (current !== lastData && storageIssue !== 'loadError') throw new Error('tabConflict');
    const encoded = JSON.stringify(clean);
    localStorage.setItem(DATA_KEY, encoded); lastData = encoded;
  } catch (error) { throw new Error(error.message === 'tabConflict' ? 'tabConflict' : 'localError'); }
  state = clean; storageIssue = ''; $('#storage-banner').hidden = true;
}
function notifyError(error) { toast(t(error.message in messages[language] ? error.message : 'invalidData')); }
function heading(title, subtitle, actions = '') {
  return `<div class="page-heading"><div><div class="eyebrow">${esc(currentSite().code)} · ${esc(currentSite().name)}</div><h1>${t(title)}</h1><p>${t(subtitle)}</p></div><div class="heading-actions">${actions}</div></div>`;
}
function empty(title, subtitle, action = '') { return `<div class="empty"><strong>${t(title)}</strong>${t(subtitle)}${action ? `<div style="margin-top:16px">${action}</div>` : ''}</div>`; }
function renderChrome() {
  document.documentElement.lang = language;
  document.title = `SiteAssistant · ${t(view)}`;
  $('#brand-sub').textContent = t('brandSub'); $('#workspace-label').textContent = t('workspace');
  $('#local-label').innerHTML = `${t('local')}<small>${t('fiction')}</small>`;
  $('#navigation').setAttribute('aria-label', t('nav'));
  $('#navigation').innerHTML = ['overview', 'sites', 'tasks', 'diary'].map(key => `<a href="#${key}" ${view === key ? 'class="active" aria-current="page"' : ''}>${icon(key)}${t(key)}</a>`).join('');
  $('#skip').textContent = t('skip'); $('#site-label').textContent = t('site'); $('#actor-label').textContent = t('actor');
  $('#site-select').innerHTML = state.sites.map(site => `<option value="${esc(site.id)}" ${site.id === siteId ? 'selected' : ''}>${esc(site.name)}</option>`).join('');
  $('#actor-select').innerHTML = personOptions(actor);
  $('#language').textContent = language === 'it' ? 'EN' : 'IT';
  $('#language').setAttribute('aria-label', language === 'it' ? 'Switch to English' : 'Passa all’italiano');
  $('#demo-banner').innerHTML = `<strong>${t('demo')}</strong> &nbsp; ${t('demoNote')}`;
  $('#footer-note').textContent = t('footer');
  for (const key of ['backup', 'restore', 'reset']) $(`#${key}`).textContent = t(key);
  $('#storage-banner').hidden = !storageIssue; $('#storage-banner').textContent = storageIssue ? t(storageIssue) : '';
}
function personOptions(value) { return USERS.map(user => `<option value="${user.id}" ${user.id === value ? 'selected' : ''}>${personName(user.id)}</option>`).join(''); }
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
  const report = state.reports.find(item => item.siteId === siteId && item.date === today());
  const lastEntry = report?.entries.at(-1);
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
    `<div class="toolbar"><input class="search" id="filter-search" aria-label="${t('search')}" placeholder="${t('search')}" value="${esc(filters.search)}"><select id="filter-status" aria-label="${t('status')}"><option value="">${t('allStatuses')}</option>${STATUSES.map(status => `<option value="${status}" ${filters.status === status ? 'selected' : ''}>${t(status)}</option>`).join('')}</select><select id="filter-person" aria-label="${t('assignee')}"><option value="">${t('allPeople')}</option>${USERS.map(user => `<option value="${user.id}" ${filters.person === user.id ? 'selected' : ''}>${personName(user.id)}</option>`).join('')}</select><select id="filter-priority" aria-label="${t('priority')}"><option value="">${t('allPriorities')}</option>${PRIORITIES.map(priority => `<option value="${priority}" ${filters.priority === priority ? 'selected' : ''}>${t(priority)}</option>`).join('')}</select><div class="view-toggle">${button('board', 'task-view', `data-value="board" aria-pressed="${taskView === 'board'}"`, taskView === 'board' ? 'selected' : '')}${button('list', 'task-view', `data-value="list" aria-pressed="${taskView === 'list'}"`, taskView === 'list' ? 'selected' : '')}</div></div><div id="task-results"></div>`;
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
  const report = state.reports.find(item => item.siteId === siteId && item.date === reportDate);
  $('#main').innerHTML = heading('diaryTitle', 'diarySub', button('print', 'print') + button('newEntry', 'new-entry', '', 'primary')) +
    `<div class="diary-toolbar"><label for="report-date">${t('reportDate')}</label><input id="report-date" type="date" min="0001-01-01" max="9999-12-31" value="${reportDate}"><span class="badge">${t('draft')}</span><span class="subtitle">${report?.entries.length || 0} ${t('entries')}</span></div><div class="diary-grid"><section class="panel">${report ? report.entries.map(entry => {
      const linked = state.tasks.find(task => task.id === entry.taskId);
      return `<article class="diary-entry"><div class="entry-heading"><strong>${t(entry.shift)} · ${personName(entry.author)}</strong><span>${t('recordedAt')} ${timeLabel(entry.createdAt)}</span></div>${linked ? `<p class="note">${t('linkedTask')}: ${esc(linked.title)}</p>` : ''}<div class="entry-grid">${['plan', 'actual', 'blockers', 'next'].map(key => `<section class="entry-section ${key === 'blockers' && entry[key] ? 'entry-blocker' : ''}"><h3>${t(key)}</h3><p>${esc(entry[key] || '—')}</p></section>`).join('')}</div></article>`;
    }).join('') : empty('diaryEmpty', 'diaryEmptyHint', button('newEntry', 'new-entry', '', 'primary'))}</section><aside class="panel diary-aside"><div class="panel-body"><h3>${t('dayRule')}</h3><p>${t('dayRuleNote')}</p><div class="blank-message">${t('diaryLimit')}</div></div></aside></div><p class="note">${t('forDate')} ${dateLabel(reportDate)} · ${t('draft')} · ${t('diaryLimit')}</p>`;
}
function render() {
  renderChrome(); ({ overview: renderOverview, sites: renderSites, tasks: renderTasks, diary: renderDiary })[view]();
}
function go(next) { if (location.hash !== `#${next}`) location.hash = next; else { view = next; render(); } }
function selectSite(id) {
  if (!state.sites.some(site => site.id === id)) return;
  siteId = id; filters = { search: '', status: '', person: '', priority: '' }; preference(); render();
}
function showModal(title, content) {
  $('#modal-content').innerHTML = `<div class="modal-header"><h2 id="modal-title">${esc(title)}</h2><button class="close" type="button" data-command="close-modal" aria-label="${t('close')}">×</button></div><div class="modal-body">${content}</div>`;
  if (!$('#modal').open) $('#modal').showModal();
  $('#modal').scrollTop = 0;
  const first = $('#modal-content input:not([type=hidden]), #modal-content textarea, #modal-content select');
  if (first) first.focus();
}
function closeModal() { $('#modal').close(); }
function field(label, name, value = '', { type = 'text', required = false, full = false, max = 4000, hint = '', options = null } = {}) {
  const attrs = `name="${name}" id="field-${name}" ${required ? 'required' : ''}`;
  const control = options !== null ? `<select ${attrs}>${options}</select>` : type === 'textarea' ? `<textarea ${attrs} maxlength="${max}">${esc(value)}</textarea>` : `<input ${attrs} type="${type}" value="${esc(value)}" ${type === 'date' ? 'min="0001-01-01" max="9999-12-31"' : `maxlength="${max}"`}>`;
  return `<label class="field ${full ? 'full' : ''}" for="field-${name}"><span>${t(label)} ${required ? '*' : `<small>(${t('optional')})</small>`}</span>${control}${hint ? `<small>${t(hint)}</small>` : ''}</label>`;
}
const formActions = () => `<div class="form-actions">${button('cancel', 'close-modal')}<button type="submit" class="primary">${t('save')}</button></div>`;
function formError(form, error) {
  const target = form.querySelector('.form-error');
  target.textContent = t(error.message in messages[language] ? error.message : 'invalidData'); target.hidden = false; target.focus();
}
function showSiteForm() {
  showModal(t('newSite'), `<form id="site-form"><div class="form-error" role="alert" tabindex="-1" hidden></div><div class="form-grid">${field('code', 'code', '', { required: true, max: 30, hint: 'codeHint' })}${field('name', 'name', '', { required: true, max: 120 })}${field('location', 'location', '', { full: true, max: 160 })}${field('startDate', 'start', today(), { type: 'date' })}${field('endDate', 'end', '', { type: 'date' })}</div>${formActions()}</form>`);
}
function showTaskForm(taskId = '') {
  const task = state.tasks.find(item => item.id === taskId);
  const input = task || { title: '', description: '', area: '', company: '', assignee: 'worker', reviewer: 'reviewer', priority: 'normal', due: today(), criteria: '' };
  showModal(t(task ? 'editTask' : 'newTask'), `<form id="task-form" data-task-id="${esc(taskId)}"><div class="form-error" role="alert" tabindex="-1" hidden></div><div class="form-grid">${field('title', 'title', input.title, { full: true, required: true, max: 180 })}${field('description', 'description', input.description, { full: true, type: 'textarea' })}${field('area', 'area', input.area, { max: 100 })}${field('company', 'company', input.company, { max: 100, required: true })}${field('assignee', 'assignee', '', { options: personOptions(input.assignee), required: true })}${field('reviewer', 'reviewer', '', { options: personOptions(input.reviewer), required: true })}${field('priority', 'priority', '', { options: PRIORITIES.map(priority => `<option value="${priority}" ${input.priority === priority ? 'selected' : ''}>${t(priority)}</option>`).join(''), required: true })}${field('due', 'due', input.due, { type: 'date' })}${field('criteria', 'criteria', input.criteria, { full: true, type: 'textarea', required: true, max: 2000, hint: 'criteriaHint' })}</div>${formActions()}</form>`);
}
function showDetail(taskId) {
  const task = state.tasks.find(item => item.id === taskId && item.siteId === siteId);
  if (!task) return;
  const actions = allowedActions(task, actor);
  showModal(task.title, `<p>${badge(task.status)} ${priorityBadge(task.priority)}</p><dl class="detail-grid">${['area', 'company', 'assignee', 'reviewer', 'due', 'priority'].map(key => `<div><dt>${t(key)}</dt><dd>${['assignee', 'reviewer'].includes(key) ? personName(task[key]) : key === 'due' ? dateLabel(task[key]) : key === 'priority' ? t(task[key]) : esc(task[key] || '—')}</dd></div>`).join('')}<div class="full"><dt>${t('description')}</dt><dd class="prewrap">${esc(task.description || '—')}</dd></div><div class="full"><dt>${t('criteria')}</dt><dd class="prewrap">${esc(task.criteria)}</dd></div></dl><label class="field">${t('actor')}<select id="detail-actor">${personOptions(actor)}</select><small>${t('actorHelp')}</small></label><div class="detail-actions">${actions.map(action => button(action, 'action', `data-id="${esc(task.id)}" data-action="${action}"`, ['submit', 'verify', 'start', 'resume'].includes(action) ? 'primary' : '')).join('')}${['todo', 'in_progress', 'blocked'].includes(task.status) && [task.assignee, 'lead'].includes(actor) ? button('editTask', 'edit-task', `data-id="${esc(task.id)}"`) : ''}</div>${actions.length ? '' : `<p class="note">${t('waitingActor')}</p>`}<section class="timeline"><h3>${t('history')}</h3>${[...task.history].reverse().map(event => `<div class="event"><strong>${t(event.action)}</strong><div class="event-meta">${personName(event.actor)} · ${timeLabel(event.at)}</div>${event.note ? `<p>${esc(event.note)}</p>` : ''}</div>`).join('')}</section>`);
  $('#modal-content').dataset.detailId = taskId;
}
function showAction(taskId, action) {
  if (['start', 'resume'].includes(action)) {
    try { commit(transition(state, taskId, action, actor)); render(); showDetail(taskId); toast(t('actionSaved')); } catch (error) { notifyError(error); }
    return;
  }
  showModal(t(action), `<form id="action-form" data-task-id="${esc(taskId)}" data-action="${action}"><div class="form-error" role="alert" tabindex="-1" hidden></div><p class="subtitle">${t(`${action}Hint`)}</p>${field('actionNote', 'note', '', { type: 'textarea', required: true, full: true })}<div class="form-actions">${button('cancel', 'detail', `data-id="${esc(taskId)}"`)}<button type="submit" class="primary">${t(action)}</button></div></form>`);
}
function showEntryForm() {
  showModal(t('newEntry'), `<form id="entry-form"><div class="form-error" role="alert" tabindex="-1" hidden></div><p class="note">${t('forDate')} ${dateLabel(reportDate)} · ${personName(actor)}</p><p class="note">${t('dayRuleNote')}</p><div class="form-grid">${field('shift', 'shift', '', { required: true, options: `<option value="day">${t('day')}</option><option value="night">${t('night')}</option>` })}${field('linkedTask', 'taskId', '', { options: `<option value="">${t('none')}</option>${siteTasks().map(task => `<option value="${esc(task.id)}">${esc(task.title)}</option>`).join('')}` })}${field('plan', 'plan', '', { type: 'textarea', required: true, full: true })}${field('actual', 'actual', '', { type: 'textarea', required: true, full: true })}${field('blockers', 'blockers', '', { type: 'textarea', full: true })}${field('next', 'next', '', { type: 'textarea', full: true })}</div>${formActions()}</form>`);
}
function download(content, type, name) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function exportCsv() {
  const tasks = filteredTasks();
  if (!tasks.length) return toast(t('emptyExport'));
  const header = ['title', 'area', 'company', 'assignee', 'reviewer', 'priority', 'due', 'status', 'criteria'];
  const rows = [header.map(t), ...tasks.map(task => header.map(key => ['assignee', 'reviewer'].includes(key) ? personName(task[key]) : ['priority', 'status'].includes(key) ? t(task[key]) : task[key]))];
  download('\ufeff' + rows.map(row => row.map(csvCell).join(',')).join('\r\n'), 'text/csv;charset=utf-8', `siteassistant-tasks-${today()}.csv`); toast(t('csvDone'));
}
function confirmDialog(messageKey, command) {
  showModal(t('confirm'), `<p>${t(messageKey)}</p><div class="form-actions">${button('cancel', 'close-modal')}${button('confirm', command, '', 'primary')}</div>`);
}
let pendingRestore = null;
document.addEventListener('click', event => {
  const target = event.target.closest('[data-command]'); if (!target) return;
  const command = target.dataset.command, id = target.dataset.id;
  const commands = {
    'new-site': showSiteForm, 'new-task': () => showTaskForm(), 'edit-task': () => showTaskForm(id),
    'select-site': () => { selectSite(id); go('overview'); }, detail: () => showDetail(id),
    action: () => showAction(id, target.dataset.action), 'new-entry': showEntryForm,
    'close-modal': closeModal, 'task-view': () => { taskView = target.dataset.value; renderTasks(); },
    'clear-filters': () => { filters = { search: '', status: '', person: '', priority: '' }; renderTasks(); },
    csv: exportCsv, print: () => window.print(),
    'confirm-reset': () => { try { commit(seedState()); siteId = state.sites[0].id; preference(); closeModal(); render(); toast(t('resetDone')); } catch (error) { notifyError(error); } },
    'confirm-restore': () => { try { if (!pendingRestore) return; commit(pendingRestore); pendingRestore = null; siteId = state.sites[0].id; filters = { search: '', status: '', person: '', priority: '' }; preference(); closeModal(); render(); toast(t('restoreDone')); } catch (error) { notifyError(error); } },
  };
  commands[command]?.();
});
document.addEventListener('submit', event => {
  const form = event.target;
  if (!['site-form', 'task-form', 'entry-form', 'action-form'].includes(form.id)) return;
  event.preventDefault();
  const data = Object.fromEntries(new FormData(form));
  try {
    let message, detailId;
    if (form.id === 'site-form') { const result = createSite(state, data); commit(result.state); siteId = result.site.id; preference(); message = 'siteCreated'; }
    if (form.id === 'task-form') {
      const taskId = form.dataset.taskId;
      commit(taskId ? updateTask(state, taskId, data, actor) : createTask(state, { ...data, siteId }, actor));
      message = taskId ? 'taskUpdated' : 'taskCreated'; detailId = taskId;
    }
    if (form.id === 'entry-form') { commit(addDiaryEntry(state, siteId, reportDate, data, actor)); message = 'entrySaved'; }
    if (form.id === 'action-form') { detailId = form.dataset.taskId; commit(transition(state, detailId, form.dataset.action, actor, data.note)); message = 'actionSaved'; }
    closeModal(); render(); if (detailId) showDetail(detailId); toast(t(message));
  } catch (error) { formError(form, error); }
});
$('#site-select').addEventListener('change', event => selectSite(event.target.value));
$('#actor-select').addEventListener('change', event => { actor = event.target.value; });
document.addEventListener('change', event => {
  if (event.target.id === 'detail-actor') { actor = event.target.value; $('#actor-select').value = actor; showDetail($('#modal-content').dataset.detailId); }
  if (event.target.id === 'report-date') { if (validDate(event.target.value)) { reportDate = event.target.value; renderDiary(); } else event.target.value = reportDate; }
  for (const [id, key] of [['filter-status', 'status'], ['filter-person', 'person'], ['filter-priority', 'priority']]) if (event.target.id === id) { filters[key] = event.target.value; renderTaskResults(); }
});
document.addEventListener('input', event => { if (event.target.id === 'filter-search') { filters.search = event.target.value; renderTaskResults(); } });
$('#language').addEventListener('click', () => { if ($('#modal').open) return toast(t('saveDraftFirst')); language = language === 'it' ? 'en' : 'it'; preference(); render(); });
$('#backup').addEventListener('click', () => { download(JSON.stringify(state, null, 2), 'application/json', `siteassistant-backup-${today()}.json`); toast(t('backupDone')); });
$('#restore').addEventListener('click', () => { $('#restore-file').value = ''; $('#restore-file').click(); });
$('#restore-file').addEventListener('change', async event => {
  const file = event.target.files[0]; if (!file) return;
  pendingRestore = null;
  try { if (file.size > 5 * 1024 * 1024) throw new Error('fileTooLarge'); pendingRestore = validateState(JSON.parse(await file.text())); confirmDialog('confirmRestore', 'confirm-restore'); }
  catch (error) { notifyError(new Error(error.message in messages[language] ? error.message : 'invalidBackup')); }
});
$('#reset').addEventListener('click', () => confirmDialog('confirmReset', 'confirm-reset'));
window.addEventListener('hashchange', () => { const next = location.hash.slice(1); view = ['overview', 'sites', 'tasks', 'diary'].includes(next) ? next : 'overview'; closeModal(); render(); $('#main').focus(); });
window.addEventListener('storage', event => { if (event.key === DATA_KEY) { storageIssue = 'tabConflict'; $('#storage-banner').textContent = t('tabConflict'); $('#storage-banner').hidden = false; } });
render();
