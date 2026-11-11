import { NextResponse } from 'next/server';
import { runAwayLive } from '@/lib/away/live';
import { errorMessage } from '@/lib/errorMessage';

const USER_ID = 'manoj';
export const maxDuration = 60; // the run itself stops starting new messages at 45 s (live.ts RUN_BUDGET_MS)

// Every 30 minutes. Does nothing (no Gmail call, no model call) unless an away trip is active.
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const r = await runAwayLive(USER_ID);
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    const msg = errorMessage(e);
    console.error('away cron error:', msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
