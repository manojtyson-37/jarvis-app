import { NextRequest, NextResponse } from 'next/server';
import { loadActivity } from '@/lib/activity/store';
import { istDayStart } from '@/lib/activity/feed';

// Session-gated by middleware (not in PUBLIC_PATHS). Read-only.
// range=today (default, since midnight IST) or week (last 7 days).
export async function GET(req: NextRequest) {
  const week = req.nextUrl.searchParams.get('range') === 'week';
  const since = week ? new Date(Date.now() - 7 * 86_400_000).toISOString() : istDayStart(new Date());
  try {
    const { events, warnings } = await loadActivity('manoj', since);
    return NextResponse.json({ since, events, warnings });
  } catch (e) {
    console.error('activity feed failed:', (e as Error).message);
    return NextResponse.json({ since, events: [], warnings: ['all sources'] }, { status: 500 });
  }
}
