// Chat tool for searching the full chat history. Read-only.
import type Groq from 'groq-sdk';
import { supabase } from '@/lib/supabase';
import { searchTerms, escapeLike, clampHits, clampDays, dropSelfMatches, formatHits, type ConversationRow } from './search';
import { isChannel } from './channel';

export const CONVERSATION_TOOLS: Groq.Chat.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'search_conversations',
      description: 'Search every past chat message between Manoj and Maya, from all devices (web app, Mac pet, Telegram), not just the recent ones in context. Read-only. Use for "what did I tell you about X", "did we talk about Y", "when did I mention Z".',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Key words or a name to look for, e.g. "Razorpay offer". Every word must appear in the message.' },
          days: { type: 'number', description: 'Optional: only look this many days back.' },
          channel: { type: 'string', enum: ['web', 'pet', 'telegram', 'system'], description: 'Optional: only messages from this device.' },
          limit: { type: 'number', description: 'Optional: how many messages to return (default 8, max 15).' },
        },
        required: ['query'],
      },
    },
  },
];

export const CONVERSATION_TOOL_NAMES = new Set(CONVERSATION_TOOLS.map(t => t.function.name));

export async function runConversationTool(name: string, args: Record<string, unknown>, userId: string, now: Date = new Date()): Promise<string> {
  if (name !== 'search_conversations') return `Unknown conversation tool: ${name}`;
  const terms = searchTerms(String(args.query ?? ''));
  if (!terms.length) return formatHits([], terms, '');
  const limit = clampHits(args.limit);
  const days = clampDays(args.days);
  const channel = isChannel(args.channel) ? args.channel : null;

  // select('*') on purpose: it keeps working before the `channel` column exists.
  const run = (withChannel: boolean) => {
    let q = supabase.from('conversation_history').select('*').eq('user_id', userId).neq('content', '');
    for (const t of terms) q = q.ilike('content', `%${escapeLike(t)}%`);
    if (days) q = q.gte('ts', new Date(now.getTime() - days * 86_400_000).toISOString());
    if (withChannel && channel) q = q.eq('channel', channel);
    // A few extra rows: the question that triggered this search is dropped below.
    return q.order('ts', { ascending: false }).limit(limit + 4);
  };
  let { data, error } = await run(true);
  let channelUsed = channel;
  // The device filter needs the `channel` column. Without it, search every device rather than fail.
  if (error && channel && /channel/i.test(error.message)) { ({ data, error } = await run(false)); channelUsed = null; }
  if (error) {
    console.error('[conversations] search failed:', error.message);
    return 'I could not search the chat history just now. Please try again.';
  }
  const rows = dropSelfMatches((data ?? []) as ConversationRow[], now).slice(0, limit);
  const scope = `${channelUsed ? ` on ${channelUsed}` : ''}${days ? ` in the last ${days} day${days === 1 ? '' : 's'}` : ''}`;
  return formatHits(rows, terms, scope);
}
