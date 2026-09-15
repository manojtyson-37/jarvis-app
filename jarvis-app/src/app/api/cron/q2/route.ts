import { NextResponse } from 'next/server';
import { generateAndPushQuestion } from '@/lib/question';

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const result = await generateAndPushQuestion('manoj');
  return NextResponse.json({ ok: true, ...result });
}
