import { NextResponse } from 'next/server';
import webpush from 'web-push';
import { getDueReminders, markReminderFired, getPushSubscriptions } from '@/lib/supabase';

webpush.setVapidDetails(
  'mailto:kbdcreditsolutions@gmail.com',
  process.env.VAPID_PUBLIC_KEY!,
  process.env.VAPID_PRIVATE_KEY!
);

export const runtime = 'nodejs';

export async function GET(req: Request) {
  // Verify cron secret to prevent public triggering
  const auth = req.headers ? new Headers(req.headers as unknown as HeadersInit).get('authorization') : null;
  if (auth !== `Bearer ${process.env.CRON_SECRET}` && process.env.NODE_ENV !== 'development') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userId = 'manoj';
  const [due, subs] = await Promise.all([
    getDueReminders(userId),
    getPushSubscriptions(userId),
  ]);

  if (!due.length || !subs.length) {
    return NextResponse.json({ fired: 0, due: due.length, subs: subs.length });
  }

  let fired = 0;
  for (const reminder of due) {
    for (const sub of subs) {
      try {
        await webpush.sendNotification(
          sub.subscription as webpush.PushSubscription,
          JSON.stringify({ title: '⏰ Maya Reminder', body: reminder.text, tag: reminder.id })
        );
      } catch (e) {
        console.error('Push failed for sub', sub.id, e);
      }
    }
    await markReminderFired(userId, reminder.id);
    fired++;
  }

  return NextResponse.json({ fired });
}
