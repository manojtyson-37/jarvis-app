import { safeFactCategory, isReservedFactCategory } from '../../../src/lib/memoryCategory';
let f = 0; const ok = (n: string, c: boolean) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) f++; };

// Reserved categories are dropped by evolve, not renamed into the prompt.
for (const c of ['instruction', ' Ticket ', 'EMAIL', 'question']) ok(`reserved ${JSON.stringify(c)}`, isReservedFactCategory(c));
for (const c of ['general', 'goal', 'contact', '', undefined, 5]) ok(`not reserved ${JSON.stringify(c)}`, !isReservedFactCategory(c));

// Allowed categories pass through (normalised).
for (const c of ['general', 'preference', 'goal', 'person', 'habit']) ok(`keeps ${c}`, safeFactCategory(c) === c);
ok('normalises case/space', safeFactCategory('  Goal ') === 'goal');

// Reserved or unknown categories never survive: "instruction" would become a standing rule (prompt injection).
for (const c of ['instruction', 'INSTRUCTION', ' instruction ', 'question', 'ticket', 'email', 'contact', 'rule', '']) {
  ok(`maps ${JSON.stringify(c)} to general`, safeFactCategory(c) === 'general');
}
for (const v of [undefined, null, 42, {}, ['instruction']]) ok(`non-string ${JSON.stringify(v)} -> general`, safeFactCategory(v) === 'general');

if (f) { console.error(`${f} failed`); process.exit(1); }
console.log('all passed');
