const STATUS_MAP: Record<string, number> = { open: 2, pending: 3, resolved: 4, closed: 5 };
const STATUS_NAMES: Record<number, string> = { 2: 'Open', 3: 'Pending', 4: 'Resolved', 5: 'Closed' };
const PRIORITY_NAMES: Record<number, string> = { 1: 'Low', 2: 'Medium', 3: 'High', 4: 'Urgent' };

function authHeader(): string {
  const key = process.env.FRESHDESK_API_KEY!;
  return 'Basic ' + Buffer.from(`${key}:X`).toString('base64');
}

function baseUrl(): string {
  return `https://${process.env.FRESHDESK_DOMAIN}/api/v2`;
}

export interface FreshdeskTicket {
  id: number;
  subject: string;
  description_text: string;
  status: number;
  priority: number;
  requester_id: number;
  requester?: { name?: string; email?: string };
}

function validTicketId(ticketId: string): boolean {
  return /^\d+$/.test(ticketId);
}

export interface FreshdeskTicketSummary {
  id: number;
  subject: string;
  status: number;
  priority: number;
  requester?: { name?: string; email?: string };
}

// "new_and_my_open" is a Freshdesk built-in filter scoped to the authenticated
// agent's own tickets — no separate agent-ID lookup needed. include=requester embeds
// the requester inline (confirmed working on this filtered endpoint too, not just the
// single-ticket show endpoint) so callers don't need a second lookup per ticket.
export async function listMyOpenTickets(): Promise<FreshdeskTicketSummary[]> {
  if (!process.env.FRESHDESK_API_KEY || !process.env.FRESHDESK_DOMAIN) return [];
  const res = await fetch(`${baseUrl()}/tickets?filter=new_and_my_open&order_by=created_at&order_type=desc&include=requester`, {
    headers: { Authorization: authHeader() },
  });
  if (!res.ok) {
    console.error('Freshdesk listMyOpenTickets failed:', res.status, await res.text());
    return [];
  }
  const data = await res.json() as FreshdeskTicketSummary[];
  return data;
}

// Manoj's own agent profile has an empty group_ids (not a formal member of any group via
// that field), so "the latest ticket" can't be derived from his profile — he specified these
// 3 groups directly: Team Engineering, Team ERP Integration, Team Tech Operation.
const LATEST_TICKET_GROUP_IDS = [88000150786, 88000150785, 88000112496];

export async function getLatestTicketInGroups(): Promise<string> {
  if (!process.env.FRESHDESK_API_KEY || !process.env.FRESHDESK_DOMAIN) return 'Freshdesk not configured.';
  // The regular /tickets list endpoint has no group_id filter; Freshdesk's search API
  // supports arbitrary field queries via FQL. Confirmed live: results come back sorted
  // newest-first by created_at with no explicit order_by needed, and `include=requester`
  // is NOT supported here (only 'company' is) — so this call only finds the latest ticket
  // ID, then hands off to getTicket() for the full requester-resolved, formatted detail.
  const query = LATEST_TICKET_GROUP_IDS.map(id => `group_id:${id}`).join(' OR ');
  const res = await fetch(
    `${baseUrl()}/search/tickets?query=${encodeURIComponent(`"${query}"`)}`,
    { headers: { Authorization: authHeader() } }
  );
  if (!res.ok) {
    console.error('Freshdesk getLatestTicketInGroups search failed:', res.status, await res.text());
    return 'Freshdesk ticket search failed.';
  }
  const data = await res.json() as { results?: { id: number }[] };
  if (!data.results?.length) return 'No tickets found in the Engineering / ERP Integration / Tech Operation groups.';
  // Don't just trust results[0] — the search API's newest-first ordering was confirmed
  // empirically, not via any documented order_by guarantee. Freshdesk ticket IDs are
  // monotonically increasing per account, so sorting by ID client-side gets the true
  // latest regardless of whatever order the API actually returns.
  const latest = data.results.reduce((max, t) => (t.id > max.id ? t : max));
  return getTicket(String(latest.id));
}

export async function getTicket(ticketId: string): Promise<string> {
  if (!process.env.FRESHDESK_API_KEY || !process.env.FRESHDESK_DOMAIN) return 'Freshdesk not configured.';
  if (!validTicketId(ticketId)) return 'Invalid ticket ID — must be numeric.';
  // include=requester embeds the requester's name/email inline — without it only a bare
  // requester_id number comes back, which is useless in a reply and invites the model to
  // guess/fabricate a customer name instead of saying it doesn't have one.
  const res = await fetch(`${baseUrl()}/tickets/${ticketId}?include=requester`, {
    headers: { Authorization: authHeader() },
  });
  if (res.status === 404) return `Ticket #${ticketId} not found.`;
  if (!res.ok) return `Freshdesk fetch failed: ${res.status}`;
  const t = await res.json() as FreshdeskTicket;
  const requester = t.requester?.name || t.requester?.email || `requester #${t.requester_id}`;
  return `#${t.id} "${t.subject}" — ${STATUS_NAMES[t.status] ?? t.status} / ${PRIORITY_NAMES[t.priority] ?? t.priority} priority\nFrom: ${requester}\n${(t.description_text ?? '').slice(0, 300)}`;
}

export async function updateTicketStatus(ticketId: string, status: string): Promise<{ ok: boolean; message: string }> {
  if (!process.env.FRESHDESK_API_KEY || !process.env.FRESHDESK_DOMAIN) return { ok: false, message: 'Freshdesk not configured.' };
  if (!validTicketId(ticketId)) return { ok: false, message: 'Invalid ticket ID — must be numeric.' };
  const code = STATUS_MAP[status.toLowerCase()];
  if (!code) return { ok: false, message: `Unknown status "${status}". Use: open, pending, resolved, closed.` };
  const res = await fetch(`${baseUrl()}/tickets/${ticketId}`, {
    method: 'PUT',
    headers: { Authorization: authHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: code }),
  });
  if (res.status === 404) return { ok: false, message: `Ticket #${ticketId} not found.` };
  if (!res.ok) return { ok: false, message: `Failed to update ticket: ${res.status}` };
  return { ok: true, message: `Ticket #${ticketId} marked ${STATUS_NAMES[code]}.` };
}

export async function addTicketNote(ticketId: string, note: string): Promise<{ ok: boolean; message: string }> {
  if (!process.env.FRESHDESK_API_KEY || !process.env.FRESHDESK_DOMAIN) return { ok: false, message: 'Freshdesk not configured.' };
  if (!validTicketId(ticketId)) return { ok: false, message: 'Invalid ticket ID — must be numeric.' };
  const res = await fetch(`${baseUrl()}/tickets/${ticketId}/notes`, {
    method: 'POST',
    headers: { Authorization: authHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: note, private: true }),
  });
  if (res.status === 404) return { ok: false, message: `Ticket #${ticketId} not found.` };
  if (!res.ok) return { ok: false, message: `Failed to add note: ${res.status}` };
  return { ok: true, message: `Note added to ticket #${ticketId}.` };
}
