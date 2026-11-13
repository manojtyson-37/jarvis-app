import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LinkedInInbox, inActiveHours, istHour, nextDelayMs, parseLinkedInCallback, linkedinCard, groupByConversation, EDIT_TTL_MS } from './linkedin.mjs';

// 10:00 IST = 04:30 UTC
const DAY_IST = Date.UTC(2026, 10, 13, 4, 30);
const msgs = [
  { id: 'e1', conversation: '2-P', sender: 'Pushpita Mazumdar', text: 'Please share your CV and details' },
  { id: 'e2', conversation: '2-S', sender: 'Sanjeev', text: 'Next steps for Senior PM (remote)' },
];

function rig({ pollOut = { messages: msgs }, pollCode = 0, sendCode = 0, sendOk = () => true, now = DAY_IST, draft = async ({ sender }) => ({ kind: 'recruiter', draft: `Thanks ${sender}` }) } = {}) {
  const calls = { worker: [], tg: [], answers: [] };
  let t = now;
  const inbox = new LinkedInInbox({
    now: () => t,
    worker: async (cmd, args, stdin) => {
      calls.worker.push({ cmd, args, stdin });
      if (cmd === 'poll') return { code: pollCode, out: pollCode === 0 ? pollOut : { error: 'x' } };
      if (cmd === 'send') return { code: sendCode, out: {} };
      return { code: 0, out: {} };
    },
    draft,
    send: async (text, extra = {}) => { calls.tg.push({ text, extra }); return { ok: sendOk(text) }; },
  });
  const sends = () => calls.worker.filter(w => w.cmd === 'send');
  const tokens = () => calls.tg.filter(m => m.extra.reply_markup).map(m => m.extra.reply_markup.inline_keyboard[0][0].callback_data.split(':')[1]);
  const answer = async a => { calls.answers.push(a); };
  return { inbox, calls, sends, tokens, answer, advance: ms => { t += ms; } };
}

// ---- quiet hours ----
test('IST hour maths', () => {
  assert.equal(istHour(new Date(Date.UTC(2026, 0, 1, 2, 30))), 8);
  assert.equal(istHour(new Date(Date.UTC(2026, 0, 1, 17, 29))), 22);
  assert.equal(istHour(new Date(Date.UTC(2026, 0, 1, 17, 30))), 23);
  assert.equal(istHour(new Date(Date.UTC(2026, 0, 1, 18, 45))), 0);
});
test('active only 08:00 to 23:00 IST', () => {
  assert.equal(inActiveHours(new Date(Date.UTC(2026, 0, 1, 2, 29))), false); // 07:59
  assert.equal(inActiveHours(new Date(Date.UTC(2026, 0, 1, 2, 30))), true);  // 08:00
  assert.equal(inActiveHours(new Date(Date.UTC(2026, 0, 1, 17, 29))), true); // 22:59
  assert.equal(inActiveHours(new Date(Date.UTC(2026, 0, 1, 17, 30))), false); // 23:00
});
test('quiet hours: poll does not touch LinkedIn', async () => {
  const r = rig({ now: Date.UTC(2026, 10, 13, 20, 0) }); // 01:30 IST
  assert.equal(await r.inbox.poll(), 'quiet');
  assert.equal(r.calls.worker.length, 0);
});
test('jitter between 15 and 20 minutes', () => {
  assert.equal(nextDelayMs(0), 15 * 60000);
  assert.equal(nextDelayMs(1), 20 * 60000);
  for (let i = 0; i < 50; i++) { const d = nextDelayMs(); assert.ok(d >= 15 * 60000 && d <= 20 * 60000); }
});

// ---- dedupe (bridge side) ----
test('mark seen only after the card was delivered', async () => {
  const r = rig({ sendOk: t => !t.includes('Sanjeev') });
  assert.equal(await r.inbox.poll(), 'shown 1');
  const marks = r.calls.worker.filter(w => w.cmd === 'mark');
  assert.deepEqual(marks.map(m => m.args), [['e1']]); // Sanjeev's card failed, so it is retried next poll
});
test('several messages in one thread make one card', () => {
  const g = groupByConversation([...msgs, { id: 'e3', conversation: '2-P', sender: 'Pushpita Mazumdar', text: 'Also notice period?' }]);
  assert.equal(g.length, 2);
  assert.deepEqual(g[0].ids, ['e1', 'e3']);
});

// ---- approval gating ----
test('poll alone never sends anything to LinkedIn', async () => {
  const r = rig();
  await r.inbox.poll();
  assert.equal(r.sends().length, 0);
  assert.equal(r.tokens().length, 2);
});
test('Approve sends exactly the shown draft, once', async () => {
  const r = rig();
  await r.inbox.poll();
  const [tok] = r.tokens();
  assert.equal(await r.inbox.onCallback(`la:${tok}`, r.answer), true);
  assert.equal(r.sends().length, 1);
  assert.deepEqual(JSON.parse(r.sends()[0].stdin), { conversation: '2-P', text: 'Thanks Pushpita Mazumdar' });
  await r.inbox.onCallback(`la:${tok}`, r.answer); // double tap
  assert.equal(r.sends().length, 1);
  assert.equal(r.calls.answers.at(-1), 'This card has expired.');
});
test('Approve answers the button before the slow send', async () => {
  const r = rig();
  await r.inbox.poll();
  await r.inbox.onCallback(`la:${r.tokens()[0]}`, r.answer);
  assert.equal(r.calls.answers[0], 'Sending...');
});
test('failed mark pauses LinkedIn so cards never repeat', async () => {
  const r = rig();
  r.inbox.d.worker = async (cmd) => (cmd === 'poll' ? { code: 0, out: { messages: msgs } } : { code: 4, out: { error: 'disk' } });
  assert.match(await r.inbox.poll(), /paused/);
  assert.equal(r.inbox.halted, true);
  r.inbox.d.gmailFallback = async () => { throw new Error('must not run'); };
  assert.equal(await r.inbox.poll(), 'halted'); // no LinkedIn call, no Gmail copies
});
test('send failure (code 4) says it may have failed', async () => {
  const r = rig({ sendCode: 4 });
  await r.inbox.poll();
  await r.inbox.onCallback(`la:${r.tokens()[0]}`, r.answer);
  assert.ok(r.calls.tg.some(m => /may have failed/.test(m.text)));
});
test('send refused for auth (code 3) pauses and alerts once', async () => {
  const r = rig({ sendCode: 3 });
  await r.inbox.poll();
  await r.inbox.onCallback(`la:${r.tokens()[0]}`, r.answer);
  assert.equal(r.inbox.paused, true);
  assert.equal(r.calls.tg.filter(m => /re-copy the LinkedIn cookie/.test(m.text)).length, 1);
  assert.ok(r.calls.tg.some(m => /Not sent to Pushpita/.test(m.text)));
});
test('Gmail fallback shows each email once, raw', async () => {
  const r = rig({ pollCode: 3 });
  r.inbox.d.gmailFallback = async () => [{ id: 'g1', from: 'Pushpita', subject: 'New message', snippet: 'CV please' }];
  await r.inbox.poll();             // auth lost -> paused
  assert.equal(await r.inbox.poll(), 'fallback 1');
  r.advance(3 * 60 * 60 * 1000);
  assert.equal(await r.inbox.poll(), 'fallback 0');
  assert.equal(r.calls.tg.filter(m => m.text.includes('CV please')).length, 1);
});
test('Skip never sends and kills the card', async () => {
  const r = rig();
  await r.inbox.poll();
  const [tok] = r.tokens();
  await r.inbox.onCallback(`ls:${tok}`, r.answer);
  await r.inbox.onCallback(`la:${tok}`, r.answer);
  assert.equal(r.sends().length, 0);
});
test('made-up or foreign token sends nothing', async () => {
  const r = rig();
  await r.inbox.poll();
  await r.inbox.onCallback('la:AAAAAAAAAAAA', r.answer);
  assert.equal(r.sends().length, 0);
  assert.equal(await r.inbox.onCallback('a:AAAAAAAAAAAA', r.answer), false); // Maya action button: not ours
});
test('no draft: card has no Approve, and approve is refused', async () => {
  const r = rig({ draft: async () => null });
  await r.inbox.poll();
  const kb = r.calls.tg.find(m => m.extra.reply_markup).extra.reply_markup.inline_keyboard[0];
  assert.deepEqual(kb.map(b => b.text), ['Edit', 'Skip']);
  const tok = kb[0].callback_data.split(':')[1];
  await r.inbox.onCallback(`la:${tok}`, r.answer);
  assert.equal(r.sends().length, 0);
});
test('Edit: next message becomes a new card; only its Approve sends the edited text', async () => {
  const r = rig();
  await r.inbox.poll();
  const [tok] = r.tokens();
  await r.inbox.onCallback(`le:${tok}`, r.answer);
  assert.equal(r.sends().length, 0);
  assert.equal(await r.inbox.onText('Hi Pushpita, sharing my CV by email today.'), true);
  assert.equal(r.sends().length, 0); // editing alone sends nothing
  const t2 = r.tokens().at(-1);
  assert.notEqual(t2, tok);
  await r.inbox.onCallback(`la:${tok}`, r.answer); // old card dead
  assert.equal(r.sends().length, 0);
  await r.inbox.onCallback(`la:${t2}`, r.answer);
  assert.equal(JSON.parse(r.sends()[0].stdin).text, 'Hi Pushpita, sharing my CV by email today.');
});
test('Edit /cancel keeps the original card', async () => {
  const r = rig();
  await r.inbox.poll();
  const [tok] = r.tokens();
  await r.inbox.onCallback(`le:${tok}`, r.answer);
  assert.equal(await r.inbox.onText('/cancel'), true);
  await r.inbox.onCallback(`la:${tok}`, r.answer);
  assert.equal(r.sends().length, 1);
});
test('stale edit: message goes to normal chat instead', async () => {
  const r = rig();
  await r.inbox.poll();
  await r.inbox.onCallback(`le:${r.tokens()[0]}`, r.answer);
  r.advance(EDIT_TTL_MS + 1);
  assert.equal(await r.inbox.onText('what is on my calendar'), false);
});
test('no edit open: text is not consumed', async () => {
  const r = rig();
  assert.equal(await r.inbox.onText('hello'), false);
});

// ---- session loss ----
test('auth failure: one alert, polling stops', async () => {
  const r = rig({ pollCode: 3 });
  assert.equal(await r.inbox.poll(), 'auth');
  assert.equal(await r.inbox.poll(), 'paused');
  assert.equal(r.calls.worker.filter(w => w.cmd === 'poll').length, 1);
  assert.equal(r.calls.tg.filter(m => /re-copy the LinkedIn cookie/.test(m.text)).length, 1);
});

// ---- card text ----
test('card shows full message and draft; plain text only', () => {
  const c = linkedinCard({ sender: 'X', texts: ['<b>hi</b> [link](http://evil)'], kind: 'sales', draft: 'No thanks' }, 'tok12345');
  assert.ok(c.parts.join('').includes('<b>hi</b> [link](http://evil)'));
  assert.ok(c.parts.join('').includes('No thanks'));
  assert.deepEqual(parseLinkedInCallback('la:tok12345'), { decision: 'approve', token: 'tok12345' });
  assert.equal(parseLinkedInCallback('lx:tok12345'), null);
});
