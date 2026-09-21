import Groq from 'groq-sdk';

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Fireflies GraphQL transcript shape
interface FirefliesTranscript {
  id: string;
  title: string;
  date: number;
  duration: number;
  participants: string[];
  summary?: {
    action_items?: string; // Fireflies returns this as a formatted markdown block, not an array
    overview?: string;
  };
  sentences?: { speaker_name: string; text: string }[];
}

interface FirefliesWebhookPayload {
  meeting_id?: string;
  meetingId?: string;
  title?: string;
  date?: number;
  duration?: number;
  organizer_email?: string;
  participants?: string[];
}

export interface ProcessedMeeting {
  meeting_id: string;
  title: string;
  meeting_date: string;
  duration_sec: number;
  participants: string[];
  summary: string;
  action_items: string[];
  raw_transcript?: string;
}

async function fetchFirefliesTranscript(meetingId: string): Promise<FirefliesTranscript | null> {
  const apiKey = process.env.FIREFLIES_API_KEY;
  if (!apiKey) return null;

  const query = `query Transcript($id: String!) {
    transcript(id: $id) {
      id title date duration participants
      summary { action_items overview }
      sentences { speaker_name text }
    }
  }`;

  const res = await fetch('https://api.fireflies.ai/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ query, variables: { id: meetingId } }),
  });

  if (!res.ok) {
    console.error('Fireflies API error:', res.status, await res.text());
    return null;
  }

  const data = await res.json() as { data?: { transcript?: FirefliesTranscript } };
  return data.data?.transcript ?? null;
}

function parseFirefliesActionItemsText(text: string): string[] {
  return text
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !/^\*\*.*\*\*$/.test(l)) // drop empty lines and bold speaker-name headers
    .map(l => l.replace(/\s*\((?:\d{1,2}:)?\d{1,2}:\d{2}\)\s*$/, '')) // strip trailing (mm:ss) or (h:mm:ss) timestamps
    .map(l => l.replace(/^[-*•]\s+|^\d+\.\s+/, '')) // strip leading bullet/numbering markers
    .filter(Boolean);
}

async function extractWithGroq(
  title: string,
  transcript: string,
  firefliesItemsText: string
): Promise<{ summary: string; action_items: string[] }> {
  const fallbackItems = parseFirefliesActionItemsText(firefliesItemsText);
  const prompt = `You are extracting structured information from a meeting transcript.

Meeting: ${title}
${firefliesItemsText ? `Fireflies extracted action items:\n${firefliesItemsText}` : ''}

Transcript:
${transcript.slice(0, 6000)}

Return ONLY valid JSON:
{
  "summary": "2-3 sentence overview of what was discussed and decided",
  "action_items": ["action item 1", "action item 2", ...]
}

Be specific. Action items must be concrete, assignable tasks — not vague observations.`;

  try {
    const response = await groq.chat.completions.create({
      model: 'qwen/qwen3.8-27b',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: 800,
    });
    const text = response.choices[0]?.message?.content ?? '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON in response');
    const parsed = JSON.parse(jsonMatch[0]) as { summary?: string; action_items?: string[] };
    return {
      summary: parsed.summary ?? 'Meeting processed.',
      action_items: parsed.action_items ?? fallbackItems,
    };
  } catch (e) {
    console.error('extractWithGroq failed:', e instanceof Error ? e.message : e);
    return {
      summary: `Meeting: ${title}`,
      action_items: fallbackItems,
    };
  }
}

// transcript.duration (Fireflies GraphQL) is in minutes as a float. payload.duration (webhook
// body fallback, only used if the GraphQL fetch itself fails) is assumed seconds — unverified.
function resolveDurationSec(transcriptDurationMin: number | undefined, payloadDurationSec: number | undefined): number {
  if (transcriptDurationMin != null) return Math.round(transcriptDurationMin * 60);
  if (payloadDurationSec != null) {
    console.warn('meetingProcessor: using unverified payload.duration unit assumption (seconds):', payloadDurationSec);
    return payloadDurationSec;
  }
  return 0;
}

export async function processMeeting(payload: FirefliesWebhookPayload): Promise<ProcessedMeeting | null> {
  const meetingId = payload.meeting_id ?? payload.meetingId;
  if (!meetingId) return null;

  const transcript = await fetchFirefliesTranscript(meetingId);

  if (transcript) {
    const rawText = (transcript.sentences ?? []).map(s => `${s.speaker_name}: ${s.text}`).join('\n');
    const firefliesItemsText = transcript.summary?.action_items ?? '';
    const { summary, action_items } = await extractWithGroq(transcript.title, rawText, firefliesItemsText);

    return {
      meeting_id: meetingId,
      title: transcript.title ?? payload.title ?? 'Meeting',
      // Fireflies returns date as Unix ms; multiply by 1000 only if it looks like seconds (<1e12)
      meeting_date: new Date(transcript.date < 1e12 ? transcript.date * 1000 : transcript.date).toISOString(),
      duration_sec: resolveDurationSec(transcript.duration, payload.duration),
      participants: transcript.participants ?? payload.participants ?? [],
      summary,
      action_items,
      raw_transcript: rawText.slice(0, 50000),
    };
  }

  // No API key or fetch failed — store basic info from webhook payload
  return {
    meeting_id: meetingId,
    title: payload.title ?? 'Meeting',
    meeting_date: payload.date ? new Date(payload.date).toISOString() : new Date().toISOString(),
    duration_sec: payload.duration ?? 0,
    participants: payload.participants ?? [],
    summary: 'Transcript fetch pending — add FIREFLIES_API_KEY to enable full processing.',
    action_items: [],
  };
}
