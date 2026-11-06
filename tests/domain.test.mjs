import test from 'node:test';
import assert from 'node:assert/strict';
import { STATUSES, sitePayload, taskPayload, diaryPayload, transitionPayload, allowedTransitions, transitionRequirements, counts, today, validDate, csvCell } from '../app/domain.mjs';

const input = { siteId: 'site-example', title: 'Example task', area: 'Area 1', company: 'Example company', assignee: 'Example executor', reviewer: 'Example verifier', priority: 'normal', due: '2026-01-01' };

test('form payloads map only supported fields and preserve optional dates as null', () => {
  assert.deepEqual(sitePayload({ code: ' EX-01 ', name: 'Example', start: '', end: null }), { code: 'EX-01', name: 'Example', location: '', start_date: null, end_date: null });
  assert.deepEqual(taskPayload({ ...input, description: 'Ignored', criteria: 'Ignored' }), { siteId: input.siteId, title: input.title, area: input.area, company: input.company, executor: input.assignee, verifier: input.reviewer, priority: 'normal', due_date: input.due });
  assert.equal(taskPayload({ ...input, due: null }).due_date, null);
});
test('site and task validation respects API requirements with free-text people', () => {
  assert.throws(() => sitePayload({ code: 'X', name: 'Example', start: '2026-11-05', end: '2026-11-01' }), /dateOrder/);
  assert.throws(() => taskPayload({ ...input, reviewer: ' Example executor ' }), /separatePeople/);
  assert.throws(() => taskPayload({ ...input, assignee: ' ' }), /invalidData/);
  assert.equal(taskPayload({ ...input, company: '', priority: 'custom' }).priority, 'custom');
});
test('transitions match the backend map for every status without mutating helpers', () => {
  const expected = { todo: ['in_progress', 'blocked'], in_progress: ['to_verify', 'blocked'], to_verify: ['closed', 'blocked'], closed: ['in_progress'], blocked: [] };
  assert.deepEqual(STATUSES, Object.keys(expected));
  for (const status of STATUSES) {
    assert.deepEqual(allowedTransitions({ status }), expected[status]);
    for (const to of STATUSES) {
      const task = { status, reviewer: input.reviewer };
      const payload = { to, actor: input.reviewer, note: 'Checked', reason: 'Example reason' };
      if (expected[status].includes(to)) assert.deepEqual(transitionPayload(task, payload), payload);
      else assert.throws(() => transitionPayload(task, payload), /actionDenied/);
    }
  }
  allowedTransitions({ status: 'todo' }).push('closed');
  assert.deepEqual(allowedTransitions({ status: 'todo' }), expected.todo);
});
test('transitions require note, reason and designated verifier as in the API', () => {
  const task = { status: 'in_progress', reviewer: input.reviewer };
  assert.deepEqual(transitionRequirements(task, 'to_verify'), { note: true, reason: false });
  assert.throws(() => transitionPayload(task, { to: 'to_verify', actor: 'Any person' }), /noteRequired/);
  assert.throws(() => transitionPayload(task, { to: 'blocked', actor: 'Any person', note: 'A note' }), /reasonRequired/);
  assert.throws(() => transitionPayload({ ...task, status: 'closed' }, { to: 'in_progress', actor: 'Any person' }), /reasonRequired/);
  assert.throws(() => transitionPayload({ ...task, status: 'to_verify' }, { to: 'closed', actor: 'Other person', note: 'Checked' }), /verifierRequired/);
  assert.equal(transitionPayload(task, { to: 'to_verify', actor: 'Any person', note: 'Done' }).actor, 'Any person');
});
test('diary maps explicit operational day and shift without unsupported author or task link', () => {
  assert.deepEqual(diaryPayload({ siteId: 'site-example', date: '2026-01-01', shift: 'night', plan: ' Plan ', actual: 'Actual', blockers: 'Delay', next: 'Next', author: 'Ignored', taskId: 'ignored' }), { siteId: 'site-example', operational_date: '2026-01-01', shift: 'night', plan: 'Plan', actual: 'Actual', impediments: 'Delay', next_step: 'Next' });
  assert.throws(() => diaryPayload({ siteId: 'site-example', date: '2026-01-01', shift: 'other' }), /invalidData/);
  assert.throws(() => diaryPayload({ siteId: 'site-example', date: '', shift: 'day' }), /invalidData/);
});
test('review items remain overdue and are not counted as closed', () => {
  assert.deepEqual(counts([{ status: 'to_verify', due: '2026-01-01' }], '2026-01-02'), { execution: 0, review: 1, closed: 0, overdue: 1, blocked: 0 });
  assert.deepEqual(counts([{ status: 'closed', due: '2026-01-01' }, { status: 'blocked', due: null }], '2026-01-02'), { execution: 1, review: 0, closed: 1, overdue: 0, blocked: 1 });
});
test('CSV neutralizes formulas including leading whitespace and quotes correctly', () => {
  assert.equal(csvCell('=1+1'), '"\'=1+1"');
  assert.equal(csvCell(' \t@SUM(A1)'), '"\' \t@SUM(A1)"');
  assert.equal(csvCell('plain "text"'), '"plain ""text"""');
  assert.equal(csvCell('a,b\nnext'), '"a,b\nnext"');
  assert.equal(csvCell(null), '""');
});
test('local dates reject impossible days and retain local calendar semantics', () => {
  assert.equal(validDate('2026-02-30'), false);
  assert.equal(validDate('2024-02-29'), true);
  assert.equal(validDate('2026-13-01'), false);
  assert.equal(today(new Date(2026, 0, 2, 0, 5)), '2026-01-02');
});
