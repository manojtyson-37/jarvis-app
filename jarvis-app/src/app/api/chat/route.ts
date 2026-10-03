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
  getMeetingNotes, getPendingActionItems, completeActionItem,
  logTaskExecution,
} from '@/lib/supabase';
import { parseReminderTime } from '@/lib/timeparser';
import { getTicket, updateTicketStatus, addTicketNote } from '@/lib/freshdesk';
import { getQueryResults } from '@/lib/redash';
import { searchLogs } from '@/lib/coralogix';
import { listRecentEmails, getEmail, sendEmail } from '@/lib/gmail';

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
  {
    type: 'function',
    function: {
      name: 'get_meeting_notes',
      description: 'Get notes and summaries from recent meetings recorded by Fireflies. Use when asked about meetings, what was discussed, or what happened in a call.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Number of recent meetings to return (default 3)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_action_items',
      description: 'Get pending action items extracted from meetings and check-ins. Use when asked about to-dos, tasks, what needs to be done.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Max items to return (default 20)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'complete_action_item',
      description: 'Mark an action item as done by its ID.',
      parameters: {
        type: 'object',
        properties: {
          item_id: { type: 'string', description: 'The action item UUID' },
        },
        required: ['item_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_freshdesk_ticket',
      description: 'Look up a Freshdesk support ticket by its ID.',
      parameters: {
        type: 'object',
        properties: { ticket_id: { type: 'string', description: 'The Freshdesk ticket number' } },
        required: ['ticket_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_freshdesk_ticket',
      description: 'Update the status of a Freshdesk ticket.',
      parameters: {
        type: 'object',
        properties: {
          ticket_id: { type: 'string' },
          status: { type: 'string', description: 'One of: open, pending, resolved, closed' },
        },
        required: ['ticket_id', 'status'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_freshdesk_note',
      description: 'Add a private note to a Freshdesk ticket.',
      parameters: {
        type: 'object',
        properties: { ticket_id: { type: 'string' }, note: { type: 'string' } },
        required: ['ticket_id', 'note'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_redash_query',
      description: 'Run a saved Redash query by ID and return its latest cached results.',
      parameters: {
        type: 'object',
        properties: { query_id: { type: 'string', description: 'The Redash query ID' } },
        required: ['query_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_logs',
      description: 'Search application logs in Coralogix using a DataPrime or Lucene query.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'DataPrime query, e.g. "source logs | filter $d.severity == \'ERROR\'"' },
          hours: { type: 'number', description: 'How many hours back to search (default 1)' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_emails',
      description: "List recent emails from Manoj's jodopay Gmail inbox, optionally filtered by a Gmail search query.",
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Gmail search query, e.g. "is:unread", "from:someone@example.com". Default "is:unread".' },
          max_results: { type: 'number', description: 'Max emails to return (default 10)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_email',
      description: 'Get the full content of one email by its Gmail message ID (from list_emails results).',
      parameters: {
        type: 'object',
        properties: { message_id: { type: 'string', description: 'The Gmail message ID' } },
        required: ['message_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_email',
      description: "Send an email from Manoj's jodopay Gmail account.",
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Recipient email address' },
          subject: { type: 'string' },
          body: { type: 'string' },
        },
        required: ['to', 'subject', 'body'],
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

    case 'get_meeting_notes': {
      const meetings = await getMeetingNotes(userId, (args.limit as number) ?? 3);
      if (!meetings.length) return 'No meeting notes yet. Meetings will appear here once Fireflies processes them.';
      return meetings.map(m => {
        const d = new Date(m.meeting_date).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'short', timeStyle: 'short' });
        const dur = m.duration_sec ? ` (${Math.round(m.duration_sec / 60)} min)` : '';
        const parts = m.participants?.length ? `\nAttendees: ${m.participants.join(', ')}` : '';
        return `**${m.title}** — ${d}${dur}${parts}\n${m.summary ?? '(no summary)'}`;
      }).join('\n\n');
    }

    case 'get_action_items': {
      const items = await getPendingActionItems(userId, (args.limit as number) ?? 20);
      if (!items.length) return 'No pending action items.';
      return items.map(i => {
        const d = new Date(i.created_at).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });
        const src = i.source === 'meeting' ? '📋' : i.source === 'checkin' ? '✅' : '📝';
        return `${src} [${i.id.slice(0, 8)}] ${i.text} (${d})`;
      }).join('\n');
    }

    case 'complete_action_item': {
      const found = await completeActionItem(userId, args.item_id as string);
      return found ? 'Action item marked done.' : 'No matching action item found.';
    }

    case 'get_freshdesk_ticket':
      return getTicket(args.ticket_id as string);

    case 'update_freshdesk_ticket': {
      const result = await updateTicketStatus(args.ticket_id as string, args.status as string);
      if (result.ok) {
        await logTaskExecution(userId, 'freshdesk', result.message, { ticket_id: args.ticket_id, status: args.status });
      }
      return result.message;
    }

    case 'add_freshdesk_note': {
      const result = await addTicketNote(args.ticket_id as string, args.note as string);
      if (result.ok) {
        await logTaskExecution(userId, 'freshdesk', result.message, { ticket_id: args.ticket_id, note: args.note });
      }
      return result.message;
    }

    case 'run_redash_query':
      return getQueryResults(args.query_id as string);

    case 'search_logs': {
      const hours = Math.min(Math.max((args.hours as number) ?? 1, 1), 168);
      return searchLogs(args.query as string, hours);
    }

    case 'list_emails':
      return listRecentEmails((args.query as string) ?? 'is:unread', (args.max_results as number) ?? 10);

    case 'get_email':
      return getEmail(args.message_id as string);

    case 'send_email': {
      const result = await sendEmail(args.to as string, args.subject as string, args.body as string);
      if (result.ok) {
        await logTaskExecution(userId, 'email', result.message, { to: args.to, subject: args.subject });
      }
      return result.message;
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
  'complete_action_item', 'update_freshdesk_ticket', 'add_freshdesk_note',
  // send_email deliberately excluded: an irreversible, third-party-visible action that
  // shouldn't skip the narration pass the way internal writes do.
]);

export async function POST(req: NextRequest) {
  const { message } = await req.json();
  const userId = 'manoj';

  if (!message?.trim()) return NextResponse.json({ error: 'Empty message' }, { status: 400 });

  // The model has shown it will sometimes skip calling get_freshdesk_ticket entirely and
  // fabricate a plausible-looking but completely wrong answer (confirmed: finish_reason 'stop'
  // with no tool_calls, inventing a customer name/email/ticket content) instead of admitting
  // uncertainty. Rather than bypassing the LLM entirely (which would drop any other intent in
  // the same message and override cases where the user wasn't actually asking for a lookup),
  // force tool_choice to that specific function when a ticket number is mentioned — the model
  // still composes the actual reply and can address the rest of the message, but now always
  // has real ticket data in context instead of a choice to skip the lookup. Forcing the call is
  // safe even for a false-positive match ("I already handled ticket 598317") since it's a
  // read-only lookup, not a side-effecting action.
  // Accepted residual risk: Gmail reads (list_emails/get_email) have no equivalent forced-route
  // here — there's no clean deterministic pattern analogous to a ticket number for "check my
  // inbox" style requests. They rely on the anti-fabrication system prompt rule alone, which
  // was already shown insufficient on its own for the Freshdesk case before this forced-choice
  // fix existed. Revisit if the same skip-and-fabricate failure is observed for Gmail.
  const ticketMatch = /\bticket\s*#?\s*(\d{4,})\b/i.exec(message);
  const forcedToolChoice = ticketMatch
    ? { type: 'function' as const, function: { name: 'get_freshdesk_ticket' } }
    : 'auto' as const;

  const [history, memoryFacts] = await Promise.all([
    getConversationHistory(userId, 10),
    getMemoryFacts(userId, 20),
  ]);
  await appendConversation(userId, 'user', message);

  const encoder = new TextEncoder();
  const sseChunk = (text: string) => encoder.encode(`data: ${JSON.stringify({ chunk: text })}\n\n`);
  const sseDone = () => encoder.encode('data: [DONE]\n\n');

  const readable = new ReadableStream({
    start(controller) {
      const emit = (text: string) => controller.enqueue(sseChunk(text));
      const close = () => { controller.enqueue(sseDone()); controller.close(); };

      const finish = async (reply: string) => {
        let r = reply.trim();
        r = r.replace(/^(.{4,}?)\s*\1$/s, '$1').trim();
        if (!r) r = 'Something went wrong on my end. Try again.';
        await appendConversation(userId, 'assistant', r).catch(() => {});
        emit(r);
        close();
      };

      // Top-level net: any unhandled throw settles the controller so the stream is never leaked
      (async () => {
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
            tool_choice: forcedToolChoice,
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
            await appendConversation(userId, 'assistant', reply).catch(() => {});
            emit(reply);
            close();
            return;
          }

          msgs.push({ role: 'assistant', content: response.choices[0].message.content ?? '', tool_calls: toolCalls });
          msgs.push(...toolResults);

          // Stream the post-tool response.
          // tool_choice:'none' errors on qwen — keep 'auto' and only collect content deltas;
          // if model returns tool_calls (rare), chunksEmitted stays 0 and finish() emits fallback.
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
            let chunksEmitted = 0;
            for await (const chunk of groqStream) {
              const text = chunk.choices[0]?.delta?.content ?? '';
              if (text) {
                fullReply += text;
                controller.enqueue(sseChunk(text));
                chunksEmitted++;
              }
            }

            fullReply = fullReply.trim();
            fullReply = fullReply.replace(/^(.{4,}?)\s*\1$/s, '$1').trim();
            if (!fullReply) fullReply = 'Something went wrong on my end. Try again.';
            await appendConversation(userId, 'assistant', fullReply).catch(() => {});
            if (chunksEmitted === 0) emit(fullReply); // nothing streamed yet, emit now
            close();
            return;
          } catch (e) {
            console.error('Groq stream (post-tool) failed:', (e as Error).message);
            const errMsg = 'Done, but had trouble composing the response. Try asking again.';
            await appendConversation(userId, 'assistant', errMsg).catch(() => {});
            emit(errMsg);
            close();
            return;
          }
        }

        // No tools: direct answer already in response
        const reply = response.choices[0]?.message?.content ?? '';
        await finish(reply);
      })().catch(e => {
        console.error('ReadableStream start() unhandled:', (e as Error).message);
        try { controller.error(e); } catch { /* already closed */ }
      });
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
