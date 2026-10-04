import webpush from 'web-push';
import { getPushSubscriptions, deletePushSubscription } from '@/lib/supabase';

if (process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    'mailto:kbdcreditsolutions@gmail.com',
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

// Returns true only if at least one subscription actually received the push —
// callers that gate follow-up state (e.g. "mark as seen/notified") on delivery
// must not do so if this returns false, or the item becomes permanently invisible.
//
// `tag` is read by the service worker's push handler (worker/index.ts) as a top-level
// field and falls back to a single shared default ('maya-reminder') when omitted — the
// browser's Notification API replaces any existing notification with the same tag, so
// two pushes sent close together with no distinct tag silently collapse into one and the
// earlier item is lost, not just delayed. Always pass a tag unique to the item (a message
// id, ticket id, reminder id) so concurrent notifications from the same or different
// sources stack instead of overwriting each other.
export async function sendPush(userId: string, payload: { title: string; body: string; icon?: string; tag?: string; data?: object }): Promise<boolean> {
  if (!process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return false;
  const subs = await getPushSubscriptions(userId);
  if (!subs.length) return false;
  const json = JSON.stringify({ icon: '/icon-192.png', ...payload });
  const results = await Promise.allSettled(
    subs.map((s: { subscription: object }) =>
      webpush.sendNotification(s.subscription as Parameters<typeof webpush.sendNotification>[0], json)
    )
  );

  // A 404/410 means the push service has permanently invalidated this endpoint
  // (browser unsubscribed, subscription rotated) — clean it up so it doesn't sit
  // forever producing silent delivery failures.
  for (const r of results) {
    if (r.status === 'rejected') {
      const statusCode = (r.reason as { statusCode?: number } | undefined)?.statusCode;
      if (statusCode === 404 || statusCode === 410) {
        await deletePushSubscription(userId).catch(() => {});
      }
    }
  }

  return results.some(r => r.status === 'fulfilled');
}
