import { NextResponse } from 'next/server';
import webpush from 'web-push';
import {
  getDueReminders, listReminders, getRecentNotes,
  getRecentWorkouts, getFinanceSummary, getPushSubscriptions,
} from '@/lib/supabase';

webpush.setVapidDetails(
  'mailto:kbdcreditsolutions@gmail.com',
  process.env.VAPID_PUBLIC_KEY!,
  process.env.VAPID_PRIVATE_KEY!
);

export const runtime = 'nodejs';

const USER_ID = 'manoj';

function istHour(): number {
  return new Date(Date.now() + 5.5 * 3600000).getUTCHours();
}

export async function GET(req: Request) {
  const auth = (req.headers as unknown as Headers).get('authorization');
  if (auth !== `Bearer ${process.env.CRON_SECRET}` && process.env.NODE_ENV !== 'development') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Only fire between 7:00–7:05 IST
  const hour = istHour();
  if (hour !== 7) return NextResponse.json({ skipped: true, istHour: hour });

  const [overdue, upcoming, notes, workouts, finance, subs] = await Promise.all([
    getDueReminders(USER_ID),
    listReminders(USER_ID),
    getRecentNotes(USER_ID, 5),
    getRecentWorkouts(USER_ID, 7),
    getFinanceSummary(USER_ID, 7),
    getPushSubscriptions(USER_ID),
  ]);

  if (!subs.length) return NextResponse.json({ skipped: true, reason: 'no subscriptions' });

  const lines: string[] = [];

  if (overdue.length) {
    lines.push(`⚠️ ${overdue.length} overdue: ${overdue.map((r: { text: string }) => r.text).slice(0, 2).join(', ')}`);
  }

  const todayIST = new Date(Date.now() + 5.5 * 3600000);
  const todayStr = todayIST.toISOString().slice(0, 10);
  const overdueIds = new Set(overdue.map((o: { id: string }) => o.id));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const todayReminders = upcoming.filter((r: any) => r.remind_at.slice(0, 10) === todayStr && !overdueIds.has(r.id));
  if (todayReminders.length) {
    lines.push(`📅 Today: ${todayReminders.slice(0, 2).map((r: { text: string; remind_at: string }) => `${r.text} (${new Date(r.remind_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })})`).join(', ')}`);
  }

  const weekWorkouts = workouts.length;
  lines.push(`💪 ${weekWorkouts} workout${weekWorkouts !== 1 ? 's' : ''} this week`);

  if (finance.expense > 0) {
    lines.push(`💸 ₹${finance.expense.toFixed(0)} spent this week`);
  }

  if (notes.length) {
    lines.push(`📝 ${notes.length} recent note${notes.length !== 1 ? 's' : ''}`);
  }

  const body = lines.join('\n') || 'All clear — no pending items.';

  let pushed = 0;
  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        sub.subscription as webpush.PushSubscription,
        JSON.stringify({ title: '☀️ Good morning, Manoj', body, tag: 'morning-briefing' })
      );
      pushed++;
    } catch (e) {
      console.error('Morning push failed:', e);
    }
  }

  return NextResponse.json({ pushed, lines });
}
