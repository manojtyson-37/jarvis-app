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
}

function validTicketId(ticketId: string): boolean {
  return /^\d+$/.test(ticketId);
}

export async function getTicket(ticketId: string): Promise<string> {
  if (!process.env.FRESHDESK_API_KEY || !process.env.FRESHDESK_DOMAIN) return 'Freshdesk not configured.';
  if (!validTicketId(ticketId)) return 'Invalid ticket ID — must be numeric.';
  const res = await fetch(`${baseUrl()}/tickets/${ticketId}`, {
    headers: { Authorization: authHeader() },
  });
  if (res.status === 404) return `Ticket #${ticketId} not found.`;
  if (!res.ok) return `Freshdesk fetch failed: ${res.status}`;
  const t = await res.json() as FreshdeskTicket;
  return `#${t.id} "${t.subject}" — ${STATUS_NAMES[t.status] ?? t.status} / ${PRIORITY_NAMES[t.priority] ?? t.priority} priority\n${(t.description_text ?? '').slice(0, 300)}`;
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
