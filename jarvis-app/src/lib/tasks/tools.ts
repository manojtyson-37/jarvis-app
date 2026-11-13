// Chat tool for the one task list. Read-only.
import type Groq from 'groq-sdk';
import { loadTaskList } from './store';
import { formatTaskList } from './rules';
import { istDayStart } from '@/lib/activity/feed';

export const TASK_TOOLS: Groq.Chat.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'list_tasks',
      description: 'One list of everything still open, from every device: to-dos, tasks given to the Mac pet, multi-step goals, and how many actions wait for approval. Read-only. Use for "what tasks are open", "what are you working on", "status of my tasks".',
      parameters: { type: 'object', properties: {} },
    },
  },
];

export const TASK_TOOL_NAMES = new Set(TASK_TOOLS.map(t => t.function.name));

export async function runTaskTool(name: string, userId: string, now: Date = new Date()): Promise<string> {
  if (name !== 'list_tasks') return `Unknown task tool: ${name}`;
  return formatTaskList(await loadTaskList(userId, istDayStart(now)));
}
