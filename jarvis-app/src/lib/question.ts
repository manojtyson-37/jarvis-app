import Groq from 'groq-sdk';
import { getMemoryFacts, saveMemoryFacts, getPushSubscriptions } from '@/lib/supabase';
import webpush from 'web-push';

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const QUESTION_AREAS = [
  'morning routine and energy patterns across the day',
  'work priorities and what frustrates you most as a PM',
  'KBD Credit Solutions — current stage, blockers, next milestone',
  'fitness schedule — what you actually do vs what you plan',
  'how you make big decisions and who you consult',
  'financial goals and your relationship with money',
  'relationships — who energizes you, who drains you',
  'stress responses — how you decompress and recover',
  'what a perfect week looks like for you',
  'your biggest current worry or unsolved problem',
  'things you keep procrastinating on and why',
  'what you read, watch, or listen to regularly',
  'your definition of success in 3 years',
  'sleep habits and how you feel when you wake up',
  'what you want Maya to proactively do for you',
  'how you like receiving feedback or pushback',
  'travel, family time, and how you protect personal time',
  'what you wish someone had told you 5 years ago',
];

export async function generateAndPushQuestion(userId: string): Promise<{ question: string; pushed: number }> {
  const knownFacts = await getMemoryFacts(userId, 80);
  const knownText = knownFacts.map(f => `• [${f.category}] ${f.fact}`).join('\n');
  const askedQuestions = knownFacts
    .filter(f => f.category === 'question')
    .map(f => f.fact.replace(/^Asked(?: \(in-chat\))?: /, ''));

  const area = QUESTION_AREAS[Math.floor(Math.random() * QUESTION_AREAS.length)];

  const result = await groq.chat.completions.create({
    model: 'openai/gpt-oss-20b',
    messages: [{
      role: 'system',
      content: `You are Maya, a sharp personal AI learning about Manoj. Ask ONE specific, honest question to understand him better in this area: "${area}".

What you know:
${knownText || 'Very little yet.'}

Questions already asked (don't repeat):
${askedQuestions.slice(-20).join('\n') || 'None yet.'}

Rules:
- One sentence max
- Ask about something NOT covered by what you know
- Conversational tone — curious friend, not survey
- Output ONLY the question`,
    }],
    max_tokens: 80,
  });

  const question = result.choices[0]?.message?.content?.trim() ?? '';
  if (!question) return { question: '', pushed: 0 };

  await saveMemoryFacts(userId, [{ fact: `Asked: ${question}`, category: 'question' }]);

  if (!process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
    return { question, pushed: 0 };
  }

  webpush.setVapidDetails(
    'mailto:kbdcreditsolutions@gmail.com',
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );

  const subs = await getPushSubscriptions(userId);
  const results = await Promise.allSettled(
    subs.map((s: { subscription: object }) =>
      webpush.sendNotification(
        s.subscription as Parameters<typeof webpush.sendNotification>[0],
        JSON.stringify({
          title: 'Maya is curious 🤔',
          body: question,
          icon: '/icon-192.png',
          data: { prefill: question },
        })
      )
    )
  );

  return { question, pushed: results.filter(r => r.status === 'fulfilled').length };
}
