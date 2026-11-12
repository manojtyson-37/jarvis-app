import { selectNotifiable, WATCH_QUERY } from '../../../src/lib/mailWatch';
let f = 0; const ok = (n: string, c: boolean) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) f++; };
const m = (id: string, automated = false) => ({ id, from: 'a@b.c', fromName: 'A', subject: 's', automated });
ok('no Jodo label in query', !/atulya|manoj r/i.test(WATCH_QUERY) && /is:unread/.test(WATCH_QUERY) && /in:inbox/.test(WATCH_QUERY));
ok('automated never pushed', selectNotifiable([m('1', true), m('2')], () => false).push.map(x => x.id).join() === '2');
ok('seen skipped', selectNotifiable([m('1'), m('2')], id => id === '1').push.map(x => x.id).join() === '2');
ok('dupes collapsed', selectNotifiable([m('1'), m('1')], () => false).push.length === 1);
const big = selectNotifiable(Array.from({ length: 8 }, (_, i) => m(String(i))), () => false);
ok('capped with overflow count', big.push.length === 5 && big.overflow.length === 3);
ok('empty', selectNotifiable([], () => false).push.length === 0);
if (f) { console.error(`${f} failed`); process.exit(1); }
