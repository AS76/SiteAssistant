import { messages } from './i18n.mjs';

let nextSelectorId = 0;

export function placeBreadcrumb(byId, placeId, site) {
  const path = [];
  const visited = new Set();
  for (let place = byId.get(placeId); place && !visited.has(place.id); place = byId.get(place.parent_id)) {
    visited.add(place.id);
    path.push({ id: place.id, kind: place.kind, name: place.name });
  }
  return [{ id: site.id, kind: 'site', name: site.name }, ...path.reverse()];
}

export function buildPlaceOptions(places, site, accept = () => true) {
  const inSite = places.filter(place => place.site_id === site.id);
  const byId = new Map(inSite.map(place => [place.id, place]));
  const options = inSite.filter(place => !place.archived_at && accept(place)).map(place => ({
    id: place.id,
    label: placeBreadcrumb(byId, place.id, site).map(node => node.name).join(' › '),
    searchText: place.name,
    place,
  }));
  const counts = new Map();
  for (const option of options) counts.set(option.label, (counts.get(option.label) ?? 0) + 1);
  return options.map(option => counts.get(option.label) > 1
    ? { ...option, label: `${option.label} · ${option.id}` }
    : option);
}

export function filterPlaceOptions(options, query, area = '') {
  const normalized = value => value.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase();
  const needle = normalized(query.trim());
  return options.filter(option => normalized(option.id === null ? `${option.searchText} ${area}` : option.searchText).includes(needle));
}

// value is a place UUID or null. onSelect receives (uuidOrNull, placeOrNull).
// places can supply a preloaded list for the same site. accept restricts eligible choices.
export function mountPlaceSelector(root, {
  api, siteId, siteName, value = null, area = '', onSelect, allowEmpty = false,
  places, accept, label, emptyLabel, t = key => messages.it[key],
}) {
  const id = `place-selector-${++nextSelectorId}`;
  const site = { id: siteId, name: siteName || t('site') };
  root.classList.add('place-selector');
  root.innerHTML = `<label class="field" for="${id}"><span></span>
      <input id="${id}" type="text" role="combobox" autocomplete="off"
        aria-autocomplete="list" aria-expanded="false" aria-controls="${id}-list"
        aria-describedby="${id}-legacy ${id}-status">
    </label>
    <p id="${id}-legacy" class="place-selector-legacy" hidden></p>
    <ul id="${id}-list" role="listbox" class="place-selector-options" hidden></ul>
    <div id="${id}-status" role="status"></div>
    <button type="button" hidden></button>`;
  const input = root.querySelector('input');
  const list = root.querySelector('ul');
  const status = root.querySelector('[role="status"]');
  const legacy = root.querySelector('.place-selector-legacy');
  const retry = root.querySelector('button');
  const fieldLabel = label || t('placeSelect');
  root.querySelector('label span').textContent = fieldLabel;
  list.setAttribute('aria-label', fieldLabel);
  retry.textContent = t('retry');

  let selected = value, selectedLabel = '', options, visible = [], active = -1, searching = false;

  function updateLegacy() {
    legacy.hidden = Boolean(selected) || !area;
    legacy.textContent = legacy.hidden ? '' : `${t('placeLegacyArea')} · ${area}`;
    input.placeholder = t(legacy.hidden ? 'placeSearch' : 'placeSearchLegacy');
  }

  function close() {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    input.value = selectedLabel;
    status.textContent = '';
    active = -1;
    searching = false;
  }

  function activate(index, scroll = false) {
    list.children[active]?.classList.remove('is-highlighted');
    active = index;
    const item = list.children[active];
    if (!item) {
      input.removeAttribute('aria-activedescendant');
      return;
    }
    input.setAttribute('aria-activedescendant', item.id);
    item.classList.add('is-highlighted');
    if (scroll) item.scrollIntoView({ block: 'nearest' });
  }

  function show(query) {
    if (!options) return;
    searching = true;
    visible = filterPlaceOptions(options, query, selected ? '' : area);
    list.replaceChildren(...visible.map((option, index) => {
      const item = root.ownerDocument.createElement('li');
      item.id = `${id}-option-${index}`;
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(selected === option.id));
      item.dataset.option = index;
      item.textContent = option.label;
      return item;
    }));
    activate(-1);
    list.hidden = !visible.length;
    input.setAttribute('aria-expanded', String(!list.hidden));
    const legacyMatches = !selected && area && filterPlaceOptions([{ searchText: area }], query).length;
    status.textContent = visible.length || legacyMatches ? '' : t('placeNoMatches');
  }

  function select(index) {
    const option = visible[index];
    if (!option) return;
    selected = option.id;
    selectedLabel = selected ? option.label : emptyLabel || '';
    close();
    updateLegacy();
    input.focus();
    onSelect(selected, option.place);
  }

  input.addEventListener('input', () => show(input.value));
  input.addEventListener('click', () => {
    if (searching) return;
    input.select();
    show('');
  });
  input.addEventListener('blur', close);
  input.addEventListener('keydown', event => {
    if (event.isComposing) return;
    if (event.key === 'Escape' && searching) {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === 'Enter' && searching) {
      event.preventDefault();
      select(active);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (list.hidden) show(input.value === selectedLabel ? '' : input.value);
      if (visible.length) {
        const step = event.key === 'ArrowDown' ? 1 : -1;
        const next = active < 0 && step < 0 ? visible.length - 1 : active + step;
        activate(Math.max(0, Math.min(visible.length - 1, next)), true);
      }
    }
  });
  // Keep focus on the combobox when choosing with a pointer.
  list.addEventListener('mousedown', event => event.preventDefault());
  list.addEventListener('click', event => {
    const option = event.target.closest('[role="option"]');
    if (option) select(Number(option.dataset.option));
  });

  async function load() {
    const retryFocused = root.ownerDocument.activeElement === retry;
    input.disabled = true;
    retry.hidden = true;
    status.textContent = t('loading');
    try {
      const rows = places ?? await api.listPlaces(siteId, { includeArchived: true });
      const byId = new Map(rows.filter(place => place.site_id === siteId).map(place => [place.id, place]));
      const current = byId.get(selected);
      options = buildPlaceOptions(rows, site, accept);
      selectedLabel = options.find(option => option.id === selected)?.label ?? '';
      if (current && !selectedLabel) {
        selectedLabel = placeBreadcrumb(byId, selected, site).map(node => node.name).join(' › ');
        if (current.archived_at) selectedLabel += ` · ${t('placeArchived')}`;
      }
      if (allowEmpty) {
        const text = emptyLabel || t('placeNoSelection');
        options.unshift({ id: null, label: text, searchText: text, place: null });
      }
      if (!selected && emptyLabel) selectedLabel = emptyLabel;
      input.disabled = false;
      close();
      if (retryFocused) input.focus();
    } catch {
      status.textContent = t('placeLoadError');
      retry.hidden = false;
    }
  }

  retry.addEventListener('click', load);
  updateLegacy();
  void load();
}
