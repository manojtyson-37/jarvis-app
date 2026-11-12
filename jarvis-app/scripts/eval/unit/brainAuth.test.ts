import { brainAuthorized } from '../../../src/lib/brainAuth';
let f = 0; const ok = (n: string, c: boolean) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) f++; };
const key = 'k'.repeat(40);

ok('chat with right key', brainAuthorized('/api/chat', `Bearer ${key}`, key));
ok('pending actions list', brainAuthorized('/api/actions', `Bearer ${key}`, key));
ok('approve one action', brainAuthorized('/api/actions/0b7c5a3e-1111-2222-3333-444455556666', `Bearer ${key}`, key));
ok('wrong key refused', !brainAuthorized('/api/chat', `Bearer ${'x'.repeat(40)}`, key));
ok('prefix of key refused', !brainAuthorized('/api/chat', `Bearer ${key.slice(0, 39)}`, key));
ok('missing header refused', !brainAuthorized('/api/chat', null, key));
ok('unset key never matches', !brainAuthorized('/api/chat', 'Bearer undefined', undefined));
ok('empty key never matches', !brainAuthorized('/api/chat', 'Bearer ', ''));
ok('short key refused even if equal', !brainAuthorized('/api/chat', 'Bearer short', 'short'));
ok('other paths refused (rules)', !brainAuthorized('/api/rules', `Bearer ${key}`, key));
ok('other paths refused (dashboard)', !brainAuthorized('/api/dashboard', `Bearer ${key}`, key));
ok('pages refused', !brainAuthorized('/', `Bearer ${key}`, key));
ok('lookalike path refused', !brainAuthorized('/api/chatty', `Bearer ${key}`, key));
ok('nested actions path refused', !brainAuthorized('/api/actions/x/y', `Bearer ${key}`, key));
ok('non-bearer scheme refused', !brainAuthorized('/api/chat', `Basic ${key}`, key));

if (f) { console.error(`${f} failed`); process.exit(1); }
