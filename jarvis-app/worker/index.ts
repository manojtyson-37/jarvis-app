// Custom service worker additions merged by next-pwa into the generated SW
/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable no-restricted-globals */

const sw = self as any;

sw.addEventListener('push', (event: any) => {
  if (!event.data) return;
  let data: any = {};
  try { data = event.data.json(); } catch { /* malformed payload — show fallback */ }
  event.waitUntil(
    sw.registration.showNotification(data.title ?? '⏰ Maya', {
      body: data.body ?? '',
      icon: '/icon-192.png',
      tag: data.tag ?? 'maya-reminder',
      requireInteraction: true,
      vibrate: [200, 100, 200],
      data: data.data ?? null,
    })
  );
});

sw.addEventListener('notificationclick', (event: any) => {
  event.notification.close();
  const notifData = event.notification.data;
  const prefill = notifData?.prefill ? encodeURIComponent(notifData.prefill) : '';
  const url = prefill ? `/?q=${prefill}` : '/';
  event.waitUntil(
    sw.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients: any[]) => {
      for (const client of clients) {
        if ('focus' in client) {
          client.postMessage({ type: 'PREFILL_QUESTION', question: notifData?.prefill ?? '' });
          return client.focus();
        }
      }
      return sw.clients.openWindow(url);
    })
  );
});
