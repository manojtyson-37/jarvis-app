import { NextResponse } from 'next/server';
import { listMyOpenTickets } from '@/lib/freshdesk';
import { isFreshdeskTicketSeen, markFreshdeskTicketSeen } from '@/lib/supabase';
import { sendPush } from '@/lib/push';

const USER_ID = 'manoj';
const PRIORITY_NAMES: Record<number, string> = { 1: 'Low', 2: 'Medium', 3: 'High', 4: 'Urgent' };

// Proactively surfaces new Freshdesk tickets assigned to the user — previously
// Maya only knew about tickets when asked to look one up directly.
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const tickets = await listMyOpenTickets();
    let notified = 0;
    let deliveryFailed = 0;

    for (const t of tickets) {
      const ticketId = String(t.id);
      if (await isFreshdeskTicketSeen(ticketId)) continue;

      const delivered = await sendPush(USER_ID, {
        title: 'Maya · New Freshdesk ticket',
        body: `#${t.id} "${t.subject}" — ${PRIORITY_NAMES[t.priority] ?? 'priority unknown'}`,
        data: { prefill: `Show me Freshdesk ticket ${t.id}` },
      });

      if (!delivered) {
        // Don't mark as seen — leave it to retry next run rather than going silently invisible.
        deliveryFailed++;
        continue;
      }
      await markFreshdeskTicketSeen(USER_ID, ticketId);
      notified++;
    }

    return NextResponse.json({ ok: true, checked: tickets.length, notified, deliveryFailed });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('sync-freshdesk cron error:', msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
