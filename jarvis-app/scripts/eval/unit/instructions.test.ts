import { parseStandingInstruction as p, ruleKey, rulesBlock } from '../../../src/lib/instructions';
import { inboxSubjectWords } from '../../../src/lib/grounded';
import { mailWriteIntent } from '../../../src/lib/routingGuards';
let f = 0; const ok = (n: string, c: boolean) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) f++; };

// Real messages from chat history (2026-11-10) plus common phrasings.
const rules: [string, string][] = [
  ['Be polite', 'Be polite'],
  ['Remember to be polite. I am your boss', 'Be polite. I am your boss'],
  ['Hey Maya, be more formal', 'Be more formal'],
  ['from now on reply in Hindi', 'Reply in Hindi'],
  ['Going forward, keep answers under two lines', 'Keep answers under two lines'],
  ['always call me Manoj sir', 'Always call me Manoj sir'],
  ['never use emoji', 'Never use emoji'],
  ["don't use bullet points ever", "Don't use bullet points ever"],
  ['stop being sarcastic', 'Stop being sarcastic'],
  ['call me boss', 'Call me boss'],
  ['please remember to confirm before you queue any email', 'Confirm before you queue any email'],
  ['I want you to always greet me by name', 'Always greet me by name'],
];
for (const [m, want] of rules) { const r = p(m); ok(`rule: ${m} -> ${r?.rule}`, r?.kind === 'instruction' && r.rule === want); }

ok('fact: remember that', p('remember that Priya prefers email')?.kind === 'fact');

// Must NOT be captured: reminders, one-off commands, questions, small talk.
for (const m of [
  'remind me to call mom at 6', 'remember to call mom at 6pm', 'remember to buy milk', 'remember to pay rent tomorrow',
  "don't send that email", 'stop', 'do not reply yet', 'is it always this slow?', 'what is the status of jobs?',
  'Hey Maya', 'Gmail', 'check my inbox', 'be at the gym at 7', 'never mind', 'always the same thing with you?',
  'save a note that Priya prefers email', 'from now on?',
  'Be polite and check my inbox', 'from now on remind me every morning at 8', 'Be polite. What is on my calendar today',
]) ok(`not a rule: ${m}`, p(m) === null);

ok('ruleKey ignores case and punctuation', ruleKey('Be polite.') === ruleKey('be  POLITE'));
ok('rules block empty when none', rulesBlock([]) === '');
ok('rules block lists rules and says they override', /override/.test(rulesBlock(['Be polite'])) && rulesBlock(['Be polite']).includes('- Be polite'));

// Topic of an inbox question: what to filter for, or null for a plain inbox check.
// Subject words only gate whether the model is asked what the subject is; see inboxSearch.test.ts for the rest.
ok('subject words: jobs in inbox', inboxSubjectWords('What about jobs in my inbox?').join() === 'jobs');
ok('subject words: from amazon', inboxSubjectWords('anything from amazon in my inbox').join() === 'amazon');
ok('subject words: no length limit', inboxSubjectWords('Any job roles where I am moved to next stage rejected?').length >= 6);
for (const m of ['summarise my inbox', 'triage my inbox', 'go through my inbox', 'check my inbox', 'any unread email?', 'Gmail', 'show me my emails', 'what is in my inbox today']) ok(`no subject words: ${m}`, inboxSubjectWords(m).length === 0);

// Inbox reads phrased as a request frame keep their forced read; real write requests still veto it.
for (const m of ['What about jobs in my inbox?', 'how about my unread email', 'any new message from Bob in my inbox', 'what about email from amazon in my inbox', 'did Bob email me?', 'who emailed me today?', "tell me what's in my inbox", 'tell me my unread emails', 'mail from bob?', 'message from hr?', 'email from bob today?', 'Email ids from today', 'email summary please']) ok(`read, not write: ${m}`, !mailWriteIntent(m));
for (const m of ['can you delete the emails in my inbox', 'how about replying to Bob', 'what about archiving my inbox', 'clear my inbox', 'reply to Bob saying yes', 'can you email Bob the job mails in my inbox']) ok(`write: ${m}`, mailWriteIntent(m));

process.exit(f ? 1 : 0);
