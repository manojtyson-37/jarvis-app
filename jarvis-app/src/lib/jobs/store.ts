// Job tracker storage: job_applications (one row per company + role) and job_profile (Manoj's own facts).
// Both tables are server-only (RLS on, no policies); every call goes through the service-role client.
import { supabase } from '@/lib/supabase';
import { matchKey, type JobStatus } from './rules';

export interface JobRow {
  id: string;
  company: string;
  role: string;
  status: JobStatus;
  evidence: string;
  notified_status: JobStatus | null;
  pending_ask: string | null;
  ask_from: string | null;
  ask_at: string | null;
  ask_nudged_at: string | null;
  last_update_at: string;
}

const COLS = 'id, company, role, status, evidence, notified_status, pending_ask, ask_from, ask_at, ask_nudged_at, last_update_at';

export async function findApplication(userId: string, company: string, role: string): Promise<JobRow | null> {
  const { data, error } = await supabase.from('job_applications').select(COLS)
    .eq('user_id', userId).eq('company_key', matchKey(company)).eq('role_key', matchKey(role)).maybeSingle();
  if (error) throw error;
  return (data as JobRow | null) ?? null;
}

// Writes one application. An existing row is UPDATEd by id: an upsert would try the INSERT half first, which fails on the
// NOT NULL source and date columns when a non-advancing email passes only the status. A new row is upserted in full.
export async function saveApplication(userId: string, row: {
  company: string; role: string; status: JobStatus;
  evidence?: string; sourceMessageId?: string; sourceThreadId?: string | null; lastUpdateAt?: string;
}, existingId?: string): Promise<string> {
  const extra = {
    ...(row.evidence !== undefined ? { evidence: row.evidence } : {}),
    ...(row.sourceMessageId !== undefined ? { source_message_id: row.sourceMessageId, source_thread_id: row.sourceThreadId ?? null } : {}),
    ...(row.lastUpdateAt !== undefined ? { last_update_at: row.lastUpdateAt } : {}),
  };
  if (existingId) {
    const { data, error } = await supabase.from('job_applications')
      .update({ status: row.status, updated_at: new Date().toISOString(), ...extra })
      .eq('user_id', userId).eq('id', existingId).select('id');
    if (error) throw error;
    // Zero rows means the row vanished since it was read: throw so the email stays unseen and is retried as new.
    if (!data?.length) throw new Error('job application row vanished before update');
    return existingId;
  }
  const { data, error } = await supabase.from('job_applications').upsert({
    user_id: userId,
    company: row.company, company_key: matchKey(row.company),
    role: row.role, role_key: matchKey(row.role),
    status: row.status, updated_at: new Date().toISOString(), ...extra,
  }, { onConflict: 'user_id,company_key,role_key' }).select('id').single();
  if (error) throw error;
  return (data as { id: string }).id;
}

// Atomic claim: sets notified_status to the new status only if it still holds the value we read. Returns false when
// another run already claimed it, so the push happens once.
export async function claimNotify(userId: string, id: string, prev: JobStatus | null, status: JobStatus): Promise<boolean> {
  const base = supabase.from('job_applications').update({ notified_status: status }).eq('user_id', userId).eq('id', id);
  const { data, error } = await (prev === null ? base.is('notified_status', null) : base.eq('notified_status', prev)).select('id');
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

// Gives the claim back after a failed push, so the next run tries again.
export async function releaseNotify(userId: string, id: string, claimed: JobStatus, prev: JobStatus | null): Promise<void> {
  const { error } = await supabase.from('job_applications').update({ notified_status: prev })
    .eq('user_id', userId).eq('id', id).eq('notified_status', claimed);
  if (error) throw error;
}

// Atomic claim of a recruiter ask: succeeds only if no ask is waiting, so one ask is pushed once across overlapping runs.
export async function claimAsk(userId: string, id: string, ask: string, from: string, messageId: string): Promise<boolean> {
  const { data, error } = await supabase.from('job_applications').update({
    pending_ask: ask, ask_from: from.slice(0, 200), ask_message_id: messageId, ask_thread_id: null,
    ask_at: new Date().toISOString(), ask_nudged_at: null,
  }).eq('user_id', userId).eq('id', id).is('pending_ask', null).select('id');
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

// Gives the ask claim back after a failed push, only if it still holds this ask.
export async function releaseAsk(userId: string, id: string, ask: string): Promise<void> {
  const { error } = await supabase.from('job_applications').update({
    pending_ask: null, ask_from: null, ask_message_id: null, ask_thread_id: null, ask_at: null, ask_nudged_at: null,
  }).eq('user_id', userId).eq('id', id).eq('pending_ask', ask);
  if (error) throw error;
}

// Manoj answered the recruiter: clear the waiting ask for that company so no nudge goes out.
export async function clearAsks(userId: string, company: string): Promise<number> {
  const { data, error } = await supabase.from('job_applications')
    .update({ pending_ask: null, ask_from: null, ask_message_id: null, ask_thread_id: null, ask_at: null, ask_nudged_at: null })
    .eq('user_id', userId).eq('company_key', matchKey(company)).not('pending_ask', 'is', null).select('id');
  if (error) throw error;
  return data?.length ?? 0;
}

export async function markAskNudged(userId: string, id: string): Promise<void> {
  const { error } = await supabase.from('job_applications').update({ ask_nudged_at: new Date().toISOString() }).eq('user_id', userId).eq('id', id);
  if (error) throw error;
}

export async function askNudgeCandidates(userId: string, limit: number): Promise<JobRow[]> {
  const { data, error } = await supabase.from('job_applications').select(COLS)
    .eq('user_id', userId).not('pending_ask', 'is', null).is('ask_nudged_at', null)
    .order('ask_at', { ascending: true }).limit(limit);
  if (error) throw error;
  return (data ?? []) as JobRow[];
}

export async function listApplications(userId: string, status?: JobStatus, limit = 20): Promise<JobRow[]> {
  let q = supabase.from('job_applications').select(COLS).eq('user_id', userId).order('last_update_at', { ascending: false }).limit(limit);
  if (status) q = q.eq('status', status);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as JobRow[];
}

export interface JobProfile {
  total_exp: string | null; relevant_exp: string | null; current_ctc: string | null;
  expected_ctc: string | null; notice_period: string | null; location: string | null;
}
export const PROFILE_FIELDS = ['total_exp', 'relevant_exp', 'current_ctc', 'expected_ctc', 'notice_period', 'location'] as const;
export const PROFILE_MAX: Record<(typeof PROFILE_FIELDS)[number], number> = {
  total_exp: 80, relevant_exp: 80, current_ctc: 80, expected_ctc: 80, notice_period: 80, location: 120,
};

export async function getProfile(userId: string): Promise<JobProfile | null> {
  const { data, error } = await supabase.from('job_profile').select(PROFILE_FIELDS.join(', ')).eq('user_id', userId).maybeSingle();
  if (error) throw error;
  return (data as unknown as JobProfile | null) ?? null;
}

// Only the fields given are written. Callers pass Manoj's own words, never a guess.
export async function upsertProfile(userId: string, fields: Partial<JobProfile>): Promise<void> {
  const { error } = await supabase.from('job_profile').upsert({ user_id: userId, ...fields, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
  if (error) throw error;
}
