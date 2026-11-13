// maya-brain: Telegram <-> Maya bridge. Runs on the droplet under systemd.
// Long-polls Telegram (no open port), forwards Manoj's messages to Maya's /api/chat on Vercel,
// and turns Maya's pending actions into Approve/Reject buttons. Maya's own approval gate still decides;
// this process only relays a button press with the exact hash that was shown.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { ownerMessage, ownerCallback, parseSSE, splitMessage, ApprovalTokens, approvalCard, parseCallback } from './lib.mjs';
import { LinkedInInbox, nextDelayMs, parseLinkedInCallback } from './linkedin.mjs';

const TG = process.env.MAYA_TELEGRAM_TOKEN;
const OWNER = process.env.MAYA_OWNER_CHAT_ID;
const MAYA = (process.env.MAYA_URL || 'https://maya.tysonlabs.in').replace(/\/$/, '');
const KEY = process.env.MAYA_BRAIN_KEY;
if (!TG || !OWNER || !KEY || KEY.length < 32) {
  console.error('missing MAYA_TELEGRAM_TOKEN, MAYA_OWNER_CHAT_ID or MAYA_BRAIN_KEY (>=32 chars)');
  process.exit(1);
}

const tokens = new ApprovalTokens();
const announced = new Set(); // pending action ids already shown as a card
let offset = 0;

async function tg(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${TG}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(method === 'getUpdates' ? 65000 : 20000),
  });
  const json = await res.json().catch(() => ({}));
  if (!json.ok) console.error(`telegram ${method} failed:`, res.status, json.description ?? '');
  return json;
}

async function maya(path, init = {}) {
  return fetch(`${MAYA}${path}`, {
    ...init,
    headers: { ...(init.headers || {}), Authorization: `Bearer ${KEY}` },
    redirect: 'manual', // a 307 to /login means the key was refused; never follow it
    signal: AbortSignal.timeout(90000),
  });
}

async function say(text, extra = {}) {
  for (const part of splitMessage(text)) {
    await tg('sendMessage', { chat_id: OWNER, text: part, disable_web_page_preview: true, ...extra });
  }
}

async function showPendingActions() {
  const res = await maya('/api/actions');
  if (res.status !== 200) { console.error('actions list failed:', res.status); return; }
  const { actions = [] } = await res.json();
  for (const a of actions) {
    if (a.status !== 'pending' || announced.has(a.id) || !a.hash) continue;
    announced.add(a.id);
    const card = approvalCard(a, tokens);
    // Full text first; the buttons ride on the last part, so nothing is approved unseen.
    // If any part fails, stop before the buttons and let the next poll resend the whole card.
    for (let i = 0; i < card.parts.length; i++) {
      const last = i === card.parts.length - 1;
      const r = await tg('sendMessage', { chat_id: OWNER, text: card.parts[i], disable_web_page_preview: true, ...(last ? { reply_markup: card.reply_markup } : {}) });
      if (!r.ok) { announced.delete(a.id); break; }
    }
  }
}

// ---------- LinkedIn inbox (Python worker does the LinkedIn calls) ----------
const STATE_DIR = process.env.MAYA_STATE_DIR || '/var/lib/maya-brain';
const PY = '/opt/maya-brain/li-venv/bin/python';
const LI = '/opt/maya-brain/linkedin/li.py';
const CARDS = `${STATE_DIR}/linkedin-cards.json`;

function worker(cmd, args, stdin) {
  return new Promise(resolve => {
    // Only what li.py needs: never the Telegram token or brain key.
    const env = { PATH: '/usr/bin:/bin', PYTHONDONTWRITEBYTECODE: '1', MAYA_STATE_DIR: STATE_DIR };
    for (const k of ['LINKEDIN_LI_AT', 'LINKEDIN_JSESSIONID', 'LINKEDIN_UA']) if (process.env[k]) env[k] = process.env[k];
    const p = spawn(PY, ['-I', LI, cmd, ...args], { env, timeout: 180000 });
    let out = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', () => {}); // library logging; may echo data, so never logged
    p.on('error', () => resolve({ code: 4, out: { error: 'spawn' } }));
    p.on('close', code => {
      let json = {};
      try { json = JSON.parse(out.trim().split('\n').pop() || '{}'); } catch { /* keep {} */ }
      resolve({ code: code ?? 4, out: json });
    });
    if (stdin) p.stdin.end(stdin); else p.stdin.end();
  });
}

async function draftReply({ sender, text }) {
  const res = await maya('/api/linkedin/draft', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sender, text }),
  });
  if (res.status !== 200) { console.error('linkedin draft failed:', res.status); return null; }
  return res.json();
}

// Cookie lost: LinkedIn's own notification emails, fetched raw (no LLM, no tools, no chat history).
async function gmailFallback() {
  const res = await maya('/api/linkedin/gmail');
  if (res.status !== 200) { console.error('linkedin gmail fallback failed:', res.status); return null; }
  return (await res.json()).emails ?? [];
}

const linkedin = process.env.LINKEDIN_LI_AT ? new LinkedInInbox({
  worker,
  draft: draftReply,
  gmailFallback,
  send: (text, extra = {}) => tg('sendMessage', { chat_id: OWNER, text, disable_web_page_preview: true, ...extra }),
  store: {
    load: () => { try { return JSON.parse(readFileSync(CARDS, 'utf8')); } catch { return {}; } },
    save: obj => { try { writeFileSync(`${CARDS}.tmp`, JSON.stringify(obj), { mode: 0o600 }); renameSync(`${CARDS}.tmp`, CARDS); } catch (e) { console.error('linkedin cards not saved:', e.code); } },
  },
  log: (...a) => console.error(...a),
}) : null;

function scheduleLinkedIn(delay) {
  setTimeout(async () => {
    try { console.log('linkedin poll:', await linkedin.poll()); } catch (e) { console.error('linkedin poll error:', e.name); }
    scheduleLinkedIn(nextDelayMs());
  }, delay);
}

async function onMessage(m) {
  const text = m.text?.trim();
  if (!text) { await say('I can read text messages for now. Voice notes are coming next.'); return; }
  if (linkedin && await linkedin.onText(text)) return; // reply text for an open LinkedIn Edit
  if (text === '/start') { await say('Hi Manoj, Maya here. Ask me anything or tell me what to do.'); return; }
  await tg('sendChatAction', { chat_id: OWNER, action: 'typing' });
  const res = await maya('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: text }),
  });
  if (res.status !== 200) {
    console.error('chat failed:', res.status);
    await say(res.status === 307 ? 'My access key was refused. Manoj, the brain key needs fixing.' : 'Sorry, I could not reach Maya just now. Please try again.');
    return;
  }
  const reply = parseSSE(await res.text());
  await say(reply || 'Done.');
  await showPendingActions();
}

async function onCallback(c) {
  if (linkedin && parseLinkedInCallback(c.data)) {
    const answer = text => tg('answerCallbackQuery', { callback_query_id: c.id, text });
    await linkedin.onCallback(c.data, answer);
    if (parseLinkedInCallback(c.data).decision !== 'edit') {
      await tg('editMessageReplyMarkup', { chat_id: OWNER, message_id: c.message.message_id, reply_markup: { inline_keyboard: [] } });
    }
    return;
  }
  const parsed = parseCallback(c.data);
  const entry = parsed && tokens.take(parsed.token);
  if (!entry) {
    await tg('answerCallbackQuery', { callback_query_id: c.id, text: 'This button has expired. Ask me again.' });
    return;
  }
  const body = parsed.decision === 'approve' ? { decision: 'approve', hash: entry.hash } : { decision: 'reject' };
  const res = await maya(`/api/actions/${entry.id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const out = await res.json().catch(() => ({}));
  const note = out.message || (res.ok ? (parsed.decision === 'approve' ? 'Done.' : 'Cancelled.') : 'That did not go through.');
  await tg('answerCallbackQuery', { callback_query_id: c.id, text: note.slice(0, 190) });
  await tg('editMessageReplyMarkup', { chat_id: OWNER, message_id: c.message.message_id, reply_markup: { inline_keyboard: [] } });
  await say(`${parsed.decision === 'approve' ? 'Approved' : 'Rejected'}: ${note}`);
}

async function loop() {
  console.log('maya-brain started');
  for (;;) {
    try {
      const r = await tg('getUpdates', { offset, timeout: 50, allowed_updates: ['message', 'callback_query'] });
      if (!r.ok) { await new Promise(res => setTimeout(res, 5000)); continue; } // 401/409: back off, don't spin
      for (const u of r.result ?? []) {
        offset = u.update_id + 1;
        try {
          const m = ownerMessage(u, OWNER);
          if (m) { await onMessage(m); continue; }
          const c = ownerCallback(u, OWNER);
          if (c) { await onCallback(c); continue; }
          if (u.message || u.callback_query) console.log('ignored update from non-owner');
        } catch (e) {
          console.error('update failed:', e.name, e.message);
          await say('Something went wrong on my side. Please try again.').catch(() => {});
        }
      }
    } catch (e) {
      console.error('poll error:', e.name);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

// Actions queued without a chat turn (to-do runner, crons) still reach Manoj within a minute.
setInterval(() => { showPendingActions().catch(e => console.error('pending check failed:', e.name)); }, 60000);

if (linkedin) scheduleLinkedIn(60000);

loop();
