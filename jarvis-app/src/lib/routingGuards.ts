// A forced tool_choice on a READ tool must never swallow a write request: "resolve ticket 598317" forced into
// get_freshdesk_ticket means the update never happens and the model may claim it did (same class as the calendar bug).
// When this returns true the message stays on tool_choice 'auto' so the model can pick the gated write tool.
//
// Shape (inverted after the reviewer kept finding phrasings a clause-start verb match missed): a message is only forced when
// it either has no write word at all, or it opens like a question ("what is the latest note on ticket 5", "did anyone send
// me mail") AND no write verb starts a later clause ("..., and close it"). Everything else with a write word stays on auto.
const READ_START = /^\s*(?:(?:hey|ok|okay|so|and|please|can you|could you|tell me|let me know)\s+)*(?:what|what's|whats|which|who|whom|when|where|why|how|did|does|do|is|are|was|were|has|have|had|any|show|list|check|get|find|latest|recent|status|see|read|look|give me)\b/i;
const CLAUSE = '(?:[,;.]\\s*|\\b(?:and|then|also|but)\\s+)';
const build = (words: string) => ({
  any: new RegExp(`\\b(?:${words})\\b`, 'i'),
  clause: new RegExp(`${CLAUSE}(?:please\\s+)?(?:${words})\\b`, 'i'),
});
const T = build('close|closing|resolve|resolving|reopen|escalate|assign|reassign|mark|note|comment|reply|respond|set|change|update|add|put|cancel|delete');
const M = build('forward|delete|archive|trash|draft|compose|send|mark|unsubscribe|label|move|put|reply|respond');

const veto = (w: ReturnType<typeof build>, message: string): boolean =>
  w.any.test(message) && (!READ_START.test(message) || w.clause.test(message));

export const ticketWriteIntent = (message: string): boolean => veto(T, message);
// "send me the inbox summary" asks for a read, not for mail to go anywhere.
export const mailWriteIntent = (message: string): boolean => veto(M, message.replace(/\bsend me\b/gi, 'give me'));
