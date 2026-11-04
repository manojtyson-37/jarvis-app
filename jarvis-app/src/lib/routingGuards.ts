// A forced tool_choice on a READ tool must never swallow a write request: "resolve ticket 598317" forced into
// get_freshdesk_ticket means the update never happens and the model may claim it did (same class as the calendar bug).
// When this returns true the message stays on tool_choice 'auto' so the model can pick the gated write tool.
//
// Allowlist shape (verb-position and clause-start matching leaked new phrasings on four review rounds). A message with no
// write word is never vetoed. One with a write word keeps its forced read only when it is ONE short clause that either
//   - opens as a real question (what/which/who/when/did/is/any…: "what is the latest note on ticket 5"), or
//   - opens with a read verb (show/list/check/get…) and every write word is excused as part of a read phrase:
//     "show tickets I need to close", "show resolved tickets".
// "show ticket 5 close", "get ticket 5 resolved", "can you close it" and anything compound stay on auto.
const INTERROGATIVE = /^\s*(?:(?:hey|ok|okay|so|please|can you|could you|tell me|let me know)\s+)*(?:what|what's|whats|which|who|whom|when|where|why|how|did|does|is|are|was|were|has|had|any)\b/i;
const IMPERATIVE_READ = /^\s*(?:(?:hey|ok|okay|so|please|can you|could you|tell me|let me know)\s+)*(?:show|list|check|get|find|read|look|see|give me|latest|recent|status)\b/i;
const COMPOUND = /[.?!;,:&\n—–]\s*\S|\s-+\s|\b(?:and|then|also|but|so|plus|after|next|now|finally|please|kindly|just|can you|could you|would you|make it|if)\b/i;

const TW = 'close|closing|resolve|resolving|reopen|escalate|assign|reassign|mark|note|comment|reply|respond|set|change|update|add|put|cancel|delete';
const MW = 'forward|delete|archive|trash|draft|compose|send|mark|unsubscribe|label|move|put|reply|respond';
const INFL = '(?:e?s|e?d|ing)?';
const NOUN = '(?:tickets?|e-?mails?|mail|messages?|threads?|notes?)';

const make = (words: string) => {
  const w = `(?:${words})${INFL}`;
  return {
    any: new RegExp(`\\b${w}\\b`, 'i'),
    // Write words that are part of a read phrase.
    excused: [
      new RegExp(`\\b(?:i|we|you)\\s+(?:need|should|have|want|must|ought)\\s+to\\s+${w}\\b`, 'gi'),       // "tickets I need to close"
      new RegExp(`\\b(?:that|which)\\s+(?:were|are|was|have been|had been)\\s+${w}\\b`, 'gi'),            // "tickets that were closed"
      new RegExp(`\\b(?:${words})e?d\\s+${NOUN}\\b`, 'gi'),                                                   // "resolved tickets" (participle only, never "add note")
    ],
  };
};
const T = make(TW);
const M = make(MW);

const veto = (set: ReturnType<typeof make>, message: string): boolean => {
  if (!set.any.test(message)) return false;
  // The opener's own "please"/"can you" is allowed; the rest of the message must be a single clause.
  const body = message.replace(/^\s*(?:(?:hey|ok|okay|so|and|please|can you|could you)\s+)+/i, '');
  if (COMPOUND.test(body.trim())) return true;
  if (INTERROGATIVE.test(message)) return false;
  if (IMPERATIVE_READ.test(message)) {
    let rest = message;
    for (const re of set.excused) rest = rest.replace(re, ' ');
    return set.any.test(rest);
  }
  return true;
};

export const ticketWriteIntent = (message: string): boolean => veto(T, message);
// "send me the inbox summary" asks for a read, not for mail to go anywhere.
export const mailWriteIntent = (message: string): boolean => veto(M, message.replace(/\bsend me\b/gi, 'give me'));
