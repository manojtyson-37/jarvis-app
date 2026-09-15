import { NextResponse } from 'next/server';
import Groq from 'groq-sdk';
import { getRecentConversations, saveEvolutionLog, saveMemoryFacts, getPushSubscriptions } from '@/lib/supabase';
import webpush from 'web-push';

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const USER_ID = 'manoj';

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

  const analysis = await groq.chat.completions.create({
    model: 'openai/gpt-oss-20b',
    messages: [{
      role: 'system',
      content: `Analyze this AI assistant conversation log. Output JSON with:
- gaps: array of {question, issue} where the assistant failed or said it couldn't help (max 5)
- new_facts: array of {fact, category} — new things learned about the user worth remembering
- suggestions: array of {feature, priority:"high"|"medium", why} — features that would have helped (max 3)
- summary: one sentence describing today's usage pattern`,
    }, {
      role: 'user',
      content: transcript,
    }],
    max_tokens: 600,
    response_format: { type: 'json_object' },
  });

  const raw = analysis.choices[0]?.message?.content ?? '{}';
  let parsed: { gaps?: unknown[]; new_facts?: { fact: string; category: string }[]; suggestions?: unknown[]; summary?: string } = {};
  try { parsed = JSON.parse(raw); } catch { /* silent */ }

  const today = new Date().toISOString().split('T')[0];
  const gaps = parsed.gaps ?? [];
  const newFacts = parsed.new_facts ?? [];
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
