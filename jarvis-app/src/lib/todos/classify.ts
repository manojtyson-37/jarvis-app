// Tier is decided HERE, in code. The model only suggests a kind; the kind maps to a tier, and a keyword floor
// can only raise it (auto -> approval -> manual), never lower it. Tiered autonomy, decided by Manoj 2026-11-01:
//   auto     : research, summary, draft, reminder, note, lookup — Maya does it
//   approval : send email, notify others, calendar change, delete — queued behind the Approve button
//   manual   : money, credentials, settings, anything else — never done autonomously
import { UNTRUSTED_SOURCES, type TodoSource } from './capture';

export const KINDS = ['research', 'summary', 'draft', 'reminder', 'note', 'lookup', 'email_send', 'notify', 'calendar', 'delete', 'money', 'credential', 'settings', 'manual'] as const;
export type Kind = typeof KINDS[number];
export type Tier = 'auto' | 'approval' | 'manual';

const KIND_TIER: Record<Kind, Tier> = {
  research: 'auto', summary: 'auto', draft: 'auto', reminder: 'auto', note: 'auto', lookup: 'auto',
  email_send: 'approval', notify: 'approval', calendar: 'approval', delete: 'approval',
  money: 'manual', credential: 'manual', settings: 'manual', manual: 'manual',
};
const RANK: Record<Tier, number> = { auto: 0, approval: 1, manual: 2 };
export const isKind = (k: unknown): k is Kind => typeof k === 'string' && (KINDS as readonly string[]).includes(k);

// Money: moving or spending it. "find the price of X" is research, so price words alone don't count.
const MONEY = /\b(pay|paying|paid|transfer|send money|wire|deposit|withdraw|invest|buy|purchase|order|subscribe|top ?up|recharge|donate|lend|repay|emi|upi)\b|₹\s*\d|\brs\.?\s*\d|\b\d+\s*(?:rupees|inr|rs)\b/i;
const CREDENTIAL = /\b(passwords?|passcodes?|otp|2fa|two[- ]factor|mfa|api[- ]?keys?|tokens?|secrets?|credentials?|log ?in to|sign ?in to|pin)\b/i;
const SETTINGS = /\b(settings?|permissions?|turn (?:on|off)|enable|disable|privacy|recovery (?:email|phone))\b/i;
const OUTWARD = /\b(send|email|mail|message|text|whatsapp|tell|notify|inform|ping|invite|reply to|forward|post|publish|share with)\b/i;
const CALENDAR = /\b(schedule|reschedule|book|cancel|move|postpone)\b.*\b(meeting|call|event|appointment|slot|invite|calendar|dentist|doctor)\b|\b(calendar|invite)\b/i;
const DELETE = /\b(delete|remove|erase|wipe|unsubscribe|archive|trash|cancel my)\b/i;
// A draft is fine on its own; "draft and send" still sends.
const DRAFT_ONLY = /^\s*(?:draft|write|prepare)\b(?![^.]*\b(?:and|then)\s+send\b)/i;

// "remind me to pay rent" only sets a reminder: the reminder is the whole action, whatever it is about.
const SELF_ONLY = /^\s*(?:remind me|ping me|nudge me|note(?: down)?|jot(?: down)?)\b(?![^]*\b(?:and|then)\s+(?:send|pay|email|tell|delete|book)\b)/i;

export function safetyFloor(text: string): Tier {
  if (SELF_ONLY.test(text)) return 'auto';
  if (MONEY.test(text) || CREDENTIAL.test(text) || SETTINGS.test(text)) return 'manual';
  if (DELETE.test(text) || CALENDAR.test(text)) return 'approval';
  if (OUTWARD.test(text) && !DRAFT_ONLY.test(text)) return 'approval';
  return 'auto';
}

export function finalTier(kind: Kind, text: string, source: TodoSource): Tier {
  const base = isKind(kind) ? KIND_TIER[kind] : 'manual';
  const floor = safetyFloor(text);
  let tier = RANK[floor] > RANK[base] ? floor : base;
  // Email and meeting text is written by other people: it may create work for Maya, never an outward action.
  if (tier === 'approval' && UNTRUSTED_SOURCES.has(source)) tier = 'manual';
  return tier;
}

// Used only when the classifier model is unavailable.
export function heuristicKind(text: string): Kind {
  const t = text.trim();
  if (MONEY.test(t)) return 'money';
  if (CREDENTIAL.test(t)) return 'credential';
  if (SETTINGS.test(t)) return 'settings';
  if (/^\s*(?:remind|ping me|nudge me)\b/i.test(t)) return 'reminder';
  if (/^\s*(?:draft|write|prepare)\b/i.test(t)) return 'draft';
  if (/^\s*summari[sz]e\b|\bsummary of\b/i.test(t)) return 'summary';
  if (CALENDAR.test(t)) return 'calendar';
  if (/^\s*(?:email|mail|send|reply)\b/i.test(t)) return 'email_send';
  if (OUTWARD.test(t)) return 'notify';
  if (DELETE.test(t)) return 'delete';
  if (/^\s*(?:research|find|look ?up|check|compare|search|what|which|who|how|when|where|list)\b/i.test(t)) return 'research';
  if (/^\s*(?:note|jot|save)\b/i.test(t)) return 'note';
  return 'manual';
}

export const WEB_TOOLS = ['web_search', 'read_url'];
// Private data. Never given to a to-do whose wording came from someone else: with nobody watching, injected text
// could read his mail and carry it out through read_url.
export const PRIVATE_READERS = ['list_emails', 'get_email', 'search_drive', 'read_drive_file', 'get_calendar_events', 'search_notes', 'get_recent_notes'];
const SAFE_WRITES = ['save_note', 'set_reminder'];
const GATED = ['send_email', 'create_calendar_event', 'delete_calendar_event'];

// Once private data has been read in a run, nothing that reaches the internet may run after it: a search query or a
// URL could carry that data out (injected text in an email can ask for exactly that).
export function narrowAfterPrivateRead(allowed: ReadonlySet<string>, privateRead: boolean): Set<string> {
  return privateRead ? new Set([...allowed].filter(t => !WEB_TOOLS.includes(t))) : new Set(allowed);
}

export function toolsForTier(tier: Tier, source: TodoSource = 'chat'): Set<string> {
  if (tier === 'manual') return new Set();
  if (UNTRUSTED_SOURCES.has(source)) return new Set([...WEB_TOOLS, ...SAFE_WRITES]);
  return new Set(tier === 'auto' ? [...WEB_TOOLS, ...PRIVATE_READERS, ...SAFE_WRITES] : [...WEB_TOOLS, ...PRIVATE_READERS, ...SAFE_WRITES, ...GATED]);
}

// read_url may only open a URL that is already in front of the run (in the to-do or in an earlier tool result),
// so the model can never build a new URL that carries data out.
export const urlsIn = (text: string): string[] => text.match(/https?:\/\/[^\s<>"'`)\]]+/g) ?? [];
export function urlAllowed(url: unknown, seen: ReadonlySet<string>): boolean {
  if (typeof url !== 'string') return false;
  const u = url.trim().replace(/[.,;:!?]+$/, '');
  return seen.has(u);
}
