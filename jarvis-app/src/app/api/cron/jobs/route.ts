import { NextResponse } from 'next/server';
import { runJobTrack } from '@/lib/jobs/track';
import { errorMessage } from '@/lib/errorMessage';
import { getActiveSession } from '@/lib/away/store';

export const runtime = 'nodejs';
export const maxDuration = 300;

const USER_ID = 'manoj';

// Hourly: record job-application status from Gmail, push on progress and recruiter asks, nudge once after a day.
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    // Away Mode owns the inbox while it runs; the same mail must not be pushed twice.
    if (await getActiveSession(USER_ID)) return NextResponse.json({ ok: true, skipped: 'away_active' });
    const run = await runJobTrack(USER_ID);
    if (!run.gmailOk) return NextResponse.json({ ok: false, error: 'gmail_unavailable' }, { status: 502 });
    return NextResponse.json({ ok: true, ...run });
  } catch (e) {
    console.error('jobs cron failed:', errorMessage(e));
    return NextResponse.json({ ok: false, error: errorMessage(e) }, { status: 500 });
  }
}
