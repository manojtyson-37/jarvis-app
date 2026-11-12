// Which new mail earns a push. Manoj left Jodo, so the old Jodo labels ('Atulya/Manoj R') matched nothing and failed
// every hour. Now: unread Primary-inbox mail from real people. Automated senders (alerts, newsletters, receipts) never push.
import type { EmailSummary } from '@/lib/gmail';

// 2h window for an hourly cron: one missed run is still covered, and a first run can't replay days of old mail.
export const WATCH_QUERY = 'in:inbox is:unread category:primary newer_than:2h';
export const MAX_PUSHES = 5;

export function selectNotifiable(found: EmailSummary[], alreadySeen: (id: string) => boolean, cap = MAX_PUSHES): { push: EmailSummary[]; overflow: EmailSummary[] } {
  const fresh: EmailSummary[] = [];
  const ids = new Set<string>();
  for (const m of found) {
    if (m.automated || ids.has(m.id) || alreadySeen(m.id)) continue;
    ids.add(m.id); fresh.push(m);
  }
  return { push: fresh.slice(0, cap), overflow: fresh.slice(cap) };
}
