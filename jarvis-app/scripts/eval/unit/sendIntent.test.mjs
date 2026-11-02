// Mirrors the sendMailMatch rule in src/app/api/chat/route.ts (kept in sync by hand; route.ts is not importable).
const send = m => !/\b(?=[0-9a-f]*[a-f])[0-9a-f]{10,}\b/i.test(m)
  && (/\b(send|shoot|fire off)\s+(?:an?\s+|the\s+)?(?:e-?mail|mail)\b.{0,80}(?:\bto\b|@)/i.test(m) || /\b(?:e-?mail|mail)\s+[\w.+-]+@[\w-]+\.\w+/i.test(m))
  && !/\b(draft|compose|write|unread|inbox)\b|\bsend me\b|\b(don.?t|do not|never|not)\b/i.test(m);
let f = 0;
for (const [m, e] of [['send an email to test@example.com saying hi', true], ['email bob@x.com I am late', true], ['send a message to mom', false], ['send me the unread emails', false], ["don't send the email to Bob", false], ['draft an email to Bob', false], ['send the email to Priya about the deck', true], ['any unread email?', false]]) {
  const ok = send(m) === e; if (!ok) f++; console.log((ok ? 'PASS ' : 'FAIL ') + m);
}
process.exit(f ? 1 : 0);
