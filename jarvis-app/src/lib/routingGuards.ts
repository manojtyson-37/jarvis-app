// A forced tool_choice on a READ tool must never swallow a write request: "resolve ticket 598317" forced into
// get_freshdesk_ticket means the update never happens and the model may claim it did (same class as the calendar bug).
// When one of these matches, the message stays on tool_choice 'auto' so the model can pick the gated write tool.
export const TICKET_WRITE = /\b(?:close|closing|resolve|resolving|reopen|escalate|assign|reassign|mark|(?:reply|respond)\s+to\s+(?:the\s+)?ticket|set\s+(?:the\s+)?(?:ticket|status|priority)|change\s+(?:the\s+)?(?:ticket|status|priority)|update\s+(?:the\s+)?(?:ticket|status)|add\s+(?:a\s+)?(?:private\s+)?note|note\s+(?:on|to))\b/i;
export const MAIL_WRITE = /\b(?:forward|delete|archive|trash|send|draft|compose|mark|unsubscribe|label (?:it|this|them)|move (?:it|this|them))\b/i;

export const ticketWriteIntent = (message: string): boolean => TICKET_WRITE.test(message);
export const mailWriteIntent = (message: string): boolean => MAIL_WRITE.test(message);
