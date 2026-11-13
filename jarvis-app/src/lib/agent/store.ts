// Persistence for agent runs. A run is owned by one worker at a time through a lease (compare-and-set on
// lease_owner), so the chat trigger, the approval trigger and the cron can never drive the same run at once.
import { randomUUID } from 'crypto';
import { supabase } from '@/lib/supabase';
import type { RunState, Msg, Waiting } from './loop';

const LEASE_MS = 5 * 60 * 1000;
export const MAX_ACTIVE_RUNS = 3;
const ACTIVE = ['queued', 'running', 'waiting_approval'];
const RESUMABLE_DAYS = 7;

export interface RunRow {
  id: string; user_id: string; goal: string; status: string;
  plan: unknown; messages: unknown; state: Record<string, unknown> | null;
}
export interface Claimed { row: RunRow; owner: string; stale: boolean }

const leaseIso = () => new Date(Date.now() + LEASE_MS).toISOString();

export async function createRun(userId: string, goal: string, source: string): Promise<{ id: string } | { error: string }> {
  const { count, error: cErr } = await supabase.from('agent_runs')
    .select('id', { count: 'exact', head: true }).eq('user_id', userId).in('status', ACTIVE);
  if (cErr) throw cErr;
  if ((count ?? 0) >= MAX_ACTIVE_RUNS) return { error: `${MAX_ACTIVE_RUNS} goals are already in progress. Let one finish (or reject its pending step) first.` };
  const { data, error } = await supabase.from('agent_runs')
    .insert({ user_id: userId, goal, source, status: 'queued' }).select('id').single();
  if (error || !data) throw error ?? new Error('run not created');
  return { id: data.id as string };
}

// Takes the run if it is free: queued or waiting (a waiting run is checked for a decision), or running with a dead lease.
export async function claimRun(userId: string, id: string): Promise<Claimed | null> {
  const owner = randomUUID();
  const now = new Date().toISOString();
  const set = { status: 'running', lease_owner: owner, lease_until: leaseIso(), updated_at: now };
  const fresh = await supabase.from('agent_runs').update(set)
    .eq('id', id).eq('user_id', userId).in('status', ['queued', 'waiting_approval']).select('*');
  if (fresh.error) throw fresh.error;
  if (fresh.data?.length) return { row: fresh.data[0] as RunRow, owner, stale: false };
  const stale = await supabase.from('agent_runs').update(set)
    .eq('id', id).eq('user_id', userId).eq('status', 'running').lt('lease_until', now).select('*');
  if (stale.error) throw stale.error;
  if (stale.data?.length) return { row: stale.data[0] as RunRow, owner, stale: true };
  return null;
}

const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? v as T[] : []);

export function toState(row: RunRow): RunState & { errors: number } {
  const s = row.state ?? {};
  const w = s.waiting as Waiting | null | undefined;
  return {
    goal: row.goal,
    plan: arr<string>(row.plan).filter(x => typeof x === 'string'),
    messages: arr<Msg>(row.messages),
    rounds: Number(s.rounds) || 0,
    steps: Number(s.steps) || 0,
    privateRead: s.privateRead === true,
    seenUrls: arr<string>(s.seenUrls).filter(x => typeof x === 'string'),
    waiting: w && typeof w.actionId === 'string' && typeof w.toolCallId === 'string' ? w : null,
    errors: Number(s.errors) || 0,
  };
}

const stateCol = (st: RunState & { errors?: number }) => ({
  rounds: st.rounds, steps: st.steps, privateRead: st.privateRead, seenUrls: st.seenUrls, waiting: st.waiting, errors: st.errors ?? 0,
});

// The checkpoint. Returns false when another worker has taken the run: the caller must stop.
export async function saveCheckpoint(id: string, owner: string, st: RunState & { errors?: number }): Promise<boolean> {
  const { data, error } = await supabase.from('agent_runs')
    .update({ plan: st.plan, messages: st.messages, state: stateCol(st), lease_until: leaseIso(), updated_at: new Date().toISOString() })
    .eq('id', id).eq('lease_owner', owner).eq('status', 'running').select('id');
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

export async function releaseRun(
  id: string, owner: string, status: 'queued' | 'waiting_approval' | 'done' | 'failed',
  st: RunState & { errors?: number }, result?: string,
): Promise<boolean> {
  const end = status === 'done' || status === 'failed';
  const { data, error } = await supabase.from('agent_runs')
    .update({
      status, plan: st.plan, messages: st.messages, state: stateCol(st), lease_owner: null, lease_until: null,
      updated_at: new Date().toISOString(), ...(result !== undefined ? { result } : {}), ...(end ? { finished_at: new Date().toISOString() } : {}),
    })
    .eq('id', id).eq('lease_owner', owner).select('id');
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

export async function insertStep(
  userId: string, runId: string, idx: number, tool: string, toolCallId: string, args: Record<string, unknown>, tier: 'auto' | 'approval',
): Promise<string> {
  const { data, error } = await supabase.from('agent_steps')
    .insert({ user_id: userId, run_id: runId, idx, tool, tool_call_id: toolCallId, args, tier, status: 'running' })
    .select('id').single();
  if (error || !data) throw error ?? new Error('step not saved');
  return data.id as string;
}

export async function updateStep(id: string, status: string, result: string, actionId?: string): Promise<void> {
  const final = status !== 'running' && status !== 'waiting_approval';
  const { error } = await supabase.from('agent_steps')
    .update({ status, result: result.slice(0, 6000), ...(actionId ? { pending_action_id: actionId } : {}), ...(final ? { finished_at: new Date().toISOString() } : {}) })
    .eq('id', id);
  if (error) throw error;
}

// A worker that died left steps marked running. Never re-run (a send may have happened); record it.
export async function closeInterruptedSteps(runId: string): Promise<void> {
  const { error } = await supabase.from('agent_steps')
    .update({ status: 'failed', result: 'Interrupted: the worker stopped mid-step. Outcome unknown.', finished_at: new Date().toISOString() })
    .eq('run_id', runId).eq('status', 'running');
  if (error) throw error;
}

export async function runnableRunIds(userId: string, limit = 3): Promise<string[]> {
  const since = new Date(Date.now() - RESUMABLE_DAYS * 86400000).toISOString();
  const now = new Date().toISOString();
  const { data, error } = await supabase.from('agent_runs')
    .select('id, status, lease_until').eq('user_id', userId).in('status', ACTIVE).gte('updated_at', since)
    .order('updated_at', { ascending: true }).limit(20);
  if (error) throw error;
  return (data ?? [])
    .filter(r => r.status !== 'running' || !r.lease_until || (r.lease_until as string) < now)
    .slice(0, limit).map(r => r.id as string);
}

export async function runIdsForAction(userId: string, actionId: string): Promise<string[]> {
  const { data, error } = await supabase.from('agent_steps')
    .select('run_id').eq('user_id', userId).eq('pending_action_id', actionId);
  if (error) throw error;
  return [...new Set((data ?? []).map(r => r.run_id as string))];
}

// Safety net: a run nothing has touched for a week (a bug, not a normal path: waiting runs are re-checked every
// few minutes and their approval expires in 24h) is closed so it stops counting toward MAX_ACTIVE_RUNS.
export async function closeAbandonedRuns(userId: string): Promise<number> {
  const since = new Date(Date.now() - RESUMABLE_DAYS * 86400000).toISOString();
  const { data, error } = await supabase.from('agent_runs')
    .update({ status: 'failed', result: 'Abandoned: no progress for 7 days.', lease_owner: null, lease_until: null, finished_at: new Date().toISOString() })
    .eq('user_id', userId).in('status', ACTIVE).lt('updated_at', since).select('id');
  if (error) throw error;
  return data?.length ?? 0;
}
