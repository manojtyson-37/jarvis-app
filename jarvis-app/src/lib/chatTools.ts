// Maya's tool layer: model client with fallback, tool definitions and the tool executor.
// Shared by the chat route and the to-do runner, so both run exactly the same tools and the same approval gate.
import Groq from 'groq-sdk';
import {
  saveNote, searchNotes, getRecentNotes, deleteNote,
  saveReminder, listReminders, markReminderDone,
  logWorkout, getRecentWorkouts,
  logFinance, getFinanceSummary,
  getMeetingNotes, getPendingActionItems, completeActionItem,
} from '@/lib/supabase';
import { parseReminderTime } from '@/lib/timeparser';
import { listRecentEmails, getEmail, listLabels } from '@/lib/gmail';
import { searchDrive, readDriveFile } from '@/lib/drive';
import { GATED_TOOLS, queueAction } from '@/lib/actions';
import { JOB_TOOLS, JOB_TOOL_NAMES, runJobTool } from '@/lib/jobs/tools';
import { getGoogleAccessToken } from '@/lib/google';
import { insertTodos } from '@/lib/todos/store';
import { ACTIVITY_TOOLS, ACTIVITY_TOOL_NAMES, runActivityTool } from '@/lib/activity/tools';
import { CONVERSATION_TOOLS, CONVERSATION_TOOL_NAMES, runConversationTool } from '@/lib/conversations/tools';
import { TASK_TOOLS, TASK_TOOL_NAMES, runTaskTool } from '@/lib/tasks/tools';
import { PIPELINE_TOOLS, PIPELINE_TOOL_NAMES, runPipelineTool } from '@/lib/pipeline/tools';
import { isToolUseFailed } from '@/lib/groqErrors';
import { llm } from '@/lib/llm';
import { parseSlotArgs, freeSlots, formatSlots, busyFromEvents, type CalItem } from '@/lib/agent/slots';

// Retries are handled here, not in the SDK: a daily-quota 429 carries a wait of many minutes, so the SDK would burn
// seconds of backoff before we ever reached the fallback.
// Claude via src/lib/llm.ts (chat-completions shape). Kept under the old name so every caller stays unchanged.
export const groq = llm;

// Free-tier Groq caps each model at 200k tokens/day (and 8k/minute). A short per-minute limit is waited out once;
// a daily limit goes straight to a second model with its own quota so Maya keeps answering.
export const PRIMARY_MODEL = 'claude-haiku-5-5';
export const FALLBACK_MODEL = 'claude-sonnet-5-5';
const MAX_WAIT_MS = 12000;

// Groq words the wait as e.g. "7m12.5s", "3.2s" or "250ms".
function retryWaitMs(e: unknown): number | null {
  // Anthropic sends the wait as a retry-after header (seconds).
  const h = (e as { headers?: { get?: (k: string) => string | null } & Record<string, unknown> }).headers;
  const ra = h ? (typeof h.get === 'function' ? h.get('retry-after') : (h['retry-after'] as string | undefined)) : null;
  if (ra != null && ra !== '' && !Number.isNaN(Number(ra))) return Number(ra) * 1000;
  const m = /try again in (?:(\d+)m(?!s))?(?:([\d.]+)(ms|s))?/i.exec((e as Error).message ?? '');
  if (!m || (!m[1] && !m[2])) return null;
  const secs = m[2] ? (m[3].toLowerCase() === 'ms' ? Number(m[2]) / 1000 : Number(m[2])) : 0;
  return (Number(m[1] ?? 0) * 60 + secs) * 1000;
}

// Waits stack across the several model calls of one turn, so a turn that has already run long skips the wait.
const WAIT_BUDGET_MS = 25000;

// No status means the request never got a response (connection error, timeout); 5xx means Groq itself is failing.
const isUnavailable = (status?: number) => status === undefined || (status >= 500 && status < 600);

export async function withFallback<T>(call: (model: string) => Promise<T>, startedAt: number): Promise<T> {
  try {
    return await call(PRIMARY_MODEL);
  } catch (e) {
    // The primary model sometimes returns nothing under a forced tool choice ("tool_use_failed"); the other model copes.
    if (isToolUseFailed(e)) {
      console.warn('primary model failed to call the forced tool, using fallback model:', (e as Error).message?.slice(0, 200));
      return call(FALLBACK_MODEL);
    }
    // "over capacity" (503) and other server-side or network failures of the primary: the other model is a different deployment.
    const status = (e as { status?: number }).status;
    if (isUnavailable(status)) {
      console.warn('primary model unavailable, using fallback model:', (e as Error).message?.slice(0, 200));
      return call(FALLBACK_MODEL);
    }
    if (status !== 429) throw e;
    const wait = retryWaitMs(e);
    if (wait !== null && wait <= MAX_WAIT_MS && Date.now() - startedAt < WAIT_BUDGET_MS) {
      await new Promise(r => setTimeout(r, wait + 250));
      try { return await call(PRIMARY_MODEL); } catch (e2) { const s2 = (e2 as { status?: number }).status; if (isUnavailable(s2)) return call(FALLBACK_MODEL); if (s2 !== 429) throw e2; }
    }
    console.warn('primary model rate limited, using fallback model');
    return call(FALLBACK_MODEL);
  }
}
// The fallback is a reasoning model: keep its thinking short so the answer fits the token budget.
export const fallbackOpts = (model: string) => (model === PRIMARY_MODEL ? {} : { reasoning_effort: 'low' as const });

export const TOOLS: Groq.Chat.ChatCompletionTool[] = [
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
      name: 'find_free_slots',
      description: "Find free slots in Manoj's Google Calendar on weekdays 10:00-18:00 IST between two dates. Use this (not get_calendar_events) to pick a time for a new meeting. Returns slot start/end as ISO times ready for create_calendar_event. All-day entries (e.g. holidays) do not block time, so check those separately if relevant.",
      parameters: {
        type: 'object',
        properties: {
          from_date: { type: 'string', description: 'First day to search, YYYY-MM-DD (IST)' },
          to_date: { type: 'string', description: 'Last day to search, YYYY-MM-DD (IST), at most 14 days after from_date' },
          duration_minutes: { type: 'number', description: 'Meeting length in minutes (default 30)' },
        },
        required: ['from_date', 'to_date'],
      },
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
      description: 'Get notes and summaries from past meetings saved in Maya. Use when asked about meetings, what was discussed, or what happened in a call.',
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
      name: 'add_todos',
      description: "Add tasks to Manoj's to-do list. Maya then works on them in the background (research, drafts, reminders; sends and calendar changes wait for his approval) and reports back.",
      parameters: {
        type: 'object',
        properties: { items: { type: 'array', items: { type: 'string' }, description: 'Each to-do as a short task' } },
        required: ['items'],
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
      name: 'list_emails',
      description: "List recent emails from Manoj's Gmail inbox, optionally filtered by a Gmail search query. Also the tool for anything that reaches him by email: job applications, interview stages, rejections, recruiters, bank/card alerts, orders, a company or a person.",
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
  ...JOB_TOOLS,
  ...ACTIVITY_TOOLS,
  ...CONVERSATION_TOOLS,
  ...TASK_TOOLS,
  ...PIPELINE_TOOLS,
];

export async function executeTool(name: string, args: Record<string, unknown>, userId: string): Promise<string> {
  // Tiered approval: outward-facing/irreversible tools never run here — they are queued and
  // only the session-gated /api/actions/[id] endpoint can execute them.
  if (GATED_TOOLS.has(name)) return queueAction(userId, name, args);
  if (JOB_TOOL_NAMES.has(name)) return runJobTool(name, args, userId);
  if (ACTIVITY_TOOL_NAMES.has(name)) return runActivityTool(name, userId);
  if (CONVERSATION_TOOL_NAMES.has(name)) return runConversationTool(name, args, userId);
  if (TASK_TOOL_NAMES.has(name)) return runTaskTool(name, userId);
  if (PIPELINE_TOOL_NAMES.has(name)) return runPipelineTool(name, userId);
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

    case 'find_free_slots': {
      const p = parseSlotArgs(args);
      if ('error' in p) return p.error;
      const token = await getGoogleAccessToken();
      if (!token) return 'Google Calendar not configured.';
      // Busy times come from the event list: the granted scope (calendar.events) does not cover the freeBusy API.
      // Every page, or an error: a missed page would show taken time as free.
      const items: CalItem[] = [];
      let pageToken = '';
      for (let page = 0; ; page++) {
        if (page >= 4) return 'Calendar too busy to scan in one go: try a shorter date range.';
        const q = new URLSearchParams({ timeMin: `${p.from}T00:00:00+05:30`, timeMax: `${p.to}T23:59:59+05:30`, singleEvents: 'true', orderBy: 'startTime', maxResults: '250', ...(pageToken ? { pageToken } : {}) });
        const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${q}`, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) return `Calendar lookup failed: ${res.status}`;
        const data = await res.json() as { items?: CalItem[]; nextPageToken?: string };
        items.push(...(data.items ?? []));
        if (!data.nextPageToken) break;
        pageToken = data.nextPageToken;
      }
      return formatSlots(freeSlots(busyFromEvents(items), p.from, p.to, p.minutes, { now: new Date() }), p.minutes);
    }

    case 'get_meeting_notes': {
      const meetings = await getMeetingNotes(userId, (args.limit as number) ?? 3);
      if (!meetings.length) return 'No meeting notes saved.';
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

    case 'add_todos': {
      const items = (Array.isArray(args.items) ? args.items : []).filter((t): t is string => typeof t === 'string' && t.trim().length > 0).map(t => t.trim().slice(0, 500)).slice(0, 10);
      if (!items.length) return 'No to-dos given.';
      // 'assistant', not 'chat': the model may be acting on an email or page it read this turn (see capture.ts).
      const saved = await insertTodos(userId, items, 'assistant');
      return `Added ${saved.length} to-do${saved.length === 1 ? '' : 's'}. I'll work on ${saved.length === 1 ? 'it' : 'them'} within 30 minutes and report back.`;
    }

    case 'complete_action_item': {
      const found = await completeActionItem(userId, args.item_id as string);
      return found ? 'Action item marked done.' : 'No matching action item found.';
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

