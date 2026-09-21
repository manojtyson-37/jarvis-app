import { createClient } from '@supabase/supabase-js';

export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

// ── Notes ──────────────────────────────────────────────────────────────────

export async function saveNote(userId: string, content: string, tags: string[] = []) {
  const { data, error } = await supabase
    .from('notes').insert({ user_id: userId, content, tags }).select().single();
  if (error) throw error;
  return data;
}

export async function searchNotes(userId: string, query: string) {
  const { data, error } = await supabase
    .from('notes').select('*').eq('user_id', userId)
    .textSearch('content', query, { type: 'websearch', config: 'english' })
    .order('created_at', { ascending: false }).limit(5);
  if (error) throw error;
  return data ?? [];
}

export async function getRecentNotes(userId: string, limit = 10) {
  const { data, error } = await supabase
    .from('notes').select('*').eq('user_id', userId)
    .order('created_at', { ascending: false }).limit(limit);
  if (error) throw error;
  return data ?? [];
}

export async function deleteNote(userId: string, noteId: string) {
  const { error } = await supabase
    .from('notes').delete().eq('id', noteId).eq('user_id', userId);
  if (error) throw error;
}

// ── Reminders ──────────────────────────────────────────────────────────────

export async function saveReminder(userId: string, text: string, remindAt: string) {
  const { data, error } = await supabase
    .from('reminders').insert({ user_id: userId, text, remind_at: remindAt, fired: false })
    .select().single();
  if (error) throw error;
  return data;
}

export async function listReminders(userId: string) {
  const { data, error } = await supabase
    .from('reminders').select('*').eq('user_id', userId).eq('fired', false)
    .order('remind_at', { ascending: true }).limit(20);
  if (error) throw error;
  return data ?? [];
}

export async function markReminderDone(userId: string, reminderId: string) {
  const { error } = await supabase
    .from('reminders').update({ fired: true }).eq('id', reminderId).eq('user_id', userId);
  if (error) throw error;
}

export async function deleteReminder(userId: string, reminderId: string) {
  const { error } = await supabase
    .from('reminders').delete().eq('id', reminderId).eq('user_id', userId);
  if (error) throw error;
}

// ── Fitness ────────────────────────────────────────────────────────────────

export async function logWorkout(userId: string, workout: Record<string, unknown>) {
  const { data, error } = await supabase
    .from('fitness_logs').insert({ user_id: userId, ...workout }).select().single();
  if (error) throw error;
  return data;
}

export async function getRecentWorkouts(userId: string, days = 7) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const { data, error } = await supabase
    .from('fitness_logs').select('*').eq('user_id', userId)
    .gte('logged_at', since).order('logged_at', { ascending: false });
  if (error) throw error;
  return data ?? [];
}

// ── Finance ────────────────────────────────────────────────────────────────

export async function logFinance(
  userId: string,
  type: 'income' | 'expense',
  amount: number,
  category: string,
  description: string
) {
  const { data, error } = await supabase
    .from('finance_logs')
    .insert({ user_id: userId, type, amount, category, description })
    .select().single();
  if (error) throw error;
  return data;
}

export async function getFinanceSummary(userId: string, days = 30) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const { data, error } = await supabase
    .from('finance_logs').select('*').eq('user_id', userId)
    .gte('logged_at', since).order('logged_at', { ascending: false });
  if (error) throw error;
  const logs = data ?? [];
  const income = logs.filter((l: { type: string }) => l.type === 'income')
    .reduce((s: number, l: { amount: number }) => s + Number(l.amount), 0);
  const expense = logs.filter((l: { type: string }) => l.type === 'expense')
    .reduce((s: number, l: { amount: number }) => s + Number(l.amount), 0);
  return { income, expense, net: income - expense, logs };
}

// ── Conversation ───────────────────────────────────────────────────────────

export async function getConversationHistory(userId: string, limit = 20) {
  const { data, error } = await supabase
    .from('conversation_history').select('role, content, ts')
    .eq('user_id', userId).neq('content', '').order('ts', { ascending: false }).limit(limit);
  if (error) console.error('getConversationHistory error:', error.message);
  return (data ?? []).reverse();
}

export async function appendConversation(userId: string, role: 'user' | 'assistant', content: string) {
  await supabase.from('conversation_history').insert({ user_id: userId, role, content });
  // Fire-and-forget prune — never blocks the response path
  pruneConversation(userId).catch(() => {});
}

async function pruneConversation(userId: string) {
  const { data: keep } = await supabase
    .from('conversation_history').select('id').eq('user_id', userId)
    .order('ts', { ascending: false }).limit(100);
  if ((keep?.length ?? 0) >= 100) {
    await supabase.from('conversation_history').delete()
      .eq('user_id', userId).not('id', 'in', `(${keep!.map((r: { id: string }) => r.id).join(',')})`);
  }
}

// ── Push Subscriptions ─────────────────────────────────────────────────────

export async function savePushSubscription(userId: string, subscription: object) {
  const { error } = await supabase
    .from('push_subscriptions')
    .upsert({ user_id: userId, subscription, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
  if (error) throw error;
}

export async function getPushSubscriptions(userId: string) {
  const { data, error } = await supabase
    .from('push_subscriptions').select('*').eq('user_id', userId);
  if (error) throw error;
  return data ?? [];
}

export async function getDueReminders(userId: string) {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('reminders').select('*').eq('user_id', userId).eq('fired', false)
    .lte('remind_at', now);
  if (error) throw error;
  return data ?? [];
}

export async function markReminderFired(userId: string, reminderId: string) {
  const { error } = await supabase
    .from('reminders').update({ fired: true }).eq('id', reminderId).eq('user_id', userId);
  if (error) throw error;
}

// ── Maya Memory ────────────────────────────────────────────────────────────

export async function saveMemoryFacts(userId: string, facts: { fact: string; category: string }[]) {
  if (!facts.length) return;
  const rows = facts.map(f => ({ user_id: userId, fact: f.fact, category: f.category }));
  const { error } = await supabase.from('maya_memory').insert(rows);
  if (error) throw error;
}

export async function getMemoryFacts(userId: string, limit = 40) {
  const { data, error } = await supabase
    .from('maya_memory').select('fact, category')
    .eq('user_id', userId).eq('active', true)
    .order('updated_at', { ascending: false }).limit(limit);
  if (error) console.error('getMemoryFacts error:', error.message);
  return data ?? [];
}

// ── Evolution Log ──────────────────────────────────────────────────────────

export async function getRecentConversations(userId: string, hours = 24) {
  const since = new Date(Date.now() - hours * 3600000).toISOString();
  const { data, error } = await supabase
    .from('conversation_history').select('role, content, ts')
    .eq('user_id', userId).gte('ts', since)
    .order('ts', { ascending: true });
  if (error) console.error('getRecentConversations error:', error.message);
  return data ?? [];
}

export async function saveEvolutionLog(entry: {
  date: string;
  gaps: unknown[];
  new_facts: unknown[];
  suggestions: unknown[];
}) {
  await supabase.from('maya_evolution_log')
    .upsert(entry, { onConflict: 'date' });
}

// ── Meeting Intelligence ───────────────────────────────────────────────────

export interface MeetingNote {
  id: string;
  meeting_id: string;
  title: string;
  meeting_date: string;
  duration_sec: number | null;
  participants: string[];
  summary: string | null;
  created_at: string;
}

export interface ActionItem {
  id: string;
  meeting_id: string | null;
  text: string;
  source: 'meeting' | 'checkin' | 'manual';
  status: 'pending' | 'in_progress' | 'done' | 'skipped';
  created_at: string;
  completed_at: string | null;
}

export async function saveMeetingNote(
  userId: string,
  data: {
    meeting_id: string;
    title: string;
    meeting_date: string;
    duration_sec?: number;
    participants?: string[];
    summary?: string;
    raw_transcript?: string;
    raw_payload?: object;
  }
) {
  const { error } = await supabase.from('meeting_notes')
    .upsert({ user_id: userId, ...data }, { onConflict: 'meeting_id' });
  if (error) throw error;
}

export async function getMeetingNotes(userId: string, limit = 5): Promise<MeetingNote[]> {
  const { data, error } = await supabase
    .from('meeting_notes')
    .select('id, meeting_id, title, meeting_date, duration_sec, participants, summary, created_at')
    .eq('user_id', userId).order('meeting_date', { ascending: false }).limit(limit);
  if (error) throw error;
  return (data ?? []) as MeetingNote[];
}

export async function saveActionItems(
  userId: string,
  items: { text: string; meeting_id?: string; source?: 'meeting' | 'checkin' | 'manual' }[]
) {
  if (!items.length) return;
  const rows = items.map(i => ({
    user_id: userId,
    text: i.text,
    meeting_id: i.meeting_id ?? null,
    source: i.source ?? 'manual',
    status: 'pending',
  }));
  const { error } = await supabase.from('action_items').insert(rows);
  if (error) throw error;
}

export async function getPendingActionItems(userId: string, limit = 20): Promise<ActionItem[]> {
  const { data, error } = await supabase
    .from('action_items').select('*').eq('user_id', userId)
    .eq('status', 'pending').order('created_at', { ascending: false }).limit(limit);
  if (error) throw error;
  return (data ?? []) as ActionItem[];
}

export async function completeActionItem(userId: string, itemId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('action_items')
    .update({ status: 'done', completed_at: new Date().toISOString() })
    .eq('id', itemId).eq('user_id', userId)
    .select('id');
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

// ── Task Queue (audit log for automated actions) ────────────────────────────

export async function logTaskExecution(
  userId: string,
  actionType: 'freshdesk' | 'redash' | 'coralogix' | 'email',
  description: string,
  payload?: object
) {
  const { error } = await supabase.from('task_queue').insert({
    user_id: userId, action_type: actionType, description, payload: payload ?? null,
  });
  if (error) console.error('logTaskExecution failed:', error.message);
}

// ── Dashboard ──────────────────────────────────────────────────────────────

export async function getDashboardData(userId: string) {
  const [notes, reminders, workouts] = await Promise.all([
    getRecentNotes(userId, 20),
    listReminders(userId),
    getRecentWorkouts(userId, 14),
  ]);
  return { notes, reminders, workouts };
}
