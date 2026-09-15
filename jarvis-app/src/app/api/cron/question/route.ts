import { NextResponse } from 'next/server';
import { generateAndPushQuestion } from '@/lib/question';

export async function GET(req: Request) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const result = await generateAndPushQuestion('manoj');
  return NextResponse.json({ ok: true, ...result });
}
