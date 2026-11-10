// Maya eval runner. Usage: node scripts/eval/run.mjs [--base http://localhost:3001] [--only id,id] [--out file.json]
// Runs every case as a throwaway user (x-maya-eval-user header, honoured only outside production) so real data is untouched.
import fs from 'node:fs';
import { CASES } from './cases.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const BASE = arg('--base', 'http://localhost:3001');
const ONLY = arg('--only', '')?.split(',').filter(Boolean);
const OUT = arg('--out', '');
if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) { console.error('Refusing to run: --base must be localhost. Outside dev the eval header is ignored and tests would act as the real user.'); process.exit(2); }
const GATED = new Set(['send_email', 'update_freshdesk_ticket', 'add_freshdesk_note', 'create_calendar_event', 'delete_calendar_event']);

const env = Object.fromEntries(fs.readFileSync(new URL('../../.env.local', import.meta.url), 'utf8').split('\n').filter(l => l.includes('=')).map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^["']|["']$/g, '')]; }));

async function login() {
  const res = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: env.MAYA_PASSWORD }) });
  if (!res.ok) throw new Error(`login failed: ${res.status}`);
  return (res.headers.getSetCookie?.() ?? []).map(c => c.split(';')[0]).join('; ');
}

async function ask(cookie, user, message) {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, 'x-maya-eval-user': user }, body: JSON.stringify({ message }) });
  if (!res.ok) return { reply: `HTTP ${res.status}`, toolCalls: [], ms: Date.now() - t0, error: true };
  const text = await res.text();
  let reply = ''; const toolCalls = [];
  for (const part of text.split('\n\n')) {
    if (!part.startsWith('data: ')) continue;
    const d = part.slice(6).trim(); if (d === '[DONE]') continue;
    try { const j = JSON.parse(d); if (j.chunk) reply += j.chunk; if (j.tool && j.phase === 'end') toolCalls.push({ tool: j.tool, ok: j.ok, args: j.args, result: j.result }); } catch { /* ignore */ }
  }
  return { reply: reply.trim(), toolCalls, ms: Date.now() - t0 };
}

function grade(c, r) {
  const fails = []; const used = r.toolCalls.map(t => t.tool);
  if (r.error) fails.push(r.reply);
  if (c.noTools && used.length) fails.push(`called tools: ${used.join(',')}`);
  for (const t of c.tools ?? []) if (!used.includes(t)) fails.push(`missing tool ${t} (used: ${used.join(',') || 'none'})`);
  if (c.anyTools && !c.anyTools.some(t => used.includes(t))) fails.push(`none of ${c.anyTools.join('|')} called (used: ${used.join(',') || 'none'})`);
  for (const t of c.forbidTools ?? []) if (used.includes(t)) fails.push(`forbidden tool ${t}`);
  for (const re of c.match ?? []) if (!re.test(r.reply)) fails.push(`reply missing ${re}`);
  for (const re of c.avoid ?? []) if (re.test(r.reply)) fails.push(`reply matches avoided ${re}`);
  if (c.maxWords && r.reply.split(/\s+/).filter(Boolean).length > c.maxWords) fails.push(`too long (${r.reply.split(/\s+/).length} words > ${c.maxWords})`);
  const gatedUsed = used.filter(t => GATED.has(t));
  if (gatedUsed.length && !/waiting for your approval|queued/i.test(r.reply)) fails.push('gated tool without approval text');
  if (/error|went wrong|snag/i.test(r.reply) && !c.match) fails.push('error-ish reply');
  const custom = c.custom?.(r); if (custom) fails.push(custom);
  return fails;
}

const cookie = await login();
const run = `${Date.now().toString(36)}`;
const todo = CASES.filter(c => !ONLY.length || ONLY.includes(c.id));
const results = [];
for (const [i, c] of todo.entries()) {
  const user = `cso-eval-${run}-${i}`;
  // Free-tier Groq limits tokens per minute: when the reply is the rate-limit message, wait and retry (up to 3x).
  let r;
  for (let attempt = 0; attempt < 4; attempt++) {
    // Multi-turn cases: earlier messages from the same throwaway user (a rule, a question being followed up).
    if (attempt === 0) for (const p of c.pre ?? []) await ask(cookie, user, p);
    try { r = await ask(cookie, user, c.msg); } catch (e) { r = { reply: `exception: ${e.message}`, toolCalls: [], ms: 0, error: true }; }
    if (!/rate limit for the moment|Hit a snag/.test(r.reply) || attempt === 3) break;
    await new Promise(res => setTimeout(res, 40000));
  }
  const fails = grade(c, r);
  results.push({ id: c.id, msg: c.msg, pass: fails.length === 0, fails, tools: r.toolCalls.map(t => t.tool), toolCalls: r.toolCalls, reply: r.reply, ms: r.ms });
  console.log(`${fails.length ? 'FAIL' : 'PASS'}  ${c.id.padEnd(20)} ${String(r.ms).padStart(5)}ms  tools=[${r.toolCalls.map(t => t.tool).join(',')}]${fails.length ? '\n        ' + fails.join('\n        ') + '\n        reply: ' + r.reply.replace(/\n/g, ' ⏎ ').slice(0, 220) : ''}`);
}
const passed = results.filter(r => r.pass).length;
console.log(`\n${passed}/${results.length} passed  (run ${run}, users cso-eval-${run}-*)`);
if (OUT) fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
