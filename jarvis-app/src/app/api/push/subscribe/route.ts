import { NextRequest, NextResponse } from 'next/server';
import { savePushSubscription } from '@/lib/supabase';

export async function POST(req: NextRequest) {
  const { subscription } = await req.json();
  if (!subscription?.endpoint) return NextResponse.json({ error: 'Invalid subscription' }, { status: 400 });
  await savePushSubscription('manoj', subscription);
  return NextResponse.json({ ok: true });
}
