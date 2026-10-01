import { createHmac, timingSafeEqual } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { processAndSaveMeeting } from '@/lib/meetingProcessor';

const USER_ID = 'manoj';

function verifySignature(rawBody: string, sig: string, secret: string): boolean {
  const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
  try {
    return timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest) {
  const secret = process.env.FIREFLIES_WEBHOOK_SECRET;
  if (!secret) {
    // Refuse unauthenticated writes — misconfigured deployment is safer as closed
    console.error('FIREFLIES_WEBHOOK_SECRET not set — rejecting all webhook requests');
    return NextResponse.json({ error: 'Webhook not configured' }, { status: 500 });
  }

  // Read body as text first so we can verify HMAC before parsing
  const rawBody = await req.text();
  const sig = req.headers.get('x-hub-signature') ?? req.headers.get('x-fireflies-signature') ?? '';

  if (!sig || !verifySignature(rawBody, sig, secret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  try {
    const meeting = await processAndSaveMeeting(USER_ID, payload, payload);
    if (!meeting) {
      return NextResponse.json({ ok: false, error: 'No meeting_id in payload' }, { status: 400 });
    }

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
