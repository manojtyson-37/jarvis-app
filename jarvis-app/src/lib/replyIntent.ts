// "reply to Bob saying yes": handled without the model. Left to the model it listed the inbox and the raw list became the
// answer, or it invented an address. Here the sender is looked up in Gmail, the draft is built from the user's own words
// and queued through the normal approval gate, so nothing is ever sent without a yes.
import type { EmailSummary } from '@/lib/gmail';

export interface ReplyIntent { who: string; text: string }

// Whole-message template only (same reasoning as calendarReadIntent): anything else stays with the model.
const REPLY_RE = /^(?:please\s+)?(?:reply|respond|write back)(?:\s+back)?\s+to\s+([a-z][a-z.'@_-]*(?:\s+[a-z][a-z.'@_-]*){0,2}?)(?:'s\s+(?:e-?mail|mail|message))?\s*(?:,|:|\s+(?:saying|and say|and tell (?:him|her|them)|telling (?:him|her|them)|that))\s*(.{1,400})$/i;
const NOT_A_NAME = /^(?:him|her|them|it|this|that|the|that one|this one|first|second|third|last|latest|all|everyone|everybody|me|my|an?|each)(?:\s|$)/i;
// A second instruction hidden in the reply text means the model should see the whole message.
const SECOND_TASK = /\b(?:and|then|also)\s+(?:cancel|delete|remind|schedule|book|add|forward|set|move|call|create|mark|close|resolve|cc|bcc|send|email|text|share|attach)\b|\b(?:forward|cc|bcc)\b|@|^(?:an?\s+|the\s+)?(?:summary|status|report|update|list|latest)\b|[;\n]/i;

export function parseReplyIntent(message: string): ReplyIntent | null {
  if (message.length > 600) return null;
  const m = REPLY_RE.exec(message.replace(/[‘’]/g, "'").trim());
  if (!m) return null;
  const who = m[1].trim().replace(/\s+(?:e-?mail|mail|message)$/i, '').replace(/'s$/i, '');
  const text = m[2].trim();
  if (NOT_A_NAME.test(who) || SECOND_TASK.test(text)) return null;
  return { who, text };
}

// The user's own words, tidied: capital first letter, closing punctuation. No wording is added or changed.
export function replyBody(text: string): string {
  const t = text.trim().replace(/^["“]|["”]$/g, '').trim();
  const cap = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?]$/.test(cap) ? cap : `${cap}.`;
}

export function addressOf(from: string): string | null {
  const m = /<([^<>\s]+@[^<>\s]+)>/.exec(from) ?? /([^\s<>"',;]+@[^\s<>"',;]+)/.exec(from);
  return m ? m[1].toLowerCase() : null;
}

// Bulk-mail senders the gmail.ts heuristic misses ("newsletters@…"): nobody replies to these.
const BULK_SENDER = /^(?:newsletters?|news|marketing|promo(?:tions?)?|offers?|deals|info|mailer|mailers|updates?|digest|campaigns?|bounce|postmaster)[+@.-]/i;

export interface ReplyDeps {
  fetchSummaries: (query: string, max: number) => Promise<EmailSummary[] | null>;
  queue: (tool: string, args: Record<string, unknown>) => Promise<string>;
}

export interface ReplyResult { text: string; queued?: { to: string; subject: string; body: string } }

export async function handleReply(intent: ReplyIntent, deps: ReplyDeps): Promise<ReplyResult> {
  const who = intent.who.replace(/[^A-Za-z0-9.'@_ -]/g, '').trim();
  if (!who) return { text: 'Who should I reply to?' };
  const found = await deps.fetchSummaries(`from:"${who}"`, 10);
  if (found === null) return { text: 'Gmail not configured or list failed.' };
  // Automated senders (no-reply, alerts) are never someone you reply to.
  const tokens = who.toLowerCase().split(/\s+/).filter(t => t.length > 1);
  const people = found.filter(e => {
    const a = addressOf(e.from) ?? '';
    if (e.automated || BULK_SENDER.test(a)) return false;
    // Gmail's from: is a fuzzy match, so require the typed name in the real name or address, and drop senders whose
    // display name pretends to be a different address ("bob@trusted.com" <attacker@evil.com>).
    if (/@/.test(e.fromName) && !e.fromName.toLowerCase().includes(a)) return false;
    const hay = `${e.fromName} ${a}`.toLowerCase();
    return tokens.every(t => hay.includes(t));
  });
  if (!people.length) return { text: `I couldn't find a recent email from "${who}", so nothing was queued.` };
  const byAddr = new Map<string, EmailSummary>();
  for (const e of people) {
    const a = addressOf(e.from);
    if (a && !byAddr.has(a)) byAddr.set(a, e); // the list is newest first, so this keeps each sender's latest
  }
  if (!byAddr.size) return { text: `I couldn't read a sender address for "${who}", so nothing was queued.` };
  if (byAddr.size > 1) {
    const options = [...byAddr.entries()].slice(0, 5).map(([a, e]) => `${e.fromName} <${a}>`).join(', ');
    return { text: `More than one sender matches "${who}": ${options}. Say "reply to <address> saying …" and I'll queue it. Nothing was queued.` };
  }
  const [to, latest] = [...byAddr.entries()][0];
  const cleanSubject = latest.subject.replace(/[\r\n]+/g, ' ').trim();
  const subject = /^re:/i.test(cleanSubject) ? cleanSubject : `Re: ${cleanSubject}`;
  const body = replyBody(intent.text);
  const status = await deps.queue('send_email', { to, subject, body });
  const context = `Replying to ${latest.fromName} <${to}>, email "${cleanSubject}"${latest.date ? ` (${latest.date})` : ''}.`;
  return { text: `${context}\n${status}`, queued: { to, subject, body } };
}
