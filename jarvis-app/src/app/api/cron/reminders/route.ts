import { NextResponse } from 'next/server';
import { getDueReminders, markReminderFired } from '@/lib/supabase';
import { sendPush } from '@/lib/push';
import { errorMessage } from '@/lib/errorMessage';

export const runtime = 'nodejs';

// This route existed since Sept 2026 but was never actually scheduled anywhere —
// it was meant to run via a GitHub Actions workflow (.github/workflows/reminders-cron.yml),
// but that file sits one directory too deep in this repo's push layout for GitHub to ever
// discover it, so it has silently never fired a single reminder. Scheduled here on Vercel
// instead, hourly — matching the sibling sync-* crons, which are proven to deploy fine on
// this account. A commit in this repo's own history (5d8c5c0) shows a tighter schedule was
// previously rejected on this exact route; don't widen this without confirming plan tier first.
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const userId = 'manoj';
    const due = await getDueReminders(userId);
    if (!due.length) return NextResponse.json({ fired: 0, deliveryFailed: 0, due: 0 });

    let fired = 0;
    let deliveryFailed = 0;
    for (const reminder of due) {
      const delivered = await sendPush(userId, {
        title: '⏰ Maya Reminder',
        body: reminder.text,
        tag: `reminder-${reminder.id}`,
      });
      if (!delivered) {
        // Don't mark fired — leave it due so the next run retries rather than losing it silently.
        deliveryFailed++;
        continue;
      }
      await markReminderFired(userId, reminder.id);
      fired++;
    }

    return NextResponse.json({ fired, deliveryFailed, due: due.length });
  } catch (e) {
    const msg = errorMessage(e);
    console.error('reminders cron error:', msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
