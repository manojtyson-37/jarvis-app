// Maya's multi-step agent loop: plan -> act -> observe, checkpointed after every step so a run survives the function
// being killed, and paused (not blocked) on any approval-tier step until Manoj decides on the Telegram/app card.
// Pure engine: every side effect comes in through Deps, so the control flow is unit-tested without a DB or a model.
import { tierOf, allowedTools, PRIVATE_READERS } from './tiers';
import { urlsIn, urlAllowed } from '../todos/classify';

export const MAX_ROUNDS = 10;   // model calls over the whole run, across resumes
export const MAX_STEPS = 16;    // tool calls over the whole run
const RESULT_CAP = 6000;

export interface ToolCall { id: string; name: string; args: string }
export interface Msg {
  role: 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}
export interface Waiting { stepId: string; toolCallId: string; actionId: string; summary: string }
export interface RunState {
  goal: string;
  plan: string[];
  messages: Msg[];        // the checkpoint: everything after the system + goal messages
  rounds: number;
  steps: number;
  privateRead: boolean;
  seenUrls: string[];
  waiting: Waiting | null;
}

export type ActionStatus = { status: string; result: string | null; expired: boolean } | null;

export interface Deps {
  model(messages: Msg[], tools: string[], final: boolean): Promise<{ content: string; toolCalls: ToolCall[] }>;
  exec(name: string, args: Record<string, unknown>): Promise<string>;
  queue(name: string, args: Record<string, unknown>): Promise<{ message: string; actionId: string | null }>;
  actionStatus(actionId: string): Promise<ActionStatus>;
  stepStart(call: ToolCall, tier: 'auto' | 'approval', args: Record<string, unknown>, idx: number): Promise<string>;
  stepEnd(stepId: string, status: 'done' | 'failed' | 'waiting_approval' | 'approved' | 'rejected' | 'expired', result: string, actionId?: string): Promise<void>;
  checkpoint(state: RunState): Promise<boolean>; // false = this worker lost its lease: stop at once
  now(): number;
}

export type Outcome =
  | { kind: 'done'; text: string }
  | { kind: 'waiting'; summary: string; fresh: boolean } // fresh = queued in this call (notify once)
  | { kind: 'paused' }                                   // out of time this invocation; the cron continues it
  | { kind: 'failed'; reason: string }
  | { kind: 'lost' };

export const newState = (goal: string, plan: string[]): RunState => ({
  goal, plan, messages: [], rounds: 0, steps: 0, privateRead: false, seenUrls: urlsIn(goal).map(clean), waiting: null,
});

const clean = (u: string) => u.replace(/[.,;:!?]+$/, '');

// What the model is told once Manoj has decided on a paused step.
export function decisionText(s: ActionStatus): string | null {
  if (!s) return 'The approval request for this step could not be found, so it was NOT done. Do not retry it. Finish and say it is still open.';
  if (s.status === 'pending' || s.status === 'executing') return s.expired && s.status === 'pending'
    ? 'The approval request expired without an answer, so it was NOT done. Do not retry it. Finish and say it is still open.'
    : null;
  if (s.status === 'executed') return `Manoj approved this step and it was done. Result: ${s.result ?? 'done'}`;
  if (s.status === 'failed') return `Manoj approved this step but it failed: ${s.result ?? 'unknown error'}. Do not retry it automatically; report it.`;
  if (s.status === 'rejected') return 'Manoj rejected this step, so it was NOT done. Do not retry it or ask again. Finish what does not depend on it and say what was skipped.';
  if (s.status === 'expired') return 'The approval request expired without an answer, so it was NOT done. Do not retry it. Finish and say it is still open.';
  return `This step ended with status "${s.status}" and was NOT done. Do not retry it.`;
}

const stepStatusFor = (s: ActionStatus): 'approved' | 'rejected' | 'expired' | 'failed' =>
  !s ? 'failed' : s.status === 'executed' ? 'approved' : s.status === 'rejected' ? 'rejected'
    : s.status === 'expired' || s.expired ? 'expired' : 'failed';

// A worker that died mid-round leaves tool calls with no result. They are never re-run here (one may have had an
// effect); the model is told the outcome is unknown and decides from there.
export function repairTranscript(state: RunState): void {
  const lastAsst = [...state.messages].reverse().find(m => m.role === 'assistant' && m.tool_calls?.length);
  if (!lastAsst) return;
  const answered = new Set(state.messages.filter(m => m.role === 'tool').map(m => m.tool_call_id));
  for (const tc of lastAsst.tool_calls ?? []) {
    if (answered.has(tc.id) || state.waiting?.toolCallId === tc.id) continue;
    state.messages.push({ role: 'tool', tool_call_id: tc.id, content: 'This step was interrupted and its outcome is unknown. Check before redoing it; never redo a send.' });
  }
}

function parseArgs(raw: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(raw || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
  } catch { return null; }
}

export async function advance(state: RunState, deps: Deps, budgetMs: number): Promise<Outcome> {
  const started = deps.now();

  // 1. Resume a paused step once Manoj has decided.
  if (state.waiting) {
    const s = await deps.actionStatus(state.waiting.actionId);
    const text = decisionText(s);
    if (text === null) return { kind: 'waiting', summary: state.waiting.summary, fresh: false };
    await deps.stepEnd(state.waiting.stepId, stepStatusFor(s), text, state.waiting.actionId);
    state.messages.push({ role: 'tool', tool_call_id: state.waiting.toolCallId, content: text });
    state.waiting = null;
    if (!(await deps.checkpoint(state))) return { kind: 'lost' };
  }
  repairTranscript(state);

  // 2. Plan -> act -> observe until the model answers without a tool, a step pauses, or a cap is hit.
  while (deps.now() - started < budgetMs) {
    const final = state.rounds >= MAX_ROUNDS - 1 || state.steps >= MAX_STEPS;
    const tools = [...allowedTools(state.privateRead)];
    const r = await deps.model(state.messages, tools, final);
    state.rounds++;
    if (!r.toolCalls.length || final) {
      const text = r.content.trim();
      if (!(await deps.checkpoint(state))) return { kind: 'lost' };
      return text ? { kind: 'done', text } : { kind: 'failed', reason: 'The model gave no answer.' };
    }
    const allowed = allowedTools(state.privateRead); // fixed for this round: what the model was offered
    state.messages.push({ role: 'assistant', content: r.content, tool_calls: r.toolCalls });
    if (!(await deps.checkpoint(state))) return { kind: 'lost' };

    let freshSummary: string | null = null;
    for (const tc of r.toolCalls) {
      let result: string;
      const tier = tierOf(tc.name);
      const args = parseArgs(tc.args);
      if (!allowed.has(tc.name) || tier === 'never') result = `Tool ${tc.name} is not available in this run.`;
      else if (!args) result = 'Tool arguments were not valid JSON. Nothing was done.';
      else if (state.steps >= MAX_STEPS) result = 'Step limit reached. Nothing was done; finish with what you have.';
      else if (tc.name === 'read_url' && !urlAllowed(args.url, new Set(state.seenUrls))) {
        result = 'read_url can only open a link that appears in the goal or in earlier web_search results.';
      } else if (tier === 'approval') {
        if (state.waiting) result = 'Not queued: one approval at a time. Ask for this again after the current one is decided.';
        else {
          const idx = state.steps++;
          const stepId = await deps.stepStart(tc, 'approval', args, idx);
          const q = await deps.queue(tc.name, args);
          if (q.actionId) {
            await deps.stepEnd(stepId, 'waiting_approval', q.message, q.actionId);
            state.waiting = { stepId, toolCallId: tc.id, actionId: q.actionId, summary: q.message };
            freshSummary = q.message;
            if (!(await deps.checkpoint(state))) return { kind: 'lost' };
            continue; // its tool result is added when Manoj decides
          }
          await deps.stepEnd(stepId, 'failed', q.message);
          result = q.message;
        }
      } else {
        const idx = state.steps++;
        const stepId = await deps.stepStart(tc, 'auto', args, idx);
        try {
          result = await deps.exec(tc.name, args);
          await deps.stepEnd(stepId, 'done', result.slice(0, RESULT_CAP));
        } catch (e) {
          result = `Tool error: ${(e as Error).message}`;
          await deps.stepEnd(stepId, 'failed', result);
        }
        if (tc.name === 'web_search' && !state.privateRead) {
          for (const u of urlsIn(result)) if (!state.seenUrls.includes(clean(u))) state.seenUrls.push(clean(u));
        }
        if (PRIVATE_READERS.has(tc.name)) state.privateRead = true;
      }
      state.messages.push({ role: 'tool', tool_call_id: tc.id, content: result.slice(0, RESULT_CAP) });
      if (!(await deps.checkpoint(state))) return { kind: 'lost' };
    }
    if (state.waiting) return { kind: 'waiting', summary: state.waiting.summary, fresh: freshSummary !== null };
  }
  return { kind: 'paused' };
}
