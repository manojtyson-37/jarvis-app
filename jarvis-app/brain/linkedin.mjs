// LinkedIn inbox for maya-brain. Polls through the Python worker (li.py), asks Maya for a tool-less draft,
// and shows Manoj a Telegram card with Approve / Edit / Skip. A LinkedIn message is sent ONLY from the
// Approve handler, with the exact draft text stored for that card's one-time token.
// Everything with side effects is injected, so the whole flow is unit-tested with fakes.
import { randomBytes } from 'node:crypto';
import { splitMessage } from './lib.mjs';

export const ACTIVE_FROM = 8, ACTIVE_TO = 23; // IST hours, polling only in [08:00, 23:00)
export const EDIT_TTL_MS = 30 * 60 * 1000;
export const CARD_TTL_MS = 3 * 24 * 60 * 60 * 1000;
export const FALLBACK_EVERY_MS = 2 * 60 * 60 * 1000;

export function istHour(now = new Date()) {
  return (now.getUTCHours() + 5 + Math.floor((now.getUTCMinutes() + 30) / 60)) % 24;
}
export function inActiveHours(now = new Date()) {
  const h = istHour(now);
  return h >= ACTIVE_FROM && h < ACTIVE_TO;
}
// 15 to 20 minutes, random each time so the polling has no fixed rhythm.
export function nextDelayMs(rand = Math.random()) {
  return Math.round((15 + 5 * rand) * 60 * 1000);
}

// Group new messages by conversation: one card per thread, in arrival order.
export function groupByConversation(messages) {
  const map = new Map();
  for (const m of messages) {
    if (!map.has(m.conversation)) map.set(m.conversation, { conversation: m.conversation, sender: m.sender, ids: [], texts: [] });
    const g = map.get(m.conversation);
    g.ids.push(m.id); g.texts.push(m.text);
  }
  return [...map.values()];
}

export function parseLinkedInCallback(data) {
  const m = /^l([aes]):([A-Za-z0-9_-]{8,20})$/.exec(String(data ?? ''));
  if (!m) return null;
  return { decision: { a: 'approve', e: 'edit', s: 'skip' }[m[1]], token: m[2] };
}

// Card text is plain (no parse_mode), so nothing in a stranger's message can format or link-spoof it.
export function linkedinCard({ sender, texts, kind, draft }, token) {
  const theirs = texts.join('\n\n');
  const head = `LinkedIn${kind ? ` · ${kind}` : ''}\nFrom: ${sender}\n\n${theirs}\n\n`;
  const tail = draft ? `Draft reply (Approve sends exactly this):\n${draft}` : 'Maya could not draft a reply. Tap Edit to write one, or Skip.';
  const buttons = draft
    ? [{ text: 'Approve', callback_data: `la:${token}` }, { text: 'Edit', callback_data: `le:${token}` }, { text: 'Skip', callback_data: `ls:${token}` }]
    : [{ text: 'Edit', callback_data: `le:${token}` }, { text: 'Skip', callback_data: `ls:${token}` }];
  return { parts: splitMessage(head + tail), reply_markup: { inline_keyboard: [buttons] } };
}

export class LinkedInInbox {
  // deps: worker(cmd, args, stdin) -> {code, out}; draft({sender,text}) -> {kind,draft}|null;
  //       send(text, extra) -> {ok}; store {load(), save(obj)}; now() -> ms; log(...)
  constructor(deps) {
    this.d = { now: () => Date.now(), log: () => {}, ...deps };
    const s = this.d.store?.load?.() ?? {};
    this.cards = new Map(Object.entries(s.cards ?? {}));
    this.editing = null; // { token, at }
    this.paused = false;
    this.halted = false; // set when seen-marking fails; stops LinkedIn and Gmail fallback alike
    this.busy = false;
    this.lastFallback = 0;
  }

  persist() { this.d.store?.save?.({ cards: Object.fromEntries(this.cards) }); }

  newToken() { return randomBytes(9).toString('base64url'); }

  sweep() {
    const now = this.d.now();
    for (const [k, v] of this.cards) if (now - v.at > CARD_TTL_MS) this.cards.delete(k);
  }

  async deliver(card, token) {
    const c = linkedinCard(card, token);
    for (let i = 0; i < c.parts.length; i++) {
      const last = i === c.parts.length - 1;
      const r = await this.d.send(c.parts[i], last ? { reply_markup: c.reply_markup } : {});
      if (!r?.ok) return false;
    }
    return true;
  }

  async authLost() {
    if (this.paused) return;
    this.paused = true;
    await this.d.send('LinkedIn signed me out. Please re-copy the LinkedIn cookie (run set-cookie.sh). Until then I will watch Gmail for LinkedIn message emails.');
  }

  // One poll. Returns a short status string for logs/tests.
  async poll() {
    if (this.halted) return 'halted';
    if (this.busy) return 'busy';
    if (!inActiveHours(new Date(this.d.now()))) return 'quiet';
    if (this.paused) return this.fallback();
    this.busy = true;
    try {
      const r = await this.d.worker('poll', []);
      if (r.code === 3) { await this.authLost(); return 'auth'; }
      if (r.code !== 0) { this.d.log('linkedin poll failed', r.out?.error); return 'error'; }
      if (r.out.skipped > 0) this.d.log(`linkedin poll skipped ${r.out.skipped} thread(s) this round`);
      const groups = groupByConversation(r.out.messages ?? []);
      this.sweep();
      let shown = 0;
      for (const g of groups) {
        const text = g.texts.join('\n\n');
        const dr = await this.d.draft({ sender: g.sender, text }).catch(() => null);
        const card = { conversation: g.conversation, sender: g.sender, texts: g.texts, kind: dr?.kind ?? '', draft: dr?.draft ?? '', at: this.d.now() };
        const token = this.newToken();
        this.cards.set(token, card);
        this.persist();
        if (await this.deliver(card, token)) {
          const mk = await this.d.worker('mark', g.ids); // seen only after Manoj actually has the card
          shown++;
          if (mk.code !== 0) {
            // Unmarked ids would come back as duplicate cards every poll: stop until restart.
            this.d.log('linkedin mark failed', mk.out?.error);
            this.halted = true;
            await this.d.send('LinkedIn: I could not record which messages I showed you, so I paused LinkedIn checks to avoid repeats. Restart maya-brain to resume.');
            return `shown ${shown}, paused`;
          }
        } else {
          this.cards.delete(token); this.persist(); // next poll retries the whole card
        }
      }
      return `shown ${shown}`;
    } finally { this.busy = false; }
  }

  async fallback() {
    if (!this.d.gmailFallback) return 'paused';
    if (this.d.now() - this.lastFallback < FALLBACK_EVERY_MS) return 'paused';
    this.lastFallback = this.d.now();
    const emails = await this.d.gmailFallback().catch(() => null);
    if (!emails) return 'fallback failed';
    this.gmailSeen ??= new Set();
    let shown = 0;
    for (const e of emails) {
      if (!e?.id || this.gmailSeen.has(e.id)) continue;
      const r = await this.d.send(`LinkedIn (from Gmail, cookie is off)\nFrom: ${e.from}\n${e.subject}\n\n${e.snippet}`);
      if (r?.ok) { this.gmailSeen.add(e.id); shown++; }
    }
    return `fallback ${shown}`;
  }

  // Returns true if this callback was a LinkedIn button (handled), false otherwise.
  async onCallback(data, answer) {
    const p = parseLinkedInCallback(data);
    if (!p) return false;
    const card = this.cards.get(p.token);
    if (!card) { await answer('This card has expired.'); return true; }

    if (p.decision === 'skip') {
      this.cards.delete(p.token); this.persist();
      if (this.editing?.token === p.token) this.editing = null;
      await answer('Skipped.');
      return true;
    }
    if (p.decision === 'edit') {
      this.editing = { token: p.token, at: this.d.now() };
      await answer('Send me the new reply.');
      await this.d.send(`Send the reply text for ${card.sender} as your next message (or /cancel).`);
      return true;
    }
    // approve: spend the token first, so a double tap can never send twice.
    if (!card.draft) { await answer('Nothing to send yet. Tap Edit.'); return true; }
    this.cards.delete(p.token); this.persist();
    if (this.editing?.token === p.token) this.editing = null;
    await answer('Sending...'); // answer now: Telegram drops late callback answers
    const r = await this.d.worker('send', [], JSON.stringify({ conversation: card.conversation, text: card.draft }));
    this.d.log(`linkedin send exit ${r.code}${r.out?.error ? ` (${r.out.error})` : ''}`); // no message text in logs
    if (r.code === 0) {
      await this.d.send(`Sent to ${card.sender} on LinkedIn.`);
    } else if (r.code === 3) {
      await this.authLost();
      await this.d.send(`Not sent to ${card.sender}: LinkedIn signed me out.`);
    } else {
      await this.d.send(`Sending to ${card.sender} may have failed. Please check LinkedIn before trying again.`);
    }
    return true;
  }

  // Owner text while an Edit is open becomes the new draft, shown again for Approve. Returns true if consumed.
  async onText(text) {
    if (!this.editing) return false;
    const { token, at } = this.editing;
    this.editing = null;
    if (this.d.now() - at > EDIT_TTL_MS) return false; // stale edit: treat as a normal chat message
    const card = this.cards.get(token);
    if (!card) return false;
    if (text.trim() === '/cancel') { await this.d.send('Edit cancelled. The card above still works.'); return true; }
    const next = { ...card, draft: text.trim().slice(0, 8000), at: this.d.now() };
    const t2 = this.newToken();
    this.cards.set(t2, next);
    this.persist();
    if (await this.deliver(next, t2)) {
      this.cards.delete(token); // old card's buttons stop working only once the new one is on screen
    } else {
      this.cards.delete(t2);
      await this.d.send('Could not show the edited card. The earlier card still works.');
    }
    this.persist();
    return true;
  }

  resume() { this.paused = false; }
}
