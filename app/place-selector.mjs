import { createApi } from './api.mjs';
import { messages } from './i18n.mjs';

let nextSelectorId = 0;

export function placeBreadcrumb(places, id, site) {
  const byId = places instanceof Map ? places : new Map(places.map(place => [place.id, place]));
  const path = [];
  const visited = new Set();
  for (let place = byId.get(id); place && !visited.has(place.id); place = byId.get(place.parent_id)) {
    path.push({ id: place.id, kind: place.kind, name: place.name });
    visited.add(place.id);
  }
  if (site?.name) path.push({ id: site.id, kind: 'site', name: site.name });
  return path.reverse();
}

const pathLabel = path => path.map(node => node.name).join(' › ');
const searchKey = value => String(value ?? '').normalize('NFC').toLowerCase();

export function searchPlaceOptions(places, query, site, eligible = () => true) {
  const byId = new Map(places.map(place => [place.id, place]));
  const needle = searchKey(query).trim();
  return places.filter(place => !place.archived_at && eligible(place)).flatMap(place => {
    const path = pathLabel(placeBreadcrumb(byId, place.id, site));
    const aliases = (place.aliases ?? []).filter(alias => !alias.valid_to);
    const fields = [place.name, path, place.code,
      ...aliases.flatMap(alias => [alias.original_code, alias.canonical_code, alias.namespace + ' ' + alias.canonical_code])];
    if (!fields.some(field => searchKey(field).includes(needle))) return [];
    const codes = [...new Set([place.code, ...aliases.map(alias => alias.original_code)].filter(Boolean))];
    return [{ place, path, codes }];
  });
}

// value is a place UUID or null. onSelect receives (uuid, place), or (null, null) when cleared.
// Pass area from an unmapped legacy record, and siteName to include the site in each path.
export function mountPlaceSelector(root, {
  siteId, value = null, onSelect, allowEmpty = false, area, siteName, language = 'it',
  api = createApi({ baseUrl: root.ownerDocument.location?.origin ?? '' }), places,
  label, emptyLabel, eligible,
}) {
  const t = key => (messages[language] ?? messages.it)[key];
  const doc = root.ownerDocument;
  const id = 'place-picker-' + ++nextSelectorId;
  const site = { id: siteId, name: siteName };
  const wrapper = doc.createElement('div');
  wrapper.className = 'place-selector';
  wrapper.innerHTML = '<label class="field"><span></span><input type="text" role="combobox" autocomplete="off" aria-autocomplete="list" aria-expanded="false"></label>' +
    '<p class="place-selector-legacy" hidden></p><p role="status" class="place-selector-status"></p>' +
    '<ul class="place-selector-options" role="listbox" hidden></ul>';
  root.replaceChildren(wrapper);
  const caption = wrapper.querySelector('label span');
  const input = wrapper.querySelector('input');
  const legacy = wrapper.querySelector('.place-selector-legacy');
  const status = wrapper.querySelector('[role=status]');
  const list = wrapper.querySelector('[role=listbox]');
  caption.id = id + '-label';
  caption.textContent = label ?? t('placeSelectorLabel');
  list.id = id + '-list';
  list.setAttribute('aria-labelledby', caption.id);
  input.setAttribute('aria-controls', list.id);
  input.placeholder = t('placeSelectorSearch');
  legacy.id = id + '-legacy';

  let catalogue, selection = value, selectedLabel = '', options = [], active = -1;
  let opened = false, typed = false;
  function showSelection() {
    const selected = catalogue?.find(place => place.id === selection);
    selectedLabel = selected
      ? pathLabel(placeBreadcrumb(catalogue, selected.id, site)) + (selected.archived_at ? ' · ' + t('placeArchived') : '')
      : selection ? (catalogue ? t('placeMissing') : '') : (emptyLabel ?? '');
    input.value = selectedLabel;
    legacy.hidden = !area || Boolean(selection);
    legacy.textContent = legacy.hidden ? '' : t('placeLegacyArea') + ' · ' + area;
    if (legacy.hidden) input.removeAttribute('aria-describedby');
    else input.setAttribute('aria-describedby', legacy.id);
  }

  function highlight(index) {
    active = index;
    for (const [i, option] of [...list.children].entries()) option.classList.toggle('is-highlighted', i === index);
    if (index < 0) {
      input.removeAttribute('aria-activedescendant');
    } else {
      const option = list.children[index];
      input.setAttribute('aria-activedescendant', option.id);
      option.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    }
  }

  function renderOptions() {
    options = searchPlaceOptions(catalogue, typed ? input.value : '', site, eligible);
    if (allowEmpty && (!typed || !input.value.trim())) {
      options.unshift({ place: null, path: emptyLabel ?? t('placeSelectorEmpty'), codes: [] });
    }
    list.replaceChildren(...options.map(({ place, path, codes }, index) => {
      const item = doc.createElement('li');
      item.id = id + '-option-' + index;
      item.dataset.index = index;
      item.tabIndex = -1;
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String((place?.id ?? null) === selection));
      const title = doc.createElement('span');
      title.textContent = place?.name ?? path;
      item.append(title);
      if (place) {
        const context = doc.createElement('small');
        context.textContent = [path, ...codes].join(' · ');
        item.append(context);
      }
      return item;
    }));
    status.textContent = options.length ? '' : t('noResults');
    list.hidden = !options.length;
    input.setAttribute('aria-expanded', String(!list.hidden));
    highlight(-1);
  }

  function open() {
    if (!catalogue || opened) return;
    opened = true;
    renderOptions();
  }

  function close() {
    opened = false;
    typed = false;
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    highlight(-1);
    if (catalogue) status.textContent = '';
    showSelection();
  }

  function choose(index) {
    const { place } = options[index];
    selection = place?.id ?? null;
    input.focus();
    close();
    onSelect?.(selection, place);
  }

  input.addEventListener('focus', open);
  input.addEventListener('click', open);
  input.addEventListener('input', () => {
    typed = true;
    if (opened) renderOptions();
    else open();
  });
  input.addEventListener('keydown', event => {
    if (event.isComposing) return;
    if (event.key === 'Escape' && opened) {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
    if (event.key === 'Enter' && opened) {
      event.preventDefault();
      if (active >= 0) choose(active);
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      open();
      if (!opened || !options.length) return;
      const next = event.key === 'ArrowDown' ? active + 1 : active < 0 ? options.length - 1 : active - 1;
      highlight((next + options.length) % options.length);
    }
  });
  wrapper.addEventListener('focusout', event => {
    if (!wrapper.contains(event.relatedTarget)) close();
  });
  list.addEventListener('mousedown', event => event.preventDefault());
  list.addEventListener('click', event => {
    const option = event.target.closest('[role=option]');
    if (option && opened) choose(Number(option.dataset.index));
  });

  const load = rows => {
    catalogue = rows;
    status.textContent = '';
    input.readOnly = false;
    showSelection();
    if (doc.activeElement === input) open();
  };
  showSelection();
  if (places) load(places);
  else {
    input.readOnly = true;
    status.textContent = t('loading');
    api.listPlaces(siteId, { includeArchived: true, includeAliases: true }).then(load, () => {
      status.textContent = t('apiUnavailable');
    });
  }
  return { get value() { return selection; }, destroy: () => wrapper.remove() };
}
