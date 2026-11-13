// Prospects and sales, database part. Snapshots are rows in the audit table (task_queue, action_type 'pipeline'):
// no new table, and a changed snapshot shows up in the activity timeline as one line.
import { supabase } from '@/lib/supabase';
import { parseSnapshot, sameNumbers, summaryLine, type Snapshot } from './rules';

export async function latestSnapshot(userId: string): Promise<Snapshot | null> {
  const { data, error } = await supabase.from('task_queue').select('payload, created_at')
    .eq('user_id', userId).eq('action_type', 'pipeline').order('created_at', { ascending: false }).limit(1);
  if (error) throw new Error(error.message);
  const row = data?.[0];
  if (!row?.payload) return null;
  // Stored rows are re-checked on the way out; the age limit applies to incoming reports only.
  const parsed = parseSnapshot(row.payload, new Date(Date.parse((row.payload as { at?: string }).at ?? '') || Date.now()));
  return 'snapshot' in parsed ? parsed.snapshot : null;
}

// Unchanged numbers only move the snapshot's time forward on the existing row, so an hourly sync cannot fill the table.
export async function saveSnapshot(userId: string, snap: Snapshot): Promise<'added' | 'refreshed'> {
  const { data, error } = await supabase.from('task_queue').select('id, payload')
    .eq('user_id', userId).eq('action_type', 'pipeline').order('created_at', { ascending: false }).limit(1);
  if (error) throw new Error(error.message);
  const last = data?.[0];
  const prev = last?.payload ? parseSnapshot(last.payload, new Date(Date.parse((last.payload as { at?: string }).at ?? '') || Date.now())) : null;
  if (last && prev && 'snapshot' in prev && sameNumbers(prev.snapshot, snap)) {
    const { error: e } = await supabase.from('task_queue').update({ payload: snap }).eq('id', last.id).eq('user_id', userId).eq('action_type', 'pipeline');
    if (e) throw new Error(e.message);
    return 'refreshed';
  }
  const { error: e } = await supabase.from('task_queue').insert({ user_id: userId, action_type: 'pipeline', description: summaryLine(snap), payload: snap });
  if (e) throw new Error(e.message);
  return 'added';
}
