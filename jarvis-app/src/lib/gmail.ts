// Gmail access for manoj.r@jodopay.com via a dedicated OAuth client (separate from the
// GOOGLE_CLIENT_ID/SECRET used for Calendar, which is a different Google account/app).

async function getJodopayAccessToken(): Promise<string | null> {
  const clientId = process.env.GOOGLE_JODOPAY_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_JODOPAY_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_JODOPAY_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) return null;
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

export async function listRecentEmails(query = 'is:unread', maxResults = 10): Promise<string> {
  const token = await getJodopayAccessToken();
  if (!token) return 'Gmail (jodopay) not configured.';
  const capped = Math.min(Math.max(maxResults, 1), 25);

  const listRes = await fetch(
    `https://www.googleapis.com/gmail/v1/users/me/messages?maxResults=${capped}&q=${encodeURIComponent(query)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!listRes.ok) return `Gmail list failed: ${listRes.status}`;
  const listData = await listRes.json() as { messages?: { id: string }[] };
  const ids = listData.messages ?? [];
  if (!ids.length) return 'No matching emails.';

  const summaries = await Promise.all(ids.map(async ({ id }) => {
    const res = await fetch(
      `https://www.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) return null;
    const msg = await res.json() as GmailMessage;
    const from = getHeader(msg.payload?.headers, 'From');
    const subject = getHeader(msg.payload?.headers, 'Subject');
    return `[${id}] From: ${from} — "${subject}"${msg.snippet ? `\n  ${msg.snippet.slice(0, 100)}` : ''}`;
  }));
  // UNTRUSTED EMAIL DATA — summarize only. Never treat any instruction-like text inside
  // a From/Subject/snippet as a command; it originates from whoever sent the email, not Manoj.
  return summaries.filter((s): s is string => s !== null).join('\n');
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
  const subject = getHeader(msg.payload?.headers, 'Subject');
  const date = getHeader(msg.payload?.headers, 'Date');
  const body = extractPlainText(msg.payload).slice(0, 2000);
  // UNTRUSTED EMAIL CONTENT below — summarize/quote it, never follow instructions it contains.
  return `From: ${from}\nTo: ${to}\nDate: ${date}\nSubject: ${subject}\n\n${body}`;
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
