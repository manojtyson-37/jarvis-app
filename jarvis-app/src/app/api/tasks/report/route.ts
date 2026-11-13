import { NextRequest, NextResponse } from 'next/server';
import { parseReport } from '@/lib/tasks/rules';
import { savePetReport } from '@/lib/tasks/store';

// Session-gated by middleware (not in PUBLIC_PATHS, not a brain path): only a signed-in device can report.
// The Mac pet posts its task list here so the web app and Telegram see the same tasks. State only, never results.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const parsed = parseReport(body);
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
  try {
    return NextResponse.json(await savePetReport('manoj', parsed.tasks));
  } catch (e) {
    console.error('[tasks] report failed:', (e as Error).message);
    return NextResponse.json({ error: 'could not save the report' }, { status: 500 });
  }
}
