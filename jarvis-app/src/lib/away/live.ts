// Away Mode wired to the real world: Gmail, Claude, the database, push and Telegram. Everything decision-related stays in
// policy.ts / engine.ts; this file only plugs the I/O in.
import 'server-only';
import { llm as claude } from '@/lib/llm';
import { getInboundMessage, listMessageIds, getOwnAddress, sendReplyInThread, fetchMessageSummaries, getEmail } from '@/lib/gmail';
import { inboxSubjectWords } from '@/lib/grounded';
import { sendPush } from '@/lib/push';
import { sendTelegram } from '@/lib/telegram';
import { mapLimit } from '@/lib/concurrency';
import { runAway, type AwayDeps, type AwaySession, type InboundMsg, type RunResult } from './engine';
import { replyTarget } from './policy';
import { formatDigest } from './digest';
import * as store from './store';

// maxRetries 0: a hidden SDK backoff would eat the cron's time budget; the fallback model is the retry.
// Claude via src/lib/llm.ts (no SDK retries); the old name keeps the call below unchanged.
const groq = claude;
export const RUN_BUDGET_MS = 45_000;
const MODELS = ['claude-haiku-5-5', 'claude-sonnet-5-5'];

async function llm(system: string, user: string, maxTokens: number): Promise<string> {
  let last: unknown;
  for (const [i, model] of MODELS.entries()) {
    try {
      const c = await groq.chat.completions.create({
        model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], temperature: 0,
        max_tokens: i === 0 ? maxTokens : maxTokens + 500, // headroom for the fallback model's longer replies
        ...(i === 0 ? {} : { reasoning_effort: 'low' as const }),
      });
      const text = c.choices[0]?.message?.content ?? '';
      if (text.trim()) return text;
    } catch (e) { last = e; }
  }
  throw last ?? new Error('empty model answer');
}

// Contact details, long numbers and addresses stripped from past replies: they show tone and wording, never another
// person's details.
const redact = (t: string) => t
  .replace(/[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+/g, '[email]')
  .replace(/https?:\/\/\S+/g, '[link]')
  .replace(/\+?\d[\d\s().-]{6,}\d/g, '[number]');

// What Maya may answer from: Manoj's own typed FAQ entries, plus a few of his past sent replies on the same subject
// (redacted). Never his general memory, which holds private facts.
async function knowledgeFor(userId: string, msg: InboundMsg): Promise<string> {
  const faqs = await store.listFaqs(userId);
  const parts: string[] = [];
  if (faqs.length) parts.push(`FAQ (from Manoj):\n${faqs.map(f => `- ${f.fact}`).join('\n')}`);

  const words = inboxSubjectWords(`${msg.subject} ${msg.body.slice(0, 300)}`).slice(0, 6);
  if (words.length) {
    try {
      const sent = await fetchMessageSummaries(`in:sent (${words.join(' OR ')}) newer_than:365d`, 3, 3);
      const bodies = await mapLimit(sent ?? [], 3, async s => {
        const full = await getEmail(s.id);
        return full.startsWith('From: ') ? redact(full.split(/\n\n/).slice(1).join('\n\n')).slice(0, 600) : '';
      });
      const good = bodies.filter(Boolean);
      if (good.length) parts.push(`PAST REPLIES BY MANOJ (tone and wording only; do not reuse personal details):\n${good.map((b, i) => `[${i + 1}] ${b}`).join('\n')}`);
    } catch (e) { console.error('[away] past replies lookup failed:', (e as Error).message); }
  }
  return parts.join('\n\n');
}

export async function notify(userId: string, title: string, body: string, tag: string): Promise<void> {
  await Promise.allSettled([sendPush(userId, { title, body: body.slice(0, 200), tag }), sendTelegram(`${title}\n${body}`)]);
}

export async function makeLiveDeps(userId: string): Promise<AwayDeps | null> {
  const ownAddress = await getOwnAddress();
  if (!ownAddress) return null;
  return {
    now: () => new Date(),
    ownAddress,
    getActiveSession: store.getActiveSession,
    endSession: store.endSession,
    listInboundIds: listMessageIds,
    readInbound: getInboundMessage,
    claim: store.claim,
    markSending: store.markSending,
    finish: store.finish,
    rules: () => store.listRules(userId),
    knowledge: msg => knowledgeFor(userId, msg),
    facts: async () => (await store.listFaqs(userId)).map(f => f.fact).join('\n'), // the allowlist for links, numbers and prices
    llm,
    sendReply: async (msg, body) => {
      const to = replyTarget(msg, ownAddress);
      if (!to) return { ok: false, message: 'no valid recipient' };
      return sendReplyInThread({ threadId: msg.threadId, to, subject: msg.subject, inReplyTo: msg.messageIdHeader, references: msg.references, body });
    },
    notifyNow: (title, body, tag) => notify(userId, title, body, tag),
    modelCallsSince: store.modelCallsSince,
    alreadyHandled: store.alreadyHandled,
    repliedRecently: store.repliedRecently,
    autoRepliesSince: store.autoRepliesSince,
  };
}

export async function runAwayLive(userId: string): Promise<RunResult> {
  if (process.env.AWAY_DISABLED === '1') return { skipped: 'AWAY_DISABLED=1 (hard stop)', seen: 0, byDecision: {}, errors: 0 };
  // Cheap exit first: no session means no Gmail call and no model call at all.
  if (!(await store.getActiveSession(userId))) return { skipped: 'no active away session', seen: 0, byDecision: {}, errors: 0 };
  const deps = await makeLiveDeps(userId);
  if (!deps) return { skipped: 'Gmail not configured or token expired (re-run scripts/google-reauth.mjs)', seen: 0, byDecision: {}, errors: 0 };
  // Stop starting new messages well inside the route's 60 s budget. A message in flight when the budget ends keeps its
  // claim; a later run takes it over after the claim TTL (never if it had reached the send step).
  return runAway(userId, deps, { deadlineMs: Date.now() + RUN_BUDGET_MS });
}

// The nightly report for the active trip (null when no trip is active): last 24 hours of activity.
export async function buildDigest(userId: string): Promise<{ text: string; session: AwaySession } | null> {
  const session = await store.getActiveSession(userId);
  if (!session) return null;
  const since = new Date(Date.now() - 24 * 3_600_000).toISOString();
  const rows = await store.digestRows(session.id, since);
  return { text: formatDigest(session, rows, new Date()), session };
}

// "send draft N": an explicit instruction typed by Manoj, so it sends. N is the draft's permanent number from the report
// (see store.listDrafts). Atomic claim so a repeat sends once.
export async function sendDraft(userId: string, n: number): Promise<string> {
  const session = await store.getActiveSession(userId);
  if (!session) return 'No away trip is active, so there are no drafts waiting.';
  const drafts = await store.listDrafts(session.id);
  const pending = drafts.filter(d => !d.delivered);
  const d = drafts.find(x => x.n === n);
  if (!d) return pending.length ? `There is no draft ${n}. Waiting: ${pending.map(x => x.n).join(', ')}. Say "away drafts" to see them.` : 'No drafts are waiting.';
  if (d.delivered || !(await store.claimDraft(d.id))) return `Draft ${n} was already sent.`;
  try {
    const own = await getOwnAddress();
    const msg = await getInboundMessage(d.messageId);
    const to = msg && own ? replyTarget(msg, own) : null;
    if (!msg || !to) throw new Error('could not reopen the original message or its sender address is not safe to reply to');
    const sent = await sendReplyInThread({ threadId: msg.threadId, to, subject: msg.subject, inReplyTo: msg.messageIdHeader, references: msg.references, body: d.reply });
    if (!sent.ok) throw new Error(sent.message);
    return `Sent draft ${n} to ${to}.`;
  } catch (e) {
    await store.releaseDraft(d.id).catch(() => {});
    return `Draft ${n} was not sent (${(e as Error).message}). It is still waiting.`;
  }
}
