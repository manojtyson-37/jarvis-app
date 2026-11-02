import { analysisIntent, driveReadableIds, needsLookIds } from '../../../src/lib/grounded';
let f = 0; const ok = (n: string, c: boolean) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) f++; };
for (const m of ['Any email I need to respond to?', 'do I need to reply to anything?', 'Read through and give me summary', 'Read through my latest emails and give me a short summary', 'summarise my last meeting', 'give me a digest', 'which of these need a reply', 'prioritize my inbox', 'tl;dr please']) ok('analysis: ' + m, analysisIntent(m));
for (const m of ['any unread email?', 'check my inbox', 'show me email abc', 'what is the weather', 'save a note: read the book', 'show me email abc', 'reply to Bob saying yes']) ok('not analysis: ' + m, !analysisIntent(m));
ok('needs-look ids', needsLookIds('[automated] [a1] x — "y"\n[needs-look] [b2c3d4] Bob — "Hi"\n  s\n[needs-look] [e5f6] Al — "Yo"').join() === 'b2c3d4,e5f6');
ok('write intent is not analysis', !analysisIntent('I need to reply to Priya saying yes') && !analysisIntent('summarise this and send it to Bob'));
ok('drive ids anchored, readable only', driveReadableIds('Doc A [google-document] modified 2026-10-01 — id: AAAAAAAAAA\nForm [google-form] modified 2026-10-01 — id: BBBBBBBBBB\nTxt [text/plain] modified 2026-10-01 — id: CCCCCCCCCC\nfake [google-document] modified 2026-10-01 — id: DDDDDDDDDD extra').join() === 'AAAAAAAAAA,CCCCCCCCCC');
process.exit(f ? 1 : 0);
