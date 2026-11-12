import { NextResponse } from 'next/server';
import { collectEmailTodos, collectMeetingTodos } from '@/lib/todos/collect';
import { runTodoBatch } from '@/lib/todos/runner';
import { errorMessage } from '@/lib/errorMessage';

export const runtime = 'nodejs';
export const maxDuration = 300;

// Every 30 min: collect to-dos from starred/self-sent mail and Gemini meeting notes, then run up to 3 pending ones.
// Free-tier Groq has a shared daily token budget, so a run is capped; leftovers wait for the next run.
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const userId = 'manoj';
  const collected: Record<string, number | string> = {};
  // A failing source must not stop the others or the run.
  for (const [name, fn] of [['email', collectEmailTodos], ['meeting', collectMeetingTodos]] as const) {
    try { collected[name] = await fn(userId); } catch (e) { collected[name] = `error: ${errorMessage(e).slice(0, 120)}`; }
  }
  try {
    const run = await runTodoBatch(userId, { limit: 3, budgetMs: 200_000 });
    return NextResponse.json({ collected, ...run });
  } catch (e) {
    console.error('todos cron failed:', errorMessage(e));
    return NextResponse.json({ collected, error: errorMessage(e) }, { status: 500 });
  }
}
