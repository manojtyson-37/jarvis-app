// Read-only RLS check for the Maya Supabase project. Reads keys from .env.local, never prints them.
//   node scripts/verify-rls.mjs
// For every public table it prints the row count the service-role key sees and the row count the public
// anon key can see. With RLS on (and no policies) the anon count must be 0.
// If SUPABASE_DB_URL is set, it also reads relrowsecurity from the catalog, which is the only proof for
// empty tables, and lists views (RLS does not protect views).
// Exit codes: 0 all proven, 1 anon can read rows or RLS is off, 2 setup or service-role failure,
// 3 some tables could not be proven (empty with no catalog access, or the anon request failed).
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

function loadEnv(path) {
  const out = {};
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {
    /* no .env.local, fall back to process.env */
  }
  return out;
}

function jwtRole(key) {
  try {
    return JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString('utf8')).role;
  } catch {
    return null;
  }
}

function die(msg) {
  console.error(msg);
  process.exit(2);
}

const env = { ...loadEnv('.env.local'), ...process.env };
const url = env.NEXT_PUBLIC_SUPABASE_URL;
const anon = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const service = env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !anon || !service) die('Missing NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY or SUPABASE_SERVICE_ROLE_KEY');
// A pasted-in anon key as the "service" key would make every table look empty and protected.
if (jwtRole(service) !== 'service_role') die('SUPABASE_SERVICE_ROLE_KEY is not a service_role key');
if (jwtRole(anon) !== 'anon') die('NEXT_PUBLIC_SUPABASE_ANON_KEY is not an anon key');

async function listTables() {
  const res = await fetch(`${url}/rest/v1/`, { headers: { apikey: service, Authorization: `Bearer ${service}` } });
  if (!res.ok) die(`Could not list tables from the OpenAPI spec (HTTP ${res.status})`);
  const spec = await res.json();
  const names = Object.keys(spec.paths ?? {})
    .filter((p) => p !== '/' && !p.startsWith('/rpc/'))
    .map((p) => p.slice(1))
    .sort();
  if (!names.length) die('OpenAPI spec listed no tables');
  return names;
}

async function visibleRows(table, key, isAnon = false) {
  const res = await fetch(`${url}/rest/v1/${table}?select=*&limit=1`, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: 'count=exact', Range: '0-0' },
  });
  if (res.status === 401 || res.status === 403) {
    // Only Postgres "permission denied" (42501) proves a deliberate block. A bad API key also returns 401.
    let code = null;
    try {
      code = (await res.json()).code;
    } catch {
      /* no body */
    }
    // "Denied" is good news only for the anon key. For the service-role key any 401/403 means the app is broken.
    return isAnon && code === '42501' ? { status: res.status, rows: 0, denied: true } : { status: res.status, rows: null };
  }
  if (!res.ok && res.status !== 206) return { status: res.status, rows: null };
  let body = [];
  try {
    body = await res.json();
  } catch {
    /* empty body */
  }
  const seen = Array.isArray(body) ? body.length : 0;
  const total = (res.headers.get('content-range') ?? '').split('/')[1];
  const counted = total && total !== '*' ? Number(total) : 0;
  // A returned row always counts, even if content-range is missing or "*".
  return { status: res.status, rows: Math.max(seen, counted) };
}

// relrowsecurity per public table and the list of views, via psql. The connection string is passed as an
// argument and errors are reported without the command line, so it cannot leak into output.
function catalog() {
  const dbUrl = env.SUPABASE_DB_URL;
  if (!dbUrl) return null;
  try {
    const sql =
      "select c.relname || '|' || c.relkind || '|' || c.relrowsecurity from pg_class c " +
      "join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r','p','v','m') order by 1";
    const out = execFileSync('psql', [dbUrl, '-Atc', sql], { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'] });
    const rls = new Map();
    const views = [];
    for (const line of out.trim().split('\n').filter(Boolean)) {
      const [name, kind, flag] = line.split('|');
      if (kind === 'v' || kind === 'm') views.push(name);
      else rls.set(name, flag === 't');
    }
    return { rls, views };
  } catch (e) {
    console.error(`catalog check skipped: psql failed (exit ${e.status ?? 'n/a'})`);
    return null;
  }
}

const names = await listTables();
const cat = catalog();
console.log(`tables from live OpenAPI spec: ${names.length}; catalog check: ${cat ? 'yes' : 'no (set SUPABASE_DB_URL for proof on empty tables)'}\n`);
console.log('table'.padEnd(26), 'service rows'.padEnd(14), 'anon rows'.padEnd(11), 'verdict');
let leak = false;
let broken = false;
let unproven = false;
for (const t of names) {
  const s = await visibleRows(t, service);
  const a = await visibleRows(t, anon, true);
  const catRls = cat?.rls.get(t);
  let verdict;
  if (s.rows === null) {
    verdict = `SERVICE KEY FAILS (HTTP ${s.status})`;
    broken = true;
  } else if (a.rows !== null && a.rows > 0) {
    verdict = 'LEAK: anon can read rows';
    leak = true;
  } else if (catRls === false) {
    verdict = 'RLS OFF in catalog';
    leak = true;
  } else if (a.denied) {
    verdict = `ok: anon denied (HTTP ${a.status})`;
  } else if (catRls === true) {
    verdict = 'ok: RLS on (catalog)';
  } else if (a.rows === null) {
    verdict = `UNVERIFIED: anon request failed (HTTP ${a.status})`;
    unproven = true;
  } else if (s.rows > 0) {
    verdict = 'ok: anon sees nothing';
  } else {
    verdict = 'UNVERIFIED: empty table, no catalog access';
    unproven = true;
  }
  console.log(t.padEnd(26), String(s.rows ?? 'n/a').padEnd(14), String(a.rows ?? `n/a(${a.status})`).padEnd(11), verdict);
}
if (cat?.views.length) {
  console.log(`\nWARNING: views in public bypass RLS unless security_invoker is set: ${cat.views.join(', ')}`);
}
process.exit(broken ? 2 : leak ? 1 : unproven ? 3 : 0);
