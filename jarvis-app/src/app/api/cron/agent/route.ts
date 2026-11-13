import { NextResponse } from 'next/server';
import { tickAgents } from '@/lib/agent/runner';
import { errorMessage } from '@/lib/errorMessage';

export const runtime = 'nodejs';
export const maxDuration = 300;

// Every 5 min: resume queued goal runs, re-check runs waiting on an approval, recover runs whose worker died.
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    return NextResponse.json({ runs: await tickAgents('manoj', 240_000) });
  } catch (e) {
    console.error('agent cron failed:', errorMessage(e));
    return NextResponse.json({ error: errorMessage(e) }, { status: 500 });
  }
}
