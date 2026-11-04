// A forced tool_choice on a READ tool must never swallow a write request: "resolve ticket 598317" forced into
// get_freshdesk_ticket means the update never happens and the model may claim it did (same class as the calendar bug).
// When one of these matches, the message stays on tool_choice 'auto' so the model can pick the gated write tool.
// The verb must be an imperative: at the start of the message or of a clause ("..., close it", "and resolve it"), so read
// questions that merely mention the word ("what is the latest note on ticket 5", "did anyone send me mail") keep their tool.
const CLAUSE_START = '(?:^|[,;.]\\s*|\\b(?:and|then|please|can you|could you|just)\\s+)';
export const TICKET_WRITE = new RegExp(CLAUSE_START + '(?:close|closing|resolve|resolving|reopen|escalate|assign|reassign|mark|(?:reply|respond)\\s+to\\s+(?:the\\s+)?ticket|set\\s+(?:the\\s+)?(?:ticket|status|priority)|change\\s+(?:the\\s+)?(?:status|priority|ticket)|update\\s+(?:the\\s+)?(?:ticket|status)|add\\s+(?:a\\s+)?(?:private\\s+)?note)\\b', 'i');
export const MAIL_WRITE = new RegExp(CLAUSE_START + '(?:forward|delete|archive|trash|draft|compose|mark|unsubscribe|label|move)\\b', 'i');

export const ticketWriteIntent = (message: string): boolean => TICKET_WRITE.test(message);
export const mailWriteIntent = (message: string): boolean => MAIL_WRITE.test(message);
