// @ts-nocheck: run with `node --experimental-strip-types`, which needs the explicit .ts import path that tsc rejects.
import { stuckTodos, nudgePush, NUDGE_AFTER_DAYS, MAX_NUDGES_PER_RUN } from '../../../src/lib/todos/nudge-rules.ts';
let f = 0; const ok = (n: string, c: boolean) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) f++; };
const eq = (n: string, a: unknown, b: unknown) => ok(`${n} (${JSON.stringify(a)})`, JSON.stringify(a) === JSON.stringify(b));

const NOW = Date.parse('2026-11-20T06:00:00Z');
const RUNNER_SINCE = '2026-11-12T00:00:00Z';
const SOURCES = ['chat', 'checkin', 'email', 'meeting', 'assistant'];
const day = (n: number) => new Date(NOW - n * 86_400_000).toISOString();
const row = (id: string, o: Record<string, unknown> = {}) => ({ id, text: `task ${id}`, status: 'pending', created_at: day(5), source: 'chat', ...o });
const pick = (rows: unknown[], nudged = new Set<string>()) => stuckTodos(rows, NOW, nudged, RUNNER_SINCE, SOURCES).map(r => r.id);

eq('threshold is 3 days', NUDGE_AFTER_DAYS, 3);
eq('old enough, open: nudged', pick([row('a')]), ['a']);
eq('too new: not nudged', pick([row('a', { created_at: day(2) })]), []);
eq('exactly 3 days: nudged', pick([row('a', { created_at: day(3) })]), ['a']);
eq('awaiting approval counts', pick([row('a', { status: 'awaiting_approval' })]), ['a']);
eq('done is not stuck', pick([row('a', { status: 'done' })]), []);
eq('running is not stuck', pick([row('a', { status: 'running' })]), []);
eq('failed is not stuck', pick([row('a', { status: 'failed' })]), []);
eq('manual is not nudged (already told)', pick([row('a', { status: 'manual' })]), []);
eq('pre-runner to-do never nudged', pick([row('a', { created_at: '2026-10-01T00:00:00Z' })]), []);
eq('unrunnable source never nudged', pick([row('a', { source: 'freshdesk' })]), []);
eq('already nudged: never again', pick([row('a')], new Set(['a'])), []);
eq('bad timestamp skipped', pick([row('a', { created_at: 'nope' })]), []);
eq('oldest first, capped per run', pick([row('a', { created_at: day(4) }), row('b', { created_at: day(7) }), row('c', { created_at: day(6) })]), ['b', 'c']);
eq('cap constant', MAX_NUDGES_PER_RUN, 2);

const p = nudgePush(row('x', { text: 'research Groq pricing\n\nfor  the team', created_at: day(4) }), NOW);
ok('push title shows age', p.title === 'Maya · To-do still open 4 days');
ok('push body is one line', !/\n/.test(p.body) && p.body.startsWith('research Groq pricing for the team.'));
ok('push tag is per item', p.tag === 'todo-nudge-x');
const w = nudgePush(row('y', { status: 'awaiting_approval', created_at: day(3) }), NOW);
ok('awaiting title', w.title.startsWith('Maya · To-do waiting for your approval 3 days'));
const em = nudgePush(row('e', { text: 'reply to Ravi about the SECRET EMAIL BODY', source: 'email', created_at: day(4) }), NOW);
ok('email-sourced to-do body is generic, not its text', !em.body.includes('SECRET EMAIL BODY') && em.body.startsWith('A to-do from your email'));
const long = nudgePush(row('z', { text: 'q'.repeat(500), created_at: day(3) }), NOW);
ok('long text clipped', long.body.length < 200);

console.log(f === 0 ? 'ALL PASS' : `${f} FAILED`);
if (f) process.exit(1);
