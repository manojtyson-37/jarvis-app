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
for (const m of ['reply to the second one saying yes', 'reply to him saying yes', 'reply to Bob', 'what did Bob reply', 'reply to Bob saying yes and cancel my meeting', 'reply to Bob saying yes; also delete it', 'send an email to bob@x.com saying hi', 'reply to all saying thanks', 'reply to x saying yes', 'reply to Sam saying close ticket 5', 'reply to ticket saying ok', 'reply to Sam saying yes and sms alice', 'reply to Bob saying notify the team', 'reply to Sam saying yes, and loop in alice', 'reply to Bob with a summary of my inbox', 'reply to John with the latest status of ticket 12345', 'reply to Bob: forward this to carol@x.com', 'reply to Bob saying thanks and cc carol@x.com', 'reply to Bob saying the latest status is fine', 'x'.repeat(700)])
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
  x = await run([mk('1', 'Bobby Tables <bobby@x.com>', 'Hi')]);
  ok('bob must not match Bobby', x.q.length === 0);
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

  for (const m of ['resolve ticket 598317', 'close ticket 598317', 'mark ticket 598317 as pending', 'add a note to ticket 598317', 'update the ticket 598317', 'set ticket 598317 to resolved', 'reply to ticket 598317 saying thanks', 'ticket 598317 assigned to Sam, close it', 'please resolve ticket 598317', 'check ticket 598317 and then mark it pending', 'I want you to close ticket 5', 'kindly resolve ticket 5', 'hey close ticket 5', 'ticket 598317 - close it', 'note on ticket 598317: foo', 'add a comment to ticket 598317', 'put a note on ticket 598317', 'show ticket 598317 and close it', 'solve ticket 5', 'ticket 598317 is done', 'finish ticket 5', 'complete ticket 5', 'shut ticket 5', 'archive ticket 5', 'remove ticket 5', 'snooze ticket 5', 'transfer ticket 5 to bob', 'move ticket 5 to engineering', 'pass ticket 5 to bob', 'hand ticket 5 to bob', 'give ticket 598317 to bob', 'take ticket 5', 'unassign ticket 5', 'send ticket 5 to bob', 'add bob to ticket 5', 'prioritize ticket 5', 'bump ticket 5 to urgent', 'tag ticket 5 as urgent', 'flag ticket 5', 'star ticket 5', 'tell the customer on ticket 5 we fixed it', 'notify the customer on ticket 5', 'ping bob on ticket 5', 'Is it possible to solve ticket 5', 'Why not solve ticket 5', 'What about solving ticket 5', 'let\'s close ticket 5', 'would you mind closing ticket 5', 'any chance you can close ticket 5', 'I want you to finish ticket 5', 'Is it possible to close ticket 5', 'Are you able to close ticket 5', 'Is it ok to resolve ticket 5', 'Why not close ticket 5', 'What about resolving ticket 5', 'How about closing ticket 5', 'Any way to reassign ticket 5 to Ravi', 'what happened to ticket 5 reopen it', 'How do I close ticket 5', 'How can I reply to ticket 5', 'show ticket 5 close', 'show ticket 5 add note done', 'check ticket 5 close it', 'check ticket 5 mark resolved', 'find ticket 5 reassign to me', 'latest ticket assign to me', 'list tickets assign 5 to bob', 'status ticket 5 escalate', 'get ticket 5 closed', 'get ticket 5 resolved', 'see ticket 5 resolved', 'show ticket 5 resolved', 'have ticket 5 closed', 'what\'s on ticket 5? close it', 'did anyone reply? reply yes', 'get ticket 5 & close it', 'show ticket 5 - close it', 'show ticket 5 plus close', 'show ticket 5 so close it', 'show ticket 5 after that resolve', 'show ticket 5 and kindly close it', 'show ticket 5 and just close it', 'show ticket 5 and can you close it', 'what is ticket 5? can you close it', 'what is on ticket 5 and could you resolve it', 'show ticket 5 and make it resolved', 'is ticket 5 closed? close it if not'])
    ok('ticket write vetoed: ' + m, tw(m));
  for (const m of ['what is the status of ticket 598317', 'any open tickets', 'latest ticket raised', 'show me ticket 999999999', 'show tickets I need to close', 'ticket 598317', '598317', 'ticket #598317 status', 'tell me about ticket 598317', 'summarize ticket 598317', 'describe ticket 598317', 'pull up ticket 598317', 'fetch ticket 598317', 'anything on ticket 598317', 'newest ticket please', 'bob', 'Manoj R', 'yes', "bob's ticket queue", 'how many tickets does Ravi have', 'tickets raised today', 'newest ticket', 'recent tickets', 'open tickets', 'give me ticket 5', 'show ticket 5', 'is ticket 5 done', 'any update on ticket 5', 'status of ticket 598317', 'Show me tickets I should resolve', 'did anyone comment on ticket 5', 'who is assigned to ticket 5', 'is ticket 5 closed', 'has ticket 5 been resolved', 'any reply from bob', 'who closed ticket 5', 'show resolved tickets', 'which tickets are resolved', 'what tickets were closed today', 'how many tickets were closed this week', 'list tickets I need to reply to', 'show tickets that were escalated', 'how many tickets does Priya have', 'any ticket I need to reply to', 'what is the latest note on ticket 598317', 'did he mark the ticket 123456 done', 'who added a note to ticket 598317'])
    ok('ticket read kept: ' + m, !tw(m));
  for (const m of ['forward the unread email to bob', 'delete unread emails', 'archive my inbox', 'mark all unread as read', 'I need you to delete the email', 'would you archive it', 'yo trash this', 'ok, now archive it', 'send bob a mail', 'show unread emails and delete them', 'Is it possible to delete that email', 'Are you able to send a mail to Bob', 'Is it ok to archive this email', 'What about archiving this mail', 'check inbox delete spam', 'read email 5 forward to bob', 'show email 5 forward to sam', 'find email from bob delete it', 'get email 5 trash', 'show email 5 archive', 'look email 5 unsubscribe', 'show email 5 -- delete it', 'get emails & archive', 'did anyone reply? reply yes'])
    ok('mail write vetoed: ' + m, mw(m));
  for (const m of ['any unread email?', 'check my inbox', 'Any email I need to respond to?', 'show me email 1a10115c7a74c864', 'what gmail labels do I have', 'did anyone send me mail', 'did Bob send me the email, check inbox', 'send me the inbox summary', 'which emails should I delete', 'show archived mail', 'show emails I need to reply to'])
    ok('mail read kept: ' + m, !mw(m));
  process.exit(f ? 1 : 0);
})();
