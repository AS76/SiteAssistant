import { mountPlaceSelector, placeBreadcrumb } from './place-selector.mjs';

const statuses = ['planned', 'installed', 'replaced', 'decommissioned'];
const mounted = new WeakMap();
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);

export function filterAssets(assets, { search = '', status = '' } = {}, language = 'it') {
  const needle = search.trim().toLocaleLowerCase(language);
  return assets.filter(asset => (!status || asset.status === status) &&
    [asset.tag, asset.serial_number].some(value => (value ?? '').toLocaleLowerCase(language).includes(needle)));
}

export function sortAssets(assets, language = 'it') {
  const { compare } = new Intl.Collator(language, { numeric: true });
  return [...assets].sort((a, b) => compare(a.tag, b.tag) || compare(a.name, b.name) || a.id.localeCompare(b.id));
}

export function assetActions(role, asset) {
  // Session memberships only expose demo_user on an eligible sandbox site.
  if (!['owner', 'editor', 'demo_user'].includes(role) || !asset || asset.archived_at) return [];
  if (asset.status === 'planned') return ['install', 'decommission'];
  if (asset.status === 'installed') return ['move', 'replace', 'decommission'];
  return [];
}

export function mountAssets(root, { api, site, role, userId, language, offline, t }) {
  const previous = mounted.get(root);
  if (previous?.panel.parentElement === root && previous.siteId === site?.id &&
      previous.role === role && previous.userId === userId && previous.language === language && previous.offline === offline) return;

  const label = key => esc(t(key));
  const actionLabel = action => label(`assetAction_${action}`);
  const statusLabel = status => label(`assetStatus_${status}`);
  const field = (key, markup) => `<label class="field"><span>${label(key)}</span>${markup}</label>`;
  const fact = (key, markup) => `<div><dt>${label(key)}</dt><dd>${markup}</dd></div>`;
  const missing = label('assetNoValue');
  const value = text => text == null ? missing : esc(text);
  const formatDate = new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeZone: 'UTC' });
  const formatTime = new Intl.DateTimeFormat(language, {
    dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC',
  });
  const time = instant => `<time datetime="${esc(instant)}">${esc(formatTime.format(new Date(instant)))} UTC</time>`;
  const date = day => day ? `<time datetime="${esc(day)}">${esc(formatDate.format(new Date(day)))}</time>` : missing;
  const path = nodes => esc(nodes.map(node => node.name).join(' › '));
  const errorText = error => ['apiError', 'apiUnavailable'].includes(error.message) ? t(error.message)
    : (error.code ? `${error.code} · ${error.message}` : error.message);
  const errorMarkup = (error, retry) => `<div class="places-error"><p role="alert">${esc(errorText(error))}</p>
    <button type="button" data-asset-retry="${retry}">${label('retry')}</button></div>`;
  const loading = '<p role="status" tabindex="-1">' + label('loading') + '</p>';

  root.innerHTML = `<div class="assets-view"><header class="page-heading"><h1>${label('assets')}</h1></header></div>`;
  const panel = root.firstElementChild;
  mounted.set(root, { panel, siteId: site?.id, role, userId, language, offline });
  if (!site || offline) {
    panel.insertAdjacentHTML('beforeend', `<p role="status">${label(offline ? 'assetOnlineOnly' : 'noSites')}</p>`);
    return;
  }

  panel.insertAdjacentHTML('beforeend', `
    <p class="places-feedback" data-asset-feedback role="status"></p>
    <div class="places-layout">
      <section class="panel panel-body" aria-label="${label('assetRegister')}">
        <div class="assets-filters">
          ${field('assetSearch', '<input type="search" name="assetSearch">')}
          ${field('status', `<select name="assetStatus"><option value="">${label('placeAllStatuses')}</option>
            ${statuses.map(status => `<option value="${status}">${statusLabel(status)}</option>`).join('')}</select>`)}
          <div data-asset-place-filter></div>
        </div>
        <div data-asset-list></div>
      </section>
      <section class="panel panel-body places-detail" data-asset-detail aria-label="${label('assetDetails')}">
        <p>${label('assetChooseDetail')}</p>
      </section>
    </div>
    <dialog class="assets-dialog" aria-labelledby="asset-dialog-title"></dialog>`);

  const list = panel.querySelector('[data-asset-list]');
  const detail = panel.querySelector('[data-asset-detail]');
  const feedback = panel.querySelector('[data-asset-feedback]');
  const placeFilter = panel.querySelector('[data-asset-place-filter]');
  const search = panel.querySelector('[name="assetSearch"]');
  const status = panel.querySelector('[name="assetStatus"]');
  const dialog = panel.querySelector('dialog');
  let places, byId, rows, asset, selectedId, placeId = null;
  let listVersion = 0, detailVersion = 0, saving = false;
  const active = () => panel.parentElement === root && panel.isConnected;

  function selectRow() {
    for (const button of list.querySelectorAll('[data-asset-open]')) {
      if (button.dataset.assetOpen === selectedId) button.setAttribute('aria-current', 'true');
      else button.removeAttribute('aria-current');
    }
  }

  function renderList() {
    if (!rows) return;
    const results = filterAssets(rows, { search: search.value, status: status.value }, language);
    list.innerHTML = results.length ? `<ul class="assets-results">${results.map(row => `<li>
      <button type="button" data-asset-open="${esc(row.id)}">
        <strong>${esc(row.tag)} · ${esc(row.name)}</strong>
        <span>${statusLabel(row.status)} · ${row.place_id ? path(placeBreadcrumb(byId, row.place_id, site)) : label('assetNoPosition')}</span>
      </button></li>`).join('')}</ul>` : `<p role="status">${label('assetNoResults')}</p>`;
    selectRow();
  }

  async function loadList() {
    const version = ++listVersion;
    rows = null;
    list.innerHTML = loading;
    try {
      const [catalog, locations] = await Promise.all([
        api.listAssets(site.id, placeId ? { placeId } : {}), api.listPlaces(site.id, { includeArchived: true }),
      ]);
      if (!active() || version !== listVersion) return;
      if (!places) mountPlaceSelector(placeFilter, {
        siteId: site.id, siteName: site.name, places: locations, allowEmpty: true,
        label: t('assetPlaceFilter'), emptyLabel: t('assetAllPlaces'), t,
        onSelect: id => {
          if (placeId === id) return;
          placeId = id;
          void loadList();
        },
      });
      places = locations;
      byId = new Map(places.map(place => [place.id, place]));
      rows = sortAssets(catalog, language);
      renderList();
    } catch (error) {
      if (active() && version === listVersion) list.innerHTML = errorMarkup(error, 'list');
    }
  }

  async function showDetail(id, focus = true) {
    const version = ++detailVersion;
    selectedId = id;
    asset = undefined;
    selectRow();
    detail.innerHTML = loading;
    const placeholder = detail.firstElementChild;
    if (focus) placeholder.focus();
    try {
      const [record, positions] = await Promise.all([api.getAsset(id), api.listAssetPositions(id)]);
      if (!active() || version !== detailVersion) return;
      const restoreFocus = root.ownerDocument.activeElement === placeholder;
      asset = record;
      detail.innerHTML = `<h2 tabindex="-1">${esc(asset.tag)} · ${esc(asset.name)}</h2>
        <dl class="places-facts">
          ${fact('status', statusLabel(asset.status))}
          ${fact('assetSerial', value(asset.serial_number))}
          ${fact('assetManufacturer', value(asset.manufacturer))}
          ${fact('assetModel', value(asset.model))}
          ${fact('assetInstalledOn', date(asset.installed_on))}
          ${asset.archived_at ? fact('placeArchived', time(asset.archived_at)) : ''}
        </dl>
        <h3>${label('assetWarranty')}</h3>
        <dl class="places-facts">
          ${fact('assetWarrantyStart', date(asset.warranty_start))}
          ${fact('assetWarrantyEnd', date(asset.warranty_end))}
          ${fact('assetWarrantyProvider', value(asset.warranty_provider))}
        </dl>
        <h3>${label('assetCurrentPosition')}</h3>
        <p>${asset.currentPosition ? path(asset.currentPosition.path) : label('assetNoPosition')}</p>
        <div class="places-actions">${assetActions(role, asset).map(action => `<button type="button" data-asset-action="${action}"${action === 'install' || action === 'move' ? ' class="primary"' : ''}>${actionLabel(action)}</button>`).join('')}</div>
        <h3>${label('assetPositionHistory')}</h3>
        ${positions.length ? `<ol class="places-history">${positions.map(position => `<li>
          <strong>${path([{ name: site.name }, ...JSON.parse(position.recorded_path)])}</strong>
          <dl class="places-facts">
            ${fact('assetPositionFrom', time(position.valid_from))}
            ${fact('assetPositionTo', position.valid_to ? time(position.valid_to) : label('assetPositionOpen'))}
            ${fact('reason', value(position.reason))}
          </dl>
        </li>`).join('')}</ol>` : `<p>${label('assetNoHistory')}</p>`}`;
      if (restoreFocus) detail.firstElementChild.focus();
    } catch (error) {
      if (!active() || version !== detailVersion) return;
      const restoreFocus = root.ownerDocument.activeElement === placeholder;
      detail.innerHTML = errorMarkup(error, 'detail');
      if (restoreFocus) detail.querySelector('button').focus();
    }
  }

  function openAction(action, trigger) {
    if (!assetActions(role, asset).includes(action)) return;
    const record = asset;
    const needsPlace = action === 'install' || action === 'move';
    const needsReason = action === 'replace' || action === 'decommission';
    const now = new Date().toISOString().slice(0, 19);
    let destination = action === 'install' ? record.currentPosition?.place_id ?? null : null;
    let positionSaved = false, refresh = false;
    dialog.innerHTML = `<header class="modal-header"><h2 id="asset-dialog-title">${actionLabel(action)} · ${esc(record.tag)}</h2></header>
      <form class="modal-body">
        <p class="assets-dialog-error" role="alert"></p>
        <fieldset>
          ${needsPlace ? `<div data-asset-destination></div>
            ${field('assetEffectiveTime', `<input type="datetime-local" name="when" value="${now}" max="${now}" step="1" required>`)}` : ''}
          ${action !== 'install' ? field(needsReason ? 'assetReasonRequired' : 'reason',
            `<textarea name="reason" maxlength="2000"${needsReason ? ' required' : ''}></textarea>`) : ''}
          <div class="form-actions">
            <button type="button" data-asset-cancel autofocus>${label('cancel')}</button>
            <button type="submit" class="${needsReason ? 'danger' : 'primary'}">${actionLabel(action)}</button>
          </div>
        </fieldset>
      </form>`;
    const form = dialog.querySelector('form');
    const controls = form.querySelector('fieldset');
    const alert = form.querySelector('[role="alert"]');
    const cancel = form.querySelector('[data-asset-cancel]');
    cancel.addEventListener('click', () => dialog.close());
    dialog.onclose = () => {
      if (!active()) return;
      if (refresh) {
        void loadList();
        void showDetail(record.id);
      } else trigger.focus();
    };

    if (needsPlace) mountPlaceSelector(form.querySelector('[data-asset-destination]'), {
      api, siteId: site.id, siteName: site.name, value: destination, label: t('assetPlaceRequired'), t,
      onSelect: id => { destination = id; },
    });
    dialog.showModal();
    cancel.focus();

    form.addEventListener('submit', async event => {
      event.preventDefault();
      event.stopPropagation();
      if (saving) return;
      const data = new FormData(form);
      const reason = data.get('reason')?.trim();
      alert.textContent = '';
      if (needsPlace && !destination) {
        alert.textContent = t('assetChoosePlace');
        form.querySelector('[role="combobox"]').focus();
        return;
      }
      if (needsReason && !reason) {
        alert.textContent = t('reasonRequired');
        form.elements.reason.focus();
        return;
      }
      saving = controls.disabled = true;
      form.setAttribute('aria-busy', 'true');
      refresh = true;
      try {
        if (action === 'install') {
          const latest = await api.getAsset(record.id);
          if (!active()) return;
          if (!assetActions(role, latest).includes(action)) {
            positionSaved = false;
            throw new Error(t('assetChanged'));
          }
          const when = data.get('when');
          // Installation requires an open position. A planned asset can keep
          // a saved position if the subsequent status update fails.
          if (latest.currentPosition?.place_id !== destination) {
            await api.moveAsset(record.id, { placeId: destination, validFrom: new Date(`${when}Z`).toISOString() });
            positionSaved = true;
            if (!active()) return;
          }
          await api.updateAsset(record.id, { status: 'installed', installedOn: when.slice(0, 10) });
        } else if (action === 'move') {
          await api.moveAsset(record.id, {
            placeId: destination, validFrom: new Date(`${data.get('when')}Z`).toISOString(), reason: reason || null,
          });
        } else {
          await api.updateAsset(record.id, { status: action === 'replace' ? 'replaced' : 'decommissioned', reason });
        }
        if (!active()) return;
        feedback.textContent = t(`assetSuccess_${action}`);
        dialog.close();
      } catch (error) {
        if (active()) alert.textContent = [positionSaved ? t('assetPositionSaved') : '', errorText(error)].filter(Boolean).join(' ');
      } finally {
        saving = controls.disabled = false;
        form.removeAttribute('aria-busy');
      }
    });
  }

  dialog.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
  search.addEventListener('input', renderList);
  status.addEventListener('change', renderList);
  panel.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button) return;
    const { assetOpen, assetAction, assetRetry } = button.dataset;
    if (assetOpen) {
      feedback.textContent = '';
      void showDetail(assetOpen);
    }
    if (assetAction) {
      feedback.textContent = '';
      openAction(assetAction, button);
    }
    if (assetRetry === 'list') void loadList();
    if (assetRetry === 'detail') void showDetail(selectedId);
  });
  void loadList();
}
