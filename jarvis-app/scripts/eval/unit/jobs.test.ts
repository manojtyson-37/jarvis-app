// @ts-nocheck: run with `node --experimental-strip-types`, which needs the explicit .ts import path that tsc rejects.
import { matchKey, nextStatus, shouldNotify, parseJobExtract, askNudgeDue, isStatus, ASK_NUDGE_AFTER_MS } from '../../../src/lib/jobs/rules.ts';
let f = 0; const ok = (n: string, c: boolean) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) f++; };
const eq = (n: string, a: unknown, b: unknown) => ok(`${n} (${JSON.stringify(a)})`, JSON.stringify(a) === JSON.stringify(b));

// matching: same company and role across emails must produce one key
eq('key strips punctuation and case', matchKey('  Razorpay Pvt. Ltd. '), 'razorpay pvt ltd');
eq('role key ignores separators', matchKey('Sr. Product-Manager (Payments)'), 'sr product manager payments');

// progress: only forward, offer is final, rejected does not beat an offer
eq('first status is kept', nextStatus(null, 'applied'), 'applied');
eq('moves forward', nextStatus('applied', 'interview'), 'interview');
eq('no downgrade to applied', nextStatus('interview', 'applied'), 'interview');
eq('rejection closes an open process', nextStatus('interview', 'rejected'), 'rejected');
eq('offer is final', nextStatus('offer', 'rejected'), 'offer');
eq('offer after interview', nextStatus('interview', 'offer'), 'offer');

// pushes: confirmations stay quiet; each real change pushes once
eq('plain applied is not pushed', shouldNotify(null, 'applied'), false);
eq('interview is pushed when new', shouldNotify(null, 'interview'), true);
eq('same status already notified is not pushed again', shouldNotify('interview', 'interview'), false);
eq('moved on from notified is pushed', shouldNotify('interview', 'offer'), true);

// model output validation: malformed or non-job replies are rejected, junk is trimmed
eq('non-job reply is null', parseJobExtract({ is_job: false, company: 'X', status: 'applied' }), null);
eq('unknown status is null', parseJobExtract({ is_job: true, company: 'X', status: 'hired' }), null);
eq('missing company is null', parseJobExtract({ is_job: true, company: '  ', status: 'interview' }), null);
eq('null input is null', parseJobExtract(null), null);
eq('company with no letters or digits is null', parseJobExtract({ is_job: true, company: '—', status: 'applied' }), null);
const ex = parseJobExtract({ is_job: true, company: ' Acme ', role: 'PM', status: 'interview', evidence: 'Let us schedule', ask: '' });
eq('valid extract trimmed', ex, { company: 'Acme', role: 'PM', status: 'interview', evidence: 'Let us schedule', ask: '' });
const long = parseJobExtract({ is_job: true, company: 'C'.repeat(500), status: 'applied', evidence: 'e'.repeat(900), ask: 'a'.repeat(900) });
ok('long fields capped', !!long && long.company.length === 120 && long.evidence.length === 300 && long.ask.length === 300);
ok('status guard', isStatus('moved_forward') && !isStatus('ghosted'));

// nudges: once, after a day, only while an ask waits and was not nudged
const now = Date.parse('2026-11-14T10:00:00Z');
const old = new Date(now - ASK_NUDGE_AFTER_MS - 60_000).toISOString();
const fresh = new Date(now - 3_600_000).toISOString();
eq('nudge due after a day', askNudgeDue(old, null, now), true);
eq('no nudge before a day', askNudgeDue(fresh, null, now), false);
eq('no second nudge', askNudgeDue(old, new Date(now).toISOString(), now), false);
eq('no nudge without an ask', askNudgeDue(null, null, now), false);

// retry path: a failed push leaves notified_status behind the stored status, so the next run pushes again
let notified = null;
eq('first run pushes interview', shouldNotify(notified, 'interview'), true);
eq('failed push: next run pushes again', shouldNotify(notified, 'interview'), true);
notified = 'interview';
eq('successful push: no repeat', shouldNotify(notified, 'interview'), false);

console.log(f === 0 ? 'ALL PASS' : `${f} FAILED`);
process.exit(f ? 1 : 0);
