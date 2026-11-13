import { NextResponse } from 'next/server';
import { fetchMessageSummaries } from '@/lib/gmail';

// Fallback for the maya-brain LinkedIn inbox while the LinkedIn cookie is dead: LinkedIn's own
// "new message" notification emails, returned raw. No LLM, no tools, no history: the text is a
// stranger's, so it only travels to Manoj's Telegram as plain text. Reached only with MAYA_BRAIN_KEY.
const LINKEDIN_MAIL_QUERY = 'from:(messages-noreply@linkedin.com OR inmail-hit-reply@linkedin.com) newer_than:1d';

export async function GET() {
  const found = await fetchMessageSummaries(LINKEDIN_MAIL_QUERY, 10);
  if (found === null) return NextResponse.json({ error: 'gmail unavailable' }, { status: 502 });
  return NextResponse.json({
    emails: found.map(e => ({ id: e.id, from: e.fromName.slice(0, 120), subject: e.subject.slice(0, 200), snippet: (e.snippet ?? '').slice(0, 500), date: e.date ?? '' })),
  });
}
