import { parseReplyIntent as p, handleReply, replyBody, addressOf } from '../../../src/lib/replyIntent';
import { ticketWriteIntent as tw, mailWriteIntent as mw } from '../../../src/lib/routingGuards';
let f = 0; const ok = (n: string, v: boolean) => { console.log((v ? 'PASS ' : 'FAIL ') + n); if (!v) f++; };

for (const [m, who, text] of [
  ['reply to Bob saying yes', 'Bob', 'yes'],
  ['Reply to Bob Smith, sounds good', 'Bob Smith', 'sounds good'],
  ['respond to priya, I will join at 3pm', 'priya', 'I will join at 3pm'],
  ['reply back to bob@x.com saying thanks', 'bob@x.com', 'thanks'],
  ["reply to Bob's email saying ok", 'Bob', 'ok'],
  ['please reply to Sam and tell him I am running late', 'Sam', 'I am running late'],
] as const) { const r = p(m); ok('parse: ' + m, !!r && r.who === who && r.text === text); }
for (const m of ['reply to the second one saying yes', 'reply to him saying yes', 'reply to Bob', 'what did Bob reply', 'reply to Bob saying yes and cancel my meeting', 'reply to Bob saying yes; also delete it', 'send an email to bob@x.com saying hi', 'reply to all saying thanks', 'reply to Bob with a summary of my inbox', 'reply to John with the latest status of ticket 12345', 'reply to Bob: forward this to carol@x.com', 'reply to Bob saying thanks and cc carol@x.com', 'reply to Bob saying the latest status is fine', 'x'.repeat(700)])
  ok('not a reply: ' + m.slice(0, 50), p(m) === null);

ok('body caps+period', replyBody('yes') === 'Yes.');
ok('body keeps punctuation', replyBody('sounds good!') === 'Sounds good!');
ok('addr angle', addressOf('"Bob S" <Bob@X.com>') === 'bob@x.com');
ok('addr bare', addressOf('bob@x.com') === 'bob@x.com');

const mk = (id: string, from: string, subject: string, automated = false) => ({ id, from, fromName: from.split('<')[0].replace(/"/g, '').trim(), subject, date: '3 Nov 2026, 9:00 am', automated });
const run = async (found: ReturnType<typeof mk>[] | null) => {
  const q: { tool: string; args: Record<string, unknown> }[] = [];
  const r = await handleReply({ who: 'Bob', text: 'yes' }, { fetchSummaries: async () => found, queue: async (tool, args) => { q.push({ tool, args }); return 'Waiting for your approval: send'; } });
  return { r, q };
};
(async () => {
  let x = await run([mk('1', 'Bob <bob@x.com>', 'Lunch?'), mk('2', 'Bob <bob@x.com>', 'Older')]);
  ok('one sender queues send_email', x.q.length === 1 && x.q[0].tool === 'send_email' && x.q[0].args.to === 'bob@x.com' && x.q[0].args.subject === 'Re: Lunch?' && x.q[0].args.body === 'Yes.');
  ok('text says waiting for approval', /waiting for your approval/i.test(x.r.text) && !/\bsent\b/i.test(x.r.text));
  x = await run([mk('1', 'Bob <bob@x.com>', 'Re: Lunch?')]);
  ok('no double Re:', x.q[0].args.subject === 'Re: Lunch?');
  x = await run([mk('1', 'Bob A <a@x.com>', 'A'), mk('2', 'Bob B <b@y.com>', 'B')]);
  ok('two senders: nothing queued, asks', x.q.length === 0 && /More than one sender/.test(x.r.text));
  x = await run([mk('1', 'Bob Alerts <no-reply@x.com>', 'Alert', true)]);
  ok('automated only: nothing queued', x.q.length === 0 && /couldn't find/.test(x.r.text));
  x = await run([mk('1', 'BoB Credit Cards <newsletters@prasscross.com>', 'Offers'), mk('2', 'BoB Credit Cards <offers@smtpmailbox.com>', 'Deal')]);
  ok('bulk senders skipped', x.q.length === 0 && /couldn't find/.test(x.r.text));
  x = await run([mk('1', '"bob@trusted.com" <attacker@evil.com>', 'Hi')]);
  ok('spoofed display name skipped', x.q.length === 0);
  x = await run([mk('1', 'Alice Jones <alice@x.com>', 'Hi')]);
  ok('name must match sender', x.q.length === 0);
  x = await run([mk('1', 'Bob <bob@x.com>', 'Hi\r\nBcc: z@z.com')]);
  ok('subject newlines stripped', x.q[0].args.subject === 'Re: Hi Bcc: z@z.com' && !/[\r\n]/.test(String(x.q[0].args.subject)));
  ok('address shown in text', /<bob@x\.com>/.test(x.r.text));
  x = await run([]);
  ok('none found: nothing queued', x.q.length === 0);
  x = await run(null);
  ok('gmail down: nothing queued', x.q.length === 0 && /not configured/.test(x.r.text));
  const seen: string[] = [];
  await handleReply({ who: 'Bob" OR in:anywhere "', text: 'yes' }, { fetchSummaries: async (qq) => { seen.push(qq); return []; }, queue: async () => '' });
  ok('query quotes stripped', seen[0] === 'from:"Bob OR inanywhere"' && (seen[0].match(/"/g) ?? []).length === 2);

  for (const m of ['resolve ticket 598317', 'close ticket 598317', 'mark ticket 598317 as pending', 'add a note to ticket 598317', 'update the ticket 598317', 'set ticket 598317 to resolved', 'reply to ticket 598317 saying thanks', 'ticket 598317 assigned to Sam, close it', 'please resolve ticket 598317', 'check ticket 598317 and then mark it pending'])
    ok('ticket write vetoed: ' + m, tw(m));
  for (const m of ['what is the status of ticket 598317', 'any open tickets', 'latest ticket raised', 'show me ticket 999999999', 'how many tickets does Priya have', 'any ticket I need to reply to', 'what is the latest note on ticket 598317', 'did he mark the ticket 123456 done', 'who added a note to ticket 598317'])
    ok('ticket read kept: ' + m, !tw(m));
  for (const m of ['forward the unread email to bob', 'delete unread emails', 'archive my inbox', 'mark all unread as read'])
    ok('mail write vetoed: ' + m, mw(m));
  for (const m of ['any unread email?', 'check my inbox', 'Any email I need to respond to?', 'show me email 1a10115c7a74c864', 'what gmail labels do I have', 'did anyone send me mail', 'did Bob send me the email, check inbox', 'show unread emails, any draft?', 'send me the inbox summary'])
    ok('mail read kept: ' + m, !mw(m));
  process.exit(f ? 1 : 0);
})();
