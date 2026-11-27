import { mountPlaceSelector, placeBreadcrumb } from './place-selector.mjs';
import { messages } from './i18n.mjs';

export { placeBreadcrumb };

const kinds = ['building', 'floor', 'zone', 'room'];
const statusOf = place => place.archived_at ? 'archived' : 'active';

export function buildPlaceTree(places) {
  const nodes = new Map(places.map(place => [place.id, { ...place, children: [] }]));
  const roots = [];
  for (const node of nodes.values()) {
    const parent = nodes.get(node.parent_id);
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

export function filterPlaceTree(tree, { kind = '', status = 'all' } = {}) {
  return tree.flatMap(node => {
    const children = filterPlaceTree(node.children, { kind, status });
    const matches = (!kind || node.kind === kind) && (status === 'all' || statusOf(node) === status);
    return matches || children.length ? [{ ...node, children, matches }] : [];
  });
}

export function placeActions({ role, demoSandbox = false, offline = false, place } = {}) {
  const readable = ['owner', 'editor', 'verifier', 'viewer'].includes(role) || role === 'demo_user' && demoSandbox;
  const writable = !offline && (['owner', 'editor'].includes(role) || role === 'demo_user' && demoSandbox);
  const edit = Boolean(writable && place && !place.archived_at);
  return { history: readable, create: writable, rename: edit, move: edit, archive: edit, aliases: edit };
}

const esc = value => String(value ?? '').replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

const errorKeys = {
  PLACE_ALIAS_CONFLICT: 'placeAliasConflict',
  IDEMPOTENCY_KEY_REUSED: 'placeAliasRequestConflict',
  PLACE_CYCLE: 'placeCycle',
  PLACE_KIND_ORDER: 'placeKindOrder',
  PLACE_ARCHIVED: 'placeAlreadyArchived',
  PLACE_HAS_ACTIVE_CHILDREN: 'placeActiveChildrenError',
  PLACE_HAS_CURRENT_ASSETS: 'placeCurrentAssetsError',
  PLACE_NOT_FOUND: 'placeMissing',
  REFERENCE_NOT_FOUND: 'placeMissing',
  FORBIDDEN: 'placeForbidden',
  VALIDATION_ERROR: 'invalidData',
  NETWORK_ERROR: 'apiUnavailable',
};
const kindKey = kind => 'placeKind_' + kind;
const statusKey = status => status === 'archived' ? 'placeArchived' : 'placeActive';

export function mountPlacesView(root, { api, site, role, demoSandbox, offline, language = 'it' }) {
  const t = key => (messages[language] ?? messages.it)[key];
  const date = new Intl.DateTimeFormat(language, { dateStyle: 'short', timeStyle: 'medium' });
  const formatDate = instant => date.format(new Date(instant));
  const errorText = error => t(errorKeys[error?.code] ?? 'apiError');
  const button = (action, label, attrs = '') => `<button type="button" data-place-action="${action}" ${attrs}>${esc(label)}</button>`;
  const options = (values, label) => values.map(value => `<option value="${value}">${t(label(value))}</option>`).join('');
  const field = (key, name, value = '', { required = true, max = 200 } = {}) =>
    `<label class="field">${t(key)}<input name="${name}" value="${esc(value)}" maxlength="${max}" ${required ? 'required' : ''}></label>`;
  const showError = (target, error) => { target.hidden = false; target.textContent = errorText(error); };
  const actionsFor = place => placeActions({ role, demoSandbox, offline, place });
  const section = root.ownerDocument.createElement('section');
  section.className = 'places-view';
  root.replaceChildren(section);
  section.innerHTML = `<div class="page-heading"><div><div class="eyebrow">${esc(site?.name)}</div><h1>${t('places')}</h1></div></div>`;
  if (offline || !site) {
    section.insertAdjacentHTML('beforeend', `<p role="status">${t(offline ? 'placesOffline' : 'noSites')}</p>`);
    return;
  }

  section.insertAdjacentHTML('beforeend', `<div class="places-layout">
    <section class="places-panel" aria-label="${t('placeTree')}">
      <div class="places-bar">
        <label class="field">${t('placeType')}<select name="place-kind">
          <option value="">${t('placeAllKinds')}</option>${options(kinds, kindKey)}
        </select></label>
        <label class="field">${t('status')}<select name="place-status">
          <option value="active">${t('placeActive')}</option><option value="archived">${t('placeArchived')}</option>
          <option value="all">${t('allStatuses')}</option>
        </select></label>
        ${actionsFor().create ? button('create', t('placeCreate'), 'class="primary" disabled') : ''}
      </div>
      <div class="places-tree-body"></div>
    </section>
    <section class="places-panel places-detail" aria-label="${t('placeDetails')}"></section>
  </div>`);
  const treeBody = section.querySelector('.places-tree-body');
  const detail = section.querySelector('.places-detail');
  const kindFilter = section.querySelector('[name=place-kind]');
  const statusFilter = section.querySelector('[name=place-status]');
  const expanded = new Map();
  let places = [], selected, current, selectionRead = 0;
  let previewRead = 0, saving = false;

  function drawTree() {
    const filters = { kind: kindFilter.value, status: statusFilter.value };
    const filtered = filterPlaceTree(buildPlaceTree(places), filters);
    const revealMatches = Boolean(filters.kind) || filters.status === 'archived';
    const draw = nodes => `<ul class="places-tree">${nodes.map(node => {
      const id = esc(node.id);
      const open = expanded.get(node.id) ?? revealMatches;
      const toggle = node.children.length ? button('toggle', open ? '−' : '+',
        `data-id="${id}" aria-expanded="${open}" aria-label="${esc(t(open ? 'placeCollapse' : 'placeExpand') + ' ' + node.name)}" class="places-toggle"`) : '';
      return `<li><div class="places-node">${toggle}${button('detail',
        node.name, `data-id="${id}" class="places-node-name" ${selected === node.id ? 'aria-current="true"' : ''}`)}
        <span>${t(kindKey(node.kind))}${node.archived_at ? ' · ' + t('placeArchived') : ''}</span></div>
        ${node.children.length && open ? draw(node.children) : ''}</li>`;
    }).join('')}</ul>`;
    treeBody.innerHTML = filtered.length ? draw(filtered) : `<p>${t(places.length ? 'noResults' : 'placeEmpty')}</p>`;
  }

  async function loadTree() {
    treeBody.innerHTML = `<p role="status">${t('loading')}</p>`;
    const create = section.querySelector('[data-place-action=create]');
    if (create) create.disabled = true;
    try {
      places = await api.listPlaces(site.id, { includeArchived: true, includeAliases: true });
      if (create) create.disabled = false;
      drawTree();
    } catch (error) {
      treeBody.innerHTML = `<p role="alert">${esc(errorText(error))}</p>${button('retry-tree', t('retry'))}`;
    }
  }

  function eventText(event) {
    const changes = event.changes;
    if (changes.alias) {
      const alias = changes.alias.to ?? changes.alias.from;
      return [t(changes.alias.from ? 'placeAliasRemoved' : 'placeAliasAdded'), alias.namespace + ' · ' + alias.canonical_code];
    }
    const summary = [];
    if (changes.name?.from != null) summary.push(changes.name.from + ' → ' + changes.name.to);
    if (typeof changes.name === 'string') summary.push(changes.name);
    if (changes.parent_id?.from !== undefined) {
      const parentName = id => id ? places.find(place => place.id === id)?.name ?? id : site.name;
      summary.push(t('placeHistoryCurrentParents') + ' · ' + parentName(changes.parent_id.from) + ' → ' + parentName(changes.parent_id.to));
    }
    if (changes.note) summary.push(changes.note);
    return [t('placeEvent_' + event.action) ?? t('placeHistory'), summary.join(' · ')];
  }

  function renderDetail(place, history, historyError) {
    const actions = actionsFor(place);
    const path = place.path.map((node, index) => `<li>${
      index === 0 || node.id === place.id ? `<span ${node.id === place.id ? 'aria-current="location"' : ''}>${esc(node.name)}</span>`
        : button('detail', node.name, `data-id="${esc(node.id)}"`)
    }</li>`).join('');
    detail.innerHTML = `<nav aria-label="${t('placePath')}" class="places-path"><ol>${path}</ol></nav>
      <h2 tabindex="-1" data-place-focus>${esc(place.name)}</h2>
      <p class="places-meta">${t(kindKey(place.kind))} · ${t(statusKey(statusOf(place)))}</p>
      <div class="places-bar">
        ${actions.rename ? button('rename', t('placeRename')) : ''}
        ${actions.move ? button('move', t('placeMove')) : ''}
        ${actions.archive ? button('archive', t('placeArchive')) : ''}
      </div>
      <div class="places-operation"></div>
      <section class="places-area"><h3>${t('placeAliases')}</h3>
        ${place.aliases.length ? `<ul class="places-aliases">${place.aliases.map(alias => `<li>
          <div><strong>${esc(alias.original_code)}</strong>
            <div>${esc(alias.namespace)} · ${esc(alias.canonical_code)} · ${esc(alias.source)}</div>
            <small>${t('placeAliasValidFrom')} ${esc(formatDate(alias.created_at))}
              ${alias.valid_to ? ' · ' + t('placeAliasValidTo') + ' ' + esc(formatDate(alias.valid_to)) : ''}</small></div>
          ${actions.aliases && !alias.valid_to ? button('remove-alias', t('placeAliasRemove'),
            `data-id="${esc(alias.id)}" aria-label="${esc(t('placeAliasRemove') + ' ' + alias.original_code + ' · ' + alias.namespace)}"`) : ''}
        </li>`).join('')}</ul>` : `<p>${t('placeNoAliases')}</p>`}
        <p role="alert" class="places-alias-error" hidden></p>
        ${actions.aliases ? `<form data-place-form="add-alias"><div class="places-fields">
          ${field('placeAliasNamespace', 'namespace')}${field('placeAliasOriginal', 'originalCode')}
          ${field('placeAliasCanonical', 'canonicalCode')}${field('placeAliasSource', 'source')}
        </div><button type="submit">${t('placeAliasAdd')}</button></form>` : ''}
      </section>
      ${actions.history ? `<section class="places-area"><h3>${t('placeHistory')}</h3>
        ${historyError ? `<p role="alert">${esc(errorText(historyError))}</p>${button('detail', t('retry'), `data-id="${esc(place.id)}"`)}`
          : !history.length ? `<p>${t('placeNoHistory')}</p>` : `<ol class="places-history">${history.map(event => {
            const [title, change] = eventText(event);
            return `<li><strong>${esc(title)}</strong>
              <small><time datetime="${esc(event.at)}">${esc(formatDate(event.at))}</time> · ${esc(event.actor_name ?? t('coreUnknown'))}</small>
              ${change ? `<div>${esc(change)}</div>` : ''}</li>`;
          }).join('')}</ol>`}
      </section>` : ''}`;
  }

  async function selectPlace(id, focus = false) {
    const request = ++selectionRead;
    ++previewRead;
    selected = id;
    current = undefined;
    for (const ancestor of placeBreadcrumb(places, id).slice(0, -1)) expanded.set(ancestor.id, true);
    drawTree();
    detail.innerHTML = `<p role="status">${t('loading')}</p>`;
    const history = api.placeHistory(id).then(events => ({ events }), error => ({ events: [], error }));
    try {
      const [place, log] = await Promise.all([api.getPlace(id), history]);
      if (request !== selectionRead) return;
      current = place;
      renderDetail(place, log.events, log.error);
      if (focus) detail.querySelector('[data-place-focus]').focus();
    } catch (error) {
      if (request === selectionRead) {
        detail.innerHTML = `<p role="alert">${esc(errorText(error))}</p>${button('detail', t('retry'), `data-id="${esc(id)}"`)}`;
      }
    }
  }

  function dependencies(place, action) {
    const counts = place.dependencies;
    const items = action === 'move'
      ? [['placeDescendants', counts.descendants], ['placeSubtreeAssets', counts.subtree_current_assets]]
      : [['placeActiveChildren', counts.active_children], ['placeCurrentAssets', counts.current_assets]];
    return `<h4>${t('placeDependencies')}</h4><dl class="places-dependencies">${items.map(([key, count]) =>
      `<dt>${t(key)}</dt><dd>${count}</dd>`).join('')}</dl>`;
  }

  function operationForm(action, fields, { blocked = false } = {}) {
    const key = { create: 'placeCreate', rename: 'placeRename', move: 'placeMove', archive: 'placeArchive' }[action];
    return `<form data-place-form="${action}" class="places-operation-form">
      <h3 tabindex="-1">${t(key)}</h3><p role="alert" hidden></p>${fields}
      <div class="places-bar">${button('cancel', t('cancel'))}
        <button type="submit" class="${action === 'archive' ? 'danger' : 'primary'}" ${blocked ? 'disabled' : ''}>${t(key)}</button></div></form>`;
  }

  function parentSelector(form, kind, value, place, catalogue = places) {
    const exclude = place ? new Set(catalogue.filter(candidate =>
      placeBreadcrumb(catalogue, candidate.id).some(node => node.id === place.id)).map(candidate => candidate.id)) : new Set();
    const parentInput = form.querySelector('[name=parentId]');
    const eligible = candidate => !exclude.has(candidate.id) && kinds.indexOf(candidate.kind) < kinds.indexOf(kind);
    parentInput.value = value ?? '';
    mountPlaceSelector(form.querySelector('.places-parent'), {
      api, places: catalogue, siteId: site.id, siteName: site.name, value, eligible,
      label: t('placeParent'), emptyLabel: t('placeSiteRoot'), allowEmpty: true, language,
      onSelect: id => { parentInput.value = id ?? ''; },
    });
  }

  const parentFields = '<div class="places-parent"></div><input type="hidden" name="parentId">';

  function openCreate() {
    ++selectionRead;
    ++previewRead;
    selected = current = undefined;
    drawTree();
    detail.innerHTML = operationForm('create', `<div class="places-fields">${field('name', 'name')}
      <label class="field">${t('placeType')}<select name="kind">${options(kinds, kindKey)}</select></label></div>${parentFields}`);
    const form = detail.querySelector('form');
    const kind = form.elements.kind;
    parentSelector(form, kind.value, null);
    kind.addEventListener('change', () => {
      const parent = places.find(candidate => candidate.id === form.elements.parentId.value);
      const valid = parent && kinds.indexOf(parent.kind) < kinds.indexOf(kind.value);
      parentSelector(form, kind.value, valid ? parent.id : null);
    });
    form.querySelector('[name=name]').focus();
  }

  async function openOperation(action) {
    if (!current || !actionsFor(current)[action]) return;
    const request = ++previewRead;
    const target = detail.querySelector('.places-operation');
    let place = current, catalogue;
    let fields = field('name', 'name', place.name), blocked = false;
    if (action !== 'rename') {
      target.innerHTML = `<p role="status">${t('loading')}</p>`;
      try {
        [place, catalogue] = await Promise.all([api.getPlace(place.id), action === 'move'
          ? api.listPlaces(site.id, { includeArchived: true, includeAliases: true }) : undefined]);
        if (request !== previewRead) return;
        fields = dependencies(place, action) + (action === 'move' ? parentFields : '') +
          field('reason', 'reason', '', { required: false, max: 2000 });
        blocked = Boolean(place.archived_at || action === 'archive' &&
          (place.dependencies.active_children || place.dependencies.current_assets));
        if (blocked) fields += `<p role="status">${t(place.archived_at ? 'placeAlreadyArchived' : 'placeArchiveBlocked')}</p>`;
      } catch (error) {
        if (request === previewRead) target.innerHTML = `<p role="alert">${esc(errorText(error))}</p>`;
        return;
      }
    }
    target.innerHTML = operationForm(action, fields, { blocked });
    const form = target.querySelector('form');
    if (action === 'move') parentSelector(form, place.kind, place.parent_id, place, catalogue);
    form.querySelector('h3').focus();
  }

  async function save(action, form, aliasId) {
    if (saving) return;
    const place = current;
    const aliasAction = action === 'add-alias' || action === 'remove-alias';
    if (action === 'create' ? !actionsFor().create : !actionsFor(place)[aliasAction ? 'aliases' : action]) return;
    const request = selectionRead;
    const target = aliasAction ? detail.querySelector('.places-alias-error') : form.querySelector('[role=alert]');
    const submit = form?.querySelector('[type=submit]');
    const input = form ? Object.fromEntries(new FormData(form)) : {};
    target.hidden = true;
    saving = true;
    if (submit) submit.disabled = true;
    try {
      let id = place?.id;
      if (action === 'add-alias') {
        const payload = JSON.stringify(input);
        if (form.aliasPayload !== payload) {
          form.aliasPayload = payload;
          form.aliasRequestKey = globalThis.crypto.randomUUID();
        }
        await api.addPlaceAlias(id, input, form.aliasRequestKey);
      }
      if (action === 'remove-alias') await api.removePlaceAlias(id, aliasId);
      if (action === 'create') id = (await api.createPlace({ ...input, parentId: input.parentId || null, siteId: site.id })).id;
      if (action === 'rename') await api.updatePlace(id, input);
      if (action === 'move') await api.updatePlace(id, { ...input, parentId: input.parentId || null, reason: input.reason || null });
      if (action === 'archive') await api.archivePlace(id, { reason: input.reason || null });
      if (action === 'archive' && request === selectionRead && statusFilter.value === 'active') statusFilter.value = 'all';
      await loadTree();
      if (request === selectionRead) await selectPlace(id, true);
    } catch (error) {
      showError(target, error);
    } finally {
      saving = false;
      if (submit) submit.disabled = false;
    }
  }

  section.addEventListener('change', event => {
    if (event.target === kindFilter || event.target === statusFilter) drawTree();
  });
  section.addEventListener('click', event => {
    const control = event.target.closest('[data-place-action]');
    if (!control) return;
    const { placeAction, id } = control.dataset;
    if (placeAction === 'retry-tree') void loadTree();
    if (placeAction === 'detail') void selectPlace(id, true);
    if (placeAction === 'toggle') {
      const open = control.getAttribute('aria-expanded') === 'true';
      expanded.set(id, !open);
      drawTree();
      treeBody.querySelector(`[data-place-action=toggle][data-id="${id}"]`)?.focus();
    }
    if (placeAction === 'create') openCreate();
    if (['rename', 'move', 'archive'].includes(placeAction)) void openOperation(placeAction);
    if (placeAction === 'cancel') {
      ++previewRead;
      if (current) {
        const action = control.form.dataset.placeForm;
        detail.querySelector('.places-operation').replaceChildren();
        detail.querySelector(`[data-place-action="${action}"]`)?.focus();
      } else {
        detail.innerHTML = `<p>${t('placeChoose')}</p>`;
        section.querySelector('[data-place-action=create]')?.focus();
      }
    }
    if (placeAction === 'remove-alias') void save(placeAction, null, id);
  });
  section.addEventListener('submit', event => {
    const form = event.target;
    if (form.dataset.placeForm) {
      event.preventDefault();
      if (!form.querySelector('[type=submit]').disabled) void save(form.dataset.placeForm, form);
    }
  });
  detail.innerHTML = `<p>${t('placeChoose')}</p>`;
  void loadTree();
}
