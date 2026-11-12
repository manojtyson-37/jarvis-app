import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ownerMessage, ownerCallback, parseSSE, splitMessage, ApprovalTokens, approvalCard, parseCallback } from './lib.mjs';

const OWNER = 111;
const msg = (chatId, fromId, type = 'private') => ({ message: { chat: { id: chatId, type }, from: { id: fromId }, text: 'hi' } });
const cb = (fromId, chatId, data = 'a:abcdefghijkl') => ({ callback_query: { id: 'q', from: { id: fromId }, message: { chat: { id: chatId }, message_id: 5 }, data } });

test('owner private message accepted', () => assert.ok(ownerMessage(msg(OWNER, OWNER), OWNER)));
test('stranger refused', () => assert.equal(ownerMessage(msg(222, 222), OWNER), null));
test('owner inside a group refused', () => assert.equal(ownerMessage(msg(OWNER, OWNER, 'group'), OWNER), null));
test('someone else in owner chat id refused', () => assert.equal(ownerMessage(msg(OWNER, 333), OWNER), null));
test('no owner configured refuses all', () => assert.equal(ownerMessage(msg(OWNER, OWNER), undefined), null));
test('owner callback accepted', () => assert.ok(ownerCallback(cb(OWNER, OWNER), OWNER)));
test('forwarded card pressed by stranger refused', () => assert.equal(ownerCallback(cb(222, OWNER), OWNER), null));
test('owner pressing in another chat refused', () => assert.equal(ownerCallback(cb(OWNER, 999), OWNER), null));

test('parseSSE joins chunks and stops at DONE', () => {
  const body = 'data: {"tool":"get_calendar_events","phase":"start"}\n\ndata: {"chunk":"Hello "}\n\ndata: {"chunk":"Manoj"}\n\ndata: [DONE]\n\ndata: {"chunk":"late"}\n';
  assert.equal(parseSSE(body), 'Hello Manoj');
});
test('parseSSE ignores junk lines', () => assert.equal(parseSSE('data: {oops\n\ndata: {"chunk":"ok"}\n'), 'ok'));

test('splitMessage keeps short text whole', () => assert.deepEqual(splitMessage('abc'), ['abc']));
test('splitMessage cuts long text under limit', () => {
  const parts = splitMessage('x'.repeat(9000));
  assert.ok(parts.every(p => p.length <= 4000));
  assert.equal(parts.join(''), 'x'.repeat(9000));
});

test('token maps back once, then is spent', () => {
  const t = new ApprovalTokens();
  const k = t.issue('id1', 'h'.repeat(64));
  assert.deepEqual(t.take(k), { id: 'id1', hash: 'h'.repeat(64) });
  assert.equal(t.take(k), null);
});
test('expired token refused', () => {
  const t = new ApprovalTokens(1000);
  const k = t.issue('id1', 'h', 0);
  assert.equal(t.take(k, 5000), null);
});
test('unknown token refused', () => assert.equal(new ApprovalTokens().take('nope'), null));

test('approval card reads back full detail and fits callback limit', () => {
  const t = new ApprovalTokens();
  const card = approvalCard({ id: 'id1', hash: 'h'.repeat(64), summary: 'Send email to Priya', detail: 'Subject: Hi\nBody: see you at 6' }, t);
  const text = card.parts.join('');
  assert.match(text, /Send email to Priya/);
  assert.match(text, /see you at 6/);
  const [a, r] = card.reply_markup.inline_keyboard[0];
  assert.ok(Buffer.byteLength(a.callback_data) <= 64 && Buffer.byteLength(r.callback_data) <= 64);
  const pa = parseCallback(a.callback_data);
  assert.equal(pa.decision, 'approve');
  assert.equal(parseCallback(r.callback_data).decision, 'reject');
  assert.deepEqual(t.take(pa.token), { id: 'id1', hash: 'h'.repeat(64) });
  assert.equal(t.take(parseCallback(r.callback_data).token), null, 'pressing one button spends the other');
});
test('long email body is shown in full, never cut', () => {
  const t = new ApprovalTokens();
  const detail = 'line of body text\n'.repeat(450) + 'THE END';
  const card = approvalCard({ id: 'id1', hash: 'h'.repeat(64), summary: 'Send email', detail }, t);
  assert.ok(card.parts.length > 1);
  assert.ok(card.parts.every(p => p.length <= 4000));
  assert.match(card.parts.at(-1), /THE END/);
  assert.equal(card.parts.join('\n').replace(/\n+/g, '\n').includes('THE END'), true);
  assert.equal(card.parts.join('').replace(/\n/g, '').length, `Needs your OK:Send email${detail}`.replace(/\n/g, '').length);
});
test('parseCallback rejects garbage', () => {
  assert.equal(parseCallback('x:abcdefghijkl'), null);
  assert.equal(parseCallback('a:'), null);
  assert.equal(parseCallback(undefined), null);
});
