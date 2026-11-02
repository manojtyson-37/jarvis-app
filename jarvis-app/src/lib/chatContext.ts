// Earlier raw email lists in the chat history invite the model to copy (and mangle) them instead of
// calling the tool, and they can be stale (e.g. from a previous account). Hide them in the model's
// context only; the stored history and what the user sees are unchanged.
const ROW = /^\[(?:automated|needs[- ]?look)\]\s+\[[A-Za-z0-9]+\]|^\[[A-Za-z0-9]{10,}\]\s+From:/i;
// Placeholder text from earlier builds that was stored as assistant replies: the model copies such text back
// as its own answer, so rows made only of it are dropped from the model's context.
const POISON = /^\s*(?:\(older email list omitted\)|\[An earlier email list is not shown here[^\]]*\])\s*$/i;

export const isPlaceholderReply = (role: string, content: string) => role === 'assistant' && POISON.test(content);

export function hasEmailList(content: string): boolean {
  return content.split('\n').some(l => ROW.test(l));
}

// Model context for the chat history: the MOST RECENT email list stays intact (follow-ups like "summarise
// these" or "reply to the second one" need it); older lists are hidden because they are stale and invite
// the model to copy their format instead of fetching fresh mail.
export function historyForModel(history: { role: 'user' | 'assistant'; content: string }[]): { role: 'user' | 'assistant'; content: string }[] {
  let lastList = -1;
  history.forEach((h, i) => { if (h.role === 'assistant' && hasEmailList(h.content)) lastList = i; });
  // Long replies are cut for the model's context: they cost tokens against the per-minute limit and add little.
  const trim = (t: string) => (t.length > 700 ? `${t.slice(0, 700)}…` : t);
  return history
    .map((h, i) => ({ role: h.role, content: i === lastList ? h.content : h.role === 'assistant' ? trim(forModel(h.role, h.content)) : h.content }))
    .filter(h => h.role === 'user' || (h.content.trim() !== '' && !isPlaceholderReply(h.role, h.content)));
}

export function forModel(role: 'user' | 'assistant', content: string): string {
  if (role !== 'assistant' || !hasEmailList(content)) return content;
  const lines = content.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!ROW.test(lines[i])) { out.push(lines[i]); continue; }
    // Drop the row's snippet line too (indented in the current format, unindented in older ones).
    const next = lines[i + 1] ?? '';
    if (next.trim() && !ROW.test(next) && !next.trim().startsWith('[')) i++;
  }
  return out.join('\n').trim();
}

// "gmail" alone forces the read-only inbox lookup, unless the message is clearly an action or another tool's job.
export function gmailLookupIntent(message: string): boolean {
  return /\bgmail\b/i.test(message) && !/\b(send|draft|compose|reply|forward|write|connect|redash)\b/i.test(message);
}

// A read-only calendar question must hit the tool: left on 'auto' the model skipped it on production and invented events.
// Allowlist of whole-message read templates, not a verb deny-list: three review rounds found a new write phrasing
// ("list my meetings as done", "any chance my meeting can be 4pm") every time a deny-list was extended. Anything that
// is not exactly one of these shapes stays on 'auto', so a write can never be forced into the read tool.
const DAYS = 'monday|tuesday|wednesday|thursday|friday|saturday|sunday';
const D = `(?:today|tomorrow|tonight|this week|next week|this weekend|(?:on )?(?:${DAYS}))`;
const TM = '\\d{1,2}(?::\\d\\d)? ?(?:am|pm)';
const MY = '(?:my |the )?';
const EVT = '(?:meetings?|events?|appointments?)';
const FOR_D = `(?:\\s+(?:on |for )?${D})?`;
const CAL_READ_TEMPLATES = [
  `(?:what(?:'s| is)?|show|list|check|read)\\s+(?:on\\s+)?${MY}(?:calendar|schedule|agenda)${FOR_D}`,
  `(?:what|which)\\s+${EVT}\\s+do i have${FOR_D}`,
  `(?:do i have|any)\\s+(?:any\\s+)?${EVT}${FOR_D}`,
  `(?:show|list)(?: me)?\\s+${MY}${EVT}${FOR_D}`,
  `when(?:'s| is)? my next (?:meeting|event|appointment)`,
  `am i (?:free|busy)(?:\\s+(?:${D}|at ${TM}))*`,
  `what(?:'s| is)? (?:on|up|happening|going on)\\s+${D}`,
  `what do i have(?:\\s+(?:on|planned|scheduled|coming up|lined up))?\\s+${D}`,
  `(?:what(?:'s| is)? my day(?: look(?:s|ing)?(?: like)?)?|how(?: does|'s| is) my day(?: look(?:s|ing)?(?: like)?)?)${FOR_D}`,
  `(?:tell|read|give|walk) me (?:about )?${MY}(?:agenda|schedule|day|calendar)${FOR_D}`,
  `do i have (?:time|anything|something|plans)\\s+${D}`,
].map((t) => `(?:${t})`).join('|');
const CAL_READ_RE = new RegExp(`^(?:${CAL_READ_TEMPLATES})$`, 'i');
export function calendarReadIntent(message: string): boolean {
  if (message.length > 200) return false; // no real read is this long; also bounds the normalisation below
  const m = message.replace(/[‘’]/g, "'").trim().replace(/[?!.\s]+$/, '').replace(/\s+/g, ' ');
  return CAL_READ_RE.test(m);
}
