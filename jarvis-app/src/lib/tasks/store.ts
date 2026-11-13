// One task list across devices, database part. Reads to-dos, Mac pet tasks, agent goals and the approval queue.
import { supabase } from '@/lib/supabase';
import { PET_SOURCE, toRow, type PetTaskReport, type TaskListInput, type OpenTodo, type OpenGoal } from './rules';
import { RUNNER_SINCE } from '@/lib/todos/store';

const OPEN_TODO = ['pending', 'running', 'in_progress', 'awaiting_approval', 'manual'];
const OPEN_GOAL = ['queued', 'running', 'waiting_approval'];
const TODO_CAP = 60;

// The pet sends its whole list each time. New tasks are inserted; known ones are updated only if they are pet rows,
// so a report can never touch a to-do that came from chat, email or a meeting.
export async function savePetReport(userId: string, tasks: PetTaskReport[], now: Date = new Date()): Promise<{ added: number; updated: number }> {
  if (!tasks.length) return { added: 0, updated: 0 };
  const rows = tasks.map(t => toRow(t, now.toISOString()));
  const { data: known, error: readErr } = await supabase.from('action_items')
    .select('id, status, text, source, user_id').in('id', rows.map(r => r.id));
  if (readErr) throw new Error(readErr.message);
  const byId = new Map((known ?? []).map(k => [k.id as string, k]));
  const fresh = rows.filter(r => !byId.has(r.id));
  const changed = rows.filter(r => {
    const k = byId.get(r.id);
    return k && k.source === PET_SOURCE && k.user_id === userId && (k.status !== r.status || k.text !== r.text);
  });
  if (fresh.length) {
    const { error } = await supabase.from('action_items').insert(fresh.map(r => ({ ...r, user_id: userId })));
    if (error) throw new Error(error.message);
  }
  for (const r of changed) {
    const { error } = await supabase.from('action_items')
      .update({ status: r.status, text: r.text, completed_at: r.completed_at })
      .eq('id', r.id).eq('user_id', userId).eq('source', PET_SOURCE);
    if (error) throw new Error(error.message);
  }
  return { added: fresh.length, updated: changed.length };
}

export async function loadTaskList(userId: string, dayStartIso: string): Promise<TaskListInput> {
  const warnings: string[] = [];
  const [todos, goals, approvals, done] = await Promise.all([
    // Old pre-runner meeting to-dos are left out, same rule as the runner and the nudge.
    supabase.from('action_items').select('text, source, status, created_at')
      .eq('user_id', userId).in('status', OPEN_TODO).gte('created_at', RUNNER_SINCE)
      .order('created_at', { ascending: false }).limit(TODO_CAP),
    supabase.from('agent_runs').select('goal, status, created_at')
      .eq('user_id', userId).in('status', OPEN_GOAL).order('created_at', { ascending: false }).limit(10),
    supabase.from('pending_actions').select('id', { count: 'exact', head: true })
      .eq('user_id', userId).eq('status', 'pending').gt('expires_at', new Date().toISOString()),
    supabase.from('action_items').select('id', { count: 'exact', head: true })
      .eq('user_id', userId).eq('status', 'done').gte('completed_at', dayStartIso),
  ]);
  if (todos.error) warnings.push('to-dos');
  if ((todos.data?.length ?? 0) >= TODO_CAP) warnings.push(`to-dos beyond the newest ${TODO_CAP}`);
  if (goals.error) warnings.push('goals');
  if (approvals.error) warnings.push('approvals');
  if (done.error) warnings.push('finished count');
  for (const r of [todos, goals, approvals, done]) if (r.error) console.error('[tasks] read failed:', r.error.message);
  return {
    todos: (todos.data ?? []) as OpenTodo[],
    goals: (goals.data ?? []) as OpenGoal[],
    approvals: approvals.count ?? 0,
    doneToday: done.count ?? 0,
    warnings,
  };
}
