// Tiered-approval action layer.
// Tier is decided HERE, in code — the model can request a tool but cannot change its tier.
//   auto   : runs immediately (reads, drafts, notes, reminders) — not listed here
//   gated  : outward-facing or irreversible — queued in pending_actions, runs only after
//            the session-gated /api/actions/[id] endpoint approves it
//   locked : credentials/settings — no tool exists for these at all
import { createHash } from 'crypto';
import { supabase, logTaskExecution } from '@/lib/supabase';
import { sendEmail } from '@/lib/gmail';
import { getGoogleAccessToken } from '@/lib/google';

export const GATED_TOOLS = new Set([
  'send_email',
  'create_calendar_event',
  'delete_calendar_event',
]);

export interface PendingAction {
  id: string;
  user_id: string;
  tool: string;
  args: Record<string, unknown>;
  summary: string;
  status: 'pending' | 'executing' | 'executed' | 'failed' | 'rejected' | 'expired';
  result: string | null;
  created_at: string;
  expires_at: string;
  // Computed on read, never stored: hash of the full validated args, the full long text, and a flag
  // for text longer than the on-card excerpt.
  hash?: string;
  detail?: string;
  long?: boolean;
}

// Binds an approval to the COMPLETE action, not just the excerpt shown in the summary.
export function argsHash(tool: string, args: Record<string, unknown>): string {
  return createHash('sha256').update(`${tool}:${JSON.stringify(args)}`).digest('hex');
}

const MAX_PENDING = 5;
const EXECUTING_STALE_MS = 5 * 60 * 1000;
const EMAIL_RE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;
const EVENT_ID_RE = /^[A-Za-z0-9_-]{1,1024}$/;
const ISO_DT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?([+-]\d{2}:\d{2}|Z)?$/;
const MAX_TEXT = 8000;
const EXCERPT = 300;

const auditType = (tool: string) =>
  tool === 'send_email' ? 'email' : 'calendar';

// The model sometimes drifts and sends an ID as a JSON number — accept that, reject everything else.
const str = (v: unknown): string =>
  typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : '';

// Display-only: hidden control / zero-width / bidi-override characters could make a card read differently
// from what runs. The hash still covers the raw text, so stripping here can never hide a change.
const displaySafe = (t: string) => t.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '');

const excerpt = (t0: string) => {
  const t = displaySafe(t0);
  return t.length > EXCERPT ? `${t.slice(0, EXCERPT)}… [+${t.length - EXCERPT} more characters not shown here — open Full text]` : t;
};

type Validated = { ok: true; args: Record<string, unknown>; summary: string } | { ok: false; error: string };

// LLM tool args can be steered by untrusted content the model has read (an email, a ticket),
// so every ID/address is shape-checked before it is stored, shown to the user, or used in a URL.
// The summary the user approves is ALWAYS derived from args here — never trusted from storage —
// so what is shown is exactly what will run, and it spells out the parts an injected prompt could hide
// (full recipient, body excerpt, end time, event title).
export function validateGatedArgs(tool: string, raw: Record<string, unknown>): Validated {
  switch (tool) {
    case 'send_email': {
      const to = str(raw.to).trim(), subject = str(raw.subject), body = str(raw.body);
      if (!EMAIL_RE.test(to)) return { ok: false, error: `Invalid recipient address: "${to}".` };
      if (!subject.trim() || !body.trim()) return { ok: false, error: 'Email needs a subject and a body.' };
      if (body.length > MAX_TEXT || subject.length > 300) return { ok: false, error: 'Email too long.' };
      return { ok: true, args: { to, subject, body }, summary: `Send email to ${to}, subject "${subject}", saying: ${excerpt(body)}` };
    }
    case 'create_calendar_event': {
      const title = str(raw.title).trim(), start = str(raw.start).trim(), end = str(raw.end).trim();
      if (!title || title.length > 300) return { ok: false, error: 'Event needs a title.' };
      if (!ISO_DT_RE.test(start) || !ISO_DT_RE.test(end)) return { ok: false, error: 'Start/end must be ISO date-times.' };
      const hasOffset = (d: string) => /(Z|[+-]\d{2}:\d{2})$/.test(d);
      if (hasOffset(start) !== hasOffset(end)) return { ok: false, error: 'Start and end must both include a timezone offset, or neither.' };
      const s = Date.parse(start), e = Date.parse(end);
      if (Number.isNaN(s) || Number.isNaN(e) || e <= s) return { ok: false, error: 'End must be after start.' };
      const description = str(raw.description).slice(0, MAX_TEXT);
      const desc = description ? `, notes: ${excerpt(description)}` : '';
      return { ok: true, args: { title, start, end, description }, summary: `Create calendar event "${title}" from ${start} to ${end}${desc}` };
    }
    case 'delete_calendar_event': {
      const id = str(raw.event_id).trim();
      if (!EVENT_ID_RE.test(id)) return { ok: false, error: 'Invalid event id.' };
      const title = str(raw.event_title).slice(0, 300);
      return {
        ok: true,
        args: title ? { event_id: id, event_title: title } : { event_id: id },
        summary: title ? `Delete calendar event "${title}" (${id})` : `Delete calendar event ${id} (title could not be looked up)`,
      };
    }
    default:
      return { ok: false, error: `${tool} is not an approvable action.` };
  }
}

async function lookupEventTitle(eventId: string): Promise<string> {
  try {
    const token = await getGoogleAccessToken();
    if (!token) return '';
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) return '';
    return str(((await res.json()) as { summary?: string }).summary);
  } catch {
    return '';
  }
}

export async function queueAction(
  userId: string, tool: string, rawArgs: Record<string, unknown>,
): Promise<string> {
  let input = rawArgs;
  if (tool === 'delete_calendar_event') {
    // Resolve the title now so the user approves "Delete 'Standup'", not an opaque ID.
    // Always overwrite — a model-supplied event_title is never trusted.
    input = { event_id: rawArgs.event_id, event_title: await lookupEventTitle(str(rawArgs.event_id).trim()) };
  }
  const v = validateGatedArgs(tool, input);
  if (!v.ok) return `Not queued: ${v.error}`;

  const nowIso = new Date().toISOString();
  const { data: open, error: openErr } = await supabase
    .from('pending_actions').select('tool, args')
    .eq('user_id', userId).eq('status', 'pending').gt('expires_at', nowIso);
  if (openErr) {
    console.error('queueAction pending lookup failed:', openErr.message);
    return 'Could not queue that action. Nothing was done.';
  }
  // jsonb returns keys in its own order, so compare after re-running each stored row through the
  // validator, which always rebuilds args in one fixed key order.
  const sig = (t: string, a: Record<string, unknown>) => {
    const n = validateGatedArgs(t, a);
    return n.ok ? `${t}:${JSON.stringify(n.args)}` : '';
  };
  const wanted = sig(tool, v.args);
  // Rows for tools that no longer exist (the removed Freshdesk actions) never show on a card and can never run,
  // so they must not count toward the cap either.
  const liveSigs = (open ?? []).filter(r => GATED_TOOLS.has(r.tool as string))
    .map(r => sig(r.tool as string, (r.args ?? {}) as Record<string, unknown>)).filter(Boolean);
  const dupe = liveSigs.includes(wanted);
  if (dupe) return `Already waiting for your approval: ${v.summary}.`;
  if (liveSigs.length >= MAX_PENDING) {
    return `Not queued: ${MAX_PENDING} actions are already waiting for approval. Approve or cancel some first.`;
  }

  const { data, error } = await supabase
    .from('pending_actions')
    .insert({ user_id: userId, tool, args: v.args, summary: v.summary })
    .select('id')
    .single();
  if (error || !data) {
    console.error('queueAction failed:', error?.message);
    return 'Could not queue that action. Nothing was done.';
  }
  await logTaskExecution(userId, auditType(tool), `Queued for approval: ${v.summary}`, { pending_action_id: data.id, status: 'pending_approval' });
  const longText = (str(v.args.body) || str(v.args.note) || str(v.args.description)).length > EXCERPT;
  return longText
    ? `Waiting for your approval: ${v.summary}. It has long text — open Full text on the card, then tap Approve (or "cancel" to drop it).`
    : `Waiting for your approval: ${v.summary}. Say "approve" or tap Approve to do it, "cancel" to drop it.`;
}

export async function listPendingActions(userId: string): Promise<PendingAction[]> {
  const now = new Date();
  const nowIso = now.toISOString();
  // Expire stale rows first so an old request can never be approved later.
  await supabase.from('pending_actions').update({ status: 'expired', decided_at: nowIso })
    .eq('user_id', userId).eq('status', 'pending').lt('expires_at', nowIso);
  // A crash between claim and finish leaves a row 'executing' forever. Never retry (it may have
  // already sent), but make the unknown outcome visible instead of silent.
  await supabase.from('pending_actions')
    .update({ status: 'failed', result: 'Outcome unknown — the server stopped mid-action. Check manually before retrying.' })
    .eq('user_id', userId).eq('status', 'executing')
    .lt('decided_at', new Date(now.getTime() - EXECUTING_STALE_MS).toISOString());

  const { data, error } = await supabase
    .from('pending_actions').select('*')
    .eq('user_id', userId).eq('status', 'pending')
    .order('created_at', { ascending: true });
  if (error) throw error;

  // Rows are re-validated and their summary recomputed from args on every read. The table is
  // reachable with the project's public anon key, so a stored summary or args are not trusted.
  const out: PendingAction[] = [];
  for (const row of (data ?? []) as PendingAction[]) {
    const v = validateGatedArgs(row.tool, row.args ?? {});
    if (v.ok && GATED_TOOLS.has(row.tool)) {
      const rawDetail = str(v.args.body) || str(v.args.note) || str(v.args.description);
      const detail = displaySafe(rawDetail);
      out.push({ ...row, args: v.args, summary: v.summary, hash: argsHash(row.tool, v.args), detail, long: detail.length > EXCERPT });
    }
  }
  return out;
}

async function runGatedTool(tool: string, args: Record<string, unknown>): Promise<{ ok: boolean; message: string }> {
  switch (tool) {
    case 'send_email':
      return sendEmail(str(args.to), str(args.subject), str(args.body));
    case 'create_calendar_event': {
      const token = await getGoogleAccessToken();
      if (!token) return { ok: false, message: 'Google Calendar not configured.' };
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
      if (!res.ok) return { ok: false, message: `Failed to create event: ${res.status}` };
      const ev = await res.json() as { id?: string; summary: string; htmlLink: string };
      return { ok: true, message: `Event created: "${ev.summary}" (id: ${ev.id ?? '(unavailable)'}) — ${ev.htmlLink}` };
    }
    case 'delete_calendar_event': {
      const token = await getGoogleAccessToken();
      if (!token) return { ok: false, message: 'Google Calendar not configured.' };
      const res = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(str(args.event_id))}`,
        { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
      );
      if (res.ok) return { ok: true, message: 'Event deleted.' };
      if (res.status === 404 || res.status === 410) return { ok: false, message: 'Event not found — it may have already been deleted.' };
      return { ok: false, message: `Failed to delete event: ${res.status}` };
    }
    default:
      return { ok: false, message: `Unknown action: ${tool}` };
  }
}

export async function decideAction(
  userId: string, id: string, decision: 'approve' | 'reject', shownHash?: string,
): Promise<{ ok: boolean; message: string }> {
  const now = new Date().toISOString();

  if (decision === 'reject') {
    const { data, error } = await supabase.from('pending_actions')
      .update({ status: 'rejected', decided_at: now })
      .eq('id', id).eq('user_id', userId).eq('status', 'pending').select('args, tool');
    if (error) throw error;
    if (!data?.length) return { ok: false, message: 'No pending action with that id.' };
    const rv = validateGatedArgs(data[0].tool, (data[0].args ?? {}) as Record<string, unknown>);
    await logTaskExecution(userId, auditType(data[0].tool), `Rejected: ${rv.ok ? rv.summary : data[0].tool}`, { pending_action_id: id });
    return { ok: true, message: 'Cancelled. Nothing was done.' };
  }

  // Atomic claim: only one caller can move pending -> executing, so a double-tap or a retry
  // can never run the same action twice. Also refuses anything past its expiry.
  const { data: claimed, error } = await supabase.from('pending_actions')
    .update({ status: 'executing', decided_at: now })
    .eq('id', id).eq('user_id', userId).eq('status', 'pending').gt('expires_at', now)
    .select('*');
  if (error) throw error;
  if (!claimed?.length) return { ok: false, message: 'That request is no longer pending (already handled or expired).' };

  const action = claimed[0] as PendingAction;
  let auditSummary = action.tool; // replaced by the server-derived summary once args validate
  const finish = async (ok: boolean, message: string) => {
    const { error: upErr } = await supabase.from('pending_actions')
      .update({ status: ok ? 'executed' : 'failed', result: message }).eq('id', id);
    if (upErr) console.error('pending_actions final update failed:', upErr.message);
    await logTaskExecution(userId, auditType(action.tool),
      `${ok ? 'Executed' : 'Failed'}: ${auditSummary} — ${message}`, { pending_action_id: id, args: action.args });
    return { ok, message };
  };

  // Re-validate what is actually stored right before running it (never run unvalidated args).
  const v = validateGatedArgs(action.tool, action.args ?? {});
  if (!v.ok || !GATED_TOOLS.has(action.tool)) return finish(false, 'Stored action failed validation — not run.');
  auditSummary = v.summary;
  // The table is reachable with the public anon key, so a row can be edited after the user saw the
  // card. The approval only counts for exactly what they were shown: these args are the ones the
  // atomic claim just returned, and their hash of the FULL content (not just the excerpt) must equal
  // the hash on the card they tapped.
  if (argsHash(action.tool, v.args) !== shownHash) {
    return finish(false, 'This request changed after it was shown to you, so it was not run. Ask me again.');
  }

  try {
    const result = await runGatedTool(action.tool, v.args);
    return finish(result.ok, result.message);
  } catch (e) {
    return finish(false, `Action failed: ${(e as Error).message}`);
  }
}
