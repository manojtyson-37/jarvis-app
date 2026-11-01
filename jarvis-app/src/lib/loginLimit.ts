import { NextRequest } from 'next/server';

// Login lockout. Attempts live in login_attempts, which has RLS on with no policies, so only the
// server-side service-role key can touch it — the public anon key cannot wipe attempts to reset a lockout.
const WINDOW_MS = 15 * 60 * 1000;
const PER_IP_MAX = 5;     // failed tries per IP per window
const GLOBAL_MAX = 30;    // failed tries across all IPs per window (defeats IP rotation)
// Known trade-off: someone sending 30 wrong passwords per window can keep the owner locked out (never permanently).
// Manual reset: DELETE FROM login_attempts;
const TIMEOUT_MS = 3000;  // a hung store must hit the fail-closed 503 path, not hang the request

function conf() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('lockout store not configured');
  return { base: `${url}/rest/v1/login_attempts`, headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' } };
}

export function clientIp(req: NextRequest): string {
  // Vercel sets these at the edge; a client-supplied value is overwritten.
  // Off Vercel the generic headers are client-controlled, so only trust them on Vercel's fallback path.
  const v = req.headers.get('x-vercel-forwarded-for')
    ?? (process.env.VERCEL ? req.headers.get('x-forwarded-for') ?? req.headers.get('x-real-ip') : null)
    ?? 'unknown';
  return v.split(',')[0].trim().slice(0, 64) || 'unknown';
}

async function recent(filter: string, limit: number): Promise<number[]> {
  const { base, headers } = conf();
  const since = new Date(Date.now() - WINDOW_MS).toISOString();
  const res = await fetch(`${base}?select=created_at&created_at=gte.${encodeURIComponent(since)}${filter}&order=created_at.desc&limit=${limit}`, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`lockout read ${res.status}`);
  return (await res.json() as { created_at: string }[]).map(r => Date.parse(r.created_at));
}

async function insertAttempt(ip: string): Promise<number> {
  const { base, headers } = conf();
  const res = await fetch(base, { method: 'POST', headers: { ...headers, Prefer: 'return=representation' }, body: JSON.stringify({ ip }), signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`lockout write ${res.status}`);
  return (await res.json() as { id: number }[])[0].id;
}

async function deleteWhere(filter: string): Promise<void> {
  const { base, headers } = conf();
  const res = await fetch(`${base}?${filter}`, { method: 'DELETE', headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) console.error('login lockout delete failed:', res.status);
}

export interface AttemptGate { locked: boolean; retryAfterSec: number; attemptId: number }

// Records this attempt FIRST, then counts, so a parallel burst of guesses cannot all slip past a stale count.
// If the caller is over the limit the row is removed again so blocked tries do not extend the lockout forever.
export async function beginAttempt(ip: string): Promise<AttemptGate> {
  const attemptId = await insertAttempt(ip);
  const [ipRows, globalRows] = await Promise.all([
    recent(`&ip=eq.${encodeURIComponent(ip)}`, PER_IP_MAX + 1),
    recent('', GLOBAL_MAX + 1),
  ]);
  const unlockAt = (rows: number[], max: number) => (rows.length > max ? rows[max] + WINDOW_MS : 0);
  const until = Math.max(unlockAt(ipRows, PER_IP_MAX), unlockAt(globalRows, GLOBAL_MAX));
  if (until > 0) {
    await deleteWhere(`id=eq.${attemptId}`);
    return { locked: true, retryAfterSec: Math.max(1, Math.ceil((until - Date.now()) / 1000)), attemptId };
  }
  return { locked: false, retryAfterSec: 0, attemptId };
}

export async function clearAttempts(ip: string): Promise<void> {
  await deleteWhere(`ip=eq.${encodeURIComponent(ip)}`);
}

export async function pruneOld(): Promise<void> {
  await deleteWhere(`created_at=lt.${encodeURIComponent(new Date(Date.now() - 24 * 3600 * 1000).toISOString())}`);
}
