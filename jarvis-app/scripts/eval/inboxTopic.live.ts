// Live check of the inbox-topic path: real Groq planning + answer, real Gmail search (read-only). Prints the query,
// match count and answer for each question. Run: npx tsx scripts/eval/inboxTopic.live.ts ["question" ...]
import { readFileSync } from 'fs';
for (const l of readFileSync('.env.local', 'utf8').split('\n')) { const i = l.indexOf('='); if (i > 0 && !l.startsWith('#')) process.env[l.slice(0, i).trim()] ??= l.slice(i + 1).trim().replace(/^"|"$/g, ''); }
(async () => {
  const Groq = (await import('groq-sdk')).default;
  const { answerInboxTopic } = await import('../../src/lib/inboxSearch');
  const { fetchMessageSummaries, getEmail } = await import('../../src/lib/gmail');
  const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  const model = process.env.LIVE_MODEL ?? 'qwen/qwen3.8-27b';
  const qs = process.argv.slice(2).length ? process.argv.slice(2) : ['Any job roles where I am moved to next stage rejected?', 'check my inbox', 'Did you check my emails, read the content?'];
  for (const q of qs) {
    const r = await answerInboxTopic(q, undefined, {
      llm: async (system, user, max) => { const t = Date.now(); const call = (m: string) => groq.chat.completions.create({ model: m, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], temperature: 0, max_tokens: m === model ? max : max + 500, ...(m === model ? {} : { reasoning_effort: 'low' as const }) }, { maxRetries: 0 });
        const c = await call(model).catch(e => { console.log(`  ${model} failed (${(e as Error).message.slice(0, 40)}), fallback`); return call('openai/gpt-oss-120b'); }); console.log(`  llm ${Date.now() - t}ms`); return c.choices[0]?.message?.content ?? ''; },
      search: async (query, max) => { const t = Date.now(); const r = await fetchMessageSummaries(query, max, max); console.log(`  search ${Date.now() - t}ms`); return r; },
      read: async id => { const t = Date.now(); const r = await getEmail(id); if (Date.now() - t > 3000) console.log(`  slow read ${Date.now() - t}ms`); return r; },
    }).catch(e => ({ kind: 'error', text: (e as Error).message }));
    console.log(`\nQ: ${q}\n${JSON.stringify(r, null, 1)}`);
  }
})();
