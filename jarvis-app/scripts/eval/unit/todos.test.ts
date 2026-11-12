import { parseTodoCapture, cleanExtracted } from '../../../src/lib/todos/capture';
import { buildReport, manualReason } from '../../../src/lib/todos/report';
import { finalTier, safetyFloor, heuristicKind, toolsForTier, isKind, urlsIn, urlAllowed } from '../../../src/lib/todos/classify';
let f = 0; const ok = (n: string, c: boolean) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) f++; };
const eq = (n: string, a: unknown, b: unknown) => ok(`${n} (${JSON.stringify(a)})`, JSON.stringify(a) === JSON.stringify(b));

// ── capture ──────────────────────────────────────────────────────────────
eq('check-in prefill, comma list', parseTodoCapture('My to-dos: research Razorpay PM openings, remind me to call mom at 6, pay rent')?.items,
  ['research Razorpay PM openings', 'remind me to call mom at 6', 'pay rent']);
eq('check-in source', parseTodoCapture('My to-dos: research X')?.source, 'checkin');
eq('EOD prefill', parseTodoCapture('My to-dos for tomorrow: draft the KBD pitch email')?.items, ['draft the KBD pitch email']);
eq('newline bullets', parseTodoCapture('my todos:\n1. find cheap flights to Goa\n2) summarise the HDFC statement\n- book dentist')?.items,
  ['find cheap flights to Goa', 'summarise the HDFC statement', 'book dentist']);
eq('semicolons', parseTodoCapture('To-do: one thing; another thing')?.items, ['one thing', 'another thing']);
eq('add to my to-do list', parseTodoCapture('add to my to-do list: compare term insurance plans')?.items, ['compare term insurance plans']);
eq('add X to my todos', parseTodoCapture('add compare term insurance plans to my to-dos')?.items, ['compare term insurance plans']);
eq('chat source', parseTodoCapture('add compare term insurance plans to my to-dos')?.source, 'chat');
eq('" and " splits only on a list', parseTodoCapture('My to-dos: research Groq pricing and draft a note to Ravi')?.items, ['research Groq pricing', 'draft a note to Ravi']);
eq('commas split items', parseTodoCapture('My to-dos: research Bangalore, Pune salaries')?.items.length, 2);
eq('empty prefill is not a capture', parseTodoCapture('My to-dos: '), null);
eq('"none" is not a capture', parseTodoCapture('My to-dos: nothing'), null);
eq('question is not a capture', parseTodoCapture('what are my to-dos?'), null);
eq('show is not a capture', parseTodoCapture('show my to-dos'), null);
eq('ordinary chat', parseTodoCapture('remind me to call mom at 6'), null);
eq('mention mid-sentence', parseTodoCapture('I hate my to-dos: they never end'), null);
eq('item cap', parseTodoCapture('My to-dos: ' + Array.from({ length: 20 }, (_, i) => `task ${i}`).join(', '))?.items.length, 10);
eq('item length cap', (parseTodoCapture('My to-dos: ' + 'x'.repeat(900))?.items[0] ?? '').length, 500);
eq('drops dupes', parseTodoCapture('My to-dos: pay rent, Pay rent')?.items, ['pay rent']);

// ── classify ─────────────────────────────────────────────────────────────
ok('isKind', isKind('research') && !isKind('hack'));
eq('research auto', finalTier('research', 'research Razorpay PM openings', 'chat'), 'auto');
eq('draft auto', finalTier('draft', 'draft a reply to Ravi', 'chat'), 'auto');
eq('email_send needs approval', finalTier('email_send', 'email Ravi the deck', 'chat'), 'approval');
eq('calendar needs approval', finalTier('calendar', 'book dentist friday 4pm', 'chat'), 'approval');
eq('money manual even if model says research', finalTier('research', 'pay rent', 'chat'), 'manual');
eq('transfer manual', finalTier('lookup', 'transfer 5000 to Amma', 'chat'), 'manual');
eq('buy manual', finalTier('research', 'buy the Garmin watch', 'chat'), 'manual');
eq('researching a price is not money', finalTier('research', 'find the price of the Garmin 965', 'chat'), 'auto');
eq('password manual', finalTier('note', 'change my Gmail password', 'chat'), 'manual');
eq('settings manual', finalTier('lookup', 'turn on 2FA for HDFC', 'chat'), 'manual');
eq('api key manual', finalTier('note', 'rotate the Groq API key', 'chat'), 'manual');
eq('delete floors to approval', finalTier('note', 'delete the old KBD calendar invites', 'chat'), 'approval');
eq('send floors to approval', finalTier('draft', 'send the invoice to Ravi', 'chat'), 'approval');
eq('draft-then-send floors to approval', finalTier('draft', 'draft and send the invoice to Ravi', 'chat'), 'approval');
eq('notify floors to approval', finalTier('note', 'tell the team the demo moved', 'chat'), 'approval');
eq('model manual stays manual', finalTier('manual', 'go to the gym', 'chat'), 'manual');
eq('unknown kind manual', finalTier('hack' as never, 'something', 'chat'), 'manual');
eq('email-sourced approval becomes manual', finalTier('email_send', 'reply to Ravi with the deck', 'email'), 'manual');
eq('meeting-sourced approval becomes manual', finalTier('calendar', 'book follow-up', 'meeting'), 'manual');
eq('email-sourced research stays auto', finalTier('research', 'research Acme Corp', 'email'), 'auto');
eq('floor money', safetyFloor('pay ₹500 to the plumber'), 'manual');
eq('reminder about money is a reminder', finalTier('reminder', 'remind me to pay rent on the 5th', 'chat'), 'auto');
eq('reminder then pay is not', finalTier('reminder', 'remind me and then pay rent', 'chat'), 'manual');
eq('model says reminder but text pays', finalTier('reminder', 'pay rent', 'chat'), 'manual');
eq('floor none', safetyFloor('research Groq models'), 'auto');

eq('heuristic research', heuristicKind('research PM roles in fintech'), 'research');
eq('heuristic find', heuristicKind('find cheap flights to Goa'), 'research');
eq('heuristic summary', heuristicKind('summarise the HDFC statement'), 'summary');
eq('heuristic draft', heuristicKind('draft the KBD pitch email'), 'draft');
eq('heuristic reminder', heuristicKind('remind me to call mom at 6'), 'reminder');
eq('heuristic send', heuristicKind('email Ravi the deck'), 'email_send');
eq('heuristic calendar', heuristicKind('schedule a call with Priya tomorrow 3pm'), 'calendar');
eq('heuristic manual', heuristicKind('go to the gym'), 'manual');

// ── tool tiers (decided in code, never by the model) ─────────────────────
const auto = toolsForTier('auto'), appr = toolsForTier('approval'), man = toolsForTier('manual');
ok('auto has research tools', auto.has('web_search') && auto.has('read_url') && auto.has('search_drive') && auto.has('save_note') && auto.has('set_reminder'));
ok('auto has no gated tools', !auto.has('send_email') && !auto.has('create_calendar_event') && !auto.has('delete_calendar_event'));
ok('auto has no destructive tools', !auto.has('delete_note') && !auto.has('mark_reminder_done') && !auto.has('complete_action_item'));
ok('approval adds gated tools', appr.has('send_email') && appr.has('create_calendar_event') && appr.has('web_search'));
ok('manual has no tools', man.size === 0);
for (const src of ['email', 'meeting', 'assistant'] as const) {
  const t = toolsForTier('auto', src);
  ok(`${src}: no private readers`, !['list_emails', 'get_email', 'search_drive', 'read_drive_file', 'search_notes', 'get_recent_notes', 'get_calendar_events'].some(n => t.has(n)));
  ok(`${src}: no gated tools even at approval`, !toolsForTier('approval', src).has('send_email'));
  ok(`${src}: web + safe writes only`, t.has('web_search') && t.has('save_note'));
}
eq('assistant-added approval -> manual', finalTier('email_send', 'email Ravi the deck', 'assistant'), 'manual');
const seen = new Set(urlsIn('read https://example.com/a. and http://x.io/b').map(u => u.replace(/[.,;:!?]+$/, '')));
ok('url seen allowed', urlAllowed('https://example.com/a', seen) && urlAllowed('http://x.io/b', seen));
ok('built url blocked', !urlAllowed('https://evil.com/?d=secret', seen) && !urlAllowed('https://example.com/a?d=secret', seen));
ok('non-string url blocked', !urlAllowed(undefined, seen));

// ── report ───────────────────────────────────────────────────────────────
eq('empty batch reports nothing', buildReport([]), null);
const rep = buildReport([
  { text: 'research PM roles', tier: 'auto', status: 'done', detail: 'Found 3: ...' },
  { text: 'email Ravi the deck', tier: 'approval', status: 'awaiting_approval', detail: 'Waiting for your approval: Send email to ravi@x.com' },
  { text: 'pay rent', tier: 'manual', status: 'manual', detail: manualReason('money', false) },
  { text: 'x', tier: 'auto', status: 'failed', detail: 'cut off' },
])!;
ok('report counts', rep.chat.startsWith('To-do update: 1 done, 1 waiting for approval, 1 need you, 1 couldn\'t finish.'));
ok('report never says waiting item was done', /⏳ \*\*Waiting for your approval: email Ravi/.test(rep.chat) && !/Done: email Ravi/.test(rep.chat));
ok('push short', rep.push.body.length <= 180 && rep.push.title === 'Maya · To-dos');
ok('long detail clipped', buildReport([{ text: 't', tier: 'auto', status: 'done', detail: 'y'.repeat(2000) }])!.chat.includes('full result in Notes'));
ok('money reason', /never/.test(manualReason('money', false)));
ok('from-others reason', /email or meeting/.test(manualReason('email_send', true)));
// ── extraction cleanup (model output is untrusted) ───────────────────────
eq('extract ok', cleanExtracted({ todos: ['Send the deck to Ravi', 'Review the contract'] }), ['Send the deck to Ravi', 'Review the contract']);
eq('extract junk', cleanExtracted({ todos: 'x' }), []);
eq('extract non-strings', cleanExtracted({ todos: [1, null, 'ok task'] }), ['ok task']);
eq('extract cap', cleanExtracted({ todos: Array(9).fill('do thing') }).length, 5);
eq('extract control chars', cleanExtracted({ todos: ['a\u0000b\nc task'] }), ['a b c task']);

if (f) { console.error(`${f} failed`); process.exit(1); }
