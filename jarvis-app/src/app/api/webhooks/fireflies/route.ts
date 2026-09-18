import { NextRequest, NextResponse } from 'next/server';
import { processMeeting } from '@/lib/meetingProcessor';
import { saveMeetingNote, saveActionItems, getPushSubscriptions } from '@/lib/supabase';
import webpush from 'web-push';

const USER_ID = 'manoj';

async function pushMeetingNotification(title: string, actionItemCount: number) {
  if (!process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return;
  webpush.setVapidDetails(
    'mailto:kbdcreditsolutions@gmail.com',
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
  const subs = await getPushSubscriptions(USER_ID);
  const payload = JSON.stringify({
    title: 'Maya · Meeting processed',
    body: `"${title}" — ${actionItemCount} action item${actionItemCount !== 1 ? 's' : ''} extracted`,
    icon: '/icon-192.png',
    data: { prefill: 'Show me my action items from the last meeting' },
  });
  await Promise.allSettled(
    subs.map((s: { subscription: object }) =>
      webpush.sendNotification(
        s.subscription as Parameters<typeof webpush.sendNotification>[0],
        payload
      )
    )
  );
}

export async function POST(req: NextRequest) {
  // Verify webhook secret
  const secret = process.env.FIREFLIES_WEBHOOK_SECRET;
  if (secret) {
    const sig = req.headers.get('x-hub-signature') ?? req.headers.get('x-fireflies-signature');
    if (!sig || sig !== secret) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  let payload: Record<string, unknown>;
  try {
    payload = await req.json() as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  try {
    const meeting = await processMeeting(payload);
    if (!meeting) {
      return NextResponse.json({ ok: false, error: 'No meeting_id in payload' }, { status: 400 });
    }

    await saveMeetingNote(USER_ID, {
      meeting_id: meeting.meeting_id,
      title: meeting.title,
      meeting_date: meeting.meeting_date,
      duration_sec: meeting.duration_sec,
      participants: meeting.participants,
      summary: meeting.summary,
      raw_transcript: meeting.raw_transcript,
      raw_payload: payload,
    });

    await saveActionItems(
      USER_ID,
      meeting.action_items.map(text => ({
        text,
        meeting_id: meeting.meeting_id,
        source: 'meeting' as const,
      }))
    );

    await pushMeetingNotification(meeting.title, meeting.action_items.length);

    return NextResponse.json({
      ok: true,
      meeting_id: meeting.meeting_id,
      action_items: meeting.action_items.length,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('Fireflies webhook processing error:', msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
