import { NextResponse } from 'next/server';
import { buildDigest, notify } from '@/lib/away/live';
import { errorMessage } from '@/lib/errorMessage';

const USER_ID = 'manoj';

// Nightly at 20:30 IST. Sends nothing unless an away trip is active.
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const d = await buildDigest(USER_ID);
    if (!d) return NextResponse.json({ ok: true, skipped: 'no active away session' });
    const [head, ...rest] = d.text.split('\n');
    await notify(USER_ID, head, rest.join('\n') || 'All quiet.', `away-digest-${new Date().toISOString().slice(0, 10)}`);
    return NextResponse.json({ ok: true, sent: true, chars: d.text.length });
  } catch (e) {
    const msg = errorMessage(e);
    console.error('away-digest cron error:', msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
