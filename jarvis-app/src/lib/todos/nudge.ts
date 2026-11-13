// Stuck to-do nudges, run from the todos cron after runTodoBatch. Server-only: reads action_items and task_queue, sends a push.
// Rules (which to-dos, the age cut-off, the per-run cap) live in nudge-rules.ts. This file only does I/O.
//
// Dedupe: a nudge is recorded as a task_queue row with action_type 'nudge' and payload.todo_id. That row is written only
// after a push is delivered, so a failed push is retried on a later run. If the dedupe read fails, nothing is sent.
import 'server-only';
import { supabase, logTaskExecution } from '@/lib/supabase';
import { sendPush } from '@/lib/push';
import { RUNNER_SINCE, RUN_SOURCES } from './store';
import { stuckTodos, nudgePush, NUDGE_AFTER_DAYS, type StuckRow } from './nudge-rules';

const DAY_MS = 86_400_000;
const ID_RE = /^[A-Za-z0-9_-]+$/; // ids come from our own rows; checked before they go into a PostgREST filter

export async function nudgeStuckTodos(userId: string, nowMs = Date.now()): Promise<{ scanned: number; due: number; sent: number }> {
  // Read the dedupe set first, so the to-do query can skip already-nudged rows. Otherwise nudged-but-still-open
  // to-dos fill the oldest-first window and newer stuck to-dos are never checked.
  const { data: sentRows, error: dedupeErr } = await supabase.from('task_queue')
    .select('payload').eq('user_id', userId).eq('action_type', 'nudge').gte('created_at', RUNNER_SINCE).limit(1000);
  if (dedupeErr) throw dedupeErr;
  const alreadyNudged = new Set<string>(
    (sentRows ?? []).map(r => (r.payload as { todo_id?: unknown } | null)?.todo_id).filter((id): id is string => typeof id === 'string' && ID_RE.test(id)),
  );

  const cutoffIso = new Date(nowMs - NUDGE_AFTER_DAYS * DAY_MS).toISOString();
  let query = supabase.from('action_items')
    .select('id, text, status, created_at, source')
    .eq('user_id', userId).in('status', ['pending', 'awaiting_approval'])
    .in('source', RUN_SOURCES).gte('created_at', RUNNER_SINCE).lte('created_at', cutoffIso);
  if (alreadyNudged.size) query = query.not('id', 'in', `(${[...alreadyNudged].join(',')})`);
  const { data: rows, error } = await query.order('created_at', { ascending: true }).limit(200);
  if (error) throw error;

  const due = stuckTodos((rows ?? []) as StuckRow[], nowMs, alreadyNudged, RUNNER_SINCE, RUN_SOURCES);
  let sent = 0;
  for (const row of due) {
    const delivered = await sendPush(userId, { ...nudgePush(row, nowMs), data: { todoId: row.id } }).catch(() => false);
    if (!delivered) continue; // no audit row: the next run retries this to-do
    await logTaskExecution(userId, 'nudge', `Nudged: ${row.text}`, { todo_id: row.id });
    sent++;
  }
  return { scanned: (rows ?? []).length, due: due.length, sent };
}
