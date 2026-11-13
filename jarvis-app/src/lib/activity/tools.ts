// Chat tool for the activity timeline. Read-only: it lists what already happened and can never change anything.
import type Groq from 'groq-sdk';
import { loadActivity } from './store';
import { formatFeed, istDayStart } from './feed';

export const ACTIVITY_TOOLS: Groq.Chat.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'get_today_activity',
      description: 'List what Maya did today (since midnight IST): actions queued, run or rejected; to-do results; Away Mode drafts and escalations; job-tracker updates. Read-only. Use for "what did you do today", "what happened while I was away", "any updates today".',
      parameters: { type: 'object', properties: {} },
    },
  },
];

export const ACTIVITY_TOOL_NAMES = new Set(ACTIVITY_TOOLS.map(t => t.function.name));

export async function runActivityTool(name: string, userId: string, now: Date = new Date()): Promise<string> {
  if (name !== 'get_today_activity') return `Unknown activity tool: ${name}`;
  const { events, warnings } = await loadActivity(userId, istDayStart(now));
  return formatFeed(events, warnings, 'since midnight IST');
}
