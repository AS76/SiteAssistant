import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';

const source = await readFile(new URL('../app/app.mjs', import.meta.url), 'utf8');

function fragment(start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, start);
  return source.slice(from, to);
}

// Execute the production modal lifecycle and cancel listener with synthetic controls.
// Native focus and keyboard behavior are also covered in browser.cjs.
function dialogUi() {
  let controls = [], danger = null, safe = null, focused = null;
  const nodes = new Map();
  const content = { innerHTML: '' };
  const modal = new EventTarget();
  Object.assign(modal, {
    open: false, classList: { remove() {} },
    showModal() { this.open = true; }, close() { this.open = false; },
    focus() { focused = this; }, querySelectorAll() { return controls; },
  });
  const context = createContext({
    modalVersion: 0, esc: value => value, t: key => key,
    $: selector => {
      if (selector === '#modal') return modal;
      if (selector === '#modal-content') return content;
      if (nodes.has(selector)) return nodes.get(selector);
      if (selector === '#modal-content button.danger') return danger;
      if (selector.includes('.form-actions')) return safe;
      if (selector.startsWith('#modal-content input')) return controls.find(control => !control.disabled && control.type !== 'hidden' && control.type !== 'button');
      throw new Error(`Unexpected selector: ${selector}`);
    },
  });
  runInContext(fragment('function showModal(', 'function field('), context);
  runInContext(fragment("$('#modal').addEventListener('cancel'", "document.addEventListener('change'"), context);
  const control = (extra = {}) => ({
    name: 'notes', type: 'textarea', value: '',
    hasAttribute(name) { return name === 'aria-pressed' && this.pressed !== undefined; },
    getAttribute() { return this.pressed; }, focus() { focused = this; }, ...extra,
  });
  return {
    modal, content, context, control, nodes, focused: () => focused,
    open(fields = [], { destructive = false, form = 'synthetic-form' } = {}) {
      controls = fields; danger = destructive ? control({ type: 'button' }) : null;
      safe = destructive ? control({ type: 'button' }) : null;
      context.html = fields.length || destructive ? `<form id="${form}">Synthetic form</form>` : '<p role="status">Loading</p>';
      runInContext("showModal('Synthetic dialog', html)", context);
      return { safe, danger };
    },
    escape() {
      const event = new Event('cancel', { cancelable: true });
      modal.dispatchEvent(event);
      if (!event.defaultPrevented) modal.close(); // Native Escape default action.
      return event;
    },
    close() { runInContext('closeModal()', context); },
  };
}

test('dialog initially focuses the first enabled field', () => {
  const ui = dialogUi(), first = ui.control();
  ui.open([ui.control({ type: 'hidden' }), ui.control({ disabled: true }), first, ui.control()]);
  assert.equal(ui.focused(), first);
});

test('destructive confirmation initially focuses Cancel', () => {
  const ui = dialogUi(), { safe } = ui.open([], { destructive: true });
  assert.equal(ui.focused(), safe);
  assert.equal(ui.modal.open, true);
});

test('loading and informational dialogs focus their container', () => {
  const ui = dialogUi();
  ui.open();
  assert.equal(ui.focused(), ui.modal);
  assert.equal(ui.escape().defaultPrevented, false);
  assert.equal(ui.modal.open, false);
});

for (const form of ['hse-form', 'cert-form']) {
  test(`${form}: editing a value then cancel keeps the dialog and content`, () => {
    const ui = dialogUi(), input = ui.control({ name: form === 'hse-form' ? 'measures' : 'name' });
    ui.open([input], { form });
    const version = ui.context.modalVersion, html = ui.content.innerHTML;
    input.value = 'Synthetic unsaved value';
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.equal(ui.escape().defaultPrevented, true);
      assert.equal(ui.modal.open, true);
      assert.equal(input.value, 'Synthetic unsaved value');
      assert.equal(ui.content.innerHTML, html);
      assert.equal(ui.context.modalVersion, version, 'pending modal operations stay current');
    }
  });

  test(`${form}: cancel closes an unchanged prefilled form`, () => {
    const ui = dialogUi();
    ui.open([ui.control({ value: 'Synthetic existing value' }), ui.control({ type: 'select-one', value: 'low' })], { form });
    const version = ui.context.modalVersion;
    assert.equal(ui.escape().defaultPrevented, false);
    assert.equal(ui.modal.open, false);
    assert.equal(ui.context.modalVersion, version + 1);
  });
}

test('restoring initial values makes the form clean again', () => {
  const ui = dialogUi(), input = ui.control({ value: 'Synthetic initial value' });
  ui.open([input]);
  input.value = 'Changed';
  assert.equal(ui.escape().defaultPrevented, true);
  input.value = 'Synthetic initial value';
  assert.equal(ui.escape().defaultPrevented, false);
  assert.equal(ui.modal.open, false);
});

for (const [type, initial, changed] of [
  ['checkbox', { value: 'on', checked: true }, { checked: false }],
  ['radio', { value: 'choice', checked: false }, { checked: true }],
  ['select-one', { value: 'low' }, { value: 'high' }],
  ['select-multiple', { selectedOptions: [{ value: 'a' }] }, { selectedOptions: [{ value: 'a' }, { value: 'b' }] }],
  ['file', { files: [] }, { files: [{ name: 'synthetic.txt', size: 4, type: 'text/plain', lastModified: 1 }] }],
  ['number', { value: '1' }, { value: '2' }],
  ['button', { pressed: 'false' }, { pressed: 'true' }],
]) {
  test(`cancel protects changed ${type} state, including updates without input events`, () => {
    const ui = dialogUi(), input = ui.control({ type, ...initial });
    ui.open([input]);
    Object.assign(input, changed);
    assert.equal(ui.escape().defaultPrevented, true);
    assert.equal(ui.modal.open, true);
  });
}

test('explicit cancellation still works and opening another form resets its baseline', () => {
  const ui = dialogUi(), input = ui.control();
  ui.open([input]);
  input.value = 'Synthetic draft';
  ui.close();
  assert.equal(ui.modal.open, false);
  ui.open([ui.control({ value: 'New form default' })]);
  assert.equal(ui.escape().defaultPrevented, false);
  assert.equal(ui.modal.open, false);
});

for (const editedWhileLoading of [false, true]) {
  test(`asynchronous import fields preserve ${editedWhileLoading ? 'an existing draft' : 'the pristine form state'}`, async () => {
    const ui = dialogUi(), family = ui.control({ type: 'select-one', name: 'family', value: 'employees' });
    const fields = [family, ui.control({ type: 'file', name: 'file', files: [] })];
    ui.open(fields);
    ui.nodes.set('#import-form', { dataset: {}, isConnected: true });
    let resolve;
    Object.assign(ui.context, {
      siteId: 'synthetic-site', canImport: () => true, IMPORT_FAMILIES: ['employees'], button: () => '',
      freshApi: { listImportMappings: () => new Promise(done => { resolve = done; }) },
      renderImportMapping: () => fields.push(ui.control({ name: '', value: 'Synthetic default alias' })),
      formError: (_form, error) => { throw error; },
    });
    runInContext(fragment('async function showImportForm()', 'async function downloadImportTemplate('), ui.context);
    const loading = runInContext('showImportForm()', ui.context);
    if (editedWhileLoading) family.value = 'daily_log';
    resolve([]);
    await loading;
    assert.equal(ui.escape().defaultPrevented, editedWhileLoading);
    assert.equal(ui.modal.open, editedWhileLoading);
    assert.equal(family.value, editedWhileLoading ? 'daily_log' : 'employees');
  });
}
