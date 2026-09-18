import { NextResponse } from 'next/server';
import { pushCheckin } from '@/lib/checkin';

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // 6:30 PM IST = 13:00 UTC — treat as EOD
  const utcHour = new Date().getUTCHours();
  const type = utcHour === 13 ? 'eod' : 'regular';

  try {
    const result = await pushCheckin('manoj', type);
    return NextResponse.json({ ok: true, type, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
