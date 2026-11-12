// action_items is the to-do table. The runner adds status values on the existing text column, no schema change:
//   pending -> running -> done | awaiting_approval | manual | failed
// While an item is running, completed_at holds the claim time, so a run that died can be found and closed.
import { supabase } from '@/lib/supabase';
import type { TodoSource } from './capture';

// Items created before the runner existed (old Jodo meeting to-dos) are never run.
export const RUNNER_SINCE = '2026-11-12T00:00:00Z';
const STALE_MS = 15 * 60 * 1000;
export const RUN_SOURCES: TodoSource[] = ['chat', 'checkin', 'email', 'meeting', 'assistant'];

export interface TodoRow { id: string; text: string; source: TodoSource; created_at: string }
export type FinalStatus = 'done' | 'awaiting_approval' | 'manual' | 'failed';

export async function insertTodos(userId: string, items: string[], source: TodoSource): Promise<TodoRow[]> {
  if (!items.length) return [];
  const { data, error } = await supabase.from('action_items')
    .insert(items.map(text => ({ user_id: userId, text, source, status: 'pending' })))
    .select('id, text, source, created_at');
  if (error) throw error;
  return (data ?? []) as TodoRow[];
}

// Runs that died mid-way (function killed) are closed as failed, never retried blindly: a retry could repeat a step.
export async function closeStaleRuns(userId: string): Promise<TodoRow[]> {
  const { data, error } = await supabase.from('action_items')
    .update({ status: 'failed', completed_at: new Date().toISOString() })
    .eq('user_id', userId).eq('status', 'running').lt('completed_at', new Date(Date.now() - STALE_MS).toISOString())
    .select('id, text, source, created_at');
  if (error) throw error;
  return (data ?? []) as TodoRow[];
}

export async function nextPending(userId: string, limit: number): Promise<TodoRow[]> {
  const { data, error } = await supabase.from('action_items')
    .select('id, text, source, created_at')
    .eq('user_id', userId).eq('status', 'pending').in('source', RUN_SOURCES).gte('created_at', RUNNER_SINCE)
    .order('created_at', { ascending: true }).limit(limit);
  if (error) throw error;
  return (data ?? []) as TodoRow[];
}

// Compare-and-set: only one runner (cron or the chat-triggered one) can own an item.
export async function claim(userId: string, id: string): Promise<boolean> {
  const { data, error } = await supabase.from('action_items')
    .update({ status: 'running', completed_at: new Date().toISOString() })
    .eq('id', id).eq('user_id', userId).eq('status', 'pending').select('id');
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

export async function finish(userId: string, id: string, status: FinalStatus): Promise<void> {
  const { error } = await supabase.from('action_items')
    .update({ status, completed_at: status === 'done' || status === 'failed' ? new Date().toISOString() : null })
    .eq('id', id).eq('user_id', userId).eq('status', 'running');
  if (error) throw error;
}

// Dedupe for collected sources (an email or a meeting doc becomes to-dos once). Reuses the seen-id table with a prefix.
// Checked first and marked only after its to-dos are saved, so a failed extraction is retried next run.
export async function sourceSeen(key: string): Promise<boolean> {
  const { data, error } = await supabase.from('gmail_messages_seen').select('message_id').eq('message_id', key).maybeSingle();
  if (error) throw error;
  return data !== null;
}

export async function markSourceSeen(userId: string, key: string): Promise<boolean> {
  const { data, error } = await supabase.from('gmail_messages_seen')
    .upsert({ message_id: key, user_id: userId }, { onConflict: 'message_id', ignoreDuplicates: true })
    .select('message_id');
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}
