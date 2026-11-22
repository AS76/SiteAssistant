import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { messages } from '../app/i18n.mjs';
import * as domain from '../app/domain.mjs';

const source = await readFile(new URL('../app/app.mjs', import.meta.url), 'utf8');
const fragment = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const task = {
  id: 'synthetic-task', siteId: 'synthetic-site', title: 'Synthetic task', status: 'to_verify',
  due: '2026-04-15', priority: 'normal', verifier_id: 'synthetic-verifier', submitted_by_id: 'synthetic-submitter',
};
const labels = {
  it: { verify: 'Verifica', reject: 'Respingi', resume: 'Riprendi',
    hint: 'Spiega cosa deve essere rifatto. L’attività torna in corso.',
    denied: 'Solo il verificatore assegnato o il titolare possono verificare o respingere.' },
  en: { verify: 'Verify', reject: 'Reject', resume: 'Resume',
    hint: 'Explain what must be redone. The task returns to in progress.',
    denied: 'Only the assigned verifier or the owner can verify or reject.' },
};

function control(dataset = {}) {
  const attributes = new Map();
  return { dataset, disabled: false, hidden: true, attributes,
    setAttribute(name, value) { attributes.set(name, value); },
    removeAttribute(name) { attributes.delete(name); },
    focus() { this.focused = true; },
  };
}

function reviewUi(language, { tasks = [task], role = 'verifier', userId = task.verifier_id, write = async () => {} } = {}) {
  const state = { tasks: tasks.map(task => ({ ...task })), attachments: [], sites: [], diary: [] };
  const reads = [], writes = [], toasts = [], handlers = {};
  const main = { innerHTML: '' }, modal = { open: false }, alert = control();
  const context = {
    ...domain, messages, language, state, siteId: task.siteId, pendingOps: [], modalVersion: 0,
    session: { user: { id: userId } }, actor: 'Synthetic user', offline: false, storageReady: false,
    role: () => role, moduleVisible: name => name === 'tasks', currentModules: () => ({ tasks: true, diary: false, progress: false, deviations: false }),
    operationalDay: () => ({ date: task.due }), notebookTime: () => '', timeLabel: value => value, dateLabel: value => value,
    personName: value => value || '—', taskWbsText: () => '—', dueMarkup: task => task.due,
    t: key => messages[language][key] ?? key, $: selector => ({ '#main': main, '#modal': modal, '#task-transition-error': alert })[selector],
    render: () => context.renderToday(), taskEvidence: () => '', attachmentSection: () => '', rememberTask() {},
    freshApi: { async getTask(id) { reads.push(id); return state.tasks.find(task => task.id === id); } },
    showModal(title, html) { Object.assign(modal, { open: true, title, html }); context.modalVersion++; },
    closeModal() { modal.open = false; context.modalVersion++; },
    document: { addEventListener(type, listener) { handlers[type] = listener; } },
    dateFormData: form => form.data,
    async writeOperation(op, { task, input }, id) {
      writes.push({ op, input, id });
      await write();
      state.tasks = state.tasks.map(row => row.id === id ? { ...task, status: input.to, blocked_from: null } : row);
    },
    toast: value => toasts.push(value),
  };
  for (const [, name] of source.matchAll(/(?:async )?function (\w+)\(/g)) {
    if (!(name in context)) context[name] = () => {};
  }
  runInNewContext([
    fragment('const esc =', 'let session ='), fragment('const paths =', 'function toast('),
    fragment('const errorKeys =', 'function clearSession('), fragment('const siteTasks =', 'const dateLabel ='),
    fragment('function currentTodayActions(', 'function openTodayAction('),
    fragment('const canWriteTask =', 'const canCreateSite ='), fragment('function field(', 'function dateInput('),
    fragment('const formActions =', 'function showPasswordForm('), fragment('async function showDetail(', 'function showEntryForm('),
    fragment("document.addEventListener('click',", "$('#modal').addEventListener('cancel'"),
  ].join('\n'), context);
  const click = target => handlers.click({ target: { closest: () => target } });
  function reject(button) {
    click(button);
    const submit = control(), error = control();
    const form = { id: 'transition-form', isConnected: true, data: { actor: context.actor, note: '' },
      dataset: { taskId: button.dataset.id, to: button.dataset.to, todayReview: button.dataset.todayReview },
      querySelector: selector => ({ '[type=submit]': submit, '.form-error': error })[selector],
    };
    return { form, submit, error, send: () => handlers.submit({ target: form, preventDefault() {} }) };
  }
  return { context, main, modal, alert, reads, writes, toasts, click, reject };
}

const buttons = html => [...html.matchAll(/<button\b[^>]*data-to="[^"]+"[^>]*>[^<]*<\/button>/g)].map(([markup]) => {
  const [, text] = markup.match(/>([^<]*)<\/button>/);
  const dataset = Object.fromEntries([...markup.matchAll(/data-([\w-]+)="([^"]*)"/g)].map(([, key, value]) =>
    [key.replace(/-(\w)/g, (_, character) => character.toUpperCase()), value]));
  return Object.assign(control(dataset), { markup, text });
});

for (const [language, copy] of Object.entries(labels)) {
  test(`verification detail displays ordered actions only for an independent assigned verifier or owner (${language})`, async () => {
    for (const [role, userId, allowed] of [
      ['verifier', task.verifier_id, true], ['owner', 'synthetic-owner', true],
      ['verifier', 'synthetic-other', false], ['editor', task.submitted_by_id, false],
      ['owner', task.submitted_by_id, false], ['viewer', task.verifier_id, false],
    ]) {
      const ui = reviewUi(language, { role, userId });
      await ui.context.showDetail(task.id);
      const actions = buttons(ui.modal.html);
      assert.equal(ui.modal.html.includes(copy.denied), !allowed);
      if (allowed) {
        assert.deepEqual(actions.slice(0, 2).map(button => [button.dataset.to, button.text]), [['closed', copy.verify], ['in_progress', copy.reject]]);
        assert.match(actions[0].markup, /class="notebook-primary"/);
        assert.match(actions[1].markup, /class="notebook-outline"/);
        assert.equal(actions.filter(button => button.markup.includes('notebook-primary')).length, 1);
      } else assert.deepEqual(actions, []);
    }
  });

  test(`rejection requires a note, suppresses concurrent submits and preserves the note on error (${language})`, async () => {
    const first = Promise.withResolvers();
    let attempts = 0;
    const ui = reviewUi(language, { write: () => attempts++ === 0 ? first.promise : undefined });
    await ui.context.showDetail(task.id);
    const { form, submit, error, send } = ui.reject(buttons(ui.modal.html)[1]);
    assert.equal(ui.modal.title, `${copy.reject} · ${task.title}`);
    assert.ok(ui.modal.html.includes(copy.hint));
    assert.match(ui.modal.html, /<textarea name="note"[^>]* required/);
    assert.match(ui.modal.html, /role="alert" tabindex="-1" hidden/);
    assert.doesNotMatch(ui.modal.html, /name="reason"/);
    form.data.note = '   ';
    await send();
    assert.equal(ui.writes.length, 0);
    assert.equal(error.textContent, messages[language].noteRequired);
    form.data.note = 'Synthetic review note';
    const saving = send();
    await send();
    assert.equal(ui.writes.length, 1);
    assert.equal(submit.disabled, true);
    assert.equal(submit.attributes.get('aria-busy'), 'true');
    error.focused = false;
    first.reject(Object.assign(new Error('Synthetic failure'), { code: 'NOTE_REQUIRED' }));
    await saving;
    assert.equal(error.textContent, messages[language].noteRequired);
    assert.equal(error.focused, true);
    assert.equal(error.hidden, false);
    assert.equal(form.data.note, 'Synthetic review note');
    assert.equal(submit.disabled, false);
    assert.equal(submit.attributes.has('aria-busy'), false);
    await send();
    assert.equal(ui.writes[1].op, 'transition_task');
    assert.equal(ui.writes[1].input.to, 'in_progress');
    assert.equal(ui.writes[1].input.note, 'Synthetic review note');
    assert.equal(ui.context.state.tasks[0].status, 'in_progress');
    assert.deepEqual(ui.toasts, [messages[language].actionSaved]);
  });

  test(`resume runs directly to each valid prior status, suppresses double taps and omits invalid targets (${language})`, async () => {
    for (const target of ['todo', 'in_progress', 'to_verify', null, undefined, 'closed', 'unknown']) {
      const prior = { ...task, status: 'blocked', blocked_from: target };
      const pending = Promise.withResolvers();
      const ui = reviewUi(language, { tasks: [prior], write: () => pending.promise });
      await ui.context.showDetail(task.id);
      const actions = buttons(ui.modal.html);
      if (!['todo', 'in_progress', 'to_verify'].includes(target)) {
        assert.deepEqual(actions, []);
        continue;
      }
      const [resume] = actions;
      assert.equal(resume.text, copy.resume);
      assert.match(resume.markup, /class="notebook-outline"/);
      assert.equal(resume.dataset.to, target);
      ui.click(resume);
      ui.click(resume);
      assert.equal(ui.writes.length, 1);
      assert.equal(ui.writes[0].input.to, target);
      assert.equal(ui.writes[0].input.note, '');
      assert.equal(resume.disabled, true);
      assert.equal(resume.attributes.get('aria-busy'), 'true');
      assert.equal(ui.modal.title, task.title);
      assert.doesNotMatch(ui.modal.html, /id="transition-form"/);
      pending.resolve();
      await new Promise(setImmediate);
      assert.equal(ui.context.state.tasks[0].status, target);
      assert.deepEqual(ui.toasts, [messages[language].actionSaved]);
    }
  });

  test(`resume errors keep the task blocked and focus the dialog alert (${language})`, async () => {
    const blocked = { ...task, status: 'blocked', blocked_from: 'to_verify' };
    for (const fromDetail of [true, false]) {
      const ui = reviewUi(language, { tasks: [blocked], write: async () => { throw new Error('actionDenied'); } });
      if (fromDetail) await ui.context.showDetail(blocked.id);
      else ui.context.renderToday();
      const [resume] = buttons(fromDetail ? ui.modal.html : ui.main.innerHTML);
      ui.click(resume);
      await new Promise(setImmediate);
      assert.equal(ui.context.state.tasks[0].status, 'blocked');
      assert.equal(ui.modal.title, fromDetail ? task.title : copy.resume);
      assert.match(ui.modal.html, /role="alert" tabindex="-1"/);
      assert.equal(ui.alert.focused, true);
      if (fromDetail) assert.equal(ui.alert.textContent, messages[language].actionDenied);
      else assert.ok(ui.modal.html.includes(messages[language].actionDenied));
      assert.equal(resume.disabled, false);
      assert.deepEqual(ui.toasts, []);
    }
  });

  test(`Today provides review and resume actions, updates the queue and retains one primary action (${language})`, async () => {
    const queued = { ...task, id: 'synthetic-review', title: 'Synthetic verification' };
    const denied = { ...task, id: 'synthetic-denied', title: 'Synthetic denied', verifier_id: 'synthetic-other' };
    const blocked = { ...task, id: 'synthetic-blocked', title: 'Synthetic hold', status: 'blocked', blocked_from: 'to_verify', due: '2026-04-16' };
    const ui = reviewUi(language, { tasks: [task, queued, denied, blocked] });
    ui.context.renderToday();
    assert.equal((ui.main.innerHTML.match(/class="notebook-primary"/g) || []).length, 1);
    const [, review] = ui.main.innerHTML.match(/<section aria-labelledby="today-verify">([\s\S]*?)<\/section>/);
    assert.ok(review.includes(copy.denied));
    assert.ok(review.includes(`datetime="${blocked.due}"`));
    assert.equal(review.includes(messages[language].todayLateDays.replace('{days}', '0')), false);
    const actions = buttons(review);
    assert.deepEqual(actions.filter(button => button.dataset.id === queued.id).map(button => button.text), [copy.verify, copy.reject]);
    assert.equal(actions.some(button => button.dataset.id === denied.id), false);
    const { form, send } = ui.reject(actions.find(button => button.dataset.id === queued.id && button.text === copy.reject));
    form.data.note = 'Synthetic review note';
    await send();
    assert.equal(ui.modal.open, false);
    assert.deepEqual(ui.reads, []);
    assert.equal(buttons(ui.main.innerHTML).some(button => button.dataset.id === queued.id), false);
    ui.click(actions.find(button => button.dataset.id === blocked.id && button.text === copy.resume));
    await new Promise(setImmediate);
    assert.equal(ui.context.state.tasks.find(task => task.id === blocked.id).status, 'to_verify');
    assert.equal(buttons(ui.main.innerHTML).some(button => button.dataset.id === blocked.id && button.text === copy.verify), true);
  });
}
