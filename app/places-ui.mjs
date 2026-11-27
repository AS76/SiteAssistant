import { mountPlaceSelector, placeBreadcrumb } from './place-selector.mjs';

const kinds = ['building', 'floor', 'zone', 'room'];
const mounted = new WeakMap();
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);

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

export function filterPlaceTree(tree, { kind = '', status = '' } = {}) {
  return tree.flatMap(node => {
    const children = filterPlaceTree(node.children, { kind, status });
    const matches = (!kind || node.kind === kind) && (!status || status === (node.archived_at ? 'archived' : 'active'));
    return matches || children.length ? [{ ...node, children, matches }] : [];
  });
}

export function placeActions(role, place) {
  if (role !== 'owner' && role !== 'demo_user') return [];
  if (!place) return ['create'];
  return place.archived_at ? [] : ['rename', 'move', 'archive'];
}

const errors = {
  PLACE_NOT_FOUND: 'placeNotFound',
  PLACE_ARCHIVED: 'placeAlreadyArchived',
  PLACE_CYCLE: 'placeCycle',
  PLACE_KIND_ORDER: 'placeKindOrder',
  CROSS_SITE_REFERENCE: 'placeWrongSite',
  REFERENCE_NOT_FOUND: 'placeParentNotFound',
  PLACE_HAS_ACTIVE_CHILDREN: 'placeHasActiveChildren',
  PLACE_HAS_CURRENT_ASSETS: 'placeHasCurrentAssets',
  FORBIDDEN: 'placeForbidden',
  VALIDATION_ERROR: 'invalidData',
  NETWORK_ERROR: 'apiUnavailable',
};

export function mountPlaces(root, { api, site, role, userId, language, offline, t }) {
  const previous = mounted.get(root);
  if (previous?.panel.parentElement === root && previous.siteId === site?.id &&
      previous.role === role && previous.userId === userId && previous.language === language && previous.offline === offline) return;

  const button = (key, attributes = '') => `<button type="button" ${attributes}>${esc(t(key))}</button>`;
  const actionKey = action => `placeAction_${action}`;
  const kindName = kind => t(`placeKind_${kind}`);
  const statusName = archived => t(archived ? 'placeArchived' : 'placeActive');
  const format = new Intl.DateTimeFormat(language, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    timeZone: 'UTC', timeZoneName: 'short',
  });
  const time = value => `<time datetime="${esc(value)}">${esc(format.format(new Date(value)))}</time>`;
  const errorText = error => t(errors[error.code] || 'apiError');
  const option = (value, text) => `<option value="${esc(value)}">${esc(text)}</option>`;
  const field = (label, markup) => `<label class="field"><span>${esc(t(label))}</span>${markup}</label>`;
  const errorWithRetry = (message, action) => `<div class="places-error"><p role="alert">${esc(message)}</p>${button('retry', `data-place-retry="${action}"`)}</div>`;

  root.innerHTML = `<div class="places-view">
    <header class="page-heading"><h1>${esc(t('places'))}</h1></header>
    <div data-place-content></div>
  </div>`;
  const panel = root.firstElementChild;
  mounted.set(root, { panel, siteId: site?.id, role, userId, language, offline });
  const content = panel.querySelector('[data-place-content]');
  if (!site || offline) {
    content.innerHTML = `<p role="status">${esc(t(offline ? 'placeOnlineOnly' : 'noSites'))}</p>`;
    return;
  }

  const canCreate = placeActions(role).includes('create');
  if (canCreate) panel.querySelector('header').insertAdjacentHTML('beforeend',
    button(actionKey('create'), 'class="primary" data-place-action="create" disabled'));
  content.innerHTML = `<p class="places-feedback" role="status"></p>
    <div class="places-layout">
      <section class="panel panel-body" aria-labelledby="places-tree-heading">
        <h2 id="places-tree-heading">${esc(site.name)}</h2>
        <div class="places-filters">
          ${field('placeKind', `<select name="kind">${option('', t('placeAllKinds'))}${kinds.map(kind => option(kind, kindName(kind))).join('')}</select>`)}
          ${field('placeStatus', `<select name="status">${option('active', statusName(false))}${option('archived', statusName(true))}${option('', t('placeAllStatuses'))}</select>`)}
        </div>
        <div data-place-tree></div>
      </section>
      <section class="panel panel-body places-detail" aria-label="${esc(t('placeDetails'))}">
        <p>${esc(t('placeChooseDetail'))}</p>
      </section>
    </div>`;
  const treeRoot = panel.querySelector('[data-place-tree]');
  const filters = panel.querySelector('.places-filters');
  const detailRoot = panel.querySelector('.places-detail');
  const feedback = panel.querySelector('.places-feedback');
  const create = panel.querySelector('[data-place-action="create"]');
  const filter = { kind: '', status: 'active' };
  const expanded = new Set();
  let places = [], byId = new Map(), tree = [], selectedId, detail, detailVersion = 0, opening = false;

  function renderTree() {
    const filtered = filterPlaceTree(tree, filter);
    const branches = nodes => `<ul>${nodes.map(node => {
      const id = esc(node.id);
      const open = expanded.has(node.id) || filter.kind || filter.status === 'archived';
      const showChild = node.children.length ? `<button type="button" class="places-expand" data-place-expand="${id}"
        aria-expanded="${Boolean(open)}" aria-controls="place-children-${id}" aria-label="${esc(`${t('placeSubtree')} · ${node.name}`)}"></button>` : '';
      return `<li><div class="places-node">
        ${showChild}<button type="button" class="places-node-link" data-place-open="${id}"${node.id === selectedId ? ' aria-current="true"' : ''}${node.matches ? '' : ' data-place-context'}>
          <strong>${esc(node.name)}</strong><span>${esc(kindName(node.kind))} · ${esc(statusName(node.archived_at))}</span>
        </button>
      </div>${node.children.length ? `<div class="places-branch" id="place-children-${id}"${open ? '' : ' hidden'}>${branches(node.children)}</div>` : ''}</li>`;
    }).join('')}</ul>`;
    treeRoot.innerHTML = filtered.length ? branches(filtered) : `<p role="status">${esc(t('placeEmptyTree'))}</p>`;
  }

  function selectInTree(id) {
    treeRoot.querySelector('[aria-current]')?.removeAttribute('aria-current');
    treeRoot.querySelector(`[data-place-open="${esc(id)}"]`)?.setAttribute('aria-current', 'true');
  }

  async function loadTree() {
    if (create) create.disabled = true;
    for (const select of filters.querySelectorAll('select')) select.disabled = true;
    treeRoot.innerHTML = `<p role="status">${esc(t('loading'))}</p>`;
    try {
      places = await api.listPlaces(site.id, { includeArchived: true });
      byId = new Map(places.map(place => [place.id, place]));
      tree = buildPlaceTree(places);
      const path = placeBreadcrumb(byId, selectedId, site);
      for (const parent of path.slice(1, -1)) expanded.add(parent.id);
      renderTree();
      if (create) create.disabled = false;
      for (const select of filters.querySelectorAll('select')) select.disabled = false;
    } catch (error) {
      treeRoot.innerHTML = errorWithRetry(errorText(error), 'tree');
    }
  }

  function pathMarkup(path, linkAncestors = true) {
    return `<nav class="places-breadcrumb" aria-label="${esc(t('placePath'))}"><ol>${path.map((node, index) => {
      const current = index === path.length - 1;
      return `<li${current ? ' aria-current="location"' : ''}>${current || node.kind === 'site' || !linkAncestors
        ? esc(node.name)
        : `<button type="button" data-place-open="${esc(node.id)}">${esc(node.name)}</button>`}</li>`;
    }).join('')}</ol></nav>`;
  }

  function dependenciesMarkup({ activeChildren, currentAssets }) {
    return `<dl class="places-facts">
      <div><dt>${esc(t('placeActiveChildren'))}</dt><dd>${activeChildren}</dd></div>
      <div><dt>${esc(t('placeCurrentAssets'))}</dt><dd>${currentAssets}</dd></div>
    </dl>`;
  }

  function historyMarkup(history) {
    function values({ action, changes }) {
      const parent = value => value ?? site.name;
      const rows = [];
      if (action === 'create') {
        rows.push(`<p>${esc(changes.name)} · ${esc(kindName(changes.kind))}</p>`);
        if (changes.parent_id) rows.push(`<p>${esc(t('placeParent'))} · ${esc(parent(changes.parent_id))}</p>`);
      }
      if (changes.name && action !== 'create') rows.push(`<p>${esc(t('name'))} · ${esc(changes.name.from)} → ${esc(changes.name.to)}</p>`);
      if (changes.parent_id && action !== 'create') {
        rows.push(`<p>${esc(t('placeParent'))} · ${esc(parent(changes.parent_id.from))} → ${esc(parent(changes.parent_id.to))}</p>`);
      }
      if (changes.note) rows.push(`<p>${esc(t('reason'))} · ${esc(changes.note)}</p>`);
      return rows.join('');
    }
    return history.length ? `<ol class="places-history">${history.map(event => `<li>
      <strong>${esc(t(`placeEvent_${event.action}`))}</strong>
      <div class="places-meta">${time(event.at)} · ${esc(t('placeAuthor'))} <code>${esc(event.actor)}</code></div>
      ${values(event)}
    </li>`).join('')}</ol>` : `<p>${esc(t('placeNoHistory'))}</p>`;
  }

  async function showDetail(id, focus = true) {
    const version = ++detailVersion;
    selectedId = id;
    detail = undefined;
    selectInTree(id);
    detailRoot.innerHTML = `<p tabindex="-1" role="status">${esc(t('loading'))}</p>`;
    const loading = detailRoot.firstElementChild;
    if (focus) loading.focus();
    try {
      const [place, history] = await Promise.all([api.getPlace(id), api.listPlaceHistory(id)]);
      if (version !== detailVersion || !panel.isConnected) return;
      const restoreFocus = root.ownerDocument.activeElement === loading;
      detail = place;
      detailRoot.innerHTML = `<h2 tabindex="-1">${esc(place.name)}</h2>
        ${pathMarkup(place.path)}
        <dl class="places-facts">
          <div><dt>${esc(t('placeKind'))}</dt><dd>${esc(kindName(place.kind))}</dd></div>
          <div><dt>${esc(t('placeStatus'))}</dt><dd>${esc(statusName(place.archived_at))}</dd></div>
          <div><dt>${esc(t('placeCreatedAt'))}</dt><dd>${time(place.created_at)}</dd></div>
          <div><dt>${esc(t('placeUpdatedAt'))}</dt><dd>${time(place.updated_at)}</dd></div>
          <div><dt>ID</dt><dd><code>${esc(place.id)}</code></dd></div>
        </dl>
        <div class="places-actions">${placeActions(role, place).map(action => button(actionKey(action),
          `data-place-action="${action}"${action === 'archive' ? ' class="danger"' : ''}`)).join('')}</div>
        <h3>${esc(t('placeDependencies'))}</h3>${dependenciesMarkup(place.dependencies)}
        <h3>${esc(t('history'))}</h3>${historyMarkup(history)}
      `;
      if (restoreFocus) detailRoot.firstElementChild.focus();
    } catch (error) {
      if (version !== detailVersion || !panel.isConnected) return;
      const restoreFocus = root.ownerDocument.activeElement === loading;
      detailRoot.innerHTML = errorWithRetry(errorText(error), 'detail');
      if (restoreFocus) detailRoot.querySelector('button').focus();
    }
  }

  function editDialog(action, place, trigger) {
    const dialog = root.ownerDocument.createElement('dialog');
    dialog.className = 'places-dialog';
    dialog.setAttribute('aria-labelledby', 'place-edit-title');
    const add = action === 'create';
    const move = action === 'move';
    const archive = action === 'archive';
    const blocked = archive && (place.dependencies.activeChildren > 0 || place.dependencies.currentAssets > 0);
    dialog.innerHTML = `<div class="modal-header"><h2 id="place-edit-title">${esc(t(actionKey(action)))}</h2></div>
      <form class="modal-body">
        ${place ? pathMarkup(place.path, false) : ''}
        ${add || action === 'rename' ? field('name', `<input name="name" required maxlength="200" value="${esc(place?.name)}">`) : ''}
        ${add ? field('placeKind', `<select name="kind">${kinds.map(kind => option(kind, kindName(kind))).join('')}</select>`) : ''}
        ${move || archive ? `<h3>${esc(t('placeDependencies'))}</h3>${dependenciesMarkup(place.dependencies)}` : ''}
        ${blocked ? `<p role="alert">${esc(t('placeArchiveBlocked'))}</p>` : ''}
        ${move || add ? '<div data-place-parent></div>' : ''}
        ${move || archive && !blocked ? field('reason', '<textarea name="reason" maxlength="2000"></textarea>') : ''}
        <p class="form-error" role="alert" tabindex="-1" hidden></p>
        <div class="form-actions">
          ${button(blocked ? 'close' : 'cancel', 'data-place-cancel autofocus')}
          ${blocked ? '' : `<button type="submit" class="${archive ? 'danger' : 'primary'}">${esc(t(archive ? actionKey(action) : 'save'))}</button>`}
        </div>
      </form>`;
    panel.append(dialog);

    const form = dialog.querySelector('form');
    const cancel = form.querySelector('[data-place-cancel]');
    const submit = form.querySelector('[type="submit"]');
    const message = form.querySelector('.form-error');
    const parentRoot = form.querySelector('[data-place-parent]');
    let parentId = place?.parent_id ?? null;
    let saving = false;

    function parentSelector() {
      const rank = kinds.indexOf(place?.kind ?? form.elements.kind.value);
      const accept = candidate => kinds.indexOf(candidate.kind) < rank;
      if (parentId && (!byId.has(parentId) || !accept(byId.get(parentId)))) parentId = null;
      mountPlaceSelector(parentRoot, {
        api, siteId: site.id, siteName: site.name, places, value: parentId, accept, t,
        label: t('placeParent'), emptyLabel: site.name, allowEmpty: true,
        onSelect: id => { parentId = id; },
      });
    }
    if (parentRoot) parentSelector();
    if (add) form.elements.kind.addEventListener('change', parentSelector);
    cancel.addEventListener('click', () => dialog.close());
    dialog.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
    dialog.addEventListener('close', () => {
      dialog.remove();
      if (trigger.isConnected) trigger.focus();
    });

    form.addEventListener('submit', async event => {
      event.preventDefault();
      event.stopPropagation();
      if (saving || blocked) return;
      const data = new FormData(form);
      const name = data.get('name')?.trim();
      if ((add || action === 'rename') && !name) {
        message.textContent = t('invalidData');
        message.hidden = false;
        form.elements.name.focus();
        return;
      }
      const reason = data.get('reason')?.trim() || null;
      saving = true;
      form.setAttribute('aria-busy', 'true');
      submit.disabled = cancel.disabled = true;
      message.hidden = true;
      let saved;
      try {
        if (add) saved = await api.createPlace({ siteId: site.id, name, kind: data.get('kind'), parentId });
        else if (move) saved = await api.updatePlace(place.id, { parentId, reason });
        else if (archive) saved = await api.archivePlace(place.id, { reason });
        else saved = await api.updatePlace(place.id, { name });
      } catch (error) {
        message.textContent = errorText(error);
        message.hidden = false;
        message.focus();
      } finally {
        saving = false;
        form.removeAttribute('aria-busy');
        submit.disabled = cancel.disabled = false;
      }
      if (!saved || !panel.isConnected) return;
      dialog.close();
      feedback.textContent = t('actionSaved');
      selectedId = saved.id;
      await Promise.all([loadTree(), showDetail(saved.id, false)]);
      if (panel.isConnected && selectedId === saved.id) detailRoot.querySelector('h2, [data-place-retry]')?.focus();
    });
    dialog.showModal();
  }

  filters.addEventListener('change', event => {
    filter[event.target.name] = event.target.value;
    renderTree();
  });
  panel.addEventListener('click', async event => {
    const target = event.target.closest('button');
    if (!target || target.closest('dialog')) return;
    const { placeOpen, placeExpand, placeRetry, placeAction } = target.dataset;
    if (placeExpand) {
      const open = target.getAttribute('aria-expanded') !== 'true';
      target.setAttribute('aria-expanded', String(open));
      panel.querySelector(`#${target.getAttribute('aria-controls')}`).hidden = !open;
      if (open) expanded.add(placeExpand);
      else expanded.delete(placeExpand);
    } else if (placeOpen) {
      feedback.textContent = '';
      void showDetail(placeOpen);
    } else if (placeRetry === 'tree') {
      void loadTree();
    } else if (placeRetry === 'detail') {
      void showDetail(selectedId);
    } else if (placeAction && !opening) {
      if (placeAction === 'create') return editDialog(placeAction, null, target);
      if (!detail || !placeActions(role, detail).includes(placeAction)) return;
      if (placeAction === 'rename') return editDialog(placeAction, detail, target);
      const id = detail.id;
      opening = true;
      target.disabled = true;
      feedback.textContent = t('loading');
      try {
        const latest = await api.getPlace(id);
        if (!target.isConnected || selectedId !== id) return;
        feedback.textContent = '';
        if (latest.archived_at) {
          feedback.textContent = t('placeAlreadyArchived');
          await showDetail(id);
        } else {
          editDialog(placeAction, latest, target);
        }
      } catch (error) {
        if (target.isConnected) feedback.textContent = errorText(error);
      } finally {
        opening = false;
        target.disabled = false;
      }
    }
  });

  void loadTree();
}
