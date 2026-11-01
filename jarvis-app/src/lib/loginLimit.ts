import { NextRequest } from 'next/server';

// Login lockout. Attempts live in login_attempts, which has RLS on with no policies, so only the
// server-side service-role key can touch it — the public anon key cannot wipe attempts to reset a lockout.
const WINDOW_SECS = 15 * 60;
const PER_IP_MAX = 5;     // failed tries per IP per window
const GLOBAL_MAX = 30;    // failed tries across all IPs per window (defeats IP rotation)
// Known trade-off: someone sending 30 wrong passwords per window can keep the owner locked out (never permanently).
// Manual reset: DELETE FROM login_attempts;
const TIMEOUT_MS = 3000;  // a hung store must hit the fail-closed 503 path, not hang the request

function conf() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('lockout store not configured');
  return { rest: `${url}/rest/v1`, headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' } };
}

// IPv6 clients usually own a whole /64, so bucket by that prefix or one client could rotate through
// 2^64 per-IP buckets. IPv4 (and v4-mapped v6) is kept as-is.
export function normalizeIp(raw: string): string {
  const ip = raw.split('%')[0].toLowerCase();
  if (!ip.includes(':') || ip.includes('.')) return ip;
  const [head, tail, extra] = ip.split('::');
  if (extra !== undefined) return ip;
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  if (groups.length !== 8 || !groups.every(g => /^[0-9a-f]{1,4}$/.test(g))) return ip;
  return `${groups.slice(0, 4).map(g => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

export function clientIp(req: NextRequest): string {
  // Vercel sets these at the edge; a client-supplied value is overwritten.
  // Off Vercel the generic headers are client-controlled, so only trust them on Vercel's fallback path.
  const v = req.headers.get('x-vercel-forwarded-for')
    ?? (process.env.VERCEL ? req.headers.get('x-forwarded-for') ?? req.headers.get('x-real-ip') : null)
    ?? 'unknown';
  return normalizeIp(v.split(',')[0].trim().slice(0, 64) || 'unknown');
}

async function deleteWhere(filter: string): Promise<void> {
  const { rest, headers } = conf();
  const res = await fetch(`${rest}/login_attempts?${filter}`, { method: 'DELETE', headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) console.error('login lockout delete failed:', res.status);
}

export interface AttemptGate { locked: boolean; retryAfterSec: number }

// One atomic Postgres call (login_begin_attempt): under an advisory lock it counts the window and, only if the
// caller is under both limits, records this attempt. Concurrent requests are serialised, so a parallel burst
// cannot overshoot the limit, and blocked tries are not recorded so they never extend a lockout.
export async function beginAttempt(ip: string): Promise<AttemptGate> {
  const { rest, headers } = conf();
  const res = await fetch(`${rest}/rpc/login_begin_attempt`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ p_ip: ip, p_window_secs: WINDOW_SECS, p_ip_max: PER_IP_MAX, p_global_max: GLOBAL_MAX }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`lockout rpc ${res.status}`);
  const row = (await res.json() as { locked: boolean; retry_after_sec: number }[])[0];
  if (!row || typeof row.locked !== 'boolean') throw new Error('lockout rpc bad response');
  return { locked: row.locked, retryAfterSec: row.retry_after_sec };
}

export async function clearAttempts(ip: string): Promise<void> {
  await deleteWhere(`ip=eq.${encodeURIComponent(ip)}`);
}

export async function pruneOld(): Promise<void> {
  await deleteWhere(`created_at=lt.${encodeURIComponent(new Date(Date.now() - 24 * 3600 * 1000).toISOString())}`);
}
