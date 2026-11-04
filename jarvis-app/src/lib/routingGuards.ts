// A forced tool_choice on a READ tool must never swallow a write request: "resolve ticket 598317" forced into
// get_freshdesk_ticket means the update never happens and the model may claim it did (same class as the calendar bug).
// When this returns true the message stays on tool_choice 'auto' so the model can pick the gated write tool.
//
// Allowlist shape (clause-start and verb-position matching leaked new phrasings on three review rounds): a message that has
// a write word is forced only when it is ONE short question ("what is the latest note on ticket 5", "did anyone send me
// mail", "show tickets I need to close"). A second clause, a request word, or no question opener means a write may be
// hiding in it, so it stays on auto. Messages with no write word at all are never vetoed.
const READ_START = /^\s*(?:(?:hey|ok|okay|so|and|please|can you|could you|tell me|let me know)\s+)*(?:what|what's|whats|which|who|whom|when|where|why|how|did|does|do|is|are|was|were|has|have|had|any|show|list|check|get|find|latest|recent|status|see|read|look|give me)\b/i;
const COMPOUND = /[.?!;,:&\n—–]\s*\S|\s-+\s|\b(?:and|then|also|but|so|plus|after|next|now|finally|please|kindly|just|can you|could you|would you|make it|if)\b/i;
const T = /\b(?:close|closing|resolve|resolving|reopen|escalate|assign|reassign|mark|note|comment|reply|respond|set|change|update|add|put|cancel|delete)(?:e?s|e?d|ing)?\b/i;
const M = /\b(?:forward|delete|archive|trash|draft|compose|send|mark|unsubscribe|label|move|put|reply|respond)(?:e?s|e?d|ing)?\b/i;

const veto = (words: RegExp, message: string): boolean => {
  if (!words.test(message)) return false;
  // The opener's own "please"/"can you" is allowed; the rest of the message must be a single clause.
  const body = message.replace(/^\s*(?:(?:hey|ok|okay|so|and|please|can you|could you)\s+)+/i, '');
  return !READ_START.test(message) || COMPOUND.test(body.trim());
};

export const ticketWriteIntent = (message: string): boolean => veto(T, message);
// "send me the inbox summary" asks for a read, not for mail to go anywhere.
export const mailWriteIntent = (message: string): boolean => veto(M, message.replace(/\bsend me\b/gi, 'give me'));
