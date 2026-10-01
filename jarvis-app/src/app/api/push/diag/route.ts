import { NextRequest, NextResponse } from 'next/server';
import { SESSION_COOKIE, verifySessionToken } from '@/lib/session';

// Temporary diagnostic sink for debugging why push subscription isn't completing
// on a real device. Logs whatever the client reports; no persistence beyond logs.
export async function POST(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const valid = token ? await verifySessionToken(token, process.env.JARVIS_API_SECRET ?? '') : false;
  if (!valid) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  console.log('PUSH_DIAG:', JSON.stringify(body));
  return NextResponse.json({ ok: true });
}
