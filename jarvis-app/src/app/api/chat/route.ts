import Groq from 'groq-sdk';
import { NextRequest, NextResponse } from 'next/server';
import { buildSystemPrompt } from '@/lib/context';
import {
  getConversationHistory, appendConversation,
  saveNote, searchNotes, getRecentNotes, deleteNote,
  saveReminder, listReminders, markReminderDone,
  logWorkout, getRecentWorkouts,
  logFinance, getFinanceSummary,
  getMemoryFacts,
} from '@/lib/supabase';
import { parseReminderTime } from '@/lib/timeparser';

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const TOOLS: Groq.Chat.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'save_note',
      description: 'Save a note or piece of information.',
      parameters: { type: 'object', properties: { content: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } }, required: ['content'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_notes',
      description: 'Search existing notes by keyword.',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_recent_notes',
      description: 'Get the most recent notes.',
      parameters: { type: 'object', properties: { limit: { type: 'number' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_note',
      description: 'Delete a note by its ID.',
      parameters: { type: 'object', properties: { note_id: { type: 'string' } }, required: ['note_id'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_reminder',
      description: 'Set a reminder. When: "in 2 hours", "tomorrow 9am", "friday 3pm".',
      parameters: { type: 'object', properties: { text: { type: 'string' }, when: { type: 'string' } }, required: ['text', 'when'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_reminders',
      description: 'List all upcoming (unfired) reminders.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mark_reminder_done',
      description: 'Mark a reminder as done/dismissed by its ID.',
      parameters: { type: 'object', properties: { reminder_id: { type: 'string' } }, required: ['reminder_id'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'log_workout',
      description: 'Log a workout or fitness activity.',
      parameters: { type: 'object', properties: { type: { type: 'string' }, duration_min: { type: 'number' }, notes: { type: 'string' } }, required: ['type'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_recent_workouts',
      description: 'Get recent workout history.',
      parameters: { type: 'object', properties: { days: { type: 'number' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'log_expense',
      description: 'Log an expense or purchase.',
      parameters: { type: 'object', properties: { amount: { type: 'number' }, category: { type: 'string' }, description: { type: 'string' } }, required: ['amount'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'log_income',
      description: 'Log income received.',
      parameters: { type: 'object', properties: { amount: { type: 'number' }, category: { type: 'string' }, description: { type: 'string' } }, required: ['amount'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_finance_summary',
      description: 'Get income/expense summary for the last N days.',
      parameters: { type: 'object', properties: { days: { type: 'number' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_morning_briefing',
      description: 'Get a comprehensive morning briefing: upcoming reminders, recent notes, recent workouts.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web for current information, news, prices, events, or anything requiring up-to-date data.',
      parameters: { type: 'object', properties: { query: { type: 'string', description: 'The search query' } }, required: ['query'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_url',
      description: 'Fetch and read the content of any URL or webpage.',
      parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_calendar_events',
      description: 'Get upcoming Google Calendar events. Use when asked about schedule, meetings, calendar, or what\'s coming up.',
      parameters: { type: 'object', properties: { days: { type: 'number', description: 'Number of days ahead to look (default 7)' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_calendar_event',
      description: 'Create a new event on Google Calendar. Returns the event ID — store it in case user wants to delete or update it.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          start: { type: 'string', description: 'ISO 8601 datetime e.g. 2026-09-16T09:00:00+05:30' },
          end: { type: 'string', description: 'ISO 8601 datetime' },
          description: { type: 'string' },
        },
        required: ['title', 'start', 'end'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_calendar_event',
      description: 'Delete a Google Calendar event by its ID. Use when user wants to remove an event or correct a mistake (delete wrong event, then create the correct one).',
      parameters: {
        type: 'object',
        properties: {
          event_id: { type: 'string', description: 'The Google Calendar event ID returned by create_calendar_event or get_calendar_events' },
        },
        required: ['event_id'],
      },
    },
  },
];

async function executeTool(name: string, args: Record<string, unknown>, userId: string): Promise<string> {
  switch (name) {
    case 'save_note':
      await saveNote(userId, args.content as string, (args.tags as string[]) ?? []);
      return 'Saved.';

    case 'search_notes': {
      const notes = await searchNotes(userId, args.query as string);
      if (!notes.length) return 'No matching notes.';
      return notes.map((n: { id: string; content: string; created_at: string }) =>
        `[${n.id}] ${n.content} (${new Date(n.created_at).toLocaleDateString('en-IN')})`
      ).join('\n');
    }

    case 'get_recent_notes': {
      const notes = await getRecentNotes(userId, (args.limit as number) ?? 5);
      if (!notes.length) return 'No notes yet.';
      return notes.map((n: { id: string; content: string; created_at: string }) =>
        `[${n.id}] ${n.content} (${new Date(n.created_at).toLocaleDateString('en-IN')})`
      ).join('\n');
    }

    case 'delete_note':
      await deleteNote(userId, args.note_id as string);
      return 'Note deleted.';

    case 'set_reminder': {
      const remindAt = parseReminderTime(args.when as string);
      if (!remindAt) return `Couldn't parse "${args.when}" — try "in 2 hours" or "tomorrow 9am".`;
      await saveReminder(userId, args.text as string, remindAt.toISOString());
      const timeStr = remindAt.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'short', timeStyle: 'short' });
      return `Done — ${args.text} at ${timeStr}.`;
    }

    case 'list_reminders': {
      const reminders = await listReminders(userId);
      if (!reminders.length) return 'No upcoming reminders.';
      const now = new Date();
      return reminders.map((r: { id: string; text: string; remind_at: string }) => {
        const t = new Date(r.remind_at);
        const timeStr = t.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'short', timeStyle: 'short' });
        const overdue = t < now ? ' [overdue]' : '';
        return `• ${r.text} — ${timeStr}${overdue} (id:${r.id})`;
      }).join('\n');
    }

    case 'mark_reminder_done':
      await markReminderDone(userId, args.reminder_id as string);
      return 'Reminder removed.';

    case 'log_workout':
      await logWorkout(userId, {
        type: args.type, duration_min: args.duration_min ?? null,
        notes: args.notes ?? '', logged_at: new Date().toISOString(),
      });
      return `Workout logged: ${args.type}${args.duration_min ? ` (${args.duration_min} min)` : ''}.`;

    case 'get_recent_workouts': {
      const logs = await getRecentWorkouts(userId, (args.days as number) ?? 7);
      if (!logs.length) return 'No workouts logged recently.';
      return logs.map((l: { logged_at: string; type: string; duration_min?: number; notes?: string }) => {
        const d = new Date(l.logged_at).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });
        return `• ${d}: ${l.type}${l.duration_min ? ` ${l.duration_min}min` : ''}${l.notes ? ` — ${l.notes}` : ''}`;
      }).join('\n');
    }

    case 'log_expense': {
      await logFinance(userId, 'expense', args.amount as number, (args.category as string) ?? 'general', (args.description as string) ?? '');
      return `Expense logged: ₹${args.amount}${args.category ? ` (${args.category})` : ''}.`;
    }

    case 'log_income': {
      await logFinance(userId, 'income', args.amount as number, (args.category as string) ?? 'general', (args.description as string) ?? '');
      return `Income logged: ₹${args.amount}${args.category ? ` (${args.category})` : ''}.`;
    }

    case 'get_finance_summary': {
      const days = (args.days as number) ?? 30;
      const { income, expense, net, logs } = await getFinanceSummary(userId, days);
      const breakdown = logs.slice(0, 8).map((l: { type: string; amount: number; category: string; description: string; logged_at: string }) =>
        `• ${l.type === 'income' ? '+' : '-'}₹${l.amount} ${l.category}${l.description ? ` — ${l.description}` : ''}`
      ).join('\n');
      return `Last ${days} days:\nIncome: ₹${income.toFixed(0)}\nExpenses: ₹${expense.toFixed(0)}\nNet: ₹${net.toFixed(0)}\n\n${breakdown}`;
    }

    case 'get_morning_briefing': {
      const [reminders, notes, workouts] = await Promise.all([
        listReminders(userId),
        getRecentNotes(userId, 5),
        getRecentWorkouts(userId, 7),
      ]);
      const now = new Date();
      const upcoming = reminders.filter((r: { remind_at: string }) => new Date(r.remind_at) > now).slice(0, 5);
      const overdue = reminders.filter((r: { remind_at: string }) => new Date(r.remind_at) <= now);
      let brief = '';
      if (overdue.length) brief += `**Overdue (${overdue.length}):** ${overdue.map((r: { text: string }) => r.text).join(', ')}\n`;
      if (upcoming.length) brief += `**Upcoming:** ${upcoming.map((r: { text: string; remind_at: string }) => `${r.text} (${new Date(r.remind_at).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' })})`).join(', ')}\n`;
      if (notes.length) brief += `**Recent notes:** ${notes.slice(0, 3).map((n: { content: string }) => n.content.slice(0, 50)).join(' | ')}\n`;
      const wThisWeek = workouts.filter((w: { logged_at: string }) => new Date(w.logged_at) > new Date(Date.now() - 7 * 86400000));
      if (wThisWeek.length) brief += `**Workouts this week:** ${wThisWeek.length} sessions`;
      return brief || 'All clear — no reminders, notes, or recent activity.';
    }

    case 'web_search': {
      const apiKey = process.env.TAVILY_API_KEY;
      if (!apiKey) return 'Web search not configured (TAVILY_API_KEY missing).';
      const res = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: apiKey, query: args.query, max_results: 5, search_depth: 'basic' }),
      });
      if (!res.ok) return `Search failed: ${res.status}`;
      const data = await res.json() as { results: { title: string; url: string; content: string }[] };
      if (!data.results?.length) return 'No results found.';
      return data.results.slice(0, 4).map((r, i) =>
        `${i + 1}. **${r.title}**\n${r.url}\n${r.content.slice(0, 300)}`
      ).join('\n\n');
    }

    case 'read_url': {
      const jinaUrl = `https://r.jina.ai/${args.url}`;
      const res = await fetch(jinaUrl, { headers: { Accept: 'text/plain' } });
      if (!res.ok) return `Failed to fetch URL: ${res.status}`;
      const text = await res.text();
      return text.slice(0, 3000);
    }

    case 'get_calendar_events': {
      const token = await getGoogleAccessToken();
      if (!token) return 'Google Calendar not configured.';
      const days = (args.days as number) ?? 7;
      const now = new Date();
      const end = new Date(now.getTime() + days * 86400000);
      const res = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${now.toISOString()}&timeMax=${end.toISOString()}&singleEvents=true&orderBy=startTime&maxResults=20`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!res.ok) return `Calendar fetch failed: ${res.status}`;
      const data = await res.json() as { items: { id: string; summary: string; start: { dateTime?: string; date?: string }; end: { dateTime?: string; date?: string }; description?: string }[] };
      if (!data.items?.length) return `No events in the next ${days} days.`;
      return data.items.map(e => {
        const start = e.start.dateTime ?? e.start.date ?? '';
        const d = start ? new Date(start).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'short', timeStyle: 'short' }) : '';
        return `• [${e.id}] ${e.summary} — ${d}${e.description ? `\n  ${e.description.slice(0, 80)}` : ''}`;
      }).join('\n');
    }

    case 'create_calendar_event': {
      const token = await getGoogleAccessToken();
      if (!token) return 'Google Calendar not configured.';
      const res = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          summary: args.title,
          description: args.description ?? '',
          start: { dateTime: args.start, timeZone: 'Asia/Kolkata' },
          end: { dateTime: args.end, timeZone: 'Asia/Kolkata' },
        }),
      });
      if (!res.ok) return `Failed to create event: ${res.status}`;
      const ev = await res.json() as { id?: string; summary: string; htmlLink: string };
      return `Event created: "${ev.summary}" (id: ${ev.id ?? '(unavailable)'}) — ${ev.htmlLink}`;
    }

    case 'delete_calendar_event': {
      if (!args.event_id) return 'event_id is required to delete an event.';
      const token = await getGoogleAccessToken();
      if (!token) return 'Google Calendar not configured.';
      const res = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(args.event_id as string)}`,
        { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }
      );
      if (res.ok) return 'Event deleted.';
      if (res.status === 404 || res.status === 410) return 'Event not found — it may have already been deleted.';
      return `Failed to delete event: ${res.status}`;
    }

    default:
      return `Unknown tool: ${name}`;
  }
}

async function getGoogleAccessToken(): Promise<string | null> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) return null;
  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }),
    });
    if (!res.ok) {
      console.error('Google token refresh failed:', res.status, await res.text());
      return null;
    }
    const data = await res.json() as { access_token?: string };
    return data.access_token ?? null;
  } catch (e) {
    console.error('Google token fetch error:', (e as Error).message);
    return null;
  }
}

export async function GET() {
  const history = await getConversationHistory('manoj', 40);
  return NextResponse.json({ history });
}

// Tools that confirm an action — skip the 2nd Groq call
const FAST_CONFIRM_TOOLS = new Set([
  'save_note', 'delete_note', 'set_reminder', 'mark_reminder_done',
  'log_workout', 'log_expense', 'log_income', 'delete_calendar_event',
]);

export async function POST(req: NextRequest) {
  const { message } = await req.json();
  const userId = 'manoj';

  if (!message?.trim()) return NextResponse.json({ error: 'Empty message' }, { status: 400 });

  const [history, memoryFacts] = await Promise.all([
    getConversationHistory(userId, 10),
    getMemoryFacts(userId, 20),
  ]);
  await appendConversation(userId, 'user', message);

  const encoder = new TextEncoder();
  const sseChunk = (text: string) => encoder.encode(`data: ${JSON.stringify({ chunk: text })}\n\n`);
  const sseDone = () => encoder.encode('data: [DONE]\n\n');

  const readable = new ReadableStream({
    async start(controller) {
      const emit = (text: string) => controller.enqueue(sseChunk(text));
      const finish = async (reply: string) => {
        let r = reply.trim();
        r = r.replace(/^(.{4,}?)\s*\1$/s, '$1').trim();
        if (!r) r = 'Something went wrong on my end. Try again.';
        await appendConversation(userId, 'assistant', r);
        emit(r);
        controller.enqueue(sseDone());
        controller.close();
      };

      const msgs: Groq.Chat.ChatCompletionMessageParam[] = [
        ...history.map((h: { role: 'user' | 'assistant'; content: string }) => ({ role: h.role, content: h.content })),
        { role: 'user', content: message },
      ];

      let response: Groq.Chat.ChatCompletion;
      try {
        response = await groq.chat.completions.create({
          model: 'qwen/qwen3.8-27b',
          messages: [{ role: 'system', content: buildSystemPrompt(memoryFacts) }, ...msgs],
          tools: TOOLS,
          tool_choice: 'auto',
          max_tokens: 400,
        });
      } catch (e) {
        console.error('Groq initial call failed:', (e as Error).message);
        await finish('Hit a snag — try again in a moment.');
        return;
      }

      let turns = 0;
      while (response.choices[0]?.finish_reason === 'tool_calls') {
        if (++turns > 5) {
          await finish('Took too many steps — try rephrasing.');
          return;
        }
        const toolCalls = response.choices[0].message.tool_calls ?? [];
        const toolResults: Groq.Chat.ChatCompletionMessageParam[] = [];
        const fastResults: string[] = [];

        for (const tc of toolCalls) {
          let result: string;
          try {
            result = await executeTool(tc.function.name, JSON.parse(tc.function.arguments), userId);
          } catch (e) {
            result = `Tool error: ${(e as Error).message}`;
          }
          toolResults.push({ role: 'tool', tool_call_id: tc.id, content: result });
          if (FAST_CONFIRM_TOOLS.has(tc.function.name)) fastResults.push(result);
        }

        // All fast-confirm — skip 2nd Groq call
        if (fastResults.length === toolCalls.length && fastResults.length > 0) {
          const reply = fastResults.join(' ');
          await appendConversation(userId, 'assistant', reply);
          emit(reply);
          controller.enqueue(sseDone());
          controller.close();
          return;
        }

        msgs.push({ role: 'assistant', content: response.choices[0].message.content ?? '', tool_calls: toolCalls });
        msgs.push(...toolResults);

        // Stream the post-tool response
        try {
          const groqStream = await groq.chat.completions.create({
            model: 'qwen/qwen3.8-27b',
            messages: [{ role: 'system', content: buildSystemPrompt(memoryFacts) }, ...msgs],
            tools: TOOLS,
            tool_choice: 'auto',
            max_tokens: 600,
            stream: true,
          });

          let fullReply = '';
          for await (const chunk of groqStream) {
            const text = chunk.choices[0]?.delta?.content ?? '';
            if (text) {
              fullReply += text;
              controller.enqueue(sseChunk(text));
            }
          }

          fullReply = fullReply.trim();
          fullReply = fullReply.replace(/^(.{4,}?)\s*\1$/s, '$1').trim();
          if (!fullReply) fullReply = 'Something went wrong on my end. Try again.';
          await appendConversation(userId, 'assistant', fullReply);
          controller.enqueue(sseDone());
          controller.close();
          return;
        } catch (e) {
          console.error('Groq stream (post-tool) failed:', (e as Error).message);
          await finish('Done, but had trouble composing the response. Try asking again.');
          return;
        }
      }

      // No tools: direct answer already in response
      const reply = response.choices[0]?.message?.content ?? '';
      await finish(reply);
    },
  });

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
