import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { formatDateInput, parseDateInput } from '../app/domain.mjs';
import { messages } from '../app/i18n.mjs';

const source = await readFile(new URL('../app/app.mjs', import.meta.url), 'utf8');

for (const [language, display, leap, invalid, placeholder] of [
  ['it', '20/11/2026', '29/02/2028', '31/04/2026', 'GG/MM/AAAA'],
  ['en', '11/20/2026', '02/29/2028', '04/31/2026', 'MM/DD/YYYY'],
]) {
  test(`localized dates round-trip through ISO (${language})`, () => {
    assert.equal(formatDateInput('2026-11-20', language), display);
    assert.equal(parseDateInput(display, language), '2026-11-20');
    assert.equal(parseDateInput(leap, language), '2028-02-29');
    for (const iso of ['0001-01-01', '2028-02-29', '9999-12-31', '']) {
      assert.equal(parseDateInput(formatDateInput(iso, language), language), iso);
    }
    for (const value of [invalid, '02/02/0000', '29/02/2026', '02/29/2026', '2/2/2026', '2026-11-20', ' ']) {
      assert.equal(parseDateInput(value, language), null);
    }
  });

  test(`date field describes the format and sends ISO without rewriting the display (${language})`, () => {
    const error = { textContent: '' };
    const input = {
      id: 'field-due', name: 'due', value: display, required: true,
      setCustomValidity(message) { this.message = message; },
      setAttribute(key, value) { this[key] = value; },
      removeAttribute(key) { delete this[key]; },
      focus() { this.focused = true; },
    };
    const form = { querySelectorAll: () => [input] };
    const start = source.indexOf('function field('), end = source.indexOf('const formActions', start);
    const { html, readForm } = runInNewContext(source.slice(start, end) + `
      ({ html: field('due', 'due', '2026-11-20', { required: true, type: 'date' }), readForm: dateFormData })
    `, {
      language, formatDateInput, parseDateInput, esc: value => value, t: key => messages[language][key],
      $: selector => { assert.equal(selector, '#field-due-error'); return error; },
      FormData: class { constructor() { return [['due', input.value], ['title', 'Synthetic task']]; } },
    });
    assert.ok(html.includes(`placeholder="${placeholder}"`));
    assert.ok(html.includes(messages[language].dateFormatHint));
    assert.match(html, /aria-describedby="field-due-format field-due-error"/);
    assert.match(html, /id="field-due-error"[^>]*role="alert"/);
    assert.match(source, /const data = .*dateFormData.*;\s*if \(!data\) return;/s);
    assert.equal(readForm(form).due, '2026-11-20');
    assert.equal(readForm(form).title, 'Synthetic task');
    assert.equal(input.value, display);
    for (const [value, key] of [[invalid, 'dateFormatInvalid'], ['', 'dateRequired']]) {
      input.value = value;
      assert.equal(readForm(form), null);
      assert.equal(input.message, messages[language][key]);
      assert.equal(input['aria-invalid'], 'true');
      assert.equal(error.textContent, input.message);
      assert.ok(input.focused);
    }
    input.required = false;
    assert.equal(readForm(form).due, '');
    assert.equal(error.textContent, '');
    assert.equal(input['aria-invalid'], undefined);
  });
}
