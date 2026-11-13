// @ts-nocheck: run with `node --experimental-strip-types`, which needs the explicit .ts import path that tsc rejects.
import { petRowId, petStatus, parseReport, toRow, formatTaskList, isTaskListQuestion, TASK_LIST_RE, MAX_REPORT, PET_SOURCE } from '../../../src/lib/tasks/rules.ts';
import { stuckTodos } from '../../../src/lib/todos/nudge-rules.ts';
let f = 0; const ok = (n: string, c: boolean) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) f++; };
const eq = (n: string, a: unknown, b: unknown) => ok(`${n} (${JSON.stringify(a)})`, JSON.stringify(a) === JSON.stringify(b));

// ── row id ──────────────────────────────────────────────────────────────
const id = petRowId('20261111-143005-a3f1');
ok('row id is a UUID', /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id));
eq('same pet id, same row', petRowId('20261111-143005-a3f1'), id);
ok('different pet id, different row', petRowId('20261111-143005-a3f2') !== id);

// ── state mapping ───────────────────────────────────────────────────────
eq('states', ['queued', 'running', 'needsApproval', 'done', 'failed', 'cancelled'].map(petStatus), ['in_progress', 'in_progress', 'awaiting_approval', 'done', 'failed', 'skipped']);
ok('a pet task is never "pending", the status the server runner picks up', !['queued', 'running', 'needsApproval', 'done', 'failed', 'cancelled'].map(petStatus).includes('pending'));

// ── report parsing ──────────────────────────────────────────────────────
const good = { id: '20261111-143005-a3f1', title: 'Summarise the\nQ3 deck', state: 'running', createdAt: '2026-11-13T05:00:00Z', finishedAt: null, result: 'SECRET FILE CONTENTS', prompt: 'long prompt' };
const p = parseReport({ tasks: [good] });
ok('good report parses', 'tasks' in p && p.tasks.length === 1);
eq('only list fields kept, result and prompt dropped', Object.keys(p.tasks[0]).sort(), ['createdAt', 'finishedAt', 'id', 'state', 'title']);
eq('title is one line', p.tasks[0].title, 'Summarise the Q3 deck');
eq('time normalised', p.tasks[0].createdAt, '2026-11-13T05:00:00.000Z');
eq('not a list', parseReport({ tasks: 'x' }), { error: 'tasks must be a list' });
eq('no body', parseReport(null), { error: 'tasks must be a list' });
eq('too many', parseReport({ tasks: Array.from({ length: MAX_REPORT + 1 }, (_, i) => ({ ...good, id: `task-${i}` })) }), { error: `at most ${MAX_REPORT} tasks per report` });
eq('bad state', parseReport({ tasks: [{ ...good, state: 'pending' }] }), { error: 'bad task state' });
eq('bad id', parseReport({ tasks: [{ ...good, id: "x'); drop" }] }), { error: 'bad task id' });
eq('id must be text', parseReport({ tasks: [{ ...good, id: 42 }] }), { error: 'bad task id' });
eq('null entry', parseReport({ tasks: [null] }), { error: 'bad task id' });
eq('empty title', parseReport({ tasks: [{ ...good, title: '  \n ' }] }), { error: 'task title missing' });
eq('duplicate id counted once', parseReport({ tasks: [good, { ...good, state: 'done' }] }).tasks.length, 1);
eq('bad time becomes null', parseReport({ tasks: [{ ...good, createdAt: 'yesterday' }] }).tasks[0].createdAt, null);
ok('long title clipped', parseReport({ tasks: [{ ...good, title: 'x'.repeat(500) }] }).tasks[0].title.length === 200);
eq('empty list is fine', parseReport({ tasks: [] }), { tasks: [] });

// ── row built from a report ─────────────────────────────────────────────
const now = '2026-11-13T12:00:00.000Z';
const running = toRow(p.tasks[0], now);
eq('running row', [running.source, running.status, running.completed_at, running.text], [PET_SOURCE, 'in_progress', null, 'Mac task: Summarise the Q3 deck']);
eq('running row keeps its start time', running.created_at, '2026-11-13T05:00:00.000Z');
eq('done row uses the finish time', toRow({ ...p.tasks[0], state: 'done', finishedAt: '2026-11-13T06:00:00.000Z' }, now).completed_at, '2026-11-13T06:00:00.000Z');
eq('done row with no finish time uses now', toRow({ ...p.tasks[0], state: 'failed' }, now).completed_at, now);
ok('no start time leaves created_at to the database', !('created_at' in toRow({ ...p.tasks[0], createdAt: null }, now)));

// ── the server never runs or nags about a Mac task ──────────────────────
const old = { id: 'a', text: 'Mac task: x', status: 'awaiting_approval', created_at: '2026-11-13T00:00:00Z', source: PET_SOURCE };
eq('stuck nudge skips pet rows', stuckTodos([old], Date.parse('2026-11-20T00:00:00Z'), new Set(), '2026-11-12T00:00:00Z', ['chat', 'checkin', 'email', 'meeting', 'assistant']).length, 0);

// ── the one list ────────────────────────────────────────────────────────
const list = formatTaskList({
  goals: [{ goal: 'Set up a meeting with Ravi and send the deck', status: 'waiting_approval', created_at: '2026-11-13T05:00:00Z' }],
  todos: [
    { text: 'Mac task: Summarise the Q3 deck', source: 'pet', status: 'in_progress', created_at: '2026-11-13T05:00:00Z' },
    { text: 'Book dentist', source: 'chat', status: 'pending', created_at: '2026-11-12T05:00:00Z' },
  ],
  approvals: 2, doneToday: 4, warnings: [],
});
ok('list counts everything', list.startsWith('3 open tasks across all devices:'));
ok('list shows the goal', list.includes('- Goal (waiting for your approval): Set up a meeting with Ravi and send the deck · 13 Nov'));
ok('list shows the Mac task once, without the prefix twice', list.includes('- Mac task (running): Summarise the Q3 deck · from Mac · 13 Nov'));
ok('list shows the to-do', list.includes('- To-do (waiting to start): Book dentist · from chat · 12 Nov'));
ok('list shows approvals and done', list.includes('2 actions are waiting for your approval.') && list.endsWith('4 finished today.'));
eq('empty list', formatTaskList({ goals: [], todos: [], approvals: 0, doneToday: 0, warnings: [] }), 'No open tasks on any device.\n0 finished today.');
ok('a failed read is said out loud', formatTaskList({ goals: [], todos: [], approvals: 0, doneToday: 0, warnings: ['goals'] }).includes('Could not read: goals.'));
const many = formatTaskList({ goals: [], todos: Array.from({ length: 30 }, (_, i) => ({ text: `t${i}`, source: 'chat', status: 'pending', created_at: '2026-11-13T05:00:00Z' })), approvals: 1, doneToday: 0, warnings: [] });
ok('long list says it is cut', many.startsWith('30 open tasks across all devices (first 25 shown):') && many.split('\n').length === 28);
ok('one approval is singular', many.includes('1 action is waiting for your approval.'));

// ── which messages force the list ───────────────────────────────────────
for (const m of ['What tasks are open?', 'which to-dos are still pending', 'Show my tasks', 'list all my to-dos', 'any open tasks?', 'What are you working on right now?', "what's pending", 'task status', 'show me my to-do list', 'Status of my tasks', 'Hey Maya, what tasks are running across all my devices?', 'show open tasks please'])
  ok(`forces the list: ${m}`, isTaskListQuestion(m));
for (const m of ['Add buy milk to my to-do list', 'Mark the open task done', 'My to-dos: call Ravi, send deck', 'What tasks should I do first?', 'Cancel all open tasks', 'Create a task list for the launch', 'what is pending in my inbox', 'Send Ravi the status of my tasks', 'show my tasks and delete the old ones', "don't show my tasks", 'what are you working on with Ravi tomorrow at 5pm', 'Tell me a joke'])
  ok(`does not force the list: ${m}`, !isTaskListQuestion(m));
ok('loose regex still offers the tool on a mixed message', TASK_LIST_RE.test('show my open tasks and then email Ravi'));

if (f) { console.error(`${f} FAILED`); process.exit(1); }
console.log('all passed');
