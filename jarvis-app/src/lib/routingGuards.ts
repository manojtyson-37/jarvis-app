// A forced tool_choice on a READ tool must never swallow a write request: "resolve ticket 598317" forced into
// get_freshdesk_ticket means the update never happens and the model may claim it did (same class as the calendar bug).
// When this returns true the message stays on tool_choice 'auto' so the model can pick the gated write tool.
//
// Allowlist shape (verb-position, clause-start and opener-based matching all leaked new phrasings over five review rounds).
// A message with no write word is never vetoed. One with a write word keeps its forced read only when it is ONE short clause
// that opens like a read (what/which/who/did/is/any…, or show/list/check/get…) AND every write word is excused as part of a
// read phrase: "the latest note", "tickets I need to close", "did bob reply", "closed", "that were escalated".
// Request frames ("is it possible to close…", "why not close…", "how do I close…") never excuse a bare verb, so they stay on auto.
const LEAD = '(?:(?:hey|ok|okay|so|please|can you|could you|tell me|let me know)\\s+)*';
const INTERROGATIVE = new RegExp(`^\\s*${LEAD}(?:what|what's|whats|which|who|whom|when|where|why|how|did|does|is|are|was|were|has|had|any)\\b`, 'i');
const IMPERATIVE = new RegExp(`^\\s*${LEAD}(?:show|list|check|get|find|read|look|see|give me|latest|recent|status)\\b`, 'i');
const COMPOUND = /[.?!;,:&\n—–]\s*\S|\s-+\s|\b(?:and|then|also|but|so|plus|after|next|now|finally|please|kindly|just|can you|could you|would you|make it|if)\b/i;

const TW = 'close|closing|resolve|resolving|reopen|escalate|assign|reassign|mark|note|comment|reply|respond|set|change|update|add|put|cancel|delete';
const MW = 'forward|delete|archive|trash|draft|compose|send|mark|unsubscribe|label|move|put|reply|respond';
const INFL = '(?:e?s|e?d|ing)?';
const NOUN = '(?:tickets?|e-?mails?|mail|messages?|threads?|notes?)';

// "archive" -> also "archiving", "close" -> "closing"
const withIng = (words: string) => [...new Set(words.split('|').flatMap(w => (w.endsWith('e') ? [w, `${w.slice(0, -1)}ing`] : [w])))].join('|');
const GAP = '(?:(?:latest|last|new|recent|first|previous|private|public|internal|open|unread)\\s+)?';
const make = (base: string) => {
  const words = withIng(base);
  const strict = [
    // "tickets I need to close", "emails I should delete", "which emails should I delete" ("can" is not here: "how can I close" is a request)
    new RegExp(`\\b(?:i|we|you)\\s+(?:need to|have to|want to|ought to|should|must)\\s+(?:${words})\\b`, 'gi'),
    new RegExp(`\\b(?:should|must|shall)\\s+(?:i|we)\\s+(?:${words})\\b`, 'gi'),
    // "tickets that were closed"
    new RegExp(`\\b(?:that|which)\\s+(?:were|are|was|have been|had been)\\s+(?:${words})${INFL}\\b`, 'gi'),
    // "closed tickets", "archived mail": a participle describing a noun
    new RegExp(`\\b(?:${words})e?d\\s+${NOUN}\\b`, 'gi'),
    // "is/was/been closed": a state, after a form of "to be"
    new RegExp(`\\b(?:is|are|was|were|be|been|being)\\s+(?:${words})e?d\\b`, 'gi'),
    // "did bob reply", "does anyone comment" (not "did I close": that is a request frame)
    new RegExp(`\\b(?:did|does)\\s+(?!i\\b|we\\b|you\\b)\\S+\\s+(?:${words})\\b`, 'gi'),
    // the word used as a noun: "any reply from bob", "the latest note", "my last comment"
    new RegExp(`\\b(?:any|the|a|an|my|his|her|their|no)\\s+${GAP}(?:${words})s?\\b`, 'gi'),
    new RegExp(`\\b(?:latest|last|new|recent)\\s+(?:${words})s?\\b`, 'gi'),
    // plural nouns: "gmail labels", "notes", "replies"
    /\b(?:labels|notes|comments|replies|drafts|updates|changes|marks)\b/gi,
  ];
  // Past tense is also fine for a real question ("who closed ticket 5", "is ticket 5 closed", "who resolved it")
  const pastOk = [new RegExp(`\\b(?:${words})e?d\\b|\\breplied\\b`, 'gi')];
  return { any: new RegExp(`\\b(?:${words})${INFL}\\b`, 'i'), strict, pastOk };
};
const T = make(TW);
const M = make(MW);

const veto = (set: ReturnType<typeof make>, message: string): boolean => {
  if (!set.any.test(message)) return false;
  // The opener's own "please"/"can you" is allowed; the rest of the message must be a single clause.
  const body = message.replace(/^\s*(?:(?:hey|ok|okay|so|and|please|can you|could you)\s+)+/i, '');
  const interrogative = INTERROGATIVE.test(message);
  if (COMPOUND.test(body.trim()) || (!interrogative && !IMPERATIVE.test(message))) return true;
  // A real question may use past-tense forms freely; a read verb ("get ticket 5 resolved") may not.
  const excuses = interrogative ? [...set.strict, ...set.pastOk] : set.strict;
  let rest = message;
  for (const re of excuses) rest = rest.replace(re, ' ');
  return set.any.test(rest);
};

export const ticketWriteIntent = (message: string): boolean => veto(T, message);
// "send me the inbox summary" asks for a read, not for mail to go anywhere.
export const mailWriteIntent = (message: string): boolean => veto(M, message.replace(/\bsend me\b/gi, 'give me'));
