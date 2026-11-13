import { NextRequest, NextResponse } from 'next/server';
import { llm } from '@/lib/llm';
import { buildDraftMessages, parseDraft } from '@/lib/linkedinDraft';

// Reached only with MAYA_BRAIN_KEY (middleware). Drafts text, nothing else: no tools, no history,
// no rules, no queued actions. Sending happens on the droplet after Manoj taps Approve.
const MODELS = ['claude-haiku-5-5', 'claude-sonnet-5-5'];

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const sender = typeof body?.sender === 'string' ? body.sender : '';
  const text = typeof body?.text === 'string' ? body.text : '';
  if (!text.trim()) return NextResponse.json({ error: 'text required' }, { status: 400 });

  // No memory facts: the prompt is steered by a stranger, so it must hold nothing private to leak.
  const messages = buildDraftMessages(sender, text);

  for (const model of MODELS) {
    try {
      const r = await llm.chat.completions.create({ model, messages, max_tokens: 600, response_format: { type: 'json_object' } });
      const out = parseDraft(r.choices[0]?.message?.content ?? '');
      if (out) return NextResponse.json(out);
      console.error(`[linkedin-draft] ${model} returned no usable draft`);
    } catch (e) {
      console.error(`[linkedin-draft] ${model} failed:`, (e as Error).message);
    }
  }
  return NextResponse.json({ error: 'draft failed' }, { status: 502 });
}
