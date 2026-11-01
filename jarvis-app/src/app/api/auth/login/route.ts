import { NextRequest, NextResponse, after } from 'next/server';
import { createHash, timingSafeEqual } from 'crypto';
import { createSessionToken, SESSION_COOKIE, SESSION_MAX_AGE } from '@/lib/session';
import { beginAttempt, clearAttempts, clientIp, pruneOld } from '@/lib/loginLimit';

function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({})) as { password?: unknown };
  const password = typeof body.password === 'string' ? body.password : '';
  const expected = process.env.MAYA_PASSWORD;
  const ip = clientIp(req);

  // Never sign a session with a missing secret — anyone could forge one. Checked first so a misconfigured
  // deploy fails for everyone up front instead of recording attempts and erroring only on the right password.
  const secret = process.env.JARVIS_API_SECRET;
  if (!secret) {
    console.error('login: JARVIS_API_SECRET is not set');
    return NextResponse.json({ error: 'Login is not configured.' }, { status: 500 });
  }

  // Fail closed: if the lockout store is unreachable, nobody can try passwords.
  let gate;
  try {
    gate = await beginAttempt(ip);
  } catch (e) {
    console.error('login lockout unavailable:', (e as Error).message);
    return NextResponse.json({ error: 'Login is temporarily unavailable. Try again shortly.' }, { status: 503 });
  }

  if (gate.locked) {
    const mins = Math.ceil(gate.retryAfterSec / 60);
    return NextResponse.json(
      { error: `Too many wrong attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.` },
      { status: 429, headers: { 'Retry-After': String(gate.retryAfterSec) } },
    );
  }

  if (!expected || !safeEqual(password, expected)) {
    // after() keeps the function alive until pruning finishes; a bare fire-and-forget can be frozen on Vercel.
    after(() => pruneOld().catch(() => {}));
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  await clearAttempts(ip).catch(() => {});
  const token = await createSessionToken(secret);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: SESSION_MAX_AGE,
    path: '/',
  });
  return res;
}
