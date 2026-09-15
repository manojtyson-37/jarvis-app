import { NextRequest, NextResponse } from 'next/server';
import { savePushSubscription } from '@/lib/supabase';
import { SESSION_COOKIE, verifySessionToken } from '@/lib/session';

export async function POST(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const valid = token ? await verifySessionToken(token, process.env.JARVIS_API_SECRET ?? '') : false;
  if (!valid) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { subscription } = await req.json();
  if (!subscription?.endpoint) return NextResponse.json({ error: 'Invalid subscription' }, { status: 400 });
  await savePushSubscription('manoj', subscription);
  return NextResponse.json({ ok: true });
}
