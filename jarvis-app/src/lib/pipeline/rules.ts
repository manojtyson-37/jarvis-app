// Prospects and sales, pure part. No database and no network, so the rules are unit-tested.
// The numbers are a SNAPSHOT pushed by scripts/pipeline-snapshot.mjs: the lead tracker is a file on Manoj's Mac and the
// ClinicOS and Reviews databases are separate products, so Maya's server holds only counts, never names or patient data.
// Every answer says how old the snapshot is. A source that could not be read is shown as unknown, never as zero.

export const LEAD_STAGES = ['new', 'scored', 'visited', 'demo', 'asked', 'prepaid', 'no'] as const;
export const CLINIC_STATES = ['trial', 'active', 'suspended', 'cancelled'] as const;
export const REVIEW_STATES = ['trial', 'needs_card', 'active', 'past_due', 'cancel_pending', 'cancelled', 'paused', 'pilot'] as const;
// Reviews businesses that are paying right now: charged, in grace, or paid until the period ends.
export const REVIEW_PAYING = ['active', 'past_due', 'cancel_pending'] as const;
const MAX = 10_000_000;

type Counts<K extends string> = Record<K, number>;
export interface Snapshot {
  at: string;
  leads: { total: number; stages: Counts<(typeof LEAD_STAGES)[number]>; dnc: number; followupsDue: number } | null;
  clinicos: { clinics: number; states: Counts<(typeof CLINIC_STATES)[number]>; payingClinics: number; receivedInr: number } | null;
  reviews: { businesses: number; states: Counts<(typeof REVIEW_STATES)[number]> } | null;
  problems: string[];
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX ? Math.floor(v) : null);
function counts<K extends string>(raw: unknown, keys: readonly K[]): Counts<K> | null {
  if (!raw || typeof raw !== 'object') return null;
  const out = {} as Counts<K>;
  for (const k of keys) {
    const v = (raw as Record<string, unknown>)[k];
    const n = v === undefined ? 0 : num(v);
    if (n === null) return null;
    out[k] = n;
  }
  return out;
}

// A status this code does not know (a new lead stage, a new billing state) would otherwise vanish from the totals.
function unknownKeys(raw: unknown, keys: readonly string[]): number {
  if (!raw || typeof raw !== 'object') return 0;
  return Object.keys(raw as object).filter(k => !keys.includes(k)).length;
}
const sum = (c: Record<string, number>) => Object.values(c).reduce((a, b) => a + b, 0);

// Counts only. Anything that is not a sane number rejects the whole report. A status name this code does not know, or
// stage counts that do not add up to the total, is kept as a problem so the answer says the breakdown is incomplete.
export function parseSnapshot(body: unknown, now: Date = new Date()): { snapshot: Snapshot } | { error: string } {
  const b = body as Record<string, unknown> | null;
  if (!b || typeof b !== 'object') return { error: 'no snapshot' };
  const at = typeof b.at === 'string' ? Date.parse(b.at) : NaN;
  if (Number.isNaN(at) || at > now.getTime() + 5 * 60_000 || at < now.getTime() - 7 * 86_400_000) return { error: 'bad snapshot time' };
  const snap: Snapshot = { at: new Date(at).toISOString(), leads: null, clinicos: null, reviews: null, problems: [] };
  const found: string[] = [];

  if (b.leads != null) {
    const l = b.leads as Record<string, unknown>;
    const stages = counts(l.stages, LEAD_STAGES), total = num(l.total), dnc = num(l.dnc ?? 0), due = num(l.followupsDue ?? 0);
    if (!stages || total === null || dnc === null || due === null) return { error: 'bad leads block' };
    snap.leads = { total, stages, dnc, followupsDue: due };
    if (unknownKeys(l.stages, LEAD_STAGES) || sum(stages) !== total) found.push('lead stages do not add up to the total (a stage this version does not know)');
  }
  if (b.clinicos != null) {
    const c = b.clinicos as Record<string, unknown>;
    const states = counts(c.states, CLINIC_STATES), clinics = num(c.clinics), paying = num(c.payingClinics), inr = num(c.receivedInr ?? 0);
    if (!states || clinics === null || paying === null || inr === null) return { error: 'bad clinicos block' };
    snap.clinicos = { clinics, states, payingClinics: paying, receivedInr: inr };
    if (unknownKeys(c.states, CLINIC_STATES) || sum(states) !== clinics) found.push('ClinicOS states do not add up to the clinic count');
  }
  if (b.reviews != null) {
    const r = b.reviews as Record<string, unknown>;
    const states = counts(r.states, REVIEW_STATES), businesses = num(r.businesses);
    if (!states || businesses === null) return { error: 'bad reviews block' };
    snap.reviews = { businesses, states };
    if (unknownKeys(r.states, REVIEW_STATES)) found.push('Reviews has a billing state this version does not know');
  }
  if (!snap.leads && !snap.clinicos && !snap.reviews) return { error: 'empty snapshot' };
  if (Array.isArray(b.problems)) {
    snap.problems = b.problems.filter((p): p is string => typeof p === 'string')
      .map(p => p.replace(/[^\w .,:()-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80)).filter(Boolean).slice(0, 6);
  }
  for (const p of found) if (!snap.problems.includes(p)) snap.problems.push(p);
  return { snapshot: snap };
}

export const reviewsPaying = (s: NonNullable<Snapshot['reviews']>) => REVIEW_PAYING.reduce((n, k) => n + s.states[k], 0);
// Leads that have been met or spoken to at least once: every stage past "scored".
export const leadsContacted = (l: NonNullable<Snapshot['leads']>) => l.stages.visited + l.stages.demo + l.stages.asked + l.stages.prepaid + l.stages.no;

// Same numbers mean nothing new to store. The time is left out of the comparison.
export const sameNumbers = (a: Snapshot, b: Snapshot) =>
  JSON.stringify([a.leads, a.clinicos, a.reviews, a.problems]) === JSON.stringify([b.leads, b.clinicos, b.reviews, b.problems]);

export function age(atIso: string, now: Date): string {
  const mins = Math.max(0, Math.round((now.getTime() - Date.parse(atIso)) / 60_000));
  if (mins < 2) return 'just now';
  if (mins < 90) return `${mins} minutes ago`;
  if (mins < 36 * 60) return `${Math.round(mins / 60)} hours ago`;
  return `${Math.round(mins / 1440)} days ago`;
}

const inr = (n: number) => `₹${n.toLocaleString('en-IN')}`;

export function summaryLine(s: Snapshot): string {
  const parts = [
    s.leads ? `${s.leads.total} prospects, ${leadsContacted(s.leads)} contacted, ${s.leads.stages.prepaid} prepaid` : '',
    s.clinicos ? `ClinicOS ${s.clinicos.payingClinics} paying` : '',
    s.reviews ? `Reviews ${reviewsPaying(s.reviews)} paying` : '',
  ].filter(Boolean);
  return `Pipeline snapshot: ${parts.join('; ')}`;
}

export function formatPipeline(s: Snapshot | null, now: Date): string {
  if (!s) return 'I have no prospect or sales numbers yet. They arrive when the pipeline snapshot runs on your Mac (scripts/pipeline-snapshot.mjs).';
  const lines: string[] = [`Prospects and sales, as of ${age(s.at, now)}:`];
  if (s.leads) {
    const l = s.leads, st = l.stages;
    lines.push(`- Clinic leads: ${l.total} prospects. ${leadsContacted(l)} contacted (${st.visited} visited, ${st.demo} demo done, ${st.asked} asked to pay, ${st.no} said no). ${st.prepaid} sale${st.prepaid === 1 ? '' : 's'} (prepaid). ${st.new + st.scored} not contacted yet.${l.followupsDue ? ` ${l.followupsDue} follow-up${l.followupsDue === 1 ? '' : 's'} due.` : ''}`);
  } else lines.push('- Clinic leads: unknown (the lead tracker could not be read).');
  if (s.clinicos) {
    const c = s.clinicos;
    lines.push(`- ClinicOS: ${c.clinics} clinic account${c.clinics === 1 ? '' : 's'} (${c.states.active} active, ${c.states.trial} on trial, ${c.states.suspended} suspended, ${c.states.cancelled} cancelled). ${c.payingClinics} ${c.payingClinics === 1 ? 'has' : 'have'} a recorded payment, ${inr(c.receivedInr)} received in total. Accounts can include demo and test clinics.`);
  } else lines.push('- ClinicOS: unknown (its database was not read).');
  if (s.reviews) {
    const r = s.reviews;
    lines.push(`- Reviews: ${r.businesses} business${r.businesses === 1 ? '' : 'es'} (${r.states.pilot} pilot, ${r.states.trial + r.states.needs_card} on trial). ${reviewsPaying(r)} paying.`);
  } else lines.push('- Reviews: unknown (its database was not read).');
  if (s.problems.length) lines.push(`Check these: ${s.problems.join('; ')}.`);
  const stale = now.getTime() - Date.parse(s.at) > 36 * 3_600_000;
  if (stale) lines.push('These numbers are more than a day old. Run the pipeline snapshot on your Mac to refresh them.');
  return lines.join('\n');
}

// Forced read route: a whole-message allowlist (see tasks/rules.ts for why not a verb deny-list).
const P = '(?:prospects?|leads?|sales|customers?|clients?|paying (?:customers?|clients?|clinics?)|demos?)';
export const PIPELINE_QUESTION_RE = new RegExp(
  '^\\W*(?:(?:hey|hi|maya)\\b[\\s,]*){0,2}(?:'
  + `how many ${P}(?:\\s*(?:\\band\\b|\\bor\\b|[,;&/-])\\s*(?:how many )?${P}){0,3}(?: do (?:i|we) have| have (?:i|we) (?:got|made|closed)| are there| so far)?`
  + `|(?:what(?:'s| is) |show(?: me)? )?(?:my |the |our )?(?:sales |lead |prospect |clinic(?:os)? )?(?:pipeline|funnel)(?: status| numbers)?`
  + `|(?:how is|how's) (?:clinic ?os|the pipeline|sales|outreach)(?: doing| going)?`
  + `|(?:any|how many) (?:new )?(?:sales|paying (?:customers?|clients?|clinics?))(?: yet| so far)?`
  + ')(?:[\\s,]+(?:right now|now|today|so far|please|maya|for clinic ?os|in clinic ?os))*\\W*$', 'i');
export const isPipelineQuestion = (m: string) => PIPELINE_QUESTION_RE.test(m.trim());
// Loose version: only decides whether the tool is offered to the model.
export const PIPELINE_RE = /\b(prospects?|leads?|sales|pipeline|funnel|paying (?:customers?|clients?|clinics?)|clinic ?os|outreach|demos?)\b/i;
