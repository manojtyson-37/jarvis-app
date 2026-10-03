import { NextResponse } from 'next/server';
import { fetchMessageSummaries } from '@/lib/gmail';
import { isGmailMessageSeen, markGmailMessageSeen } from '@/lib/supabase';
import { sendPush } from '@/lib/push';
import { errorMessage } from '@/lib/errorMessage';

const USER_ID = 'manoj';

// Labels the user wants proactively monitored — new mail here should push a notification,
// not wait for an on-demand chat query. Gmail nested labels are independent tags (a message
// under the "Integrations" sub-label is not automatically also tagged with the parent), so
// both are queried explicitly rather than assuming one implies the other.
const MONITORED_LABELS = ['Atulya/Manoj R', 'Atulya/Manoj R/Integrations'];

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const seenIds = new Set<string>();
    const candidates: { id: string; from: string; subject: string; automated: boolean }[] = [];
    let labelErrors = 0;

    for (const label of MONITORED_LABELS) {
      // newer_than:3d (not 1d) — cheap safety margin so a message doesn't age out of the
      // window and get permanently missed if the cron skips a run for over a day (deploy
      // freeze, Vercel outage). The seen-table dedup already makes the wider window free.
      const summaries = await fetchMessageSummaries(`label:"${label}" newer_than:3d`, 25);
      if (!summaries) {
        labelErrors++;
        console.error('sync-gmail: label fetch failed or not configured:', label);
        continue; // don't fail the whole run over one label
      }
      for (const s of summaries) {
        if (seenIds.has(s.id)) continue; // de-dupe across overlapping label queries
        seenIds.add(s.id);
        candidates.push(s);
      }
    }

    let notified = 0;
    let deliveryFailed = 0;

    for (const c of candidates) {
      if (await isGmailMessageSeen(c.id)) continue;

      // Cap length — an oversized/malformed From or Subject could push the webpush payload
      // over the push service's size limit, causing silent delivery failure every run (since
      // delivery failures aren't marked seen and retry indefinitely).
      const from = c.from.slice(0, 150);
      const subject = c.subject.slice(0, 150);
      const delivered = await sendPush(USER_ID, {
        title: c.automated ? 'Maya · New mail (auto)' : 'Maya · New mail — may need a reply',
        body: `From: ${from} — "${subject}"`,
        data: { prefill: `Show me email ${c.id}` },
      });

      if (!delivered) {
        // Don't mark as seen — leave it to retry next run rather than going silently invisible.
        deliveryFailed++;
        continue;
      }
      await markGmailMessageSeen(USER_ID, c.id);
      notified++;
    }

    return NextResponse.json({ ok: true, checked: candidates.length, notified, deliveryFailed, labelErrors });
  } catch (e) {
    const msg = errorMessage(e);
    console.error('sync-gmail cron error:', msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
