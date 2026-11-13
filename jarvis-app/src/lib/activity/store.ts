// Read-only activity loader (server-only, service-role client). Reads four existing tables and never writes.
import 'server-only';
import { supabase } from '@/lib/supabase';
import { mergeActivity, pickRows, capFeed, type ActivityEvent } from './feed';

const SHOWN = 60; // the feed shows at most this many lines; the cut is reported, never silent

const LIMIT = 200;

export async function loadActivity(userId: string, sinceIso: string): Promise<{ events: ActivityEvent[]; warnings: string[] }> {
  const warnings: string[] = [];
  const [audit, away, jobs, todos] = await Promise.allSettled([
    supabase.from('task_queue').select('created_at, action_type, description, payload')
      .eq('user_id', userId).gte('created_at', sinceIso).order('created_at', { ascending: false }).limit(LIMIT),
    supabase.from('agent_actions').select('decided_at, decision, from_addr, subject')
      .eq('user_id', userId).gte('decided_at', sinceIso).order('decided_at', { ascending: false }).limit(LIMIT),
    supabase.from('job_applications').select('last_update_at, company, role, status')
      .eq('user_id', userId).gte('last_update_at', sinceIso).order('last_update_at', { ascending: false }).limit(LIMIT),
    supabase.from('action_items').select('id, text, status, completed_at')
      .eq('user_id', userId).in('status', ['done', 'failed']).gte('completed_at', sinceIso).order('completed_at', { ascending: false }).limit(LIMIT),
  ]);
  const rows = {
    audit: pickRows('task log', audit, warnings, LIMIT),
    away: pickRows('away mode', away, warnings, LIMIT),
    jobs: pickRows('job tracker', jobs, warnings, LIMIT),
    todos: pickRows('to-dos', todos, warnings, LIMIT),
  };
  const { shown, cut } = capFeed(mergeActivity(rows, sinceIso), SHOWN);
  if (cut) warnings.push(`timeline (newest ${SHOWN} shown, ${cut} older cut)`);
  return { events: shown, warnings };
}
