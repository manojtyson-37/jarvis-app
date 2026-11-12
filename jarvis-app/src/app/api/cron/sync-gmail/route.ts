import { NextResponse } from 'next/server';
import { fetchMessageSummaries } from '@/lib/gmail';
import { isGmailMessageSeen, markGmailMessageSeen } from '@/lib/supabase';
import { sendPush } from '@/lib/push';
import { errorMessage } from '@/lib/errorMessage';
import { WATCH_QUERY, selectNotifiable } from '@/lib/mailWatch';
import { getActiveSession } from '@/lib/away/store';

const USER_ID = 'manoj';

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // While Away Mode runs, it owns the inbox and pushes what needs him; a second push here would double up.
    if (await getActiveSession(USER_ID)) return NextResponse.json({ ok: true, skipped: 'away_active' });
    const found = await fetchMessageSummaries(WATCH_QUERY, 25);
    // null = Gmail unavailable or a fetch error; [] is a normal empty inbox.
    if (found === null) return NextResponse.json({ ok: false, error: 'gmail_unavailable' }, { status: 502 });
    const seen = new Set<string>();
    for (const c of found) if (!c.automated && await isGmailMessageSeen(c.id)) seen.add(c.id);
    const { push: candidates, overflow } = selectNotifiable(found, id => seen.has(id));

    let notified = 0;
    let deliveryFailed = 0;

    for (const c of candidates) {
      // Cap length — an oversized/malformed From or Subject could push the webpush payload
      // over the push service's size limit, causing silent delivery failure every run (since
      // delivery failures aren't marked seen and retry indefinitely). fromName (not the raw
      // header) so the notification reads as a name, not `"Jane Doe" <jane@x.com>`.
      const from = c.fromName.slice(0, 150);
      const subject = c.subject.slice(0, 150);
      const delivered = await sendPush(USER_ID, {
        title: 'Maya · New mail — may need a reply',
        body: `${from} — "${subject}"`,
        tag: `gmail-${c.id}`,
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

    // More new mail than the cap: one summary push instead of a flood, and those messages count as notified.
    if (overflow.length) {
      const delivered = await sendPush(USER_ID, { title: 'Maya · More new mail', body: `${overflow.length} more unread in your inbox.`, tag: `gmail-more-${overflow[0].id}`, data: { prefill: 'Any email I need to respond to?' } }).catch(() => false);
      if (delivered) for (const o of overflow) await markGmailMessageSeen(USER_ID, o.id);
    }
    return NextResponse.json({ ok: true, checked: found.length, notified, deliveryFailed, overflow: overflow.length });
  } catch (e) {
    const msg = errorMessage(e);
    console.error('sync-gmail cron error:', msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
