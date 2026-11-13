// One task list across devices, pure part. No database and no network, so the rules are unit-tested.
// Mac pet tasks run on the Mac (Claude CLI); the pet only REPORTS their state here so every device can see them.
// They live in action_items with source 'pet'. The to-do runner and the stuck to-do nudge ignore that source,
// so the server never tries to run or nag about a task that belongs to the Mac.
import { createHash } from 'node:crypto';

export const PET_SOURCE = 'pet';
export const MAX_REPORT = 50;
export const PET_STATES = ['queued', 'running', 'needsApproval', 'done', 'failed', 'cancelled'] as const;
export type PetState = (typeof PET_STATES)[number];
export interface PetTaskReport { id: string; title: string; state: PetState; createdAt: string | null; finishedAt: string | null }
export interface TaskRowInput { id: string; text: string; source: string; status: string; created_at?: string; completed_at: string | null }

// The pet's own id (20261111-143005-a3f1) is not a UUID; the table's key is. Same pet id always gives the same row.
export function petRowId(petId: string): string {
  const h = createHash('sha256').update(`maya-pet-task:${petId}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)}${h.slice(18, 20)}-${h.slice(20, 32)}`;
}

const STATUS: Record<PetState, string> = {
  queued: 'in_progress', running: 'in_progress', needsApproval: 'awaiting_approval',
  done: 'done', failed: 'failed', cancelled: 'skipped',
};
export const petStatus = (s: PetState) => STATUS[s];

const iso = (v: unknown): string | null => {
  if (typeof v !== 'string' || !v) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
};
const oneLine = (s: string, max: number) => {
  const flat = s.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
};

// Only the fields the list needs. A task's result text is never accepted: it can hold file contents.
export function parseReport(body: unknown): { tasks: PetTaskReport[] } | { error: string } {
  const list = (body as { tasks?: unknown } | null)?.tasks;
  if (!Array.isArray(list)) return { error: 'tasks must be a list' };
  if (list.length > MAX_REPORT) return { error: `at most ${MAX_REPORT} tasks per report` };
  const tasks: PetTaskReport[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    const t = raw as Record<string, unknown> | null;
    const id = typeof t?.id === 'string' ? t.id : '';
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(id)) return { error: 'bad task id' };
    if (!(PET_STATES as readonly string[]).includes(t!.state as string)) return { error: 'bad task state' };
    const title = typeof t!.title === 'string' ? oneLine(t!.title, 200) : '';
    if (!title) return { error: 'task title missing' };
    if (seen.has(id)) continue;
    seen.add(id);
    tasks.push({ id, title, state: t!.state as PetState, createdAt: iso(t!.createdAt), finishedAt: iso(t!.finishedAt) });
  }
  return { tasks };
}

export function toRow(t: PetTaskReport, nowIso: string): TaskRowInput {
  const status = petStatus(t.state);
  const finished = status === 'done' || status === 'failed' || status === 'skipped';
  return {
    id: petRowId(t.id), text: `Mac task: ${t.title}`, source: PET_SOURCE, status,
    ...(t.createdAt ? { created_at: t.createdAt } : {}),
    completed_at: finished ? (t.finishedAt ?? nowIso) : null,
  };
}

// ── the one list ────────────────────────────────────────────────────────
export interface OpenTodo { text: string; source: string; status: string; created_at: string }
export interface OpenGoal { goal: string; status: string; created_at: string }
export interface TaskListInput { todos: OpenTodo[]; goals: OpenGoal[]; approvals: number; doneToday: number; warnings: string[] }

const TODO_STATE: Record<string, string> = {
  pending: 'waiting to start', running: 'running now', in_progress: 'running', awaiting_approval: 'waiting for your approval', manual: 'needs you',
};
const GOAL_STATE: Record<string, string> = { queued: 'waiting to start', running: 'running now', waiting_approval: 'waiting for your approval' };
const WHERE: Record<string, string> = { pet: 'Mac', chat: 'chat', checkin: 'check-in', email: 'email', meeting: 'meeting', assistant: 'Maya', manual: 'manual' };
const day = (ts: string) => {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' });
};

export function formatTaskList(input: TaskListInput, shown = 25): string {
  const lines: string[] = [];
  for (const g of input.goals) lines.push(`- Goal (${GOAL_STATE[g.status] ?? g.status}): ${oneLine(g.goal, 160)} · ${day(g.created_at)}`);
  for (const t of input.todos) {
    const text = t.source === PET_SOURCE ? t.text.replace(/^Mac task:\s*/, '') : t.text;
    lines.push(`- ${t.source === PET_SOURCE ? 'Mac task' : 'To-do'} (${TODO_STATE[t.status] ?? t.status}): ${oneLine(text, 160)} · from ${WHERE[t.source] ?? t.source} · ${day(t.created_at)}`);
  }
  const cut = Math.max(0, lines.length - shown);
  const head = lines.length
    ? `${lines.length} open task${lines.length === 1 ? '' : 's'} across all devices${cut ? ` (first ${shown} shown)` : ''}:`
    : 'No open tasks on any device.';
  const tail = [
    input.approvals ? `${input.approvals} action${input.approvals === 1 ? ' is' : 's are'} waiting for your approval.` : '',
    `${input.doneToday} finished today.`,
    input.warnings.length ? `Could not read: ${input.warnings.join(', ')}.` : '',
  ].filter(Boolean);
  return [head, ...lines.slice(0, shown), ...tail].join('\n');
}

// "What tasks are open", "what are you working on", "status of my tasks", "what's pending".
export const TASK_LIST_RE = /\b(?:what|which|any|show|list|status)\b.{0,30}\b(?:tasks?|to-?dos?|goals?)\b.{0,30}\b(?:open|pending|running|left|going|active|stuck|in progress|status|waiting)\b|\b(?:open|pending|running|active|all) (?:tasks?|to-?dos?|goals?)\b|\bwhat(?:'s| is| are) (?:you |maya )?(?:working on|pending|in progress)\b|\b(?:task|to-?do) (?:list|status)\b|\bstatus of (?:my |the |all )?(?:tasks?|to-?dos?|goals?)\b/i;

// Forced read route. A whole-message allowlist, not a verb deny-list: only these exact shapes of question force the
// read tool. Anything else ("add X to my to-do list", "mark the open task done", "what tasks should I do first")
// goes through normal tool choice.
const N = '(?:tasks?|to-?dos?|goals?)';
const S = '(?:open|pending|running|left|active|stuck|in progress|waiting|going on)';
export const TASK_LIST_QUESTION_RE = new RegExp(
  '^\\W*(?:(?:hey|hi|maya)\\b[\\s,]*){0,2}(?:'
  + `(?:what|which) (?:all )?(?:of )?(?:my |the )?${N} (?:are|is) (?:still |currently |now )?${S}`
  + `|(?:any|what(?:'s| is| are)(?: my| the)?|show(?: me)?(?: my| all| the)?|list(?: my| all| the)?) (?:all )?${S} ${N}`
  + `|(?:show|list)(?: me)?(?: my| all(?: my)?| the)? ${N}`
  + `|(?:show(?: me)? |what(?:'s| is) )?(?:my |the )?(?:task|to-?do) (?:list|status)`
  + `|(?:what(?:'s| is) the )?status of (?:my |the |all (?:my )?)?${N}`
  + `|what (?:are you|is maya) working on|what(?:'s| is) (?:pending|in progress)`
  + ')(?:[\\s,]+(?:right now|now|today|please|maya|across (?:all )?(?:my )?devices|on all devices))*\\W*$', 'i');
export const isTaskListQuestion = (message: string) => TASK_LIST_QUESTION_RE.test(message.trim());
