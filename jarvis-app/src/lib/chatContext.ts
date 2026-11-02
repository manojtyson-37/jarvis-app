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
// Needs a calendar noun AND a read cue, and no write verb, so "put lunch on my calendar" or "clear my schedule" is never
// forced into the read tool. Mixed read+write messages stay on 'auto'.
const CAL_NOUN = /\b(calendar|agenda|schedule|meetings?|events?|appointments?|my day)\b/i;
const CAL_READ = /\b(what|which|show|list|check|any|do i have|when|how)\b/i;
const CAL_MY = /\b(my|am i)\b/i;
const DAYS = 'monday|tuesday|wednesday|thursday|friday|saturday|sunday';
const CAL_TIME = new RegExp(`\\b(today|tomorrow|tonight|this (?:week|morning|afternoon|evening|weekend)|next (?:week|meeting|event)|upcoming|${DAYS})\\b|\\b\\d{1,2}(?::\\d\\d)? ?(?:am|pm)\\b`, 'i');
// Fixed phrasings only: loose cues like tell/give/read captured write requests ("give my 3pm meeting a new title").
const CAL_ONLY = new RegExp(
  `\\bwhat(?:'s|s| is)? (?:on|up|happening|going on)\\b.{0,25}\\b(?:today|tomorrow|tonight|this week|next week)\\W*$` +
  `|\\bwhat do i have (?:on|planned|scheduled|coming up|lined up|today|tomorrow|tonight|this week|next week)\\b` +
  `|\\bdo i have (?:time|anything|something|plans)\\b.{0,12}\\b(?:today|tomorrow|tonight|this week|next week|${DAYS})\\b` +
  `|\\b(?:tell|read|give|walk) me (?:about )?(?:my |the )?(?:agenda|schedule|day|calendar)\\b`, 'i');
// Inflected stems (moved, scheduling, titled…); "schedule" alone stays a noun ("show my schedule").
const CAL_WRITE = /\b(?:add|creat|book|set|delet|remov|cancel|mov|reschedul|postpon|invit|remind|put|block|chang|updat|edit|renam|extend|shorten|shift|clear|sav|sync|pencil|fix|titl|nam|mark|push|drop|skip|declin|accept|swap|replac|mak)(?:e|s|es|ed|d|ing|ting|ping|king|ning)?\b|\bset up\b|\bfree up\b|\brepl(?:y|ies|ied)\b|\bschedul(?:ing|ed)\b|\bschedule (?:a|an|the|me|it|my|standup|lunch|call)\b/i;
const CAL_OTHER = /\b(notes?|minutes|transcript|action items?|fireflies|summar\w*|e-?mails?|mail|tickets?|drive|docs?|redash)\b/i;
export function calendarReadIntent(message: string): boolean {
  if (CAL_WRITE.test(message) || CAL_OTHER.test(message)) return false;
  if (CAL_ONLY.test(message)) return true;
  if (/\bam i (?:free|busy)\b/i.test(message)) return CAL_TIME.test(message);
  return CAL_NOUN.test(message) && CAL_READ.test(message) && (CAL_MY.test(message) || CAL_TIME.test(message));
}
