const labels = {
  it: {
    people: 'Persone', companies: 'Imprese', teams: 'Squadre', affiliations: 'Affiliazioni',
    'company-roles': 'Ruoli delle imprese', 'team-memberships': 'Membri delle squadre',
    'authority-roles': 'Ruoli operativi', 'account-links': 'Account collegati',
    search: 'Cerca per nome', submitSearch: 'Cerca', archived: 'Archiviato', includeArchived: 'Includi archiviati',
    name: 'Nome', reason: 'Motivo', create: 'Aggiungi', save: 'Salva', archive: 'Archivia',
    history: 'Ultime 20 modifiche', references: 'Riferimenti attivi o pianificati',
    noResults: 'Nessun risultato in questa pagina.', previous: 'Indietro', next: 'Avanti',
    offline: 'Per aprire l’anagrafica serve una connessione.',
    changed: 'La scheda è cambiata. Riaprila prima di salvare.',
    blocked: 'Prima dell’archiviazione occorre chiudere o riassegnare i riferimenti.',
    actions: { create: 'Creazione', update: 'Modifica', archive: 'Archiviazione' },
  },
  en: {
    people: 'People', companies: 'Companies', teams: 'Crews', affiliations: 'Affiliations',
    'company-roles': 'Company roles', 'team-memberships': 'Crew memberships',
    'authority-roles': 'Operational roles', 'account-links': 'Linked accounts',
    search: 'Search by name', submitSearch: 'Search', archived: 'Archived', includeArchived: 'Include archived records',
    name: 'Name', reason: 'Reason', create: 'Add', save: 'Save', archive: 'Archive',
    history: 'Latest 20 changes', references: 'Current or scheduled references',
    noResults: 'No results on this page.', previous: 'Previous', next: 'Next',
    offline: 'Connect to the internet to open the registry.',
    changed: 'The record changed. Open it again before saving.',
    blocked: 'Close or reassign the references before archiving.',
    actions: { create: 'Created', update: 'Updated', archive: 'Archived' },
  },
};
const esc = value => String(value ?? '').replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const pageSize = 25;

export function mountRegistry(root, { api, siteId, role, language, offline, t, errorMessage }) {
  const copy = labels[language] ?? labels.en;
  const writable = ['owner', 'editor'].includes(role);
  const collections = ['people', 'companies', 'teams'];
  root.innerHTML = `<section class="panel panel-body"><h1>${esc(t('registry'))}</h1>${
    offline ? `<p role="status">${copy.offline}</p>` :
    `<form data-search class="form-grid">
      <label class="field"><span>${esc(t('registry'))}</span><select name="collection">${collections.map(key =>
        `<option value="${key}">${copy[key]}</option>`).join('')}</select></label>
      <label class="field"><span>${copy.search}</span><input type="search" maxlength="200" name="q"></label>
      <label><input type="checkbox" name="includeArchived"> ${copy.includeArchived}</label>
      <div><button>${copy.submitSearch}</button></div>
    </form>
    <p data-error role="alert" hidden></p>
    <div data-records></div>
    ${writable ? `<form data-create class="form-grid">
      <label class="field"><span>${copy.name}</span><input name="name" required maxlength="200"></label>
      <label class="field"><span>${copy.reason}</span><input name="reason" required maxlength="2000"></label>
      <div><button class="primary">${copy.create}</button></div>
    </form>` : ''}
    <div data-detail></div>`}</section>`;
  if (offline) return;
  const section = root.firstElementChild;
  const search = section.querySelector('[data-search]');
  const records = section.querySelector('[data-records]');
  const detail = section.querySelector('[data-detail]');
  const error = section.querySelector('[data-error]');
  let collection = 'people', offset = 0, query = '', includeArchived = false, listVersion = 0, detailVersion = 0;

  function showError(value) {
    error.hidden = !value;
    error.textContent = value
      ? ({ REGISTRY_REVISION_CONFLICT: copy.changed, REGISTRY_ACTIVE_REFERENCES: copy.blocked }[value.code] ?? errorMessage(value))
      : '';
  }

  async function load() {
    const version = ++listVersion;
    records.innerHTML = `<p role="status">${esc(t('loading'))}</p>`;
    try {
      const rows = await api.listRegistry(siteId, collection, { q: query, includeArchived: includeArchived ? 1 : null, offset, limit: pageSize });
      if (version !== listVersion || !section.isConnected) return;
      records.innerHTML = rows.length
        ? `<ul>${rows.map(row => `<li><button type="button" class="text-button" data-open="${esc(row.id)}">${esc(row.name)}</button>${
          row.archived_at ? ` <small>${copy.archived}</small>` : ''}</li>`).join('')}</ul>`
        : `<p class="empty">${copy.noResults}</p>`;
      if (offset || rows.length === pageSize) {
        records.insertAdjacentHTML('beforeend', `${offset ? `<button type="button" data-page="-1">${copy.previous}</button> ` : ''}
          ${rows.length === pageSize ? `<button type="button" data-page="1">${copy.next}</button>` : ''}`);
      }
    } catch (value) {
      if (version === listVersion && section.isConnected) {
        records.replaceChildren();
        showError(value);
      }
    }
  }

  async function open(id) {
    const version = ++detailVersion, kind = collection;
    detail.innerHTML = `<p role="status">${esc(t('loading'))}</p>`;
    try {
      const [row, events] = await Promise.all([api.getRegistry(siteId, kind, id),
        api.registryHistory(siteId, kind, id, { limit: 20 })]);
      if (version !== detailVersion || !section.isConnected) return;
      detail.innerHTML = `<section><h2>${esc(row.name)}</h2>${row.archived_at ? `<p>${copy.archived}</p>` : ''}
        ${row.dependencies.length ? `<h3>${copy.references}</h3>
          <ul>${row.dependencies.map(dep => `<li>${copy[dep.collection]} · ${dep.ids.length}</li>`).join('')}</ul>` : ''}
        ${writable && !row.archived_at && !row.canArchive && !row.dependencies.length ? `<p>${copy.blocked}</p>` : ''}
        ${writable && !row.archived_at ? `<form class="form-grid">
          <label class="field"><span>${copy.name}</span><input name="name" value="${esc(row.name)}" required maxlength="200"></label>
          <label class="field"><span>${copy.reason}</span><input name="reason" required maxlength="2000"></label>
          <div><button class="primary" value="update">${copy.save}</button>
          ${row.canArchive ? `<button value="archive">${copy.archive}</button>` : ''}</div>
        </form>` : ''}
        <h3>${copy.history}</h3><ul>${events.map(event =>
          `<li><time datetime="${esc(event.recorded_at)}">${esc(event.recorded_at)}</time> · ${copy.actions[event.action]} · ${esc(event.reason)}
          ${event.before?.name && event.before.name !== event.after.name
            ? `<div>${esc(event.before.name)} → ${esc(event.after.name)}</div>` : ''}</li>`).join('')}</ul></section>`;
      detail.querySelector('form')?.addEventListener('submit', event => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const input = { reason: data.get('reason'), revision: row.revision };
        const action = event.submitter?.value === 'archive' ? 'archive' : null;
        if (!action) input.name = data.get('name');
        void save(event.currentTarget, input, { id, action });
      });
    } catch (value) {
      if (version === detailVersion && section.isConnected) {
        detail.replaceChildren();
        showError(value);
      }
    }
  }

  async function save(form, input, options) {
    showError();
    const kind = collection;
    const controls = [...form.elements];
    const signature = JSON.stringify([kind, input, options]);
    // Reuse the key when retrying the same submission after a lost response.
    if (form.submission !== signature) {
      form.submission = signature;
      form.requestKey = crypto.randomUUID();
    }
    controls.forEach(control => { control.disabled = true; });
    try {
      const result = await api.saveRegistry(siteId, kind, input, { ...options, idempotencyKey: form.requestKey });
      form.submission = null;
      if (kind !== collection || !form.isConnected) return;
      if (!options.id) form.reset();
      await Promise.all([load(), open(result.id)]);
    } catch (value) {
      if (kind === collection && form.isConnected) showError(value);
    } finally {
      controls.forEach(control => { control.disabled = false; });
    }
  }

  function runSearch() {
    const data = new FormData(search);
    collection = data.get('collection');
    query = data.get('q').trim();
    includeArchived = data.has('includeArchived');
    offset = 0;
    detailVersion++;
    detail.replaceChildren();
    section.querySelector('[data-create]')?.reset();
    showError();
    void load();
  }
  search.addEventListener('submit', event => { event.preventDefault(); runSearch(); });
  search.elements.collection.addEventListener('change', runSearch);
  records.addEventListener('click', event => {
    const { open: id, page } = event.target.dataset;
    if (id) { showError(); void open(id); }
    if (page) { offset += Number(page) * pageSize; showError(); void load(); }
  });
  section.querySelector('[data-create]')?.addEventListener('submit', event => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void save(event.currentTarget, { name: data.get('name'), reason: data.get('reason') }, {});
  });
  void load();
}
