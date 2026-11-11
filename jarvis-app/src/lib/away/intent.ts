// Chat commands for Away Mode. Plain pattern matching, no model: turning on an agent that answers email for Manoj must
// never depend on a model's reading of a casual sentence, and a casual sentence must never turn it on.
import { MAX_AWAY_DAYS, DEFAULT_AWAY_DAYS, parseAmountInr } from './policy';

export type AwayIntent =
  | { kind: 'start'; until: Date; thresholdInr?: number }
  | { kind: 'stop' }
  | { kind: 'kill' }
  | { kind: 'status' }
  | { kind: 'threshold'; thresholdInr: number }
  | { kind: 'drafts' }
  | { kind: 'show_draft'; n: number }
  | { kind: 'send_draft'; n: number }
  | { kind: 'faq_add'; text: string }
  | { kind: 'faq_list' }
  | { kind: 'faq_remove'; n: number };

const IST_MS = 330 * 60 * 1000;
const DAY_MS = 86_400_000;
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// 23:59:59 IST on the IST calendar day that is `plusDays` after `now`'s IST day.
function endOfIstDay(now: Date, plusDays: number): Date {
  const ist = new Date(now.getTime() + IST_MS);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + plusDays, 23, 59, 59) - IST_MS);
}
const istDow = (now: Date) => new Date(now.getTime() + IST_MS).getUTCDay();

// Month words are matched whole ("mar", "march", "sept"), never by prefix: "5 marathon" is not a date.
const MONTH_WORD = String.raw`(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)`;
const WEEKDAY_WORD = String.raw`(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)`;
const DATE_TOKEN = String.raw`(?:today|tomorrow|day after tomorrow|(?:next\s+)?${WEEKDAY_WORD}|(?:the\s+)?\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?${MONTH_WORD}|${MONTH_WORD}\s+\d{1,2}(?:st|nd|rd|th)?)`;
const monthIndex = (w: string) => MONTHS.indexOf(w.slice(0, 3).toLowerCase());

// The end of one date expression (23:59:59 IST that day). A date that has already gone by stays in the past: it is never
// silently moved to next year, except when it is more than half a year back ("until 3 Jan" said in late December).
function resolveDate(tok: string, now: Date): Date | null {
  const t = tok.trim().toLowerCase();
  if (t === 'today') return endOfIstDay(now, 0);
  if (t === 'tomorrow') return endOfIstDay(now, 1);
  if (t === 'day after tomorrow') return endOfIstDay(now, 2);
  const wd = /^(?:next\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/.exec(t);
  if (wd) return endOfIstDay(now, (WEEKDAYS.indexOf(wd[1]) - istDow(now) + 7) % 7 || 7);
  const dm = new RegExp(String.raw`^(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(${MONTH_WORD})$`).exec(t);
  const md = new RegExp(String.raw`^(${MONTH_WORD})\s+(\d{1,2})(?:st|nd|rd|th)?$`).exec(t);
  const [day, mon] = dm ? [parseInt(dm[1], 10), dm[2]] : md ? [parseInt(md[2], 10), md[1]] : [0, ''];
  const mi = mon ? monthIndex(mon) : -1;
  if (day < 1 || day > 31 || mi < 0) return null;
  const year = new Date(now.getTime() + IST_MS).getUTCFullYear();
  const at = (y: number) => Date.UTC(y, mi, day, 23, 59, 59) - IST_MS;
  let target = at(year);
  if (target < now.getTime() && now.getTime() - target > 183 * DAY_MS) target = at(year + 1);
  return new Date(target);
}

// The end of the trip the sentence asks for, or null when it gives no usable date range. `past` = that range is over.
function parseRange(text: string, now: Date): { until: Date } | { past: true } | null {
  const fromTo = new RegExp(String.raw`\bfrom\s+(${DATE_TOKEN})\s+(?:to|until|till|til|through|-|–)\s+(${DATE_TOKEN})\b`, 'i').exec(text);
  let end: Date | null = null;
  if (fromTo) end = resolveDate(fromTo[2], now);
  else {
    const forDays = /\bfor\s+(\d{1,3})\s+days?\b/i.exec(text);
    if (forDays) return { until: endOfIstDay(now, Math.max(1, parseInt(forDays[1], 10))) };
    if (/\bfor\s+(?:a|one)\s+week\b/i.test(text)) return { until: endOfIstDay(now, 7) };
    const until = new RegExp(String.raw`\b(?:until|till|through|til)\s+(${DATE_TOKEN})\b`, 'i').exec(text);
    if (until) end = resolveDate(until[1], now);
  }
  if (!end) return null;
  return end.getTime() < now.getTime() ? { past: true } : { until: end };
}

// Starting is the strict side (stopping is matched loosely above): the person themselves, present or future tense, saying
// they are away, plus a future or current date range.
const FIRST_PERSON_AWAY = new RegExp(String.raw`\b(?:i\s*['’]?\s*m|i\s+am|i['’]ll\s+be|i\s+will\s+be)\s+(?:going\s+to\s+be\s+|gonna\s+be\s+)?(?:going\s+(?:away|on\s+(?:leave|vacation|holiday))|away(?!\s+from\s+(?:my|the|home|work|desk|keyboard|office|here|it|this)\b)|out\s+of\s+(?:the\s+)?office|on\s+(?:leave|vacation|holiday)|travell?ing|off)\b`, 'i');
// An explicit command to the app. Mentioning the feature in passing ("why is away mode slow") never starts it.
const START_COMMAND = /^\s*(?:please\s+)?(?:(?:turn|switch)\s+(?:on\s+)?away\s+mode(?:\s+on)?|(?:start|enable|activate|begin)\s+away\s+mode|away\s+mode\s+(?:on|start|enable))\b/i;
// Questions and conditionals ("if I'm away until Friday, should Maya reply?", "should I say I'm away...") are about the
// feature, not instructions to it.
const HEDGE_LEAD = /^\s*(?:if|should|can|could|would|will|whether|what\s+if|do|does|is|are|how|why|when)\b/i;
const HEDGE_WORD = /\b(?:if|should|can|could|would|whether|what\s+if|suppose)\b/i;
// Reported or imperative speech: "tell John I'm away", "draft an email saying I'm away", "my wife says I'm away", or a quote.
const REPORTING = /\b(?:say|says|said|saying|tell|tells|told|telling|draft|drafts|write|writes|wrote|writing|remind|reminds|reminder|ask|asks|asked|email|emails|message|messages|post|posts|tweet|note|notify|inform|announce|mention|text)\b|["“”‘„«]/i;
const LEAVE_IN_CHARGE = /\bleave\s+(?:maya|you)\s+in\s+charge\b/i;

export function parseAwayIntent(message: string, now: Date = new Date()): AwayIntent | null {
  const t = message.trim();
  if (!t || t.length > 400) return null;

  // Stopping is always safe, so these are matched loosely; starting is matched strictly.
  if (/\bkill\s+switch\b|\b(?:kill|halt|panic|emergency[- ]stop)\b.{0,20}\b(?:away|autopilot|auto-?repl(?:y|ies))\b/i.test(t)) return { kind: 'kill' };
  if (/\b(?:i'?m|i am|im)\s+back\b|\b(?:stop|end|disable|cancel)\s+(?:the\s+)?away(?:\s+mode)?\b|\baway\s+mode\s+off\b|\bturn\s+off\s+away\s+mode\b/i.test(t)) return { kind: 'stop' };

  // The FAQ is what Maya may answer from while you are away. Written only from your own typed message.
  const faq = /^\s*(?:away\s+)?faq\s*:\s*([\s\S]{5,500})$/i.exec(t);
  if (faq) return { kind: 'faq_add', text: faq[1].trim() };
  if (/^\s*(?:show|list)\s+(?:my\s+)?(?:away\s+)?faqs?\s*$/i.test(t)) return { kind: 'faq_list' };
  const rm = /^\s*(?:forget|remove|delete)\s+(?:away\s+)?faq\s*#?\s*(\d{1,3})\s*$/i.exec(t);
  if (rm) return { kind: 'faq_remove', n: parseInt(rm[1], 10) };

  const send = /^\s*send\s+(?:away\s+)?draft\s*#?\s*(\d{1,3})\s*[.!]?\s*$/i.exec(t);
  if (send) return { kind: 'send_draft', n: parseInt(send[1], 10) };
  const showDraft = /^\s*(?:show|read|view|open)\s+(?:away\s+)?draft\s*#?\s*(\d{1,3})\s*[.!]?\s*$/i.exec(t);
  if (showDraft) return { kind: 'show_draft', n: parseInt(showDraft[1], 10) };
  if (/\baway\s+drafts?\b|\b(?:show|list|see)\s+(?:the\s+)?(?:drafted|pending)\s+repl(?:y|ies)\b/i.test(t)) return { kind: 'drafts' };
  if (/\baway\s+(?:mode\s+)?(?:status|report|summary)\b|\bwhat\s+(?:happened|did you do|did i miss)\b.{0,25}\b(?:while|when)\s+i\s+(?:was|am|were)\s+(?:away|gone|out)\b/i.test(t)) return { kind: 'status' };

  // A start is checked BEFORE a threshold: "I'm away until Friday, escalate over ₹1 lakh" starts the trip with that
  // threshold. Natural language needs a first-person away statement AND a future or current date range; commands to the
  // app ("away mode on") need no range and default to a week. A question or a conditional never starts anything.
  const fp = FIRST_PERSON_AWAY.exec(t);
  const lic = LEAVE_IN_CHARGE.exec(t);
  const command = START_COMMAND.test(t) || (lic !== null && parseRange(t, now) !== null);
  const anchor = fp?.index ?? lic?.index ?? 0; // everything before the statement itself
  const before = t.slice(0, anchor);
  const hedged = /\?/.test(t) || HEDGE_LEAD.test(t) || HEDGE_WORD.test(before) || REPORTING.test(before);
  const range = parseRange(t, now);
  const starts = !hedged && (!range || !('past' in range)) && (command || (fp !== null && range !== null));
  if (!starts) {
    const th = /\b(?:set|change|update|make)\s+(?:the\s+)?(?:escalation\s+)?threshold\s+(?:to|at)\s+(.+)$/i.exec(t) ?? /\bescalate\s+(?:only\s+)?(?:above|over)\s+(.+)$/i.exec(t);
    if (th) { const a = parseAmountInr(th[1].replace(/[.!?]+$/, '')); if (a) return { kind: 'threshold', thresholdInr: a }; }
    return null;
  }

  const capped = endOfIstDay(now, MAX_AWAY_DAYS);
  const asked = range && 'until' in range ? range.until : endOfIstDay(now, DEFAULT_AWAY_DAYS);
  const until = asked.getTime() > capped.getTime() ? capped : asked;
  const over = /\b(?:over|above|more than|exceeds?|beyond)\s+(.{1,30}?)\s*$/i.exec(t.replace(/[.!?]+$/, ''));
  const thresholdInr = over ? parseAmountInr(over[1]) ?? undefined : undefined;
  return thresholdInr ? { kind: 'start', until, thresholdInr } : { kind: 'start', until };
}
