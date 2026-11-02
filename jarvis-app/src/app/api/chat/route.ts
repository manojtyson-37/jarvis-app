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
} from '@/lib/supabase';
import { parseReminderTime } from '@/lib/timeparser';
import { getTicket, updateTicketStatus, addTicketNote, getLatestTicketInGroups, getOpenTicketCountForAgent, getAgentNameTokens, AGENT_DISAMBIGUATION_PREFIX } from '@/lib/freshdesk';
import { getQueryResults, listQueries } from '@/lib/redash';
import { searchLogs } from '@/lib/coralogix';
import { listRecentEmails, getEmail, listLabels } from '@/lib/gmail';
import { searchDrive, readDriveFile } from '@/lib/drive';
import { historyForModel, gmailLookupIntent } from '@/lib/chatContext';
import { selectTools } from '@/lib/toolRouting';
import { analysisIntent, GROUNDABLE, GROUNDED_SYSTEM, groundedUser, needsLookIds, driveReadableIds } from '@/lib/grounded';
import { GATED_TOOLS, queueAction } from '@/lib/actions';
import { getGoogleAccessToken } from '@/lib/google';

// Retries are handled here, not in the SDK: a daily-quota 429 carries a wait of many minutes, so the SDK would burn
// seconds of backoff before we ever reached the fallback.
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY, maxRetries: 0 });

// Free-tier Groq caps each model at 200k tokens/day (and 8k/minute). A short per-minute limit is waited out once;
// a daily limit goes straight to a second model with its own quota so Maya keeps answering.
const PRIMARY_MODEL = 'qwen/qwen3.8-27b';
const FALLBACK_MODEL = 'openai/gpt-oss-120b';
const MAX_WAIT_MS = 12000;

// Groq words the wait as e.g. "7m12.5s", "3.2s" or "250ms".
function retryWaitMs(e: unknown): number | null {
  const m = /try again in (?:(\d+)m(?!s))?(?:([\d.]+)(ms|s))?/i.exec((e as Error).message ?? '');
  if (!m || (!m[1] && !m[2])) return null;
  const secs = m[2] ? (m[3].toLowerCase() === 'ms' ? Number(m[2]) / 1000 : Number(m[2])) : 0;
  return (Number(m[1] ?? 0) * 60 + secs) * 1000;
}

// Waits stack across the several model calls of one turn, so a turn that has already run long skips the wait.
const WAIT_BUDGET_MS = 25000;

async function withFallback<T>(call: (model: string) => Promise<T>, startedAt: number): Promise<T> {
  try {
    return await call(PRIMARY_MODEL);
  } catch (e) {
    if ((e as { status?: number }).status !== 429) throw e;
    const wait = retryWaitMs(e);
    if (wait !== null && wait <= MAX_WAIT_MS && Date.now() - startedAt < WAIT_BUDGET_MS) {
      await new Promise(r => setTimeout(r, wait + 250));
      try { return await call(PRIMARY_MODEL); } catch (e2) { if ((e2 as { status?: number }).status !== 429) throw e2; }
    }
    console.warn('primary model rate limited, using fallback model');
    return call(FALLBACK_MODEL);
  }
}
// The fallback is a reasoning model: keep its thinking short so the answer fits the token budget.
const fallbackOpts = (model: string) => (model === PRIMARY_MODEL ? {} : { reasoning_effort: 'low' as const });

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
      name: 'get_latest_ticket',
      description: "Get the full details of the single most recently raised Freshdesk ticket, scoped to Manoj's 3 groups (Engineering, ERP Integration, Tech Operation) — use for 'latest ticket' type questions.",
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_agent_ticket_count',
      description: "Count how many open Freshdesk tickets are assigned to a specific agent — use for 'how many tickets in X's bucket/queue' type questions.",
      parameters: {
        type: 'object',
        properties: { agent_name: { type: 'string', description: "The agent's name, e.g. \"Sahil Parihar\"" } },
        required: ['agent_name'],
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
      name: 'list_redash_queries',
      description: "List or search Manoj's saved Redash queries by name — use when he doesn't know a specific query ID (e.g. 'what Redash queries do I have', 'find the payments query').",
      parameters: {
        type: 'object',
        properties: { search: { type: 'string', description: 'Optional search term to filter by name; omit to list recent queries' } },
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
      description: "List recent emails from Manoj's Gmail inbox, optionally filtered by a Gmail search query.",
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
      description: "Send an email from Manoj's Gmail account.",
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
  {
    type: 'function',
    function: {
      name: 'list_labels',
      description: "List Manoj's custom Gmail labels (folders/tags he uses to organize his inbox).",
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_drive',
      description: "Search Manoj's Google Drive by file name or content. Read-only. Returns name, type, modified date and file ID.",
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Plain text to search for in file names and contents' },
          max_results: { type: 'number', description: 'Max files to return (default 10)' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_drive_file',
      description: 'Read the text of one Drive file (Google Docs, Slides, text/CSV/JSON files; a Google Sheet returns only its first sheet) by its file ID from search_drive results. Cannot read PDFs or images. Read-only.',
      parameters: {
        type: 'object',
        properties: { file_id: { type: 'string', description: 'The Drive file ID' } },
        required: ['file_id'],
      },
    },
  },
];

async function executeTool(name: string, args: Record<string, unknown>, userId: string): Promise<string> {
  // Tiered approval: outward-facing/irreversible tools never run here — they are queued and
  // only the session-gated /api/actions/[id] endpoint can execute them.
  if (GATED_TOOLS.has(name)) return queueAction(userId, name, args);
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

    case 'get_latest_ticket':
      return getLatestTicketInGroups();

    case 'get_agent_ticket_count':
      return getOpenTicketCountForAgent(args.agent_name as string);

    case 'run_redash_query':
      return getQueryResults(args.query_id as string);

    case 'list_redash_queries':
      return listQueries(args.search as string | undefined);

    case 'search_logs': {
      const hours = Math.min(Math.max((args.hours as number) ?? 1, 1), 168);
      return searchLogs(args.query as string, hours);
    }

    case 'list_emails':
      return listRecentEmails((args.query as string) ?? 'is:unread', (args.max_results as number) ?? 10);

    case 'get_email':
      return getEmail(args.message_id as string);

    case 'list_labels':
      return listLabels();

    case 'search_drive':
      return searchDrive(String(args.query ?? ''), Number(args.max_results) || 10);

    case 'read_drive_file':
      return readDriveFile(String(args.file_id ?? ''));

    default:
      return `Unknown tool: ${name}`;
  }
}

// Vercel's default would otherwise cut a long tool-plus-summary turn off with no message.
export const maxDuration = 60;

export async function GET() {
  const history = await getConversationHistory('manoj', 40);
  return NextResponse.json({ history });
}

// Tools whose result skips the 2nd (narration) Groq call and gets returned raw instead.
// Two distinct reasons a tool lands here:
//  (a) write/confirm actions — a narrated "I did X" adds nothing over the raw confirmation.
//  (b) high-risk factual lookups — confirmed (Freshdesk ticket, Gmail inbox) that the narration
//      pass will sometimes disregard the real tool result already in context and fabricate a
//      different, wrong, plausible-sounding answer instead. Forcing tool_choice on the FIRST
//      call only guarantees the tool gets called; it does nothing to stop the SECOND call from
//      ignoring that real result, since that pass still runs with tool_choice:'auto'. Skipping
//      it entirely for these tools removes the fabrication opportunity structurally rather than
//      relying on a prompt instruction the model has already shown it won't reliably follow.
// send_email and the other gated tools ARE here now: they only queue an approval request, so the
// raw "Waiting for your approval: ..." text must reach the user verbatim — a narration pass could
// wrongly claim the action already happened.
// KNOWN GAP, not closed by this set: a turn where the model calls one of these tools ALONGSIDE
// a tool NOT in this set (e.g. get_freshdesk_ticket + get_calendar_events together) falls through
// to the normal narration path below with tool_choice:'auto' — the exact same unresolved
// fabrication risk this set exists to avoid, just for a mixed-tool turn instead of a single-tool
// one. This is unchanged risk, not reduced risk, for any multi-tool-type turn.
const SKIP_NARRATION_TOOLS = new Set([
  'save_note', 'delete_note', 'set_reminder', 'mark_reminder_done',
  'log_workout', 'log_expense', 'log_income', 'delete_calendar_event',
  'complete_action_item', 'update_freshdesk_ticket', 'add_freshdesk_note', 'send_email', 'create_calendar_event',
  'get_freshdesk_ticket', 'get_latest_ticket', 'get_agent_ticket_count', 'list_emails', 'get_email', 'list_labels',
  'run_redash_query', 'list_redash_queries', 'search_drive', 'read_drive_file',
]);

const ACTIONISH = /\b(send|add|remind|log|save|delete|cancel|set|create|schedule|book|mark|find|search|read|summari[sz]e|move|reschedule|forward|open|list)\b/i;

export async function POST(req: NextRequest) {
  const startedAt = Date.now();
  const wf = <T,>(call: (model: string) => Promise<T>) => withFallback(call, startedAt);
  const { message } = await req.json();
  // Test isolation: outside production only, an eval run can act as its own throwaway user so it never
  // touches Manoj's real notes, reminders or chat history. Deployed builds always run with NODE_ENV=production.
  const evalHeader = process.env.NODE_ENV !== 'production' ? req.headers.get('x-maya-eval-user') : null;
  const evalUser = evalHeader && /^cso-eval-[a-z0-9-]{1,48}$/.test(evalHeader) ? evalHeader : null;
  const userId = evalUser ?? 'manoj';

  if (!message?.trim()) return NextResponse.json({ error: 'Empty message' }, { status: 400 });

  // History is fetched first (not in parallel with the rest) because deciding whether to
  // fetch agentNameTokens below depends on it — see awaitingAgentDisambiguation.
  const history = await getConversationHistory(userId, 10);
  const lastAssistantMsg = history.length ? history[history.length - 1] : null;
  const awaitingAgentDisambiguationPrompt = lastAssistantMsg?.role === 'assistant'
    && lastAssistantMsg.content.startsWith(AGENT_DISAMBIGUATION_PREFIX);
  // The agent list is only fetched when the message could plausibly need it — either it
  // might be ticket-related at all, or the prior turn asked "which agent did you mean?" and
  // this message could be answering that — otherwise every casual message (most of them)
  // would pay for an unnecessary Freshdesk API call just to build a list it'll never use.
  const mightBeTicketQuestion = /\bticket(s)?\b|\bbucket\b|\bqueue\b/i.test(message);
  const [memoryFacts, agentNameTokens] = await Promise.all([
    getMemoryFacts(userId, 20),
    (mightBeTicketQuestion || awaitingAgentDisambiguationPrompt) ? getAgentNameTokens() : Promise.resolve([] as string[]),
  ]);

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
  // Confirmed: the exact same skip-and-fabricate failure happens for Gmail too (model invented
  // a detailed fake inbox — specific senders, subjects — when the real unread count was 0).
  // Tried forcing generic tool_choice:'required' first — rejected on review: 'required' isn't
  // scoped to the 3 Gmail functions, it just forces *some* tool from the full ~20-tool list, so
  // an over-broad keyword match could silently force-execute an unrelated write (e.g. save_note)
  // with no narration pass left to catch the mismatch. Force the specific list_emails function
  // instead, matching the ticket pattern, and narrow the trigger to inbox-check phrasing (not
  // bare "email" — that would wrongly also fire on "what's my email address").
  const ticketMatch = /\bticket\s*#?\s*(\d{4,})\b/i.exec(message);
  // "latest ticket raised" / "any new tickets" — a recency question, distinct from a
  // specific-ID lookup (ticketMatch always wins when a real number is present). Routes to
  // get_latest_ticket, which returns full detail on the single newest ticket across Manoj's
  // 3 groups (Engineering / ERP Integration / Tech Operation) — there is no separate
  // "list all my tickets" tool, so any ticket-recency phrasing resolves to this.
  // Requires a recency/support word co-occurring with "ticket(s)" (same AND-shape as the
  // other forced-tool regexes below) — a bare "tickets" alone would also force this on
  // "I need two tickets for the concert", an unrelated message with no Freshdesk intent.
  const ticketListMatch = !ticketMatch && /\b(latest|recent|newest|last|new|open|any|support|freshdesk|raised)\b.{0,20}\bticket(s)?\b|\bticket(s)?\b.{0,20}\b(latest|recent|newest|raised|support|freshdesk)\b/i.test(message);
  // "how many tickets in X's bucket/queue" — a per-agent count, distinct from both the
  // specific-ID lookup and the single-latest-ticket lookup above. Checked before
  // ticketListMatch's broader "open"+"ticket" pattern so a count question doesn't get
  // misrouted to get_latest_ticket (both would otherwise match "tickets are open").
  // Five review rounds caught real bugs here. Round 1: a bare "how many"+"ticket"
  // co-occurrence (no name requirement) matched general questions like "how many tickets
  // are open right now?", hijacking them with nothing to fill the required agent_name param.
  // Round 2: the round-1 fix (bare two-capitalized-word pattern near "ticket") swung too far
  // the other way — matched unrelated messages like "I need two tickets for the Ed Sheeran
  // concert", and separately still missed "how many tickets does Priya have?" (single first
  // name). Round 3's attempted fix (any capitalized word, not just two in a row) swung back
  // too far again — ordinary capitalized words (place names, weekdays, months, team/product
  // names: "tickets open in Mumbai?", "tickets in Engineering?") are common enough in real
  // ticket-count questions that "any capitalized word" isn't a usable proxy for "names a real
  // agent" at all. Round 4 switched to checking against the REAL agent list (agentNameTokens)
  // instead of guessing from capitalization, but two bugs remained: a left-boundary-only regex
  // match (needed to catch "Parihars" with no apostrophe) let ordinary words PREFIX-collide
  // ("Nairobi" matching surname token "Nair", "Josephine" matching "Jose"); and the bucket/queue
  // alternative below had no name requirement at all ("how many tickets are in the queue?"
  // forced the tool with nothing to fill agent_name). Round 5 fixed both by extracting one
  // shared, trailing-boundary-safe name-match helper (agentNameMentioned) and requiring it on
  // EVERY branch, including bucket/queue and the disambiguation-reply check further down —
  // the earlier version of the disambiguation check used a naive .includes() substring test
  // instead of this helper, which reintroduced the exact same prefix-collision class through a
  // different path ("I love balsamic vinegar" matching token "Sam" from an agent's name).
  // `(?:'s|s)?` allows the possessive-without-apostrophe case this was built for ("Parihars")
  // while still requiring a real word-break or bare "s" after the name, so "Nair" no longer
  // matches inside "Nairobi". A real agent whose surname IS an ordinary English word (e.g. an
  // agent actually named "... Watts") remains a known, accepted residual risk no regex can
  // close — see the comment on GENERIC_AGENT_WORDS.
  const agentNameMentioned = (text: string) => agentNameTokens.some(name =>
    new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:'s|s)?\\b`, 'i').test(text)
  );
  const agentCountMatch = !ticketMatch && agentNameMentioned(message) && (
    /\bticket(s)?\b.{0,40}\b(bucket|queue)\b|\b(bucket|queue)\b.{0,40}\bticket(s)?\b/i.test(message)
    || (
      /\bticket(s)?\b/i.test(message)
      && /\b(how many|number of|count of|assigned to)\b/i.test(message)
    )
  );
  // A Gmail message ID is a long hex string — check for one BEFORE the general inbox-check
  // match below, so "show me email <id>" routes to get_email rather than getting swept into
  // the broader "show...email" inbox-check pattern and incorrectly forced to list_emails.
  const emailIdMatch = /\b(?=[0-9a-f]*[a-f])[0-9a-f]{10,}\b/i.test(message);
  // Scoped to email/Gmail context, not bare "label" — otherwise "what label would you give
  // this idea" or "add a label to this note" would wrongly force a Gmail tool call too.
  const labelMatch = /\blabels?\b.{0,20}\b(email|gmail|inbox)\b|\b(email|gmail|inbox)\b.{0,20}\blabels?\b/i.test(message);
  // "gmail" (without send/draft/reply/redash intent) forces the read-only lookup: "I connected my gmail account" matched
  // nothing, so the model answered from stale chat history (old Jodo lists) instead of checking the inbox.
  // An explicit "send an email to X" must reach send_email (which only QUEUES it for approval). Left on 'auto',
  // the model sometimes skipped the tool and answered as if the email had been handled. "draft" is excluded on
  // purpose: there is no draft tool, and a draft request must never queue a send.
  const sendMailMatch = !emailIdMatch && !labelMatch
    && (/\b(send|shoot|fire off)\s+(?:an?\s+|the\s+)?(?:e-?mail|mail)\b.{0,80}(?:\bto\b|@)/i.test(message) || /\b(?:e-?mail|mail)\s+[\w.+-]+@[\w-]+\.\w+/i.test(message))
    && !/\b(draft|compose|write|unread|inbox)\b|\bsend me\b|\b(don'?t|do not|never|not)\b/i.test(message);
  const inboxCheckMatch = !emailIdMatch && !labelMatch
    && (/\b(unread|inbox)\b|\b(check|show|read|any|list)\b.{0,20}\b(emails?|mail)\b/i.test(message) || gmailLookupIntent(message));
  // "redash" is distinctive enough on its own (unlike "ticket") that it doesn't need the
  // AND-of-two-signals treatment the email/ticket regexes above do — no unrelated casual
  // message plausibly contains it. A nearby number means a specific known query ID
  // (run_redash_query); otherwise it's a browse/search request (list_redash_queries), since
  // run_redash_query was never given its own forced-tool-choice trigger before this and was
  // exposed to the same skip-and-fabricate risk get_freshdesk_ticket had prior to its fix.
  // Review caught that a bare "any 2+ digit number anywhere in the message" was too broad —
  // "redash query about 2024 revenue" and "find the query for Q3 2024 churn" both have no
  // actual known ID, just an unrelated year, and both wrongly routed to run_redash_query
  // instead of the search tool. Requires the number to sit immediately after "redash" or
  // "query" (optionally "id"/"#"/":" in between, nothing else) — a real ID reference like
  // "query 1234", "redash #1234", "query id 1234" still matches; a descriptive mention with
  // other words between the keyword and the number does not.
  const redashMentioned = /\bredash\b/i.test(message);
  const redashIdMatch = redashMentioned && /\b(?:redash|query)\b\s*(?:id\s*)?#?\s*:?\s*\d+\b/i.test(message);
  // If the previous assistant turn was get_agent_ticket_count's own "which one?" ambiguity
  // prompt, the user's reply (e.g. "Manoj R") won't match any regex above — falling through
  // to tool_choice:'auto' would hit the exact skip-and-fabricate failure mode this whole
  // forced-tool-choice architecture exists to avoid. Checked LAST, only as a fallback when
  // nothing else matched — review caught an earlier version of this that was OR'd in at the
  // TOP of the chain, which meant any unrelated follow-up message (a new ticket number, an
  // inbox check) got wrongly re-forced into this tool instead of its own correct one for a
  // full turn after any ambiguity prompt. Also requires the reply to actually name one of the
  // real agents the prompt offered — review caught that without this, a totally unrelated
  // reply ("never mind, what's the weather") still got force-routed here just because it
  // happened to follow the ambiguity prompt, with nothing to fill agent_name. A later review
  // round caught that the first fix for this used a naive .includes() substring check instead
  // of the same word-boundary-safe agentNameMentioned() helper used above — reopening the
  // identical prefix-collision bug through a different path ("I love balsamic vinegar"
  // matching token "Sam" from an unrelated agent's name). Reuses the shared helper instead.
  const awaitingAgentDisambiguation = awaitingAgentDisambiguationPrompt && agentNameMentioned(message);
  const forcedToolChoice = ticketMatch
    ? { type: 'function' as const, function: { name: 'get_freshdesk_ticket' } }
    : agentCountMatch
    ? { type: 'function' as const, function: { name: 'get_agent_ticket_count' } }
    : ticketListMatch
    ? { type: 'function' as const, function: { name: 'get_latest_ticket' } }
    : emailIdMatch
      ? { type: 'function' as const, function: { name: 'get_email' } }
      : labelMatch
        ? { type: 'function' as const, function: { name: 'list_labels' } }
        : sendMailMatch
          ? { type: 'function' as const, function: { name: 'send_email' } }
          : inboxCheckMatch
          ? { type: 'function' as const, function: { name: 'list_emails' } }
          : redashIdMatch
            ? { type: 'function' as const, function: { name: 'run_redash_query' } }
            : redashMentioned
              ? { type: 'function' as const, function: { name: 'list_redash_queries' } }
              : awaitingAgentDisambiguation
                ? { type: 'function' as const, function: { name: 'get_agent_ticket_count' } }
                : 'auto' as const;

  // Only the tool definitions this message can need — see toolRouting.ts for why.
  const forcedName = typeof forcedToolChoice === 'object' ? forcedToolChoice.function.name : undefined;
  const recent = history.slice(-4).map(h => h.content.slice(0, 300));
  const turnTools = selectTools(TOOLS, message, recent, forcedName);

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
          ...historyForModel(history),
          { role: 'user', content: message },
        ];

        let response: Groq.Chat.ChatCompletion;
        try {
          response = await wf(model => groq.chat.completions.create({
            ...fallbackOpts(model),
            model,
            messages: [{ role: 'system', content: buildSystemPrompt(memoryFacts) }, ...msgs],
            tools: turnTools,
            tool_choice: forcedToolChoice,
            max_tokens: model === PRIMARY_MODEL ? 400 : 700, // the fallback spends some tokens reasoning first
          }));
        } catch (e) {
          console.error('Groq initial call failed:', (e as Error).message);
          await finish((e as { status?: number }).status === 429
            ? "I'm at my rate limit for the moment. Ask again in about a minute."
            : 'Hit a snag — try again in a moment.');
          return;
        }

        // Last resort for a routing miss: the model answered an action-sounding message without calling any tool
        // while it only had a subset of tools. Retry once with the full set before accepting a tool-less answer.
        if (response.choices[0]?.finish_reason !== 'tool_calls' && turnTools.length < TOOLS.length && ACTIONISH.test(message)) {
          try {
            response = await wf(model => groq.chat.completions.create({
              ...fallbackOpts(model),
              model,
              messages: [{ role: 'system', content: buildSystemPrompt(memoryFacts) }, ...msgs],
              tools: TOOLS,
              tool_choice: 'auto',
              max_tokens: model === PRIMARY_MODEL ? 400 : 700,
            }));
          } catch { /* keep the first answer */ }
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
          const queuedNotes: string[] = []; // gated-tool queue text, appended verbatim in mixed turns

          for (const tc of toolCalls) {
            let result: string;
            // Progress event so the UI can show "Checking Gmail…". Unknown keys are ignored by older clients.
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ tool: tc.function.name, phase: 'start' })}\n\n`));
            try {
              const targs = JSON.parse(tc.function.arguments) as Record<string, unknown>;
              // The model sometimes truncates an id it was handed ("1a10115c…" became "1a"). An id the user
              // typed is authoritative, so use it verbatim.
              if (tc.function.name === 'get_email' && toolCalls.filter(t => t.function.name === 'get_email').length === 1) {
                const typed = /\b(?=[0-9a-f]*[a-f])[0-9a-f]{10,}\b/i.exec(message)?.[0];
                if (typed && targs.message_id !== typed) targs.message_id = typed;
              }
              result = await executeTool(tc.function.name, targs, userId);
            } catch (e) {
              result = `Tool error: ${(e as Error).message}`;
            }
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({
              tool: tc.function.name, phase: 'end', ok: !result.startsWith('Tool error'),
              // Arguments and a result excerpt are exposed to eval runs only.
              ...(evalUser ? { args: tc.function.arguments, result: result.slice(0, 700) } : {}),
            })}\n\n`));
            toolResults.push({ role: 'tool', tool_call_id: tc.id, content: result });
            if (GATED_TOOLS.has(tc.function.name)) queuedNotes.push(result);
            if (SKIP_NARRATION_TOOLS.has(tc.function.name)) fastResults.push(result);
          }

          // "Summarise / read through / prioritise" over read-only tool data: answer from the data alone.
          if (analysisIntent(message) && toolCalls.length > 0 && toolCalls.every(tc => GROUNDABLE.has(tc.function.name)) && !toolResults.some(t => String(t.content).startsWith('Tool error'))) {
            try {
              // Each section has its own cap so appended bodies / file text are never silently cut off.
              const listed = toolResults.map(t => String(t.content)).join('\n\n');
              let data = listed.slice(0, 2500);
              // An email summary is thin on snippets alone: add the bodies of the few worth a look.
              if (toolCalls.some(tc => tc.function.name === 'list_emails')) {
                const bodies = await Promise.all(needsLookIds(listed).map(id => getEmail(id).catch(() => '')));
                data += bodies.filter(Boolean).map(b => `\n\n--- email body ---\n${b.slice(0, 900)}`).join('');
              }
              // Likewise for Drive: a summary needs the file text, not just names.
              if (toolCalls.some(tc => tc.function.name === 'search_drive')) {
                const files = await Promise.all(driveReadableIds(listed).map(id => readDriveFile(id).catch(() => '')));
                data += files.filter(Boolean).map(f => `\n\n--- file text ---\n${f.slice(0, 1500)}`).join('');
              }
              const g = await wf(model => groq.chat.completions.create({
                ...fallbackOpts(model),
                model,
                messages: [{ role: 'system', content: GROUNDED_SYSTEM }, { role: 'user', content: groundedUser(message, data) }],
                temperature: 0.2,
                max_tokens: model === PRIMARY_MODEL ? 450 : 800,
              }));
              const summary = (g.choices[0]?.message?.content ?? '').trim();
              if (summary) {
                await appendConversation(userId, 'assistant', summary).catch(() => {});
                emit(summary);
                close();
                return;
              }
            } catch (e) {
              console.error('grounded summary failed, falling back to raw:', (e as Error).message);
            }
          }

          // All fast-confirm — skip 2nd Groq call
          if (fastResults.length === toolCalls.length && fastResults.length > 0) {
            // '\n\n' not ' ' — several entries in this set (ticket/email lookups) are multi-line
            // formatted blocks, not one-line confirmations; joining with a space would mash them together.
            const reply = fastResults.join('\n\n');
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
            const groqStream = await wf(model => groq.chat.completions.create({
              ...fallbackOpts(model),
              model,
              messages: [{ role: 'system', content: buildSystemPrompt(memoryFacts) }, ...msgs],
              tools: turnTools,
              tool_choice: 'auto',
              max_tokens: model === PRIMARY_MODEL ? 600 : 900,
              stream: true,
            }));

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
            // The narration pass can wrongly say a queued action already happened — state the real status.
            if (queuedNotes.length) {
              const tail = `\n\n${queuedNotes.join('\n')}`;
              fullReply += tail;
              controller.enqueue(sseChunk(tail));
              chunksEmitted++;
            }
            if (!fullReply) fullReply = 'Something went wrong on my end. Try again.';
            await appendConversation(userId, 'assistant', fullReply).catch(() => {});
            if (chunksEmitted === 0) emit(fullReply); // nothing streamed yet, emit now
            close();
            return;
          } catch (e) {
            console.error('Groq stream (post-tool) failed:', (e as Error).message);
            const errMsg = queuedNotes.length
              ? `Queued, not done yet. ${queuedNotes.join('\n')}`
              : 'Done, but had trouble composing the response. Try asking again.';
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
