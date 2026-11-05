import test from 'node:test';
import assert from 'node:assert/strict';
import { seedState, validateState, createSite, createTask, updateTask, transition, allowedActions, addDiaryEntry, counts, today, validDate, csvCell } from '../app/domain.mjs';

const taskInput = { siteId: 'site-alpha', title: 'Example task', description: '', area: 'Area 1', company: 'Example company', assignee: 'worker', reviewer: 'reviewer', priority: 'normal', due: '2026-01-01', criteria: 'Documented check' };
function freshTask() { const state = createTask(seedState(), taskInput, 'lead'); return { state, id: state.tasks.at(-1).id }; }

test('only the designated reviewer can verify, after a completion proposal with evidence', () => {
  let { state, id } = freshTask();
  assert.throws(() => transition(state, id, 'verify', 'reviewer', 'Checked'), /actionDenied/);
  state = transition(state, id, 'start', 'worker');
  assert.throws(() => transition(state, id, 'submit', 'lead', 'Done'), /actionDenied/);
  assert.throws(() => transition(state, id, 'submit', 'worker', '  '), /reasonRequired/);
  state = transition(state, id, 'submit', 'worker', 'Evidence E-01');
  assert.equal(state.tasks.at(-1).status, 'review');
  assert.throws(() => transition(state, id, 'verify', 'worker', 'Checked'), /actionDenied/);
  assert.throws(() => transition(state, id, 'verify', 'lead', 'Checked'), /actionDenied/);
  state = transition(state, id, 'verify', 'reviewer', 'Criteria checked');
  assert.equal(state.tasks.at(-1).status, 'closed');
  assert.equal(state.tasks.at(-1).history.at(-1).actor, 'reviewer');
});
test('rejection and reopening preserve prior evidence and require a reason', () => {
  let { state, id } = freshTask();
  state = transition(state, id, 'start', 'worker');
  state = transition(state, id, 'submit', 'worker', 'First evidence');
  state = transition(state, id, 'reject', 'reviewer', 'Correct the finish');
  assert.equal(state.tasks.at(-1).status, 'active');
  state = transition(state, id, 'submit', 'worker', 'New evidence');
  state = transition(state, id, 'verify', 'reviewer', 'Accepted');
  assert.throws(() => transition(state, id, 'reopen', 'lead', ''), /reasonRequired/);
  state = transition(state, id, 'reopen', 'lead', 'New defect');
  assert.equal(state.tasks.at(-1).submittedBy, null);
  assert.equal(state.tasks.at(-1).history.filter(event => event.action === 'verify').length, 1);
  assert.equal(state.tasks.at(-1).history.filter(event => event.action === 'submit').length, 2);
});
test('blocking requires a reason and completion requires resuming first', () => {
  let { state, id } = freshTask();
  assert.throws(() => transition(state, id, 'block', 'worker', ''), /reasonRequired/);
  state = transition(state, id, 'block', 'worker', 'Waiting for material');
  assert.deepEqual(allowedActions(state.tasks.at(-1), 'worker'), ['resume']);
  assert.throws(() => transition(state, id, 'submit', 'worker', 'Done'), /actionDenied/);
});
test('different executor/reviewer and unique site codes are enforced', () => {
  const state = seedState();
  assert.throws(() => createTask(state, { ...taskInput, reviewer: 'worker' }, 'lead'), /separatePeople/);
  assert.throws(() => createSite(state, { code: 'demo-01', name: 'Example', location: '', start: '', end: '' }), /duplicateCode/);
  assert.throws(() => createSite(state, { code: 'NEW', name: 'Example', location: '', start: '2026-11-05', end: '2026-11-01' }), /dateOrder/);
});
test('review items remain overdue and are not counted as closed', () => {
  let { state, id } = freshTask();
  state = transition(state, id, 'start', 'worker');
  state = transition(state, id, 'submit', 'worker', 'Evidence');
  const count = counts([state.tasks.at(-1)], '2026-01-02');
  assert.deepEqual(count, { execution: 0, review: 1, closed: 0, overdue: 1, blocked: 0 });
});
test('diary groups day and night contributions under one explicit operational date', () => {
  const state = seedState();
  const entry = { shift: 'night', taskId: '', plan: 'Plan', actual: 'Actual', blockers: '', next: '' };
  let next = addDiaryEntry(state, 'site-alpha', '2026-01-01', entry, 'worker', '2026-01-02T02:00:00Z');
  next = addDiaryEntry(next, 'site-alpha', '2026-01-01', { ...entry, shift: 'day' }, 'lead');
  assert.equal(next.reports.filter(report => report.date === '2026-01-01').length, 1);
  assert.equal(next.reports.find(report => report.date === '2026-01-01').entries.length, 2);
  assert.equal(next.reports.find(report => report.date === '2026-01-01').entries[0].shift, 'night');
});
test('cross-site task links are rejected without mutating current data', () => {
  const { state, id } = freshTask();
  const before = JSON.stringify(state);
  assert.throws(() => addDiaryEntry(state, 'site-beta', today(), { shift: 'day', taskId: id, plan: 'Plan', actual: 'Actual', blockers: '', next: '' }, 'lead'), /wrongSite/);
  assert.equal(JSON.stringify(state), before);
});
test('imports reject wrong version, duplicate records and forged closed items without verification', () => {
  const state = seedState();
  assert.throws(() => validateState({ ...state, schemaVersion: 2 }), /invalidBackup/);
  assert.throws(() => validateState({ ...state, tasks: [...state.tasks, state.tasks[0]] }), /duplicate/);
  const altered = structuredClone(state);
  altered.tasks[0].status = 'closed';
  altered.tasks[0].submittedBy = 'worker';
  altered.tasks[0].history.at(-1).status = 'closed';
  assert.throws(() => validateState(altered), /invalidData/);
  assert.deepEqual(validateState(JSON.parse(JSON.stringify(state))), state);
});
test('task edits preserve identity and history and cannot alter completed tasks', () => {
  let { state, id } = freshTask();
  state = updateTask(state, id, { ...taskInput, title: 'Updated' }, 'lead');
  assert.equal(state.tasks.at(-1).id, id);
  assert.equal(state.tasks.at(-1).history.at(-1).action, 'updated');
  state = transition(state, id, 'start', 'worker');
  state = transition(state, id, 'submit', 'worker', 'Evidence');
  assert.throws(() => updateTask(state, id, taskInput, 'lead'), /actionDenied/);
});
test('CSV neutralizes formulas including leading whitespace and quotes correctly', () => {
  assert.equal(csvCell('=1+1'), '"\'=1+1"');
  assert.equal(csvCell(' \t@SUM(A1)'), '"\' \t@SUM(A1)"');
  assert.equal(csvCell('plain "text"'), '"plain ""text"""');
  assert.equal(csvCell('a,b\nnext'), '"a,b\nnext"');
});
test('local dates reject impossible days and retain local calendar semantics', () => {
  assert.equal(validDate('2026-02-30'), false);
  assert.equal(validDate('2024-02-29'), true);
  assert.equal(validDate('2026-13-01'), false);
  assert.equal(today(new Date(2026, 0, 2, 0, 5)), '2026-01-02');
});
