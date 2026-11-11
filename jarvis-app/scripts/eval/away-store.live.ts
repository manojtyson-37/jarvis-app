// LIVE check of Away Mode persistence (src/lib/away/store.ts) against the real Supabase DB, as a unique throwaway user.
// Run: nice -n 15 npx tsx scripts/eval/away-store.live.ts
// Data safety: every row is created under one random user_id `cso-eval-away-<8hex>`; direct DB writes and the final
// cleanup are scoped to that user_id only, and cleanup refuses any other id (incl. the -test / -e2e residue ids).
import { readFileSync } from 'fs';
for (const l of readFileSync('.env.local', 'utf8').split('\n')) { const i = l.indexOf('='); if (i > 0 && !l.startsWith('#')) process.env[l.slice(0, i).trim()] ??= l.slice(i + 1).trim().replace(/^"|"$/g, ''); }

const PREFIX = 'cso-eval-away-';
const UID = PREFIX + [...crypto.getRandomValues(new Uint8Array(4))].map(b => b.toString(16).padStart(2, '0')).join('');

let f = 0; const ok = (n: string, v: boolean) => { console.log((v ? 'PASS ' : 'FAIL ') + n); if (!v) f++; };
const throwsMsg = async (fn: () => Promise<unknown>): Promise<string | null> => { try { await fn(); return null; } catch (e) { return (e as Error).message ?? String(e); } };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function stubServerOnly() { // `server-only` throws outside a React server build; make it a no-op for this script
  const req = typeof require === 'function' ? require : null;
  if (!req) throw new Error('cannot stub server-only: no require');
  const p = req.resolve('server-only');
  req.cache[p] = { id: p, filename: p, loaded: true, exports: {} } as unknown as NodeJS.Module;
}

async function main() {
  if (!UID.startsWith(PREFIX) || UID.endsWith('-test') || UID.endsWith('-e2e') || UID.length !== PREFIX.length + 8) throw new Error('bad eval user id ' + UID);
  console.log('eval user_id = ' + UID);
  stubServerOnly();
  const store = await import('../../src/lib/away/store');
  const { supabase } = await import('../../src/lib/supabase');
  const { STALE_CLAIM_MS, SHADOW_HOURS } = await import('../../src/lib/away/policy');

  let sessionId: string | null = null;
  const rowOf = async (messageId: string) => {
    const { data, error } = await supabase.from('agent_actions').select('id, decision, reason, created_at').eq('session_id', sessionId!).eq('user_id', UID).eq('message_id', messageId).single();
    if (error) throw error; return data!;
  };
  const makeStale = async (messageId: string) => { // direct update, scoped to our own row id AND user_id
    const r = await rowOf(messageId);
    const { error } = await supabase.from('agent_actions').update({ created_at: new Date(Date.now() - (STALE_CLAIM_MS + 60_000)).toISOString() }).eq('id', r.id).eq('user_id', UID);
    if (error) throw error;
  };

  try {
    // ── startSession / extend ──
    const t0 = Date.now();
    const until1 = new Date(t0 + 3 * 86_400_000), until2 = new Date(t0 + 5 * 86_400_000);
    const first = await store.startSession(UID, until1, 12345);
    sessionId = first.session.id;
    ok('startSession: new, not extended', first.extended === false);
    ok('startSession: threshold kept', first.session.thresholdInr === 12345);
    ok('startSession: shadow ~ SHADOW_HOURS ahead', Math.abs(first.session.shadowUntil.getTime() - (first.session.startsAt.getTime() + SHADOW_HOURS * 3_600_000)) < 2000);
    ok('getActiveSession returns it', (await store.getActiveSession(UID))?.id === sessionId);
    await sleep(50);
    const ext = await store.startSession(UID, until2);
    ok('startSession again: extended same session', ext.extended === true && ext.session.id === sessionId);
    ok('extend: ends_at moved', Math.abs(ext.session.endsAt.getTime() - until2.getTime()) < 1000);
    ok('extend: shadow_until NOT reset', ext.session.shadowUntil.getTime() === first.session.shadowUntil.getTime());
    ok('extend: starts_at unchanged', ext.session.startsAt.getTime() === first.session.startsAt.getTime());
    ok('extend: threshold unchanged when not given', ext.session.thresholdInr === 12345);
    const session = ext.session;

    // ── claim ──
    ok('claim: first call true', await store.claim(session, 'm-claim') === true);
    ok('claim: second call false', await store.claim(session, 'm-claim') === false);
    ok('claim: fresh processing row is "handled"', (await store.alreadyHandled(session.id, ['m-claim'])).has('m-claim'));

    // ── stale takeover ──
    await store.claim(session, 'm-stale');
    ok('claim: fresh row not taken over', await store.claim(session, 'm-stale') === false);
    await makeStale('m-stale');
    ok('alreadyHandled: stale processing row is offered again', !(await store.alreadyHandled(session.id, ['m-stale'])).has('m-stale'));
    const race = await Promise.all([store.claim(session, 'm-stale'), store.claim(session, 'm-stale')]);
    ok('stale takeover: exactly one of two concurrent claims wins', race.filter(Boolean).length === 1);
    ok('stale takeover: later claim false (created_at refreshed)', await store.claim(session, 'm-stale') === false);
    ok('stale takeover: row is handled again after takeover', (await store.alreadyHandled(session.id, ['m-stale'])).has('m-stale'));

    // ── sending is never taken over ──
    await store.claim(session, 'm-send');
    await store.markSending(session.id, 'm-send');
    await makeStale('m-send');
    ok('sending+stale: claim is false (never taken over)', await store.claim(session, 'm-send') === false);
    ok('sending+stale: concurrent claims all false', (await Promise.all([store.claim(session, 'm-send'), store.claim(session, 'm-send')])).every(v => v === false));
    ok('sending+stale: alreadyHandled still true', (await store.alreadyHandled(session.id, ['m-send'])).has('m-send'));
    ok('sending+stale: row untouched (reason sending, still processing)', (await rowOf('m-send')).reason === 'sending');

    // ── markSending CAS ──
    await store.claim(session, 'm-cas');
    ok('markSending: first call resolves', (await throwsMsg(() => store.markSending(session.id, 'm-cas'))) === null);
    ok('markSending: second call throws', (await throwsMsg(() => store.markSending(session.id, 'm-cas'))) !== null);
    const raceMs = await store.claim(session, 'm-cas2');
    const msRes = await Promise.all([throwsMsg(() => store.markSending(session.id, 'm-cas2')), throwsMsg(() => store.markSending(session.id, 'm-cas2'))]);
    ok('markSending: concurrent, exactly one resolves', raceMs && msRes.filter(m => m === null).length === 1);
    await store.claim(session, 'm-cas3'); await store.finish(session.id, 'm-cas3', { decision: 'ignore', reason: 'x' });
    ok('markSending: throws on an already finished row', (await throwsMsg(() => store.markSending(session.id, 'm-cas3'))) !== null);

    // ── finish conditional ──
    await store.claim(session, 'm-fin');
    ok('finish: first call ok', (await throwsMsg(() => store.finish(session.id, 'm-fin', { decision: 'escalate_now', reason: 'first', fromAddr: 'A@B.com', subject: 's', category: 'c' }))) === null);
    const second = await throwsMsg(() => store.finish(session.id, 'm-fin', { decision: 'ignore', reason: 'second' }));
    ok("finish: second call throws 'claim lost'", !!second && second.includes('claim lost'));
    const fin = (await supabase.from('agent_actions').select('decision, reason, from_addr').eq('session_id', session.id).eq('user_id', UID).eq('message_id', 'm-fin').single()).data;
    ok('finish: first decision preserved, from_addr lowercased', fin?.decision === 'escalate_now' && fin?.reason === 'first' && fin?.from_addr === 'a@b.com');

    // ── drafts numbering ──
    for (const m of ['d1', 'd2', 'd3']) await store.claim(session, m); // claim order d1,d2,d3
    for (const m of ['d2', 'd1', 'd3']) { // decided order d2,d1,d3 -> numbers follow decided_at
      await store.finish(session.id, m, { decision: 'draft', reply: 'reply ' + m, fromAddr: m + '@x.com', subject: 'subj ' + m });
      await sleep(30);
    }
    const nums = (ds: { messageId: string; n: number }[]) => ds.map(d => `${d.messageId}:${d.n}`).join(',');
    const before = await store.listDrafts(session.id);
    ok('listDrafts: numbered 1..3 in decided_at order', nums(before) === 'd2:1,d1:2,d3:3');
    const target = before.find(d => d.messageId === 'd1')!;
    ok('claimDraft: first true', await store.claimDraft(target.id) === true);
    ok('claimDraft: second false', await store.claimDraft(target.id) === false);
    const after = await store.listDrafts(session.id);
    ok('listDrafts: numbering stable after one delivered', nums(after) === 'd2:1,d1:2,d3:3');
    ok('listDrafts: delivered flag reflected', after.find(d => d.messageId === 'd1')?.delivered === true && after.find(d => d.messageId === 'd2')?.delivered === false);
    await store.releaseDraft(target.id);
    ok('releaseDraft: draft undelivered again, numbering stable', nums(await store.listDrafts(session.id)) === 'd2:1,d1:2,d3:3' && (await store.claimDraft(target.id)) === true);

    // ── alreadyHandled ──
    const h = await store.alreadyHandled(session.id, ['m-claim', 'd1', 'm-fin', 'never-seen']);
    ok('alreadyHandled: known ids in, unknown id out', h.has('m-claim') && h.has('d1') && h.has('m-fin') && !h.has('never-seen') && h.size === 3);
    ok('alreadyHandled: empty list ok', (await store.alreadyHandled(session.id, [])).size === 0);
    const many = Array.from({ length: 230 }, (_, i) => 'bulk-' + i).concat(['m-fin']);
    ok('alreadyHandled: >100 ids chunked', (await store.alreadyHandled(session.id, many)).has('m-fin'));

    // ── endSession ──
    await store.endSession(session.id, 'ended');
    ok('endSession: no active session afterwards', (await store.getActiveSession(UID)) === null);
    const ended = (await supabase.from('away_sessions').select('status, ended_at').eq('id', session.id).eq('user_id', UID).single()).data;
    ok('endSession: status ended with ended_at', ended?.status === 'ended' && !!ended?.ended_at);
    await store.endSession(session.id, 'killed'); // must not overwrite an ended session
    ok('endSession: second call does not overwrite status', ((await supabase.from('away_sessions').select('status').eq('id', session.id).single()).data?.status) === 'ended');
    const restart = await store.startSession(UID, new Date(Date.now() + 86_400_000));
    ok('startSession after end: new session inherits latest threshold', restart.extended === false && restart.session.id !== session.id && restart.session.thresholdInr === 12345);
    await store.endSession(restart.session.id, 'ended');
  } catch (e) {
    console.log('FAIL unexpected error: ' + ((e as Error).stack ?? e));
    f++;
  } finally {
    // Cleanup: ONLY rows with our own unique user_id.
    try {
      if (!UID.startsWith(PREFIX) || UID === PREFIX + 'test' || UID === PREFIX + 'e2e' || UID.endsWith('-test') || UID.endsWith('-e2e')) throw new Error('refusing cleanup for id ' + UID);
      const { supabase } = await import('../../src/lib/supabase');
      const a0 = await supabase.from('agent_actions').select('id', { count: 'exact', head: true }).eq('user_id', UID);
      const s0 = await supabase.from('away_sessions').select('id', { count: 'exact', head: true }).eq('user_id', UID);
      console.log(`before cleanup (user_id=${UID} only): agent_actions=${a0.count} away_sessions=${s0.count}`);
      if (a0.error || s0.error) throw a0.error ?? s0.error;
      const da = await supabase.from('agent_actions').delete().eq('user_id', UID).select('id');
      if (da.error) throw da.error;
      const ds = await supabase.from('away_sessions').delete().eq('user_id', UID).select('id');
      if (ds.error) throw ds.error;
      console.log(`removed: agent_actions=${da.data?.length} away_sessions=${ds.data?.length}`);
      ok('cleanup removed exactly the counted rows', da.data?.length === a0.count && ds.data?.length === s0.count);
      const a1 = await supabase.from('agent_actions').select('id', { count: 'exact', head: true }).eq('user_id', UID);
      const s1 = await supabase.from('away_sessions').select('id', { count: 'exact', head: true }).eq('user_id', UID);
      ok('cleanup left 0 rows for eval user', a1.count === 0 && s1.count === 0);
    } catch (e) { console.log('FAIL cleanup: ' + ((e as Error).message ?? e)); f++; }
  }
  console.log(f ? `\n${f} FAILED` : '\nALL PASS');
  process.exit(f ? 1 : 0);
}
main();
