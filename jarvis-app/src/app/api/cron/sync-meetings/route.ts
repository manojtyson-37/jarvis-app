import { NextResponse } from 'next/server';
import { listRecentTranscriptIds, processAndSaveMeeting } from '@/lib/meetingProcessor';
import { meetingExists } from '@/lib/supabase';

const USER_ID = 'manoj';
const MAX_BACKFILL_PER_RUN = 5; // self-healing across hourly runs — cap avoids timeout on a large backlog

export const maxDuration = 60;

// Reconciliation safety net: the Fireflies webhook doesn't reliably fire for every
// meeting. This polls Fireflies' own transcript list and backfills anything the
// webhook missed, so meeting intelligence doesn't depend on webhook delivery alone.
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const ids = await listRecentTranscriptIds(20);
    const missing: string[] = [];
    for (const id of ids) {
      if (!(await meetingExists(id))) missing.push(id);
    }

    const toProcess = missing.slice(0, MAX_BACKFILL_PER_RUN);
    const results = [];
    for (const id of toProcess) {
      try {
        const meeting = await processAndSaveMeeting(USER_ID, { meeting_id: id });
        results.push({ meeting_id: id, ok: meeting !== null, title: meeting?.title });
      } catch (e) {
        results.push({ meeting_id: id, ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    }

    return NextResponse.json({
      ok: true,
      checked: ids.length,
      missing: missing.length,
      backfilled: results.length,
      results,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('sync-meetings cron error:', msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
