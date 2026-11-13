// Chat tool for prospects and sales. Read-only: it reads the last snapshot.
import type Groq from 'groq-sdk';
import { latestSnapshot } from './store';
import { formatPipeline } from './rules';

export const PIPELINE_TOOLS: Groq.Chat.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'get_pipeline',
      description: 'Prospect and sales numbers for Manoj\'s products: clinic leads by stage (prospects, contacted, demos, sales), ClinicOS clinic accounts and paying clinics, Reviews businesses and paying ones. Counts only, from the last snapshot. Read-only. Use for "how many prospects", "how many sales", "how is ClinicOS doing".',
      parameters: { type: 'object', properties: {} },
    },
  },
];

export const PIPELINE_TOOL_NAMES = new Set(PIPELINE_TOOLS.map(t => t.function.name));

export async function runPipelineTool(name: string, userId: string, now: Date = new Date()): Promise<string> {
  if (name !== 'get_pipeline') return `Unknown pipeline tool: ${name}`;
  try {
    return formatPipeline(await latestSnapshot(userId), now);
  } catch (e) {
    console.error('[pipeline] read failed:', (e as Error).message);
    return 'I could not read the prospect and sales numbers just now. Please try again.';
  }
}
