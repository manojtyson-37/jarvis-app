#!/usr/bin/env node
// Sends Maya the prospect and sales COUNTS so she can answer "how many prospects, how many sales" from any device.
// Runs on Manoj's Mac, because the lead tracker is a local file. Read-only everywhere:
//   - lead tracker: sqlite3 -readonly
//   - ClinicOS and Reviews databases: psql with default_transaction_read_only=on, count queries only
// Only numbers leave this machine. No clinic names, phone numbers or patient data are read or sent.
// A source that cannot be read is reported as a problem and shown by Maya as "unknown", never as zero.
//
//   node scripts/pipeline-snapshot.mjs            read, print, send
//   node scripts/pipeline-snapshot.mjs --dry-run  read and print only
//   node scripts/pipeline-snapshot.mjs --skip=clinicos   leave one source out (shown as unknown)
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOME = homedir();
const HERE = join(dirname(fileURLToPath(import.meta.url)), '..');
const LEADS_DB = process.env.MAYA_LEADS_DB || join(HOME, 'Tysonpe- Sandbox/clinic-outreach/data/clinics.db');
// ClinicOS production is the Neon store in .env.production.pulled (see Saas Physio/CONTEXT.md). Its plain .env is a
// different, non-production database: counting that one would report the wrong business.
const CLINICOS_ENV = process.env.MAYA_CLINICOS_ENV || join(HOME, 'Saas Physio/.env.production.pulled');
const REVIEWS_ENV = process.env.MAYA_REVIEWS_ENV || join(HOME, 'TysonLabs/.env.local');
const DRY = process.argv.includes('--dry-run');
// --skip=clinicos,reviews leaves a source out; Maya then shows it as unknown.
const SKIP = new Set((process.argv.find(a => a.startsWith('--skip='))?.slice(7) ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));

export function envValue(text, key) {
  for (const line of String(text).split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m && m[1] === key) return m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return null;
}
const readEnv = (file, key) => (existsSync(file) ? envValue(readFileSync(file, 'utf8'), key) : null);

export function pgEnv(url) {
  const u = new URL(url);
  const env = { PGHOST: u.hostname, PGUSER: decodeURIComponent(u.username), PGPASSWORD: decodeURIComponent(u.password), PGDATABASE: decodeURIComponent(u.pathname.slice(1)) || 'postgres' };
  if (u.port) env.PGPORT = u.port;
  env.PGSSLMODE = u.searchParams.get('sslmode') || 'require';
  const cb = u.searchParams.get('channel_binding');
  if (cb) env.PGCHANNELBINDING = cb;
  return env;
}

// One JSON document per query; a failed query throws and its source becomes a problem.
function pg(url, sql) {
  // Connection details go through the environment, never the command line: argv is visible to every process (ps).
  const out = execFileSync('psql', ['-At', '-v', 'ON_ERROR_STOP=1', '-c', sql], {
    encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...pgEnv(url), PGOPTIONS: '-c default_transaction_read_only=on -c statement_timeout=20000', PGCONNECT_TIMEOUT: '15' },
  });
  return JSON.parse(out.trim());
}
// psql errors can echo the connection string: keep only a short, credential-free reason.
const reason = e => String(e?.stderr || e?.message || e).split('\n').find(l => /error|fatal|timeout|ENOENT/i.test(l))?.replace(/postgres(?:ql)?:\/\/\S+/gi, '[db url]').slice(0, 70) || 'failed';

export function readLeads(db = LEADS_DB) {
  const sql = "SELECT json_object('total', COUNT(*), 'dnc', COALESCE(SUM(dnc),0), 'followupsDue', COALESCE(SUM(CASE WHEN followup IS NOT NULL AND followup <= date('now','localtime') AND dnc=0 AND status NOT IN ('no','prepaid') THEN 1 ELSE 0 END),0), 'stages', (SELECT json_group_object(status, n) FROM (SELECT status, COUNT(*) n FROM clinics GROUP BY status))) FROM clinics";
  const row = JSON.parse(execFileSync('sqlite3', ['-readonly', db, sql], { encoding: 'utf8', timeout: 15_000 }).trim());
  return { total: row.total, dnc: row.dnc, followupsDue: row.followupsDue, stages: row.stages ?? {} };
}

export function readClinicOS(url) {
  const r = pg(url, `SELECT json_build_object(
    'clinics', (SELECT count(*) FROM "Tenant" WHERE "deletedAt" IS NULL),
    'states', (SELECT COALESCE(json_object_agg(lower(s), n), '{}'::json) FROM (SELECT "subscriptionStatus"::text s, count(*) n FROM "Tenant" WHERE "deletedAt" IS NULL GROUP BY 1) q),
    'payingClinics', (SELECT count(DISTINCT p."tenantId") FROM "SubscriptionPayment" p JOIN "Tenant" t ON t.id = p."tenantId" WHERE t."deletedAt" IS NULL),
    'receivedInr', (SELECT COALESCE(round(sum(p.amount)), 0)::bigint FROM "SubscriptionPayment" p JOIN "Tenant" t ON t.id = p."tenantId" WHERE t."deletedAt" IS NULL))`);
  return { clinics: r.clinics, states: r.states, payingClinics: r.payingClinics, receivedInr: Number(r.receivedInr) };
}

// The Reviews tables force row-level security. A role that cannot see every row would count 0 and look like "no customers",
// so the counts are trusted only for a role that owns the policy or bypasses RLS.
export function readReviews(url) {
  const who = pg(url, `SELECT json_build_object('role', current_user, 'bypass', (SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = current_user), 'owner', pg_has_role(current_user, 'reviews_owner', 'member'))`);
  if (!who.bypass && !who.owner) throw new Error('error: role cannot see all rows (row-level security)');
  const r = pg(url, `SELECT json_build_object(
    'businesses', (SELECT count(*) FROM tenants),
    'states', (SELECT COALESCE(json_object_agg(state, n), '{}'::json) FROM (SELECT state, count(*) n FROM tenant_billing GROUP BY 1) q))`);
  return { businesses: r.businesses, states: r.states };
}

export function buildSnapshot({ leads, clinicos, reviews, problems }, now = new Date()) {
  return { at: now.toISOString(), leads: leads ?? null, clinicos: clinicos ?? null, reviews: reviews ?? null, problems };
}

async function main() {
  const problems = [];
  const attempt = (label, fn) => {
    if (SKIP.has(label.toLowerCase())) { problems.push(`${label}: not read in this run`); return null; }
    try { return fn(); } catch (e) { problems.push(`${label}: ${reason(e)}`); return null; }
  };
  const leads = attempt('lead tracker', () => readLeads());
  const clinicos = attempt('ClinicOS', () => {
    const url = readEnv(CLINICOS_ENV, 'DATABASE_URL_UNPOOLED') || readEnv(CLINICOS_ENV, 'DATABASE_URL');
    if (!url) throw new Error('error: no database url in its env file');
    return readClinicOS(url);
  });
  const reviews = attempt('Reviews', () => {
    const url = readEnv(REVIEWS_ENV, 'DATABASE_URL_UNPOOLED') || readEnv(REVIEWS_ENV, 'DATABASE_URL');
    if (!url) throw new Error('error: no database url in its env file');
    return readReviews(url);
  });
  const snap = buildSnapshot({ leads, clinicos, reviews, problems });
  console.log(JSON.stringify(snap, null, 2));
  if (!leads && !clinicos && !reviews) { console.error('nothing could be read; not sending'); process.exit(1); }
  if (DRY) return;

  const base = (process.env.MAYA_URL || 'https://maya.tysonlabs.in').replace(/\/$/, '');
  const key = process.env.MAYA_BRAIN_KEY || readEnv(join(HERE, '.env.local'), 'MAYA_BRAIN_KEY');
  if (!key || key.length < 32) { console.error('MAYA_BRAIN_KEY missing (jarvis-app/.env.local); not sending'); process.exit(1); }
  const res = await fetch(`${base}/api/pipeline/report`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(snap),
  });
  const text = await res.text();
  if (res.status !== 200) { console.error(`send failed: HTTP ${res.status} ${text.slice(0, 200)}`); process.exit(1); }
  console.log(`sent: ${text}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch(e => { console.error(reason(e)); process.exit(1); });
