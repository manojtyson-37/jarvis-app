// Gmail access for manojsuperb09@gmail.com via the shared Google token (same OAuth client as Calendar and Drive).
import { getGoogleAccessToken } from '@/lib/google';
import { mapLimit, collectPages } from '@/lib/concurrency';
import type { InboundMsg } from '@/lib/away/engine';
import { parseMailbox, cleanName, isValidAddr } from '@/lib/away/mailbox';

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

// Any sender controls the body. Only the start is ever used, so cap it before doing any work on it.
const MAX_TRIM_INPUT = 20_000;

// Trims an email body down to the actual new content — drops quoted reply chains and
// standard signature blocks so a one-line reply doesn't surface as a wall of forwarded
// thread history. Deliberately conservative: only cuts at well-known markers, never
// reformats or reinterprets the remaining text (still untrusted content, summarize-only).
// Linear: one pass over lines with anchored per-line tests. The earlier whole-string regexes (`\n>.*(\n>.*)*$`) went
// quadratic on a long run of quoted lines and froze the event loop for ~24 s on a 240 KB body.
export function trimEmailBody(body: string): string {
  const lines = (body.length > MAX_TRIM_INPUT ? body.slice(0, MAX_TRIM_INPUT) : body).split('\n').map(l => (l.endsWith('\r') ? l.slice(0, -1) : l));
  let cut = lines.length;
  for (let i = 1; i < lines.length; i++) { // the first line is never a "marker line", matching the old \n-prefixed patterns
    const l = lines[i];
    if ((l.length <= 120 && /^\s*On .{0,80} wrote:\s*$/i.test(l)) || /^-{2,}\s*Original Message\s*-{2,}/i.test(l)) { cut = i; break; }
  }
  let q = lines.length; // start of the trailing run of "> quoted" lines
  while (q > 1 && lines[q - 1].startsWith('>')) q--;
  if (q < lines.length) cut = Math.min(cut, q);
  let trimmed = lines.slice(0, cut).join('\n');
  const sigIdx = trimmed.indexOf('\n-- \n');
  if (sigIdx !== -1) trimmed = trimmed.slice(0, sigIdx);
  return decodeHtmlEntities(trimmed).replace(/\n{3,}/g, '\n\n').trim();
}

function formatEmailDate(raw: string): string {
  const d = new Date(raw);
  if (isNaN(d.getTime())) return raw;
  return d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
}

function findPart(part: GmailMessagePart | undefined, mime: string, depth = 0): string {
  if (!part || depth > 10) return '';
  if (part.mimeType === mime && part.body?.data) return decodeBase64Url(part.body.data);
  for (const p of part.parts ?? []) {
    const text = findPart(p, mime, depth + 1);
    if (text) return text;
  }
  return '';
}

// The plain-text part, unless the HTML part says clearly more. LinkedIn's "Your application to X" plain part has only
// boilerplate while the HTML part carries the actual update ("Unfortunately, we will not be moving forward"); an
// HTML-only email (Workday, many hiring systems) used to come back as raw markup. Never decodes non-text parts.
export function pickBodyText(plain: string, html: string): string {
  const fromHtml = html ? htmlToText(html) : '';
  const p = plain.trim();
  // Compared without links: a plain part that is mostly tracking URLs is not "more".
  const textLen = (t: string) => t.replace(/<?https?:\/\/\S+>?/g, '').replace(/\s+/g, ' ').trim().length;
  return textLen(fromHtml) > textLen(p) + 150 ? fromHtml : p || fromHtml;
}

function extractPlainText(part: GmailMessagePart | undefined): string {
  return pickBodyText(findPart(part, 'text/plain'), findPart(part, 'text/html'));
}

const HTML_NAMED: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", copy: '©', middot: '·', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…', bull: '•', zwnj: '' };

// Any sender controls this HTML. Anything past this is never useful email text and only costs CPU.
const MAX_HTML_CHARS = 200_000;

// Drops every `open … close` block with indexOf scans. A lazy regex rescans to the end of the string from each opener,
// so thousands of unclosed openers ("<style<style…") cost seconds on the event loop; this stays linear. An opener with
// no closer is left in place, matching what the regex did, and the tag strip below removes the tag itself.
function dropBlocks(html: string, open: string, close: string, isTag: boolean): string {
  const lower = html.replace(/[A-Z]/g, c => c.toLowerCase()); // ASCII-only so indexes line up with `html`
  const parts: string[] = [];
  let pos = 0;
  while (pos < html.length) {
    const s = lower.indexOf(open, pos);
    if (s === -1) break;
    const after = s + open.length;
    if (isTag && /[a-z0-9]/.test(lower[after] ?? '')) { parts.push(html.slice(pos, after)); pos = after; continue; } // <header, <titlebar
    const e = lower.indexOf(close, after);
    if (e === -1) break;
    parts.push(html.slice(pos, s), ' ');
    pos = e + close.length;
  }
  parts.push(html.slice(pos));
  return parts.join('');
}

export function htmlToText(html0: string): string {
  let html = html0.length > MAX_HTML_CHARS ? html0.slice(0, MAX_HTML_CHARS) : html0;
  for (const tag of ['style', 'script', 'head', 'title']) html = dropBlocks(html, `<${tag}`, `</${tag}>`, true);
  html = dropBlocks(html, '<!--', '-->', false);
  return html
    .replace(/<(?:br|\/p|\/div|\/tr|\/li|\/h[1-6]|\/table)\b[^<>]*>/gi, '\n')
    .replace(/<[^<>]*>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ' '; }
      const k = e.toLowerCase();
      return Object.hasOwn(HTML_NAMED, k) ? HTML_NAMED[k] : m;
    })
    // Preheader padding (U+034F, zero-width and soft-hyphen runs) is invisible but long enough to bury the text.
    .replace(/[\u034f\u00ad\u200b-\u200d\u2060\ufeff]/g, '')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n[ \n]*/g, '\n')
    .trim();
}

export async function listLabels(): Promise<string> {
  const token = await getGoogleAccessToken();
  if (!token) return 'Gmail not configured.';
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
export async function fetchMessageSummaries(query: string, maxResults = 10, cap = 25): Promise<EmailSummary[] | null> {
  const token = await getGoogleAccessToken();
  if (!token) return null;
  const capped = Math.min(Math.max(maxResults, 1), Math.min(cap, 50));

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

  // Gmail answers 429 when too many requests run at once and a dropped message would silently vanish from the answer,
  // so fetch in small batches and retry a throttled one once. If every fetch still fails that is an error, not "no mail".
  const fetchMeta = async (id: string): Promise<GmailMessage | null> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(
        `https://www.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (res.ok) return await res.json() as GmailMessage;
      if (res.status !== 429) return null;
      await new Promise(r => setTimeout(r, 400));
    }
    return null;
  };
  const summaries = await mapLimit(ids, 5, async ({ id }): Promise<EmailSummary | null> => {
    const msg = await fetchMeta(id);
    if (!msg) return null;
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
  });
  const found = summaries.filter((s): s is EmailSummary => s !== null);
  return found.length ? found : null;
}

export async function listRecentEmails(query = 'is:unread', maxResults = 10): Promise<string> {
  const summaries = await fetchMessageSummaries(query, maxResults);
  if (summaries === null) return 'Gmail not configured or list failed.';
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
  const token = await getGoogleAccessToken();
  if (!token) return 'Gmail not configured.';

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

  const token = await getGoogleAccessToken();
  if (!token) return { ok: false, message: 'Gmail not configured.' };

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

// ── Away Mode helpers ────────────────────────────────────────────────────────

// The mailbox this token belongs to. Away Mode never replies to this address.
export async function getOwnAddress(): Promise<string | null> {
  const token = await getGoogleAccessToken();
  if (!token) return null;
  const res = await fetch('https://www.googleapis.com/gmail/v1/users/me/profile', { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return null;
  return ((await res.json()) as { emailAddress?: string }).emailAddress ?? null;
}

// Message ids matching a Gmail search, newest first, paginated up to `max` (5 pages of 100 at most). null = the first call
// failed (never "no mail").
export async function listMessageIds(query: string, max = 25): Promise<string[] | null> {
  const token = await getGoogleAccessToken();
  if (!token) return null;
  return collectPages(async pageToken => {
    const res = await fetch(
      `https://www.googleapis.com/gmail/v1/users/me/messages?maxResults=${Math.min(Math.max(max, 1), 100)}&q=${encodeURIComponent(query)}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) { console.error('Gmail list failed:', res.status); return null; }
    const j = await res.json() as { messages?: { id: string }[]; nextPageToken?: string };
    return { ids: (j.messages ?? []).map(m => m.id), next: j.nextPageToken };
  }, max, 5);
}

// One inbound message with everything Away Mode needs to decide and to reply in the same thread. The body is
// UNTRUSTED text from a stranger: trimmed to the new content and capped; never instructions.
export async function getInboundMessage(id: string): Promise<InboundMsg | null> {
  if (!/^[a-zA-Z0-9]+$/.test(id)) return null;
  const token = await getGoogleAccessToken();
  if (!token) return null;
  const res = await fetch(`https://www.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) { console.error('Gmail read failed:', res.status); return null; }
  const msg = await res.json() as GmailMessage & { threadId?: string };
  const h = (n: string) => getHeader(msg.payload?.headers, n);
  const from = h('From');
  const autoSubmitted = h('Auto-Submitted').trim().toLowerCase();
  const automated = looksAutomated(from)
    || (!!autoSubmitted && autoSubmitted !== 'no')
    || /^(bulk|list|junk)$/i.test(h('Precedence').trim())
    || !!h('List-Unsubscribe') || !!h('X-Autoreply') || !!h('X-Auto-Response-Suppress');
  // The sender is one strictly parsed mailbox. If the header is ambiguous the address stays empty: the engine then holds
  // the mail for Manoj and never replies. The display name is decoded AFTER parsing so an encoded word cannot smuggle in
  // a second address.
  const mb = parseMailbox(from);
  const name = mb ? cleanName(decodeRFC2047(mb.rawName)) : '';
  const fromAddr = mb?.addr ?? '';
  return {
    id, threadId: msg.threadId ?? id, fromAddr, fromHeader: mb ? `${name || 'Unknown'} <${fromAddr}>` : '(unverifiable sender)',
    subject: decodeRFC2047(h('Subject')), body: trimEmailBody(extractPlainText(msg.payload)).slice(0, 2000),
    messageIdHeader: h('Message-ID').trim(), references: h('References').trim(), automated,
  };
}

const MSGID_RE = /^<[^<>\s]{1,200}>$/;

// A reply inside the original thread, from this mailbox, marked as automatic (RFC 3834) so other auto-responders do not
// answer it back. Every header value is stripped of CR/LF and the recipient re-validated here as the last line of defence.
export async function sendReplyInThread(m: { threadId: string; to: string; subject: string; inReplyTo: string; references: string; body: string }): Promise<{ ok: boolean; message: string }> {
  const to = m.to.trim();
  if (!isValidAddr(to)) return { ok: false, message: `Invalid recipient address: ${to.slice(0, 80)}` };
  if (!/^[a-zA-Z0-9]+$/.test(m.threadId)) return { ok: false, message: 'Invalid thread id.' };
  const token = await getGoogleAccessToken();
  if (!token) return { ok: false, message: 'Gmail not configured.' };

  const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ').trim();
  const rawSubject = oneLine(m.subject).slice(0, 200) || '(no subject)';
  const subject = /^re:/i.test(rawSubject) ? rawSubject : `Re: ${rawSubject}`;
  const encSubject = /^[\x20-\x7e]*$/.test(subject) ? subject : `=?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`;
  const inReplyTo = MSGID_RE.test(m.inReplyTo.trim()) ? m.inReplyTo.trim() : '';
  const refs = [...m.references.split(/\s+/), inReplyTo].filter(r => MSGID_RE.test(r)).slice(-10).join(' ');
  const bodyB64 = Buffer.from(m.body.replace(/\r?\n/g, '\r\n')).toString('base64').replace(/(.{76})/g, '$1\r\n');

  const raw = [
    `To: ${to}`, `Subject: ${encSubject}`,
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`] : []), ...(refs ? [`References: ${refs}`] : []),
    'Auto-Submitted: auto-replied', 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64',
    '', bodyB64,
  ].join('\r\n');
  const encoded = Buffer.from(raw).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const res = await fetch('https://www.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: encoded, threadId: m.threadId }),
  });
  if (!res.ok) return { ok: false, message: `Send failed: ${res.status}` };
  return { ok: true, message: `Reply sent to ${to}.` };
}
