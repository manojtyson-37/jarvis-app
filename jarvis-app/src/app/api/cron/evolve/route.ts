import { NextResponse } from 'next/server';
import { llm } from '@/lib/llm';
import { getRecentConversations, saveEvolutionLog, saveMemoryFacts, getPushSubscriptions, getPromptFacts } from '@/lib/supabase';
import { ruleKey } from '@/lib/instructions';
import { safeFactCategory, isReservedFactCategory, FACT_CATEGORIES } from '@/lib/memoryCategory';
import webpush from 'web-push';

// Claude via src/lib/llm.ts; the old name keeps the calls below unchanged.
const groq = llm;
const USER_ID = 'manoj';
// Up to two model calls of 20s each, plus database work.
export const maxDuration = 60;

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const conversations = await getRecentConversations(USER_ID, 24);
  if (conversations.length < 4) {
    return NextResponse.json({ skipped: 'not enough conversations' });
  }

  const transcript = conversations
    .map((c: { role: string; content: string }) => `${c.role.toUpperCase()}: ${c.content.slice(0, 300)}`)
    .join('\n');

  const SYSTEM = `Analyze this AI assistant conversation log between Manoj (USER) and his assistant Maya. Output ONLY a JSON object with:
- gaps: array of {question, issue} where Maya failed, ignored an instruction, or said it couldn't help (max 5)
- new_facts: array of {fact, category} (category one of: ${FACT_CATEGORIES.join(', ')}) — durable facts about Manoj himself (goals, preferences, people, habits). Never ticket numbers, email ids, one-off requests, test messages or anything Maya said.
- suggestions: array of {feature, priority:"high"|"medium", why} — features that would have helped (max 3)
- summary: one sentence describing today's usage pattern`;

  // Claude has no server-side JSON validation: pull the {...} out of the reply and parse it ourselves, and try once
  // more when that fails or the reply was cut off at the token limit.
  let parsed: { gaps?: unknown[]; new_facts?: { fact: string; category: string }[]; suggestions?: unknown[]; summary?: string } | null = null;
  for (let attempt = 1; attempt <= 2 && !parsed; attempt++) {
    try {
      const analysis = await groq.chat.completions.create({
        model: 'claude-haiku-5-5',
        messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: transcript }],
        max_tokens: 2500,
        response_format: { type: 'json_object' },
      });
      const text = analysis.choices[0]?.message?.content ?? '';
      const cut = analysis.choices[0]?.finish_reason === 'length';
      const raw = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
      if (!cut && raw) parsed = JSON.parse(raw);
      else console.warn(`evolve: attempt ${attempt} ${cut ? 'cut off' : 'had no JSON'}`);
    } catch (e) {
      console.warn(`evolve: attempt ${attempt} failed:`, (e as Error).message.slice(0, 200));
    }
  }
  if (!parsed) return NextResponse.json({ ok: false, error: 'analysis failed' });

  const today = new Date().toISOString().split('T')[0];
  const gaps = parsed.gaps ?? [];
  // Skip facts already known, so the prompt does not fill with repeats.
  const known = new Set((await getPromptFacts(USER_ID, 200)).map((f: { fact: string }) => ruleKey(f.fact)));
  const newFacts = (Array.isArray(parsed.new_facts) ? parsed.new_facts : [])
    .filter(f => f && typeof f.fact === 'string' && f.fact.trim() && !known.has(ruleKey(f.fact)) && !isReservedFactCategory(f.category))
    .map(f => ({ fact: f.fact.trim().slice(0, 300), category: safeFactCategory(f.category) }));
  // Rules are never taken from this log: it includes Maya's replies, which quote email and ticket text, so a hostile
  // email could become a standing rule. Rules come only from Manoj's own chat messages (instructions.ts) or the Rules list.
  const suggestions = parsed.suggestions ?? [];
  const summary = parsed.summary ?? '';

  await Promise.all([
    saveEvolutionLog({ date: today, gaps, new_facts: newFacts, suggestions }),
    newFacts.length ? saveMemoryFacts(USER_ID, newFacts) : Promise.resolve(),
  ]);

  // Push notification
  if (process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails(
      'mailto:kbdcreditsolutions@gmail.com',
      process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY
    );
    const subs = await getPushSubscriptions(USER_ID);
    const body = [
      summary,
      gaps.length ? `${gaps.length} gap${gaps.length > 1 ? 's' : ''} found` : '',
      newFacts.length ? `${newFacts.length} new fact${newFacts.length > 1 ? 's' : ''} learned` : '',
      suggestions.length ? `Top suggestion: ${(suggestions[0] as { feature?: string })?.feature ?? ''}` : '',
    ].filter(Boolean).join(' · ');

    await Promise.allSettled(subs.map((s: { subscription: object }) =>
      webpush.sendNotification(s.subscription as Parameters<typeof webpush.sendNotification>[0],
        JSON.stringify({ title: 'Maya evolved today', body, icon: '/icon-192.png' }))
    ));
  }

  return NextResponse.json({ ok: true, gaps: gaps.length, new_facts: newFacts.length, suggestions: suggestions.length });
}
