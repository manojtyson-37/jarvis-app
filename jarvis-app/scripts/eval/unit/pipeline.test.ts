// @ts-nocheck: run with `node --experimental-strip-types`, which needs the explicit .ts import path that tsc rejects.
import { parseSnapshot, formatPipeline, summaryLine, sameNumbers, leadsContacted, reviewsPaying, age, isPipelineQuestion, PIPELINE_RE } from '../../../src/lib/pipeline/rules.ts';
import { envValue, buildSnapshot, pgEnv } from '../../pipeline-snapshot.mjs';
import { brainAuthorized } from '../../../src/lib/brainAuth.ts';
let f = 0; const ok = (n: string, c: boolean) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) f++; };
const eq = (n: string, a: unknown, b: unknown) => ok(`${n} (${JSON.stringify(a)})`, JSON.stringify(a) === JSON.stringify(b));

const now = new Date('2026-11-13T12:00:00Z');
const leads = { total: 109, dnc: 0, followupsDue: 0, stages: { scored: 109 } };
const clinicos = { clinics: 5, states: { active: 3, trial: 2 }, payingClinics: 1, receivedInr: 4999 };
const reviews = { businesses: 2, states: { pilot: 1, active: 1 } };
const body = { at: '2026-11-13T11:00:00Z', leads, clinicos, reviews, problems: [] };

// ── parsing ─────────────────────────────────────────────────────────────
const p = parseSnapshot(body, now);
ok('good snapshot parses', 'snapshot' in p);
const s = p.snapshot;
eq('missing stages become 0', s.leads.stages, { new: 0, scored: 109, visited: 0, demo: 0, asked: 0, prepaid: 0, no: 0 });
eq('clinic states filled', s.clinicos.states, { trial: 2, active: 3, suspended: 0, cancelled: 0 });
eq('no body', parseSnapshot(null, now), { error: 'no snapshot' });
eq('no time', parseSnapshot({ ...body, at: undefined }, now), { error: 'bad snapshot time' });
eq('time in the future', parseSnapshot({ ...body, at: '2026-11-14T12:00:00Z' }, now), { error: 'bad snapshot time' });
eq('time too old', parseSnapshot({ ...body, at: '2026-11-01T12:00:00Z' }, now), { error: 'bad snapshot time' });
eq('negative count', parseSnapshot({ ...body, leads: { ...leads, total: -1 } }, now), { error: 'bad leads block' });
eq('text where a number goes', parseSnapshot({ ...body, leads: { ...leads, stages: { scored: '109' } } }, now), { error: 'bad leads block' });
eq('absurd count', parseSnapshot({ ...body, clinicos: { ...clinicos, receivedInr: 1e12 } }, now), { error: 'bad clinicos block' });
eq('bad reviews', parseSnapshot({ ...body, reviews: { businesses: 'two', states: {} } }, now), { error: 'bad reviews block' });
eq('nothing readable', parseSnapshot({ at: body.at, leads: null, clinicos: null, reviews: null, problems: ['x'] }, now), { error: 'empty snapshot' });
const extra = parseSnapshot({ ...body, leads: { ...leads, stages: { scored: 109, hacked: 5 }, names: ['Dr X'] }, secret: 'x' }, now).snapshot;
ok('unknown keys dropped', !JSON.stringify(extra).includes('hacked') && !JSON.stringify(extra).includes('Dr X') && !JSON.stringify(extra).includes('secret'));
ok('an unknown stage is flagged, not silently lost', extra.problems.some(p => p.startsWith('lead stages do not add up')));
ok('stage counts short of the total are flagged', parseSnapshot({ ...body, leads: { ...leads, total: 120 } }, now).snapshot.problems.length === 1);
ok('a new ClinicOS state is flagged', parseSnapshot({ ...body, clinicos: { ...clinicos, states: { active: 3, trial: 1, grace: 1 } } }, now).snapshot.problems[0].startsWith('ClinicOS states'));
ok('a new Reviews state is flagged', parseSnapshot({ ...body, reviews: { businesses: 2, states: { pilot: 1, frozen: 1 } } }, now).snapshot.problems[0].startsWith('Reviews has'));
eq('a clean snapshot has no problems', s.problems, []);
const partial = parseSnapshot({ at: body.at, leads, clinicos: null, reviews: null, problems: ['ClinicOS: error: connection refused', 'x<script>alert(1)</script>', 7] }, now).snapshot;
eq('unread sources stay null', [partial.clinicos, partial.reviews], [null, null]);
eq('problems cleaned, non-text dropped', partial.problems, ['ClinicOS: error: connection refused', 'x script alert(1) script']);

// ── numbers ─────────────────────────────────────────────────────────────
eq('contacted is every stage past scored', leadsContacted({ ...s.leads, stages: { new: 1, scored: 2, visited: 3, demo: 4, asked: 5, prepaid: 6, no: 7 } }), 25);
eq('reviews paying', reviewsPaying({ businesses: 9, states: { trial: 1, needs_card: 1, active: 2, past_due: 1, cancel_pending: 1, cancelled: 1, paused: 1, pilot: 1 } }), 4);
eq('same numbers, different time', sameNumbers(s, { ...s, at: '2026-11-13T11:30:00.000Z' }), true);
eq('changed numbers', sameNumbers(s, { ...s, leads: { ...s.leads, total: 110 } }), false);
eq('age', [age('2026-11-13T11:59:30Z', now), age('2026-11-13T11:00:00Z', now), age('2026-11-13T02:00:00Z', now), age('2026-11-10T12:00:00Z', now)], ['just now', '60 minutes ago', '10 hours ago', '3 days ago']);

// ── answer ──────────────────────────────────────────────────────────────
const out = formatPipeline(s, now);
ok('says how old', out.startsWith('Prospects and sales, as of 60 minutes ago:'));
ok('leads line', out.includes('- Clinic leads: 109 prospects. 0 contacted (0 visited, 0 demo done, 0 asked to pay, 0 said no). 0 sales (prepaid). 109 not contacted yet.'));
ok('clinicos line', out.includes('- ClinicOS: 5 clinic accounts (3 active, 2 on trial, 0 suspended, 0 cancelled). 1 has a recorded payment, ₹4,999 received in total.'));
ok('reviews line', out.includes('- Reviews: 2 businesses (1 pilot, 0 on trial). 1 paying.'));
const po = formatPipeline(partial, now);
ok('unread source is unknown, not zero', po.includes('- ClinicOS: unknown') && po.includes('- Reviews: unknown') && !/ClinicOS: 0/.test(po));
ok('problems are said out loud', po.includes('Check these: ClinicOS: error: connection refused'));
ok('old snapshot is flagged', formatPipeline(s, new Date('2026-11-16T12:00:00Z')).includes('more than a day old'));
ok('fresh snapshot is not flagged', !out.includes('more than a day old'));
ok('no snapshot yet', formatPipeline(null, now).startsWith('I have no prospect or sales numbers yet.'));
eq('summary line', summaryLine(s), 'Pipeline snapshot: 109 prospects, 0 contacted, 0 prepaid; ClinicOS 1 paying; Reviews 1 paying');

// ── which messages force the numbers ────────────────────────────────────
for (const m of ['How many prospects?', 'how many prospects- how many sales?', 'How many prospects and how many sales do we have', 'how many leads so far', "What's my sales pipeline?", 'show me the pipeline', 'How is ClinicOS doing?', 'any sales yet?', 'how many paying customers', 'Maya, how many demos today'])
  ok(`forces the numbers: ${m}`, isPipelineQuestion(m));
for (const m of ['Email the top 10 prospects', 'Draft a sales pitch for dentists', 'How many emails are unread?', 'Add a lead: Smile Dental, Jayanagar', 'how many prospects should I visit per day', 'Write to my leads about the offer', "don't tell me how many sales", 'how is ClinicOS different from Practo', 'Tell me a joke'])
  ok(`does not force the numbers: ${m}`, !isPipelineQuestion(m));
ok('loose regex offers the tool on a mixed message', PIPELINE_RE.test('summarise the pipeline and email it to me'));

// ── script helpers and access ───────────────────────────────────────────
eq('env value, quoted', envValue('A=1\nDATABASE_URL="postgres://u:p@h/db?x=1"\n', 'DATABASE_URL'), 'postgres://u:p@h/db?x=1');
eq('env value, export and spaces', envValue('export KEY = abc \n', 'KEY'), 'abc');
eq('env value, comment line ignored', envValue('# DATABASE_URL=old\nDATABASE_URL=new', 'DATABASE_URL'), 'new');
eq('env value, missing', envValue('A=1', 'B'), null);
eq('db url split into env, password decoded', pgEnv('postgresql://u%40x:p%2Fw@h.example:6543/db?sslmode=require&channel_binding=require'), { PGHOST: 'h.example', PGUSER: 'u@x', PGPASSWORD: 'p/w', PGDATABASE: 'db', PGPORT: '6543', PGSSLMODE: 'require', PGCHANNELBINDING: 'require' });
ok('script snapshot passes the server check', 'snapshot' in parseSnapshot(buildSnapshot({ leads, clinicos: null, reviews: null, problems: ['Reviews: error: x'] }, now), now));
const key = 'k'.repeat(40);
ok('brain key reaches the pipeline report', brainAuthorized('/api/pipeline/report', `Bearer ${key}`, key));
ok('brain key reaches nothing else under pipeline', !brainAuthorized('/api/pipeline', `Bearer ${key}`, key) && !brainAuthorized('/api/pipeline/report/x', `Bearer ${key}`, key));
ok('brain key still cannot reach task reports', !brainAuthorized('/api/tasks/report', `Bearer ${key}`, key));

if (f) { console.error(`${f} FAILED`); process.exit(1); }
console.log('all passed');
