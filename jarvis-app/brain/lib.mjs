// Pure helpers for the maya-brain Telegram bridge. No I/O here, so every rule is unit-tested.
import { randomBytes } from 'node:crypto';

export const TG_LIMIT = 4000; // Telegram's hard cap is 4096; keep headroom.

// Only Manoj's own private chat may talk to Maya or press approval buttons.
export function ownerMessage(update, ownerId) {
  const m = update?.message;
  if (!m || !ownerId) return null;
  if (m.chat?.type !== 'private') return null;
  if (String(m.chat.id) !== String(ownerId) || String(m.from?.id) !== String(ownerId)) return null;
  return m;
}

export function ownerCallback(update, ownerId) {
  const c = update?.callback_query;
  if (!c || !ownerId) return null;
  if (String(c.from?.id) !== String(ownerId)) return null;
  if (String(c.message?.chat?.id) !== String(ownerId)) return null;
  return c;
}

// Maya's /api/chat answers as server-sent events: data: {"chunk":"..."} lines, then data: [DONE].
export function parseSSE(body) {
  let reply = '';
  for (const line of String(body).split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const payload = line.slice(6).trim();
    if (payload === '[DONE]') break;
    try {
      const ev = JSON.parse(payload);
      if (typeof ev.chunk === 'string') reply += ev.chunk;
    } catch { /* ignore malformed line */ }
  }
  return reply.trim();
}

export function splitMessage(text, limit = TG_LIMIT) {
  const out = [];
  let rest = String(text ?? '');
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < limit / 2) cut = limit;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest.trim() || out.length === 0) out.push(rest);
  return out;
}

// Telegram callback_data is capped at 64 bytes, too small for an id plus a 64-char hash,
// so buttons carry a short random token that maps to the exact {id, hash} shown on screen.
export class ApprovalTokens {
  constructor(ttlMs = 24 * 60 * 60 * 1000) { this.map = new Map(); this.ttlMs = ttlMs; }
  issue(id, hash, now = Date.now()) {
    this.sweep(now);
    const token = randomBytes(9).toString('base64url');
    this.map.set(token, { id, hash, at: now });
    return token;
  }
  take(token, now = Date.now()) {
    const v = this.map.get(token);
    if (!v) return null;
    this.map.delete(token); // one press only
    if (now - v.at > this.ttlMs) return null;
    return { id: v.id, hash: v.hash };
  }
  sweep(now = Date.now()) {
    for (const [k, v] of this.map) if (now - v.at > this.ttlMs) this.map.delete(k);
  }
}

// The read-back: the FULL action text (never cut, split over several messages if long), then two buttons
// on the last message. Approve is bound to the hash of exactly this text. One token per card, so pressing
// either button spends it and the other stops working.
export function approvalCard(action, tokens) {
  const body = action.detail && action.detail !== action.summary ? `${action.summary}\n\n${action.detail}` : action.summary;
  const parts = splitMessage(`Needs your OK:\n\n${body}`);
  const token = tokens.issue(action.id, action.hash);
  return {
    parts,
    reply_markup: { inline_keyboard: [[
      { text: 'Approve', callback_data: `a:${token}` },
      { text: 'Reject', callback_data: `r:${token}` },
    ]] },
  };
}

export function parseCallback(data) {
  const m = /^([ar]):([A-Za-z0-9_-]{8,20})$/.exec(String(data ?? ''));
  if (!m) return null;
  return { decision: m[1] === 'a' ? 'approve' : 'reject', token: m[2] };
}
