import { NextResponse } from 'next/server';
import webpush from 'web-push';
import { getDueReminders, markReminderFired, getPushSubscriptions } from '@/lib/supabase';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers ? new Headers(req.headers as unknown as HeadersInit).get('authorization') : null;
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (!process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
    return NextResponse.json({ error: 'VAPID not configured' }, { status: 500 });
  }
  webpush.setVapidDetails(
    'mailto:kbdcreditsolutions@gmail.com',
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );

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
          JSON.stringify({ title: '⏰ Maya Reminder', body: reminder.text, icon: '/icon-192.png', tag: reminder.id })
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
