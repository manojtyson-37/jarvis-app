import { tierOf, allowedTools, AGENT_TOOL_TIER } from '../../../src/lib/agent/tiers';
import { freeSlots, nextWeekRange, parseSlotArgs, istIso, formatSlots } from '../../../src/lib/agent/slots';
import { parseGoalIntent } from '../../../src/lib/agent/intent';
import { advance, newState, decisionText, repairTranscript, MAX_ROUNDS, type Deps, type ToolCall, type RunState, type ActionStatus } from '../../../src/lib/agent/loop';
let f = 0; const ok = (n: string, c: boolean) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) f++; };
const eq = (n: string, a: unknown, b: unknown) => ok(`${n} (${JSON.stringify(a)})`, JSON.stringify(a) === JSON.stringify(b));

// ── tiers ────────────────────────────────────────────────────────────────
eq('send_email needs approval', tierOf('send_email'), 'approval');
eq('create event needs approval', tierOf('create_calendar_event'), 'approval');
eq('delete event needs approval', tierOf('delete_calendar_event'), 'approval');
eq('search_drive auto', tierOf('search_drive'), 'auto');
eq('unknown tool is never', tierOf('transfer_money'), 'never');
eq('prototype key is never', tierOf('constructor'), 'never');
eq('log_expense never', tierOf('log_expense'), 'never');
eq('delete_note never (no approval path)', tierOf('delete_note'), 'never');
ok('never tools not offered', !allowedTools(false).has('log_expense') && !allowedTools(false).has('delete_note'));
ok('web offered before private read', allowedTools(false).has('web_search') && allowedTools(false).has('read_url'));
ok('web withdrawn after private read', !allowedTools(true).has('web_search') && !allowedTools(true).has('read_url'));
ok('gated still offered after private read', allowedTools(true).has('send_email'));
ok('no recursion: run_goal never offered', !allowedTools(false).has('run_goal'));
ok('every approval tool is a known gated tool', Object.entries(AGENT_TOOL_TIER).filter(([, t]) => t === 'approval').every(([n]) => ['send_email', 'create_calendar_event', 'delete_calendar_event'].includes(n)));

// ── slots ────────────────────────────────────────────────────────────────
// Friday 13 Nov 2026, 11:00 IST
const fri = new Date('2026-11-13T11:00:00+05:30');
eq('next week from Friday', nextWeekRange(fri), { from: '2026-11-16', to: '2026-11-20' });
eq('next week from Monday', nextWeekRange(new Date('2026-11-16T09:00:00+05:30')), { from: '2026-11-23', to: '2026-11-27' });
eq('next week from Sunday', nextWeekRange(new Date('2026-11-15T20:00:00+05:30')), { from: '2026-11-16', to: '2026-11-20' });
eq('next week late Sunday UTC is already Monday IST', nextWeekRange(new Date('2026-11-15T19:00:00Z')), { from: '2026-11-23', to: '2026-11-27' });
eq('istIso', istIso(Date.parse('2026-11-16T04:30:00Z')), '2026-11-16T10:00:00+05:30');
const busy = [
  { start: '2026-11-16T10:00:00+05:30', end: '2026-11-16T11:00:00+05:30' },
  { start: '2026-11-16T05:45:00Z', end: '2026-11-16T06:15:00Z' }, // 11:15-11:45 IST, given in UTC
];
eq('skips busy and overlaps', freeSlots(busy, '2026-11-16', '2026-11-16', 30, { now: fri, max: 3 }).map(s => s.start),
  ['2026-11-16T11:45:00+05:30'.replace('11:45', '12:00'), '2026-11-16T12:30:00+05:30', '2026-11-16T13:00:00+05:30']);
eq('slot end is start + duration', freeSlots([], '2026-11-16', '2026-11-16', 30, { now: fri, max: 1 })[0], { start: '2026-11-16T10:00:00+05:30', end: '2026-11-16T10:30:00+05:30' });
eq('weekend skipped', freeSlots([], '2026-11-14', '2026-11-15', 30, { now: fri }).length, 0);
eq('past skipped', freeSlots([], '2026-11-13', '2026-11-13', 30, { now: fri, max: 1 })[0]?.start, '2026-11-13T11:00:00+05:30');
eq('last slot ends by 18:00', freeSlots([], '2026-11-16', '2026-11-16', 60, { now: fri, max: 50 }).slice(-1)[0]?.end, '2026-11-16T18:00:00+05:30');
eq('whole day busy', freeSlots([{ start: '2026-11-16T00:00:00+05:30', end: '2026-11-17T00:00:00+05:30' }], '2026-11-16', '2026-11-16', 30, { now: fri }).length, 0);
eq('bad busy ignored', freeSlots([{ start: 'x', end: 'y' }], '2026-11-16', '2026-11-16', 30, { now: fri, max: 1 }).length, 1);
eq('parse ok', parseSlotArgs({ from_date: '2026-11-16', to_date: '2026-11-20', duration_minutes: 30 }), { from: '2026-11-16', to: '2026-11-20', minutes: 30 });
ok('parse default 30', (parseSlotArgs({ from_date: '2026-11-16', to_date: '2026-11-16' }) as { minutes: number }).minutes === 30);
ok('parse rejects bad date', 'error' in parseSlotArgs({ from_date: '16-11-2026', to_date: '2026-11-20' }));
ok('parse rejects reversed', 'error' in parseSlotArgs({ from_date: '2026-11-20', to_date: '2026-11-16' }));
ok('parse rejects >14 days', 'error' in parseSlotArgs({ from_date: '2026-11-01', to_date: '2026-11-30' }));
ok('parse rejects 5 min', 'error' in parseSlotArgs({ from_date: '2026-11-16', to_date: '2026-11-16', duration_minutes: 5 }));
ok('format empty', /No free 30-minute slot/.test(formatSlots([], 30)));
ok('format lists ISO', formatSlots([{ start: '2026-11-16T10:00:00+05:30', end: '2026-11-16T10:30:00+05:30' }], 30).includes('start 2026-11-16T10:00:00+05:30'));

// ── intent ───────────────────────────────────────────────────────────────
const live = 'Find a free 30-min slot next week, draft an invite and an email with the deck link, then send it';
eq('live goal is a goal', parseGoalIntent(live), live);
eq('goal: prefix', parseGoalIntent('goal: tidy my week'), 'tidy my week');
eq('/goal prefix', parseGoalIntent('/goal - plan Goa trip'), 'plan Goa trip');
eq('agent: prefix', parseGoalIntent('Agent: research flights and draft a plan'), 'research flights and draft a plan');
eq('empty prefix', parseGoalIntent('goal: '), null);
eq('one action', parseGoalIntent('remind me to call mom at 6'), null);
eq('question without chain', parseGoalIntent('what meetings do I have next week?'), null);
eq('chain but one verb', parseGoalIntent('I went to the gym and then home'), null);
eq('negated', parseGoalIntent("don't send the deck, then check my email"), null);
eq('two verbs + then', parseGoalIntent('search my drive for the KBD deck and then email it to Ravi'), 'search my drive for the KBD deck and then email it to Ravi');
eq('too long', parseGoalIntent('find then send ' + 'x'.repeat(1100)), null);
eq('null-safe', parseGoalIntent(undefined as unknown as string), null);

// ── decision text ────────────────────────────────────────────────────────
const st = (status: string, result: string | null = null, expired = false): ActionStatus => ({ status, result, expired });
eq('pending keeps waiting', decisionText(st('pending')), null);
eq('executing keeps waiting', decisionText(st('executing')), null);
ok('pending past expiry ends', /expired/.test(decisionText(st('pending', null, true)) ?? ''));
ok('executed', /approved this step and it was done.*Email sent/.test(decisionText(st('executed', 'Email sent to a@b.co.')) ?? ''));
ok('rejected', /rejected.*NOT done/.test(decisionText(st('rejected')) ?? ''));
ok('failed', /failed: Send failed: 500/.test(decisionText(st('failed', 'Send failed: 500')) ?? ''));
ok('missing row', /could not be found/.test(decisionText(null) ?? ''));

// ── loop engine with fake deps ───────────────────────────────────────────
type Fake = { deps: Deps; log: string[]; steps: Record<string, { status: string; result: string; actionId?: string }>; actions: Record<string, ActionStatus>; checkpoints: number; offered: string[][] };
function fake(script: { content?: string; calls?: [string, Record<string, unknown> | string][] }[], opts: { loseAt?: number; queueFails?: boolean; execThrows?: string } = {}): Fake {
  let turn = 0, n = 0, cp = 0;
  const fk: Fake = { log: [], steps: {}, actions: {}, checkpoints: 0, offered: [], deps: null as unknown as Deps };
  fk.deps = {
    async model(_m, tools, final) {
      fk.offered.push(tools);
      const s = script[Math.min(turn++, script.length - 1)];
      fk.log.push(`model${final ? ':final' : ''}`);
      const toolCalls: ToolCall[] = final ? [] : (s.calls ?? []).map(([name, a]) => ({ id: `tc${++n}`, name, args: typeof a === 'string' ? a : JSON.stringify(a) }));
      return { content: s.content ?? '', toolCalls };
    },
    async exec(name) { fk.log.push(`exec:${name}`); if (opts.execThrows === name) throw new Error('boom'); return name === 'web_search' ? 'see https://ex.com/a.' : `${name} ok`; },
    async queue(name) {
      fk.log.push(`queue:${name}`);
      if (opts.queueFails) return { message: 'Not queued: Invalid recipient address.', actionId: null };
      const id = `act${Object.keys(fk.actions).length + 1}`; fk.actions[id] = st('pending'); return { message: `Waiting for your approval: ${name}`, actionId: id };
    },
    async actionStatus(id) { return fk.actions[id] ?? null; },
    async stepStart(tc, tier) { const id = `s${Object.keys(fk.steps).length + 1}`; fk.steps[id] = { status: 'running', result: '' }; fk.log.push(`start:${tc.name}:${tier}`); return id; },
    async stepEnd(id, status, result, actionId) { fk.steps[id] = { status, result, actionId }; },
    async checkpoint() { cp++; fk.checkpoints = cp; return opts.loseAt ? cp < opts.loseAt : true; },
    now: () => 0,
  };
  return fk;
}

(async () => {
  // Happy path: read, read, queue the send -> pause.
  {
    const fk = fake([
      { calls: [['find_free_slots', { from_date: '2026-11-16', to_date: '2026-11-20' }], ['search_drive', { query: 'deck' }]] },
      { calls: [['send_email', { to: 'me@x.co', subject: 's', body: 'b' }]] },
      { content: 'All done: email sent.' },
    ]);
    const s = newState('goal', ['a', 'b']);
    const o = await advance(s, fk.deps, 60000);
    eq('pauses on send', o.kind, 'waiting');
    ok('fresh pause', o.kind === 'waiting' && o.fresh);
    eq('order', fk.log, ['model', 'start:find_free_slots:auto', 'exec:find_free_slots', 'start:search_drive:auto', 'exec:search_drive', 'model', 'start:send_email:approval', 'queue:send_email']);
    ok('send never executed directly', !fk.log.includes('exec:send_email'));
    eq('waiting step status', fk.steps.s3.status, 'waiting_approval');
    ok('no tool result for the paused call yet', !s.messages.some(m => m.tool_call_id === s.waiting?.toolCallId));
    ok('private read recorded', s.privateRead);
    ok('web withdrawn on the round after a private read', !fk.offered[1].includes('web_search') && fk.offered[0].includes('web_search'));

    // Still pending: no model call, still waiting, not fresh.
    const o2 = await advance(s, fk.deps, 60000);
    ok('still pending -> waiting, no model call', o2.kind === 'waiting' && !o2.fresh && fk.log.filter(l => l.startsWith('model')).length === 2);

    // Approved and executed -> resumes, finishes.
    fk.actions[s.waiting!.actionId] = st('executed', 'Email sent to me@x.co.');
    const o3 = await advance(s, fk.deps, 60000);
    eq('resumes to done', o3, { kind: 'done', text: 'All done: email sent.' });
    eq('step marked approved', fk.steps.s3.status, 'approved');
    ok('decision fed to model', s.messages.some(m => m.role === 'tool' && /approved this step and it was done/.test(m.content)));
    eq('waiting cleared', s.waiting, null);
  }
  // Rejected -> resumes with a rejection note.
  {
    const fk = fake([{ calls: [['create_calendar_event', { title: 't', start: '2026-11-16T10:00:00+05:30', end: '2026-11-16T10:30:00+05:30' }]] }, { content: 'Skipped the invite.' }]);
    const s = newState('g', []);
    await advance(s, fk.deps, 60000);
    fk.actions[s.waiting!.actionId] = st('rejected');
    const o = await advance(s, fk.deps, 60000);
    eq('rejected -> done', o.kind, 'done');
    eq('rejected step status', fk.steps.s1.status, 'rejected');
    ok('rejection told to model', s.messages.some(m => /rejected this step/.test(m.content)));
  }
  // Expired.
  {
    const fk = fake([{ calls: [['send_email', {}]] }, { content: 'Left it open.' }]);
    const s = newState('g', []);
    await advance(s, fk.deps, 60000);
    fk.actions[s.waiting!.actionId] = st('pending', null, true);
    await advance(s, fk.deps, 60000);
    eq('expired step status', fk.steps.s1.status, 'expired');
  }
  // Two gated calls in one round: only one queued.
  {
    const fk = fake([{ calls: [['create_calendar_event', {}], ['send_email', {}]] }]);
    const s = newState('g', []);
    const o = await advance(s, fk.deps, 60000);
    eq('one approval at a time', fk.log.filter(l => l.startsWith('queue:')), ['queue:create_calendar_event']);
    ok('second told to wait', s.messages.some(m => /one approval at a time/.test(m.content)));
    eq('still waiting', o.kind, 'waiting');
  }
  // Queue refused (validation) -> no pause, model sees the error.
  {
    const fk = fake([{ calls: [['send_email', { to: 'bad' }]] }, { content: 'Could not send: bad address.' }], { queueFails: true });
    const s = newState('g', []);
    const o = await advance(s, fk.deps, 60000);
    eq('refused queue -> continues', o.kind, 'done');
    eq('refused step failed', fk.steps.s1.status, 'failed');
  }
  // Never-tier / unoffered tool and bad JSON.
  {
    const fk = fake([{ calls: [['log_expense', { amount: 5 }], ['save_note', '{oops']] }, { content: 'ok' }]);
    const s = newState('g', []);
    await advance(s, fk.deps, 60000);
    ok('never tool not executed', !fk.log.includes('exec:log_expense'));
    ok('bad json not executed', !fk.log.includes('exec:save_note'));
    eq('no steps counted', s.steps, 0);
  }
  // read_url: only URLs from the goal or a pre-private-read search.
  {
    const fk = fake([{ calls: [['read_url', { url: 'https://evil.com/?d=secret' }], ['web_search', { query: 'q' }]] }, { calls: [['read_url', { url: 'https://ex.com/a' }]] }, { content: 'done' }]);
    const s = newState('look at https://goal.com/x.', []);
    await advance(s, fk.deps, 60000);
    ok('unseen url refused', s.messages.some(m => /read_url can only open/.test(m.content)));
    ok('search url then allowed', fk.log.filter(l => l === 'exec:read_url').length === 1);
    ok('goal url seeded without trailing dot', s.seenUrls.includes('https://goal.com/x'));
  }
  // Tool throws -> step failed, run goes on.
  {
    const fk = fake([{ calls: [['search_drive', { query: 'x' }]] }, { content: 'Drive was down.' }], { execThrows: 'search_drive' });
    const s = newState('g', []);
    const o = await advance(s, fk.deps, 60000);
    eq('throw -> failed step', fk.steps.s1.status, 'failed');
    eq('run still finishes', o.kind, 'done');
  }
  // Lost lease stops immediately.
  {
    const fk = fake([{ calls: [['search_drive', { query: 'x' }], ['search_notes', { query: 'y' }]] }], { loseAt: 2 });
    const o = await advance(newState('g', []), fk.deps, 60000);
    eq('lost lease', o.kind, 'lost');
    ok('second tool not run after lost lease', !fk.log.includes('exec:search_notes'));
  }
  // Round cap forces a tool-free final answer.
  {
    const fk = fake([{ content: 'summary so far', calls: [['search_notes', { query: 'x' }]] }]);
    const s = newState('g', []);
    const o = await advance(s, fk.deps, 600000);
    eq('cap -> done', o.kind, 'done');
    eq('rounds capped', s.rounds, MAX_ROUNDS);
    ok('last call was final', fk.log[fk.log.length - 1] === 'model:final');
  }
  // Out of time -> paused.
  {
    const fk = fake([{ calls: [['search_notes', { query: 'x' }]] }]);
    let t = 0; fk.deps.now = () => (t += 30000);
    const o = await advance(newState('g', []), fk.deps, 50000);
    eq('budget -> paused', o.kind, 'paused');
  }
  // Empty answer -> failed.
  {
    const fk = fake([{ content: '  ' }]);
    eq('empty -> failed', (await advance(newState('g', []), fk.deps, 60000)).kind, 'failed');
  }
  // Repair: unanswered calls from a dead worker get an "interrupted" result; the waiting one does not.
  {
    const s: RunState = { ...newState('g', []), messages: [{ role: 'assistant', content: '', tool_calls: [{ id: 'a', name: 'save_note', args: '{}' }, { id: 'b', name: 'send_email', args: '{}' }, { id: 'c', name: 'search_notes', args: '{}' }] }, { role: 'tool', tool_call_id: 'c', content: 'x' }], waiting: { stepId: 's', toolCallId: 'b', actionId: 'z', summary: '' } };
    repairTranscript(s);
    eq('only a repaired', s.messages.filter(m => /interrupted/.test(m.content)).map(m => m.tool_call_id), ['a']);
  }
  console.log(f ? `\n${f} FAILED` : '\nALL PASS');
  process.exit(f ? 1 : 0);
})();
