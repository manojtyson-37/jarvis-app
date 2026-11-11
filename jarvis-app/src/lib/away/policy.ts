// Away Mode policy. Every rule here is plain code: the model proposes (a category, a confidence, a draft reply) but
// never decides what gets sent, escalated or ignored. Email text is untrusted input from anyone on the internet.

import { isValidAddr } from './mailbox';

export const DEFAULT_THRESHOLD_INR = 50_000; // escalate-now at or above this amount
export const USD_TO_INR = 90;                // deliberately high: a dollar amount must never look smaller than it is
export const MAX_AWAY_DAYS = 14;             // an unattended agent never runs open-ended
export const DEFAULT_AWAY_DAYS = 7;
export const SHADOW_HOURS = 48;              // first hours of a trip: drafts only, nothing is sent
export const MIN_CONFIDENCE = 0.85;
export const MAX_REPLY_CHARS = 1500;
export const STALE_CLAIM_MS = 10 * 60 * 1000; // a claimed message nobody finished within this is retried

export type Category = 'faq' | 'onboarding' | 'pricing' | 'scheduling' | 'complaint' | 'refund' | 'legal' | 'payment' | 'sales_deal' | 'spam' | 'other';
const CATEGORIES = new Set<string>(['faq', 'onboarding', 'pricing', 'scheduling', 'complaint', 'refund', 'legal', 'payment', 'sales_deal', 'spam', 'other']);
// Information only, no commitment: the only categories ever answered without a human looking first.
const AUTO_OK = new Set<Category>(['faq', 'onboarding']);

export type DecisionKind = 'ignore' | 'escalate_now' | 'needs_you' | 'draft' | 'auto_reply';

// Every Unicode decimal digit (\p{Nd}) is folded to its ASCII digit. Each Nd block is a run of ten consecutive code points
// starting at zero, so a digit's value is its distance from the start of its block: counted by walking back while the
// previous code point is also a digit, modulo ten (adjacent blocks stay aligned to ten).
const isNd = (cp: number) => cp >= 0 && /^\p{Nd}$/u.test(String.fromCodePoint(cp));
function asciiDigits(t: string): string {
  return t.replace(/(?![0-9])\p{Nd}/gu, c => {
    const cp = c.codePointAt(0)!;
    let back = 0;
    while (back < 100 && isNd(cp - back - 1)) back++;
    return String(back % 10);
  }).replace(/٬/g, ',').replace(/٫/g, '.');
}

// Hostile text is normalised before any matching: compatibility forms folded (fullwidth letters and digits), digits of
// other scripts turned into ASCII digits, zero-width and bidi-control characters removed, all whitespace (newlines
// included) collapsed to single spaces.
export function normalizeText(t: string): string {
  return asciiDigits(t.normalize('NFKC')).replace(/[​-‏‪-‮⁠-⁤﻿­]/g, '').replace(/\s+/g, ' ').trim();
}

// ── money ────────────────────────────────────────────────────────────────────
const MULT: Record<string, number> = { k: 1e3, thousand: 1e3, lakh: 1e5, lakhs: 1e5, lac: 1e5, lacs: 1e5, crore: 1e7, crores: 1e7, cr: 1e7, m: 1e6, mn: 1e6, mil: 1e6, million: 1e6, bn: 1e9, billion: 1e9 };
const num = (s: string) => parseFloat(s.replace(/,/g, ''));
const NUM = String.raw`(\d[\d,]*(?:\.\d+)?)`;
const IN_UNIT = String.raw`(k|thousand|million|mil|mn|m|billion|bn|lakhs?|lacs?|crores?|cr)`;
const WORD_UNIT = String.raw`(k|thousand|million|mil|mn|m|billion|bn|lakhs?|lacs?|crores?|cr)`; // before a currency word: "5 million rupees"
const USD_UNIT = String.raw`(k|m|mn|mil|bn|thousand|million|billion|lakhs?|lacs?|crores?|cr)`;

// Every currency amount in the text, in rupees, in the order they appear. A bare number is never money (phone numbers,
// counts); an amount needs a currency sign/word, or "lakh"/"crore".
export function extractAmountsInr(raw: string): number[] {
  // A digit run longer than any real amount is cut to 25 nines: far above every threshold, and the matching below stays
  // linear (a hostile 100k-digit run would otherwise cost seconds).
  const text = normalizeText(raw).replace(/[\d,]{26,}/g, '9'.repeat(25));
  const found: { at: number; end: number; inr: number }[] = [];
  const take = (re: RegExp, toInr: (m: RegExpExecArray) => number) => {
    for (const m of text.matchAll(re)) {
      const at = m.index ?? 0, end = at + m[0].length;
      if (found.some(f => at < f.end && end > f.at)) continue; // already counted by an earlier pattern
      const v = toInr(m as RegExpExecArray);
      if (Number.isFinite(v) && v > 0) found.push({ at, end, inr: Math.round(v) });
    }
  };
  take(new RegExp(String.raw`(?:₹|\brs\.?|\binr\b|\brupees?|रुपये|रुपए|रु\.?)\s*${NUM}(?:\s*${IN_UNIT}\b)?`, 'gi'), m => num(m[1]) * (m[2] ? MULT[m[2].toLowerCase()] : 1));
  take(new RegExp(String.raw`(?:\$|\busd\b)\s*${NUM}(?:\s*${USD_UNIT}\b)?`, 'gi'), m => num(m[1]) * (m[2] ? MULT[m[2].toLowerCase()] : 1) * USD_TO_INR);
  take(new RegExp(String.raw`${NUM}\s*(?:${WORD_UNIT}\s*)?(?:rupees?|\brs\b|\binr\b|रुपये|रुपए)`, 'gi'), m => num(m[1]) * (m[2] ? MULT[m[2].toLowerCase()] : 1));
  take(new RegExp(String.raw`${NUM}\s*(?:${USD_UNIT}\s*)?(?:dollars?|\busd\b)`, 'gi'), m => num(m[1]) * (m[2] ? MULT[m[2].toLowerCase()] : 1) * USD_TO_INR);
  take(new RegExp(String.raw`${NUM}\s*(lakhs?|lacs?|crores?)\b`, 'gi'), m => num(m[1]) * MULT[m[2].toLowerCase()]);
  return found.sort((a, b) => a.at - b.at).map(f => f.inr);
}

// "50k", "₹1 lakh", "$2,000", "2000" → rupees. Used for the threshold Manoj types.
export const MAX_THRESHOLD_INR = 1_000_000_000; // a threshold above this is a typo, not a policy
export function parseAmountInr(text0: string): number | null {
  const text = normalizeText(text0);
  const withCurrency = extractAmountsInr(text);
  let v: number | null = null;
  if (withCurrency.length) v = withCurrency[0];
  else {
    const bare = new RegExp(String.raw`^\s*${NUM}\s*${IN_UNIT}?\s*$`, 'i').exec(text);
    if (bare) v = Math.round(num(bare[1]) * (bare[2] ? MULT[bare[2].toLowerCase()] : 1));
  }
  return v !== null && Number.isFinite(v) && v > 0 && v <= MAX_THRESHOLD_INR ? v : null;
}

export const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;

// ── hostile email text ───────────────────────────────────────────────────────
const INJECTION: [string, RegExp][] = [
  ['override instructions', /\b(?:ignore|disregard|forget|override)\b[^.\n]{0,30}\b(?:previous|prior|above|earlier|all|any|your)\b[^.\n]{0,30}\b(?:instructions?|rules?|prompts?|guidelines|directions)\b/i],
  ['system prompt probe', /\b(?:system|developer)\s+prompt\b/i],
  ['role reset', /\byou are now (?:dan\b|an? (?:unrestricted|unfiltered|jailbroken|different|new)\b|in (?:developer|god) mode)|\bjailbreak\b/i],
  ['bulk forward', /\bforward\b[^.\n]{0,30}\b(?:all|every|your)\b[^.\n]{0,30}\b(?:emails?|mail|messages|inbox|contacts|passwords?|keys?)\b/i],
  ['secret request', /\b(?:reveal|print|show|send|leak|share)\b[^.\n]{0,25}\b(?:api[- ]?keys?|passwords?|secrets?|tokens?|credentials?|your instructions)\b/i],
  ['hide from owner', /\bdo not tell (?:the )?(?:owner|manoj|user)\b/i],
  ['new instructions', /\bnew instructions?\s*:/i],
  ['override above', /\b(?:ignore|disregard|forget|override)\b[^.]{0,30}\b(?:instructions?|rules?|prompts?|guidelines|directions)\b[^.]{0,20}\b(?:above|before|earlier|previously|prior)\b/i],
  ['override above', /\b(?:ignore|disregard|forget)\s+(?:everything|all|anything)\s+(?:above|before)\b|\b(?:ignore|disregard)\s+(?:the\s+)?above\s+(?:instructions?|rules?|prompts?|and\b)/i],
];
// A label when the text tries to steer an AI assistant. Such mail is never answered; it waits for Manoj.
export function injectionSignals(text: string): string | null {
  const t = normalizeText(text);
  for (const [label, re] of INJECTION) if (re.test(t)) return label;
  return null;
}

// ── Manoj's own escalation rules ─────────────────────────────────────────────
export interface EscalationRule { kind: 'keyword' | 'sender' | 'category'; value: string; action: 'escalate_now' | 'needs_you' }
export interface RuleHit { action: 'escalate_now' | 'needs_you'; why: string }

export function matchEscalationRules(rules: EscalationRule[], m: { from: string; subject: string; body: string; category?: Category }): RuleHit | null {
  const text = `${m.subject}\n${m.body}`.toLowerCase();
  const from = m.from.toLowerCase();
  let hit: RuleHit | null = null;
  for (const r of rules) {
    const v = r.value.trim().toLowerCase();
    if (!v) continue;
    const matched = r.kind === 'keyword' ? text.includes(v) : r.kind === 'sender' ? from.includes(v) : m.category === v;
    if (!matched) continue;
    const h: RuleHit = { action: r.action, why: `your rule: ${r.kind} "${r.value}"` };
    if (h.action === 'escalate_now') return h;
    hit ??= h;
  }
  return hit;
}

// ── model output is untrusted too ────────────────────────────────────────────
export interface Triage { category: Category; confidence: number; amountInr: number | null; answerable: boolean; summary: string; reply: string }

export function parseTriage(raw: string): Triage | null {
  const m = /\{[\s\S]*\}/.exec(raw);
  if (!m) return null;
  let j: Record<string, unknown>;
  try { j = JSON.parse(m[0]) as Record<string, unknown>; } catch { return null; }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
  const category = (typeof j.category === 'string' && CATEGORIES.has(j.category) ? j.category : 'other') as Category;
  const c = typeof j.confidence === 'number' && Number.isFinite(j.confidence) ? j.confidence : 0;
  const amount = typeof j.amount_inr === 'number' && Number.isFinite(j.amount_inr) && j.amount_inr > 0 ? j.amount_inr : null;
  const reply = typeof j.reply === 'string' ? j.reply.trim() : '';
  const tooLong = reply.length > MAX_REPLY_CHARS;
  return {
    category, confidence: Math.min(1, Math.max(0, c)), amountInr: amount,
    answerable: j.answerable === true && !!reply && !tooLong,
    summary: (typeof j.summary === 'string' ? j.summary : '').replace(/\s+/g, ' ').trim().slice(0, 200),
    reply: tooLong ? '' : reply,
  };
}

// A reply may only carry contact details (links, domains, addresses, phone numbers, prices) that Manoj's own knowledge
// already contains, each well-formed, and may not make a commitment. Anything else is held as a draft for him to read.
const COMMITMENT = /\b(?:refund\w*|guarantee[ds]?|waive[ds]?|discount|approved?|we confirm|i confirm|promise[ds]?|legally|contract|agree to|compensat\w+|free of charge)\b/i;
// Common commitments in other languages (Spanish, French, German, Hindi in Latin and Devanagari script).
const COMMITMENT_INTL = /reembols|garantiz|garantía|prometemos|compensaci|rembours|garantie|garantissons|promettons|gratuit|erstattung|garantieren|versprechen|kostenlos|रिफंड|गारंटी|वादा|छूट|मुफ्त|मुफ़्त|\b(?:paisa|paise|paisay)\s+(?:wapas|vapas)|\b(?:wapas|vapas)\s+(?:mil|kar)|\bpakka\b|\bpuri\s+guarantee/i;
const MAX_PRICE_INR = 10_000_000;       // anything above is not a price a FAQ reply should quote
const HOST = String.raw`(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}`;
const EMAIL_G = /[^\s@<>"',;()]+@[^\s@<>"',;()]+\.[^\s@<>"',;()]+/g;
const URL_G = /https?:\/\/[^\s<>"')]+/gi;
const HOST_G = new RegExp(String.raw`(?<![a-z0-9@./-])${HOST}(?::\d{1,5})?(?![a-z0-9-])(?:[/?#][^\s<>"')]*)?`, 'g');
const trimEnd = (x: string) => x.replace(/[.,;:!?]+$/, '');

// A location reduced to its whole host (with any port), its path and its query (null when there is none). Everything is
// lowercased on both sides, so a verbatim FAQ link with capitals matches itself. Null when it is not a plain host/path: userinfo ("host@evil"), backslashes and anything else that browsers
// and parsers read differently are never accepted.
interface Loc { host: string; path: string; query: string | null; frag: string | null }
function parseLoc(raw: string): Loc | null {
  const m = new RegExp(String.raw`^(?:https?:\/\/)?(${HOST}(?::\d{1,5})?)\.?([/?#].*)?$`, 'i').exec(trimEnd(raw));
  if (!m) return null;
  const rest = (m[2] ?? '').replace(/[.,;:!?]+$/, '').toLowerCase();
  const h = rest.indexOf('#');
  const frag = h < 0 ? null : rest.slice(h + 1);
  const noFrag = h < 0 ? rest : rest.slice(0, h);
  const q = noFrag.indexOf('?');
  const path = q < 0 ? noFrag : noFrag.slice(0, q);
  const query = q < 0 ? null : noFrag.slice(q + 1);
  // Dot segments and encoded dots, slashes and backslashes let a path climb out of the place the owner named.
  if (/(?:^|\/)\.{1,2}(?:\/|$)|%2e|%2f|%5c|\\/.test(path)) return null;
  return { host: m[1].toLowerCase(), path: path === '/' ? '' : path, query: query === '' ? null : query, frag: frag === '' ? null : frag };
}
// A known location covers a reply location on the same whole host when the paths are equal or the known path is a prefix
// that ends at a / boundary. A host known without a path covers only itself. A query is part of the address: a known
// location with a query covers only that exact path and query, and a known location without one covers no query at all
// ("?redirect=..." could point the visitor anywhere). The fragment likewise: a single-page app can route on it, so a reply
// fragment must equal a known one.
function covers(known: Loc, reply: Loc): boolean {
  if (known.host !== reply.host) return false;
  if (reply.frag !== null && reply.frag !== known.frag) return false;
  if (known.query !== null) return reply.path === known.path && reply.query === known.query;
  if (reply.query !== null) return false;
  if (known.path === '') return reply.path === '';
  if (reply.path === known.path) return true;
  if (!reply.path.startsWith(known.path)) return false;
  return known.path.endsWith('/') || reply.path[known.path.length] === '/';
}

// Things that could name a place the regexes below cannot read: a scheme other than http(s)://, a protocol-relative //host,
// and any host-like token with non-ASCII letters, an ideographic dot or punycode. Such a token is refused unless the
// owner's own knowledge contains that exact token.
function locationsLookPlain(reply: string, knowledge: string): boolean {
  for (const m of reply.matchAll(/(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*):([\\/]*)/gi)) {
    const scheme = m[1].toLowerCase(), slashes = m[2];
    const rest = reply.slice((m.index ?? 0) + m[0].length - slashes.length);
    // "Tel: 080 ..." (a label) is fine; "tel:080..." / "javascript:..." (a URI) is not.
    if (/^(?:javascript|data|vbscript|mailto|tel|sms|file|ftp|blob|intent)$/.test(scheme) && /\S/.test(reply[(m.index ?? 0) + m[0].length - slashes.length] ?? '')) return false;
    if (slashes === '') continue;
    if (!((scheme === 'http' || scheme === 'https') && /^\/\/[^\\/]/.test(rest))) return false;
  }
  if (/(?:^|[\s(])\/\/[^\s/]/.test(reply)) return false;
  const known = new Set(knowledge.toLowerCase().split(' ').map(trimEnd));
  for (const tok of reply.split(' ')) {
    const t = trimEnd(tok.toLowerCase());
    const dotty = /[^\s.\u3002\uff61][.\u3002\uff61][^\s.\u3002\uff61]/.test(t);
    const nonAsciiLetter = /(?![\x00-\x7f])[\p{L}\p{M}]/u.test(t);
    const odd = /[\u3002\uff61\uff0e]/.test(t) || t.includes('xn--') || (nonAsciiLetter && (dotty || /[@/]/.test(t)));
    if (odd && !known.has(t)) return false;
  }
  return true;
}

export function replySafe(reply0: string, knowledge0: string): boolean {
  const reply = normalizeText(reply0), knowledge = normalizeText(knowledge0);
  // No FAQ at all: nothing the reply says is grounded in what the owner told us, so it is never sent without a look.
  if (!knowledge) return false;
  if (COMMITMENT.test(reply) || COMMITMENT_INTL.test(reply)) return false;
  if (!locationsLookPlain(reply, knowledge)) return false;

  // Everything the knowledge allows, as whole hosts, locations and addresses.
  const kLower = knowledge.toLowerCase();
  const knownEmails = new Set<string>(), knownHosts = new Set<string>(), knownLocs: Loc[] = [];
  for (const e of kLower.match(EMAIL_G) ?? []) {
    const a = trimEnd(e);
    knownEmails.add(a);
    const d = parseLoc(a.slice(a.lastIndexOf('@') + 1));
    if (d) knownHosts.add(d.host);
  }
  const kNoMail = kLower.replace(EMAIL_G, ' ');
  for (const u of kNoMail.match(URL_G) ?? []) { const l = parseLoc(u); if (l) { knownLocs.push(l); knownHosts.add(l.host); } }
  for (const h of kNoMail.replace(URL_G, ' ').match(HOST_G) ?? []) { const l = parseLoc(h); if (l) { knownLocs.push(l); knownHosts.add(l.host); } }

  for (const u of reply.match(URL_G) ?? []) {
    const l = parseLoc(u);
    if (!l || !knownLocs.some(k => covers(k, l))) return false;
  }
  for (const e of reply.match(EMAIL_G) ?? []) {
    const a = trimEnd(e).toLowerCase();
    if (!isValidAddr(a) || !knownEmails.has(a)) return false;
  }
  // Phone numbers: 8 to 15 digits (E.164 length), already in the knowledge. A longer digit run is never a phone.
  const knowDigits = knowledge.replace(/\D/g, '');
  if (/\d{16,}/.test(reply.replace(/[\s().-]/g, ''))) return false;
  for (const p of reply.match(/(?<![\d])\+?\d[\d\s().-]{6,24}\d(?![\d])/g) ?? []) {
    const digits = p.replace(/\D/g, '');
    if (digits.length > 15) return false;
    if (digits.length >= 8 && !knowDigits.includes(digits)) return false;
  }
  // Prices: every amount must be sane and already quoted in the knowledge.
  const knownPrices = new Set(extractAmountsInr(knowledge));
  for (const a of extractAmountsInr(reply)) {
    if (a > MAX_PRICE_INR || !knownPrices.has(a)) return false;
  }
  // Bare domains with no scheme ("evil.example/pay", "www.evil.com"): the whole host must be known; a path needs a
  // known location that covers it.
  const noMail = reply.toLowerCase().replace(EMAIL_G, ' ').replace(URL_G, ' ');
  for (const h of noMail.match(HOST_G) ?? []) {
    const l = parseLoc(h);
    if (!l) return false;
    if (l.path || l.query !== null || l.frag !== null ? !knownLocs.some(k => covers(k, l)) : !knownHosts.has(l.host)) return false;
  }
  return true;
}

// ── who a reply may go to ────────────────────────────────────────────────────
// Machines and mailing lists: never answered. Matched on the local part so "listings@agency.com" is still a person.
const NO_REPLY_LOCAL = /^(?:no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster|bounces?|noreply)(?:[-_.+].*)?$|bounce|^(?:.+[-_.+])?(?:list|listserv|majordomo|owner|request|unsubscribe)(?:[-_.+].*)?$/i;
export function isMachineAddress(addr: string): boolean {
  return NO_REPLY_LOCAL.test(addr.slice(0, addr.lastIndexOf('@')));
}
// Only ever the From address, strictly validated. A Reply-To is attacker-controlled and could route a business reply to
// a stranger. Null when the address is malformed, a machine or list, or Manoj's own.
export function replyTarget(m: { fromAddr: string; replyTo?: string }, ownAddress: string): string | null {
  const a = m.fromAddr.trim();
  if (!isValidAddr(a) || isMachineAddress(a)) return null;
  if (a.toLowerCase() === ownAddress.trim().toLowerCase()) return null;
  return a;
}

// ── retry of a message whose run died ────────────────────────────────────────
// A "processing" row older than the TTL is picked up again, unless it had reached the send step (reason "sending"):
// then the email may already be out and only Manoj can tell, so it is never retried.
export function canTakeOver(row: { decision: string; reason?: string | null; createdAtMs: number }, nowMs: number): boolean {
  return row.decision === 'processing' && row.reason !== 'sending' && nowMs - row.createdAtMs >= STALE_CLAIM_MS;
}

// ── the decision ─────────────────────────────────────────────────────────────
export interface DecideInput {
  badSender?: boolean; automated: boolean; fromSelf: boolean; triage: Triage | null; textAmountsInr: number[]; thresholdInr: number;
  shadowActive: boolean; suspicious: string | null; ruleHit: RuleHit | null; replyOk: boolean;
}

type Outcome = { kind: DecisionKind; reason: string };

// What is already settled before the model is called: own and automated mail, steering attempts, Manoj's escalate-now
// rules, and money at or above the threshold. The engine skips the model call for these (saves quota, and means hostile
// text never even reaches it).
export function precheck(i: Pick<DecideInput, 'automated' | 'fromSelf' | 'suspicious' | 'ruleHit' | 'textAmountsInr' | 'thresholdInr'> & { triage?: Triage | null; badSender?: boolean }): Outcome | null {
  if (i.fromSelf) return { kind: 'ignore', reason: 'sent by you' };
  if (i.automated) return { kind: 'ignore', reason: 'automated sender' };
  if (i.suspicious) return { kind: 'needs_you', reason: `looks like an attempt to steer the assistant (${i.suspicious})` };
  if (i.ruleHit?.action === 'escalate_now') return { kind: 'escalate_now', reason: i.ruleHit.why };
  const amount = Math.max(0, ...i.textAmountsInr, i.triage?.amountInr ?? 0);
  if (amount >= i.thresholdInr) return { kind: 'escalate_now', reason: `amount ${inr(amount)} is at or above your ${inr(i.thresholdInr)} threshold` };
  if (i.badSender) return { kind: 'needs_you', reason: 'sender address could not be verified, so no reply was sent' };
  return null;
}

export function decide(i: DecideInput): Outcome {
  const settled = precheck(i);
  if (settled) return settled;
  if (!i.triage) return { kind: 'needs_you', reason: 'could not read the message safely' };
  const cat = i.triage.category;
  if (cat === 'legal' || cat === 'complaint') return { kind: 'escalate_now', reason: `${cat} message` };
  if (cat === 'spam' && i.triage.confidence >= MIN_CONFIDENCE) return { kind: 'ignore', reason: 'spam or solicitation' };
  if (cat === 'refund' || cat === 'payment' || cat === 'sales_deal') return { kind: 'needs_you', reason: `${cat.replace('_', ' ')} needs your call` };
  if (i.ruleHit) return { kind: 'needs_you', reason: i.ruleHit.why };
  if (!i.triage.answerable) return { kind: 'needs_you', reason: 'not answerable from what I know' };
  if (i.triage.confidence < MIN_CONFIDENCE) return { kind: 'needs_you', reason: `low confidence (${Math.round(i.triage.confidence * 100)}%)` };
  if (!AUTO_OK.has(cat)) return { kind: 'draft', reason: `${cat} replies always wait for your OK` };
  if (!i.replyOk) return { kind: 'draft', reason: 'reply held: it contains a link, contact detail or commitment I cannot verify' };
  if (i.shadowActive) return { kind: 'draft', reason: 'shadow period: drafting only, nothing is sent yet' };
  return { kind: 'auto_reply', reason: 'confident, grounded, information only' };
}
