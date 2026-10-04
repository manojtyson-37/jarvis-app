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

interface FreshdeskAgent { id: number; contact?: { name?: string } }

// Freshdesk's agent list has no query/search param that works reliably (tried
// contact.name: field, rejected as invalid) — fetches the full list and matches
// client-side. 56 agents today; fine for a single in-memory filter, revisit if it grows
// enough to need pagination. A single get_agent_ticket_count request calls this twice
// (once in the chat route to build agentNameTokens for the trigger check, once inside
// findAgentsByName when the tool actually executes) — cached briefly so that's one real
// API call, not two; the agent roster changing mid-request is not a concern worth the
// complexity of threading the list through the tool-call boundary instead.
let agentsCache: { at: number; agents: FreshdeskAgent[] } | null = null;
const AGENTS_CACHE_TTL_MS = 30_000;

export async function fetchAllAgents(): Promise<FreshdeskAgent[]> {
  if (agentsCache && Date.now() - agentsCache.at < AGENTS_CACHE_TTL_MS) return agentsCache.agents;
  if (!process.env.FRESHDESK_API_KEY || !process.env.FRESHDESK_DOMAIN) return [];
  const res = await fetch(`${baseUrl()}/agents?per_page=100`, { headers: { Authorization: authHeader() } });
  if (!res.ok) {
    console.error('Freshdesk fetchAllAgents failed:', res.status, await res.text());
    return [];
  }
  const agents = await res.json() as FreshdeskAgent[];
  agentsCache = { at: Date.now(), agents };
  return agents;
}

async function findAgentsByName(name: string): Promise<FreshdeskAgent[]> {
  const agents = await fetchAllAgents();
  const needle = name.trim().toLowerCase();
  return agents.filter(a => a.contact?.name?.toLowerCase().includes(needle));
}

// Flat list of individual name tokens (first/last/middle) across every real agent, e.g.
// "Sahil Parihar" -> ["Sahil", "Parihar"]. Lets the chat route check whether a message
// actually names a real agent before forcing a per-agent ticket-count tool call — a bare
// capitalized-word heuristic was tried and rejected on review: ordinary capitalized words
// (place names, weekdays, months, product/team names) are common enough in real ticket-count
// questions that "any capitalized word" produces frequent false positives with no real name
// to fill the tool's required argument. Matching against real names has a much smaller false-
// positive surface (only an actual agent's own name can match) at the cost of one extra fetch.
// Several Freshdesk "agents" are actually shared-inbox/team placeholder accounts, not real
// people — "Integrations Team", "Cred Ops", "Support Buddy", "Engineering Jodo", "Tech ops".
// Splitting those into individual tokens reintroduces the exact false-positive this function
// exists to avoid ("Finance team" colliding with the "Team" token from "Integrations Team").
// Filtering these generic organizational words out leaves only name-shaped tokens, which also
// means a question about one of these placeholder accounts by its literal name won't force
// this tool — acceptable, since Manoj asking about a real person is the actual use case.
// Hardcoded against the live roster as of 2026-10 — re-check against fetchAllAgents() if a
// new placeholder/shared-inbox account gets added with a different generic word, or this
// list will silently stop covering it.
const GENERIC_AGENT_WORDS = new Set([
  'team', 'ops', 'operations', 'support', 'buddy', 'tech', 'data', 'cred', 'jodo',
  'engineering', 'integrations', 'integration', 'onboarding', 'banking', 'flex',
  'site', 'reliability', 'finance', 'product', 'activation',
]);
// Residual, accepted risk: a real agent whose surname happens to BE an ordinary English
// word (e.g. an agent literally named "... Watts") will still force this tool on any message
// containing that word ("measuring 100 watts of power"), no regex can distinguish the two.
// Scoped to a worse-case outcome of "wrong tool call returns a clean no-op-ish reply", not a
// fabrication or data-corruption risk — accepted rather than chased further.

export async function getAgentNameTokens(): Promise<string[]> {
  const agents = await fetchAllAgents();
  const tokens = new Set<string>();
  for (const a of agents) {
    for (const part of (a.contact?.name ?? '').split(/\s+/)) {
      if (part.length >= 3 && !GENERIC_AGENT_WORDS.has(part.toLowerCase())) tokens.add(part);
    }
  }
  return [...tokens];
}

// "X's bucket" / "tickets assigned to X" — count of tickets where X is the owner. This org
// tracks ticket ownership in TWO decoupled places: Freshdesk's native `agent_id` (responder_id)
// — which for group-routed tickets is often a shared-inbox placeholder (e.g. "Integrations
// Team"), not the real human — and a custom field `cf_assigned_to` (plain-text agent name) that
// the team actually uses for day-to-day ownership and that the "Assigned To" dashboard filter
// reads. Confirmed via live testing: a ticket can show cf_assigned_to:"Manoj R" while its
// agent_id points at "Integrations Team" — querying agent_id alone undercounts to 0 on tickets
// that are real work for that person. OR both fields so neither assignment path is missed.
// Status 2+3 (Open+Pending) is "open" in the colloquial sense Manoj used — not yet
// resolved/closed, not literally status=2 only.
export async function getOpenTicketCountForAgent(agentName: string): Promise<string> {
  if (!process.env.FRESHDESK_API_KEY || !process.env.FRESHDESK_DOMAIN) return 'Freshdesk not configured.';
  const matches = await findAgentsByName(agentName);
  if (!matches.length) return `No Freshdesk agent found matching "${agentName}".`;
  if (matches.length > 1) {
    const names = matches.map(a => a.contact?.name).filter(Boolean).join(', ');
    return `Multiple agents match "${agentName}": ${names}. Which one?`;
  }
  const agent = matches[0];
  // cf_assigned_to is a closed Freshdesk dropdown, not free text — the API validates it
  // server-side against a fixed ~140-value list (confirmed live via its own 400 error), none
  // of which contain an apostrophe, so no FQL string-escaping is needed here.
  const displayName = agent.contact?.name ?? agentName;
  const query = `(agent_id:${agent.id} OR cf_assigned_to:'${displayName}') AND (status:2 OR status:3)`;
  const res = await fetch(
    `${baseUrl()}/search/tickets?query=${encodeURIComponent(`"${query}"`)}`,
    { headers: { Authorization: authHeader() } }
  );
  if (!res.ok) {
    console.error('Freshdesk getOpenTicketCountForAgent search failed:', res.status, await res.text());
    return 'Freshdesk ticket count failed.';
  }
  const data = await res.json() as { total?: number };
  return `${agent.contact?.name ?? agentName} has ${data.total ?? 0} open ticket${data.total === 1 ? '' : 's'} (Open + Pending).`;
}
