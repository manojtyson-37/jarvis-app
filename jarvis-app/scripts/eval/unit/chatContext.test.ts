import { forModel, gmailLookupIntent, historyForModel } from '../../../src/lib/chatContext';
let f = 0; const ok = (n: string, c: boolean) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) f++; };
const list = '[automated] [1a10115c7a74c864] Quick Report (4 Oct) — "Flex"\n  Flex Setup snippet\n[needs-look] [1a104f709ed3f546] Bob — "Hi"\n  hello there';
const r = forModel('assistant', list);
ok('pure list -> only stub', r === '(older email list omitted)');
const mixed = forModel('assistant', 'Here are your emails.\n[needs-look] [abc123] Bob — "Hi"\n  hello\nBob wants lunch; I suggest replying yes.');
ok('mixed keeps analysis, drops rows', mixed.includes('Bob wants lunch') && mixed.includes('Here are your emails.') && !mixed.includes('abc123') && mixed.includes('(older email list omitted)'));
const mangled = forModel('assistant', '[needs look] [1a0f837787b0bd3f] Not verified\nNot verified by Google Yet to know\n[need');
ok('mangled row + snippet removed', !mangled.includes('Not verified') && mangled.includes('[need'));
ok('legacy removed', !forModel('assistant', '[1a10115c7a74c864] From: Google no-reply@accounts.google.com — "Security alert"\nA new sign-in').includes('Security alert'));
ok('user message untouched', forModel('user', list) === list);
ok('prose untouched', forModel('assistant', 'You have 3 unread emails.') === 'You have 3 unread emails.');
ok('gmail check forces', gmailLookupIntent('I had connected manojsuperb09 gmail account'));
ok('send from gmail not forced', !gmailLookupIntent('send an email to Bob from my gmail'));
ok('draft not forced', !gmailLookupIntent('draft a gmail to Bob'));
ok('redash+gmail not forced', !gmailLookupIntent('email the redash result via gmail'));
ok('connect gmail not forced', !gmailLookupIntent('connect my gmail'));
ok('no gmail word', !gmailLookupIntent("what's the weather"));
const h = historyForModel([
  { role: 'user', content: 'check mail' }, { role: 'assistant', content: list },
  { role: 'user', content: 'again' }, { role: 'assistant', content: '[needs-look] [zzz999] New — "Fresh"\n  s' },
  { role: 'user', content: 'summarise' },
]);
ok('older list stubbed, latest kept', h[1].content === '(older email list omitted)' && h[3].content.includes('Fresh'));
ok('only list kept intact', historyForModel([{ role: 'assistant', content: list }])[0].content === list);
process.exit(f ? 1 : 0);
