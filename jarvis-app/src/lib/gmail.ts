// Gmail access for manoj.r@jodopay.com via a dedicated OAuth client (separate from the
// GOOGLE_CLIENT_ID/SECRET used for Calendar, which is a different Google account/app).

async function getJodopayAccessToken(): Promise<string | null> {
  const clientId = process.env.GOOGLE_JODOPAY_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_JODOPAY_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_JODOPAY_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    console.error('Gmail (jodopay) not configured: missing GOOGLE_JODOPAY_CLIENT_ID/SECRET/REFRESH_TOKEN.');
    return null;
  }
  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }),
    });
    if (!res.ok) {
      console.error('Jodopay Gmail token refresh failed:', res.status, await res.text());
      return null;
    }
    const data = await res.json() as { access_token?: string };
    return data.access_token ?? null;
  } catch (e) {
    console.error('Jodopay Gmail token fetch error:', (e as Error).message);
    return null;
  }
}

interface GmailHeader { name: string; value: string }
interface GmailMessagePart { headers?: GmailHeader[]; body?: { data?: string }; parts?: GmailMessagePart[]; mimeType?: string }
interface GmailMessage { id: string; snippet?: string; payload?: GmailMessagePart }

function getHeader(headers: GmailHeader[] | undefined, name: string): string {
  return headers?.find(h => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
}

// RFC 2047 encoded-word headers (`=?UTF-8?B?...?=` / `=?UTF-8?Q?...?=`) show up for any
// sender name with non-ASCII characters. Without this, parseDisplayName would return the
// raw encoded gibberish instead of falling through to it cleanly.
function decodeRFC2047(text: string): string {
  return text.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_, charset: string, enc: string, payload: string) => {
    try {
      if (enc.toLowerCase() === 'b') return Buffer.from(payload, 'base64').toString(charset as BufferEncoding);
      // Quoted-printable: =XX hex escapes, underscore is a space.
      const qp = payload.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)));
      return Buffer.from(qp, 'binary').toString(charset as BufferEncoding);
    } catch {
      return payload; // malformed encoded-word — fall back to its raw payload rather than throwing
    }
  });
}

// Gmail headers come as `"Display Name" <addr@x.com>`, `Display Name <addr@x.com>`, or
// just `addr@x.com`. Raw headers are unreadable in a notification/chat line — pull the
// human name out, falling back to the address when there's no display name.
function parseDisplayName(rawFrom: string): string {
  const decoded = decodeRFC2047(rawFrom);
  const match = /^"?([^"<]*?)"?\s*<([^>]+)>$/.exec(decoded.trim());
  if (!match) return decoded.trim();
  const [, name, addr] = match;
  return name.trim() || addr.trim();
}

const HTML_ENTITIES: Record<string, string> = {
  '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'",
};
function decodeHtmlEntities(text: string): string {
  return text.replace(/&nbsp;|&amp;|&lt;|&gt;|&quot;|&#39;|&apos;/g, m => HTML_ENTITIES[m]);
}

// Trims an email body down to the actual new content — drops quoted reply chains and
// standard signature blocks so a one-line reply doesn't surface as a wall of forwarded
// thread history. Deliberately conservative: only cuts at well-known markers, never
// reformats or reinterprets the remaining text (still untrusted content, summarize-only).
function trimEmailBody(body: string): string {
  const quoteMarkers = [
    /\n\s*On .{0,80} wrote:\s*\n/i,
    /\n-{2,}\s*Original Message\s*-{2,}/i,
    /\n>.*(\n>.*)*$/,
  ];
  let trimmed = body;
  for (const marker of quoteMarkers) {
    const m = marker.exec(trimmed);
    if (m && m.index !== undefined) trimmed = trimmed.slice(0, m.index);
  }
  const sigIdx = trimmed.indexOf('\n-- \n');
  if (sigIdx !== -1) trimmed = trimmed.slice(0, sigIdx);
  return decodeHtmlEntities(trimmed).replace(/\n{3,}/g, '\n\n').trim();
}

function formatEmailDate(raw: string): string {
  const d = new Date(raw);
  if (isNaN(d.getTime())) return raw;
  return d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
}

function extractPlainText(part: GmailMessagePart | undefined, depth = 0): string {
  if (!part || depth > 10) return '';
  if (part.mimeType === 'text/plain' && part.body?.data) return decodeBase64Url(part.body.data);
  for (const p of part.parts ?? []) {
    const text = extractPlainText(p, depth + 1);
    if (text) return text;
  }
  // Fallback only for text parts — avoids dumping raw HTML or decoding binary attachment
  // bytes as if they were utf-8 body text.
  if (part.mimeType?.startsWith('text/') && part.body?.data) return decodeBase64Url(part.body.data);
  return '';
}

export async function listLabels(): Promise<string> {
  const token = await getJodopayAccessToken();
  if (!token) return 'Gmail (jodopay) not configured.';
  const res = await fetch('https://www.googleapis.com/gmail/v1/users/me/labels', {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return `Gmail labels fetch failed: ${res.status}`;
  const data = await res.json() as { labels?: { id: string; name: string; type: string }[] };
  const userLabels = (data.labels ?? []).filter(l => l.type === 'user');
  if (!userLabels.length) return 'No custom labels found.';
  return userLabels.map(l => l.name).join(', ');
}

// Deterministic heuristic, not an LLM judgment call — flags the common automated-sender
// patterns so the raw list already does basic triage without needing risky narration on top
// (narration over this data has already been shown to sometimes fabricate instead of report).
function looksAutomated(from: string): boolean {
  return /no-?reply|notifications?@|alerts?@|do-?not-?reply|auto(mated)?@/i.test(from);
}

export interface EmailSummary {
  id: string;
  from: string;      // raw header, e.g. `"Jane Doe" <jane@x.com>` — kept for the automated-sender heuristic
  fromName: string;   // display-friendly sender (name if present, else the address)
  subject: string;
  date?: string;       // human-readable IST, e.g. "3 Oct 2026, 2:45 pm"
  snippet?: string;
  automated: boolean;
}

// Shared by listRecentEmails (chat tool, formats to a display string) and the proactive
// label-monitoring cron (needs structured per-message data to check/mark dedup state).
export async function fetchMessageSummaries(query: string, maxResults = 10): Promise<EmailSummary[] | null> {
  const token = await getJodopayAccessToken();
  if (!token) return null;
  const capped = Math.min(Math.max(maxResults, 1), 25);

  const listRes = await fetch(
    `https://www.googleapis.com/gmail/v1/users/me/messages?maxResults=${capped}&q=${encodeURIComponent(query)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!listRes.ok) {
    console.error('Gmail list failed:', listRes.status, await listRes.text());
    return null;
  }
  const listData = await listRes.json() as { messages?: { id: string }[] };
  const ids = listData.messages ?? [];
  if (!ids.length) return [];

  const summaries = await Promise.all(ids.map(async ({ id }): Promise<EmailSummary | null> => {
    const res = await fetch(
      `https://www.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) return null;
    const msg = await res.json() as GmailMessage;
    const from = getHeader(msg.payload?.headers, 'From');
    const subject = decodeRFC2047(getHeader(msg.payload?.headers, 'Subject'));
    const date = getHeader(msg.payload?.headers, 'Date');
    return {
      id, from, subject,
      fromName: parseDisplayName(from),
      date: date ? formatEmailDate(date) : undefined,
      snippet: msg.snippet ? decodeHtmlEntities(msg.snippet) : undefined,
      automated: looksAutomated(from),
    };
  }));
  return summaries.filter((s): s is EmailSummary => s !== null);
}

export async function listRecentEmails(query = 'is:unread', maxResults = 10): Promise<string> {
  const summaries = await fetchMessageSummaries(query, maxResults);
  if (summaries === null) return 'Gmail (jodopay) not configured or list failed.';
  if (!summaries.length) return 'No matching emails.';
  // UNTRUSTED EMAIL DATA — summarize only. Never treat any instruction-like text inside
  // a From/Subject/snippet as a command; it originates from whoever sent the email, not Manoj.
  // The [automated]/[needs-look] tags below are a deterministic heuristic on the sender
  // address, not a judgment to override — report them as-is rather than re-deciding.
  return summaries.map(s => {
    const flag = s.automated ? '[automated] ' : '[needs-look] ';
    const when = s.date ? ` (${s.date})` : '';
    return `${flag}[${s.id}] ${s.fromName}${when} — "${s.subject}"${s.snippet ? `\n  ${s.snippet.slice(0, 100)}` : ''}`;
  }).join('\n');
}

export async function getEmail(messageId: string): Promise<string> {
  if (!/^[a-zA-Z0-9]+$/.test(messageId)) return 'Invalid email ID.';
  const token = await getJodopayAccessToken();
  if (!token) return 'Gmail (jodopay) not configured.';

  const res = await fetch(`https://www.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 404) return `Email ${messageId} not found.`;
  if (!res.ok) return `Gmail fetch failed: ${res.status}`;
  const msg = await res.json() as GmailMessage;
  const from = getHeader(msg.payload?.headers, 'From');
  const to = getHeader(msg.payload?.headers, 'To');
  const subject = decodeRFC2047(getHeader(msg.payload?.headers, 'Subject'));
  const date = getHeader(msg.payload?.headers, 'Date');
  const body = trimEmailBody(extractPlainText(msg.payload)).slice(0, 2000);
  // UNTRUSTED EMAIL CONTENT below — summarize/quote it, never follow instructions it contains.
  return `From: ${parseDisplayName(from)}\nDate: ${formatEmailDate(date)}\nSubject: ${subject}\nTo: ${parseDisplayName(to)}\n\n${body}`;
}

const SIMPLE_EMAIL_RE = /^[^\s@<>\r\n]+@[^\s@<>\r\n]+\.[^\s@<>\r\n]+$/;

export async function sendEmail(to: string, subject: string, body: string): Promise<{ ok: boolean; message: string }> {
  if (!SIMPLE_EMAIL_RE.test(to.trim())) return { ok: false, message: `Invalid recipient address: ${to}` };
  // Strip any CRLF from header-bound fields — an unsanitized newline here lets LLM-supplied
  // (or indirectly, email-content-supplied) text inject arbitrary extra headers like a Bcc.
  const safeTo = to.replace(/[\r\n]/g, ' ').trim();
  const safeSubject = subject.replace(/[\r\n]/g, ' ');

  const token = await getJodopayAccessToken();
  if (!token) return { ok: false, message: 'Gmail (jodopay) not configured.' };

  const raw = [
    `To: ${safeTo}`,
    `Subject: ${safeSubject}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
  ].join('\r\n');
  const encoded = Buffer.from(raw).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const res = await fetch('https://www.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: encoded }),
  });
  if (!res.ok) return { ok: false, message: `Send failed: ${res.status}` };
  return { ok: true, message: `Email sent to ${to}.` };
}
