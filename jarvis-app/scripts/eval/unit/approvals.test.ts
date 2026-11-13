// @ts-nocheck: run with `node --experimental-strip-types`, which needs the explicit .ts import path that tsc rejects.
import { approvalPush } from '../../../src/lib/approvals/notify.ts';
let f = 0; const ok = (n: string, c: boolean) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) f++; };

const email = approvalPush('send_email', { to: 'ravi@example.com', subject: 'Deck for Monday', body: 'SECRET BODY TEXT' }, 'abc');
ok('email push names recipient and subject', email.body.includes('ravi@example.com') && email.body.includes('Deck for Monday'));
ok('email push never carries the body', !email.body.includes('SECRET BODY TEXT'));
ok('email push tag is per pending action', email.tag === 'approval-abc');
ok('title', email.title === 'Maya · Needs your approval');
const cal = approvalPush('create_calendar_event', { title: 'Dentist', start: 'x', end: 'y', description: 'PRIVATE NOTES' }, 'id2');
ok('calendar create names the title only', cal.body.startsWith('Add to calendar: "Dentist"') && !cal.body.includes('PRIVATE NOTES'));
const del = approvalPush('delete_calendar_event', { event_id: 'e1', event_title: 'Standup' }, 'id3');
ok('calendar delete names the title', del.body.startsWith('Delete from calendar: "Standup"'));
ok('calendar delete without title', approvalPush('delete_calendar_event', { event_id: 'e1' }, 'id4').body.includes('an event'));
ok('control characters removed', !approvalPush('send_email', { to: 'a@b.co', subject: 'hi\u0007\nthere' }, 'x').body.match(/[\u0000-\u001F]/));
const long = approvalPush('send_email', { to: 'a@b.co', subject: 'S'.repeat(500) }, 'x');
ok('body length capped', long.body.length <= 180);
ok('unknown tool still gives a push', approvalPush('mystery', {}, 'x').body.startsWith('An action is waiting'));

console.log(f === 0 ? 'ALL PASS' : `${f} FAILED`);
if (f) process.exit(1);
