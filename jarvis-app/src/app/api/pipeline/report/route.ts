import { NextRequest, NextResponse } from 'next/server';
import { parseSnapshot } from '@/lib/pipeline/rules';
import { saveSnapshot } from '@/lib/pipeline/store';

// Reached with the browser session or the brain key (see brainAuth.ts); middleware rejects everything else.
// Accepts counts only: scripts/pipeline-snapshot.mjs sends how many leads and paying customers, never who they are.
export async function POST(req: NextRequest) {
  const parsed = parseSnapshot(await req.json().catch(() => null));
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
  try {
    return NextResponse.json({ saved: await saveSnapshot('manoj', parsed.snapshot) });
  } catch (e) {
    console.error('[pipeline] report failed:', (e as Error).message);
    return NextResponse.json({ error: 'could not save the snapshot' }, { status: 500 });
  }
}
