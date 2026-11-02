// Mirrors calendarMatch in src/app/api/chat/route.ts (keep in sync).
const yes = m => (/\b(calendar|agenda)\b|\bwhat'?s\b.{0,15}\b(on|happening|up)\b.{0,25}\b(today|tomorrow|tonight|this week|next week)\b|\bmy (?:meetings|schedule)\b|\bany (?:meetings|events)\b/i.test(m))
  && !/\b(add|create|book|set up|delete|remove|cancel|move|reschedule|postpone|invite|remind|schedule (?:a|an|the)\b)/i.test(m);
let f = 0; const ok = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) f++; };
ok("what's on my calendar today", yes("What's on my calendar today?"));
ok('any meetings tomorrow', yes('any meetings tomorrow?'));
ok('my schedule', yes('show my schedule this week'));
ok('add event not forced', !yes('add a meeting to my calendar at 5pm'));
ok('cancel not forced', !yes('cancel my calendar event tomorrow'));
ok('schedule a call not forced', !yes('schedule a call with Bob tomorrow'));
ok('unrelated', !yes('how are you'));
process.exit(f ? 1 : 0);
