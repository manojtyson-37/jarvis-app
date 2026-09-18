import webpush from 'web-push';
import { getPushSubscriptions } from '@/lib/supabase';

type CheckinType = 'regular' | 'eod';

export async function pushCheckin(userId: string, type: CheckinType = 'regular'): Promise<{ pushed: number; reason?: string }> {
  if (!process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
    return { pushed: 0, reason: 'vapid_missing' };
  }

  webpush.setVapidDetails(
    'mailto:kbdcreditsolutions@gmail.com',
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );

  const subs = await getPushSubscriptions(userId);
  const now = new Date().toLocaleTimeString('en-IN', {
    timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit',
  });

  const payload = type === 'eod'
    ? {
        title: `Maya · EOD (${now})`,
        body: 'Day winding down — any open to-dos or prep for tomorrow?',
        icon: '/icon-192.png',
        data: { prefill: 'My to-dos for tomorrow: ' },
      }
    : {
        title: `Maya · Check-in (${now})`,
        body: 'What are your to-dos for the next 3 hours?',
        icon: '/icon-192.png',
        data: { prefill: 'My to-dos: ' },
      };

  const results = await Promise.allSettled(
    subs.map((s: { subscription: object }) =>
      webpush.sendNotification(
        s.subscription as Parameters<typeof webpush.sendNotification>[0],
        JSON.stringify(payload)
      )
    )
  );

  return { pushed: results.filter(r => r.status === 'fulfilled').length };
}
