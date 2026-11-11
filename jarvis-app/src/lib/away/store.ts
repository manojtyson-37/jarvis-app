// Away Mode persistence (server-only, service-role client). Tables: away_sessions, escalation_rules, agent_actions.
import 'server-only';
import { supabase } from '@/lib/supabase';
import { DEFAULT_THRESHOLD_INR, SHADOW_HOURS, STALE_CLAIM_MS, canTakeOver, type EscalationRule } from './policy';
import type { ActionPatch, AwaySession } from './engine';
import { mergeDraftsIntoRows, type DigestRow, type DraftRef } from './digest';

const DUPLICATE = '23505';

type SessionRow = { id: string; user_id: string; status: AwaySession['status']; starts_at: string; ends_at: string; shadow_until: string; threshold_inr: number | string };
const toSession = (r: SessionRow): AwaySession => ({
  id: r.id, userId: r.user_id, status: r.status, startsAt: new Date(r.starts_at), endsAt: new Date(r.ends_at),
  shadowUntil: new Date(r.shadow_until), thresholdInr: Number(r.threshold_inr),
});

export async function getActiveSession(userId: string): Promise<AwaySession | null> {
  const { data, error } = await supabase.from('away_sessions').select('*').eq('user_id', userId).eq('status', 'active').maybeSingle();
  if (error) throw error;
  return data ? toSession(data as SessionRow) : null;
}

async function latestThreshold(userId: string): Promise<number> {
  const { data } = await supabase.from('away_sessions').select('threshold_inr').eq('user_id', userId).order('created_at', { ascending: false }).limit(1).maybeSingle();
  return data ? Number(data.threshold_inr) : DEFAULT_THRESHOLD_INR;
}

// Starts a trip, or extends the active one (shadow period is never reset by extending). A threshold given now is kept
// for the next trip too, because a new session inherits the previous session's threshold.
export async function startSession(userId: string, until: Date, thresholdInr?: number): Promise<{ session: AwaySession; extended: boolean }> {
  const existing = await getActiveSession(userId);
  if (existing) {
    const patch: Record<string, unknown> = { ends_at: until.toISOString() };
    if (thresholdInr) patch.threshold_inr = thresholdInr;
    const { data, error } = await supabase.from('away_sessions').update(patch).eq('id', existing.id).eq('status', 'active').select('*').single();
    if (error) throw error;
    return { session: toSession(data as SessionRow), extended: true };
  }
  const now = new Date();
  const { data, error } = await supabase.from('away_sessions').insert({
    user_id: userId, starts_at: now.toISOString(), ends_at: until.toISOString(),
    shadow_until: new Date(now.getTime() + SHADOW_HOURS * 3_600_000).toISOString(),
    threshold_inr: thresholdInr ?? await latestThreshold(userId),
  }).select('*').single();
  if (error) {
    if ((error as { code?: string }).code === DUPLICATE) return startSession(userId, until, thresholdInr); // raced with another start
    throw error;
  }
  return { session: toSession(data as SessionRow), extended: false };
}

export async function endSession(id: string, status: 'ended' | 'killed'): Promise<void> {
  const { error } = await supabase.from('away_sessions').update({ status, ended_at: new Date().toISOString() }).eq('id', id).eq('status', 'active');
  if (error) throw error;
}

// Changes the threshold of the active trip. Returns false when no trip is active (nothing to change).
export async function setThreshold(userId: string, thresholdInr: number): Promise<boolean> {
  const { data, error } = await supabase.from('away_sessions').update({ threshold_inr: thresholdInr }).eq('user_id', userId).eq('status', 'active').select('id');
  if (error) throw error;
  return !!data?.length;
}

export async function listRules(userId: string): Promise<EscalationRule[]> {
  const { data, error } = await supabase.from('escalation_rules').select('kind, value, action').eq('user_id', userId).eq('enabled', true);
  if (error) throw error;
  return (data ?? []) as EscalationRule[];
}

// Inserts the "processing" row first, by message id alone (before anything about the message is read). The
// UNIQUE(session_id, message_id) key makes a message claimable exactly once, so overlapping cron runs can never send two
// replies. A row left "processing" past the TTL (the run died or hit its deadline before deciding) is taken over by one
// caller via a compare-and-swap on created_at, unless it had reached the send step: then the email may already be out.
export async function claim(session: AwaySession, messageId: string): Promise<boolean> {
  const { error } = await supabase.from('agent_actions').insert({ session_id: session.id, user_id: session.userId, message_id: messageId });
  if (!error) return true;
  if ((error as { code?: string }).code !== DUPLICATE) throw error;
  const { data: row, error: e2 } = await supabase.from('agent_actions').select('id, decision, reason, created_at').eq('session_id', session.id).eq('message_id', messageId).maybeSingle();
  if (e2) throw e2;
  if (!row || !canTakeOver({ decision: row.decision as string, reason: row.reason as string | null, createdAtMs: new Date(row.created_at as string).getTime() }, Date.now())) return false;
  const { data, error: e3 } = await supabase.from('agent_actions').update({ created_at: new Date().toISOString() })
    .eq('id', row.id as string).eq('decision', 'processing').eq('created_at', row.created_at as string).is('reason', null).select('id');
  if (e3) throw e3;
  return !!data?.length;
}

// Written right before the email is sent. From here on an unfinished row is "outcome unknown", never retried. A
// compare-and-swap on reason IS NULL: of two runs that both hold the claim (one stalled and was overtaken), only the first
// to get here may send; the second throws and sends nothing.
export async function markSending(sessionId: string, messageId: string): Promise<void> {
  const { data, error } = await supabase.from('agent_actions').update({ reason: 'sending' }).eq('session_id', sessionId).eq('message_id', messageId).eq('decision', 'processing').is('reason', null).select('id');
  if (error) throw error;
  if (!data?.length) throw new Error('row is no longer processing, or another run already reached the send step');
}

// Conditional on the row still being "processing": a run that stalled and was overtaken (or already finished) cannot
// overwrite the other run's decision or rewrite decided_at (the draft-ordering key, written exactly once). Zero rows
// updated means the claim was lost, which is an error to the caller.
export async function finish(sessionId: string, messageId: string, p: ActionPatch): Promise<void> {
  const { data, error } = await supabase.from('agent_actions').update({
    decision: p.decision, reason: p.reason?.slice(0, 300) ?? null, reply_text: p.reply ?? null, category: p.category ?? null,
    confidence: p.confidence ?? null, amount_inr: p.amountInr ?? null, summary: p.summary ?? null,
    delivered: p.delivered ?? false, decided_at: new Date().toISOString(),
    ...(p.fromAddr !== undefined ? { from_addr: p.fromAddr.toLowerCase() } : {}),
    ...(p.subject !== undefined ? { subject: p.subject.slice(0, 300) } : {}),
    ...(p.threadId !== undefined ? { thread_id: p.threadId } : {}),
  }).eq('session_id', sessionId).eq('message_id', messageId).eq('decision', 'processing').select('id');
  if (error) throw error;
  if (!data?.length) throw new Error('claim lost: this message was already decided by another run');
}

export async function alreadyHandled(sessionId: string, ids: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  const now = Date.now();
  for (let i = 0; i < ids.length; i += 100) { // chunked: a long IN list would overflow the request URL
    const { data, error } = await supabase.from('agent_actions').select('message_id, decision, reason, created_at').eq('session_id', sessionId).in('message_id', ids.slice(i, i + 100));
    if (error) throw error;
    // A stale unfinished claim is not "handled": it is offered again so the run can take it over.
    for (const r of data ?? []) {
      if (!canTakeOver({ decision: r.decision as string, reason: r.reason as string | null, createdAtMs: new Date(r.created_at as string).getTime() }, now)) out.add(r.message_id as string);
    }
  }
  return out;
}

export async function repliedRecently(sessionId: string, fromAddr: string, sinceMs: number): Promise<boolean> {
  const { count, error } = await supabase.from('agent_actions').select('id', { count: 'exact', head: true })
    .eq('session_id', sessionId).eq('from_addr', fromAddr.toLowerCase()).eq('decision', 'auto_reply').eq('delivered', true)
    .gte('created_at', new Date(sinceMs).toISOString());
  if (error) throw error;
  return (count ?? 0) > 0;
}

export async function autoRepliesSince(sessionId: string, sinceMs: number): Promise<number> {
  const { count, error } = await supabase.from('agent_actions').select('id', { count: 'exact', head: true })
    .eq('session_id', sessionId).eq('decision', 'auto_reply').eq('delivered', true).gte('created_at', new Date(sinceMs).toISOString());
  if (error) throw error;
  return count ?? 0;
}

// Model calls made recently: every row where the model was asked carries a category (a failed call is "model_error").
export async function modelCallsSince(sessionId: string, sinceMs: number): Promise<number> {
  const { count, error } = await supabase.from('agent_actions').select('id', { count: 'exact', head: true })
    .eq('session_id', sessionId).not('category', 'is', null).gte('created_at', new Date(sinceMs).toISOString());
  if (error) throw error;
  return count ?? 0;
}

type ActionRow = { id: string; message_id: string; thread_id: string | null; from_addr: string | null; subject: string | null; decision: string; summary: string | null; reason: string | null; reply_text: string | null; delivered: boolean; created_at: string };

// Rows for the report, plus every pending draft of the trip with its permanent number (see digest.ts). A row stuck in
// "processing" past the TTL is surfaced as needing a manual look instead of being hidden: if it reached the send step
// the outcome is unknown, otherwise it simply was not processed and will be retried.
export async function digestRows(sessionId: string, sinceIso?: string): Promise<DigestRow[]> {
  let q = supabase.from('agent_actions').select('id, message_id, thread_id, from_addr, subject, decision, summary, reason, reply_text, delivered, created_at').eq('session_id', sessionId).order('created_at', { ascending: true }).limit(500);
  if (sinceIso) q = q.gte('created_at', sinceIso);
  const { data, error } = await q;
  if (error) throw error;
  const out: DigestRow[] = [];
  for (const r of (data ?? []) as ActionRow[]) {
    let decision = r.decision as DigestRow['decision'] | 'processing';
    let reason = r.reason ?? '';
    if (decision === 'processing') {
      if (Date.now() - new Date(r.created_at).getTime() < STALE_CLAIM_MS) continue;
      decision = 'failed';
      reason = reason === 'sending' ? 'Outcome unknown: the server stopped mid-action. Check your Sent mail before retrying.' : 'Not processed yet: the run stopped before reading it. It will be retried.';
    }
    out.push({ id: r.id, decision, from: r.from_addr ?? '', subject: r.subject ?? '(no subject)', summary: r.summary ?? '', reason, reply: r.reply_text ?? undefined, delivered: r.delivered });
  }
  return mergeDraftsIntoRows(out, await listDrafts(sessionId));
}

// Every draft of the trip in the order it became a draft (decided_at, which is written once and never touched again,
// id as tie-break), sent ones included, numbered from 1. The
// number is a draft's position in that fixed list, so it never changes when other drafts are sent: the numbered report
// and "send draft N" agree for the whole trip.
export async function listDrafts(sessionId: string): Promise<(DraftRef & { messageId: string })[]> {
  const { data, error } = await supabase.from('agent_actions').select('id, message_id, from_addr, subject, reply_text, delivered')
    .eq('session_id', sessionId).eq('decision', 'draft').not('reply_text', 'is', null).order('decided_at', { ascending: true }).order('id', { ascending: true });
  if (error) throw error;
  return (data ?? []).map((r, i) => ({ id: r.id as string, n: i + 1, messageId: r.message_id as string, from: (r.from_addr as string) ?? '', subject: (r.subject as string) ?? '', reply: (r.reply_text as string) ?? '', delivered: !!r.delivered }));
}

// Atomic: only one caller can move a draft from undelivered to delivered, so a double "send draft 2" sends once.
export async function claimDraft(id: string): Promise<boolean> {
  const { data, error } = await supabase.from('agent_actions').update({ delivered: true }).eq('id', id).eq('decision', 'draft').eq('delivered', false).select('id');
  if (error) throw error;
  return !!data?.length;
}
export async function releaseDraft(id: string): Promise<void> {
  await supabase.from('agent_actions').update({ delivered: false }).eq('id', id).eq('decision', 'draft');
}

// ── FAQ: the only business knowledge Maya may answer strangers from (besides redacted past replies) ──
// Stored in maya_memory with category "faq"; written only from Manoj's own typed "FAQ: ..." message.
export interface FaqRow { id: string; fact: string }

export async function listFaqs(userId: string): Promise<FaqRow[]> {
  const { data, error } = await supabase.from('maya_memory').select('id, fact').eq('user_id', userId).eq('category', 'faq').eq('active', true).order('updated_at', { ascending: true }).limit(60);
  if (error) throw error;
  return (data ?? []) as FaqRow[];
}
export async function addFaq(userId: string, fact: string): Promise<boolean> {
  const existing = await listFaqs(userId);
  if (existing.some(f => f.fact.trim().toLowerCase() === fact.trim().toLowerCase())) return false;
  const { error } = await supabase.from('maya_memory').insert({ user_id: userId, fact: fact.trim(), category: 'faq' });
  if (error) throw error;
  return true;
}
export async function removeFaq(userId: string, id: string): Promise<void> {
  const { error } = await supabase.from('maya_memory').update({ active: false }).eq('id', id).eq('user_id', userId).eq('category', 'faq');
  if (error) throw error;
}
