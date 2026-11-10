#!/usr/bin/env node
// One-step Google re-authorization for Maya (fixes "Token has been expired or revoked" / invalid_grant).
// Run it from your own terminal:   cd "/Users/manojaaa/Documents/Manoj OS/jarvis-app" && node scripts/google-reauth.mjs
//
// What it does:
//  1. Opens Google's consent page (loopback + PKCE flow) for the account Maya uses.
//  2. Catches the response on http://127.0.0.1:<port>/oauth2callback (bound to 127.0.0.1 only, state checked).
//  3. Refuses to continue if you signed in as a different account or unticked a permission.
//  4. Proves the new token works against Gmail, Calendar and Drive before saving anything.
//  5. Saves it as GOOGLE_REFRESH_TOKEN in .env.local, then (only if you answer y) in Vercel Production.
// The token is never printed, never put on a command line, and never written anywhere else.
//
// Options:  --no-vercel   save to .env.local only
// Env:      REAUTH_PORT (default 53682), GOOGLE_EXPECTED_ACCOUNT (default manojsuperb09@gmail.com)
// If Google shows "redirect_uri_mismatch", add the redirect URI this script prints to the OAuth client's
// "Authorized redirect URIs" in Google Cloud Console (Desktop-type clients accept it as is).

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ENV_KEY = 'GOOGLE_REFRESH_TOKEN';
export const CALLBACK_PATH = '/oauth2callback';
// Least privilege for what the app does: Gmail read + send, Calendar events, Drive read-only.
export const REQUIRED_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/drive.readonly',
];

// ---------- pure helpers (unit-tested in google-reauth.test.mjs) ----------

export function parseEnv(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2');
  }
  return out;
}

// Replace KEY in place (first occurrence), drop duplicates of it, or append it. Every other line is kept as is.
export function upsertEnvText(text, key, value) {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const out = [];
  let done = false;
  for (const line of lines) {
    if (line.startsWith(`${key}=`)) {
      if (!done) out.push(`${key}=${value}`);
      done = true;
    } else out.push(line);
  }
  if (!done) out.push(`${key}=${value}`);
  return out.join('\n') + '\n';
}

// .env.local holds every app secret: refuse to write unless all other lines survived untouched.
export function assertEnvIntegrity(before, after, key) {
  const keep = (t) => t.split('\n').filter((l) => l !== '' && !l.startsWith(`${key}=`));
  const a = keep(before);
  const b = keep(after);
  if (a.length !== b.length || a.some((l, i) => l !== b[i])) throw new Error('env rewrite would change other lines; .env.local left untouched');
  if (after.split('\n').filter((l) => l.startsWith(`${key}=`)).length !== 1) throw new Error(`env rewrite must contain ${key} exactly once; .env.local left untouched`);
}

export function makePkce() {
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function buildAuthUrl({ clientId, redirectUri, state, challenge, loginHint }) {
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: REQUIRED_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'false',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    ...(loginHint ? { login_hint: loginHint } : {}),
  }).toString();
  return u.toString();
}

export function missingScopes(granted, required = REQUIRED_SCOPES) {
  const have = new Set((granted || '').split(/\s+/).filter(Boolean));
  return required.filter((s) => !have.has(s));
}

const safeEqual = (a, b) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

const page = (msg) => `<!doctype html><meta charset="utf-8"><title>Maya</title><body style="font:16px system-ui;background:#0a0a0c;color:#eee;display:grid;place-items:center;height:100vh;margin:0"><p>${msg}</p></body>`;

// Starts a loopback server and resolves with the authorization code. Requests with a wrong Host, path or state
// get an error and the server keeps waiting; one good callback (or a Google error) ends it.
export function waitForCallback({ port, state, timeoutMs = 300000, onListening }) {
  return new Promise((resolve, reject) => {
    let actualPort = port;
    let finished = false;
    const server = http.createServer((req, res) => {
      if (req.headers.host !== `127.0.0.1:${actualPort}`) return void res.writeHead(400).end('bad host');
      const url = new URL(req.url, `http://127.0.0.1:${actualPort}`);
      if (url.pathname !== CALLBACK_PATH) return void res.writeHead(404).end('not found');
      if (!safeEqual(url.searchParams.get('state') || '', state)) return void res.writeHead(400).end('state mismatch');
      const err = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      // finish only after the page is flushed, so closing connections cannot truncate it
      if (err || !code) {
        res.end(page('Google did not authorize this. Return to the terminal.'), () => finish(() => reject(new Error(`Google returned: ${err || 'no code'}`))));
      } else {
        res.end(page('Done. You can close this tab and return to the terminal.'), () => finish(() => resolve(code)));
      }
    });
    const timer = setTimeout(() => finish(() => reject(new Error('timed out waiting for the Google sign-in (5 min)'))), timeoutMs);
    function finish(settle) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      server.close();
      server.closeAllConnections?.();
      settle();
    }
    server.once('error', (e) => {
      clearTimeout(timer);
      reject(new Error(e.code === 'EADDRINUSE' ? `port ${port} is busy; set REAUTH_PORT to a free port (and register that redirect URI)` : e.message));
    });
    server.listen(port, '127.0.0.1', () => {
      actualPort = server.address().port;
      onListening?.(actualPort);
    });
  });
}

// ---------- network steps ----------

async function postForm(url, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(20000),
  });
  return { ok: res.ok, status: res.status, body: await res.json().catch(() => ({})) };
}

const googleError = (r) => `${r.status} ${r.body.error || ''} ${r.body.error_description || ''}`.trim(); // never includes request params

async function getJson(url, accessToken) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(20000) });
  return { ok: res.ok, status: res.status, body: await res.json().catch(() => ({})) };
}

// Best effort: a grant we are rejecting should not stay live in the Google account.
async function revokeQuietly(token) {
  try {
    await postForm('https://oauth2.googleapis.com/revoke', { token });
  } catch {
    /* ignore */
  }
}

function openBrowser(url) {
  execFile('open', [url], () => {}); // macOS; the URL is printed as a fallback
}

// ---------- main ----------

async function main() {
  const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const envFile = path.join(HERE, '.env.local');
  const skipVercel = process.argv.includes('--no-vercel');
  const expected = (process.env.GOOGLE_EXPECTED_ACCOUNT || 'manojsuperb09@gmail.com').toLowerCase();
  const wantPort = Number(process.env.REAUTH_PORT || 53682);

  const before = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
  const env = parseEnv(before);
  const clientId = env.GOOGLE_CLIENT_ID;
  const clientSecret = env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET missing from .env.local');

  const { verifier, challenge } = makePkce();
  const state = crypto.randomBytes(16).toString('hex');

  console.log(`Re-authorizing Maya for ${expected}`);
  console.log('Permissions requested: Gmail read + send, Calendar events, Drive read-only.\n');

  let redirectUri = '';
  const codePromise = waitForCallback({
    port: wantPort,
    state,
    onListening: (p) => {
      redirectUri = `http://127.0.0.1:${p}${CALLBACK_PATH}`;
      console.log(`Listening on ${redirectUri} (this machine only).`);
      console.log('If Google shows "redirect_uri_mismatch", add exactly that URI under Authorized redirect URIs for this OAuth client, then rerun.');
      const url = buildAuthUrl({ clientId, redirectUri, state, challenge, loginHint: expected });
      console.log('\nOpening your browser. If it does not open, paste this URL into Chrome:\n' + url + '\n');
      console.log(`Sign in as ${expected} and tick ALL requested permissions.`);
      openBrowser(url);
    },
  });
  const code = await codePromise;

  console.log('\nGoogle responded. Exchanging the code...');
  const tok = await postForm('https://oauth2.googleapis.com/token', {
    client_id: clientId,
    client_secret: clientSecret,
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });
  if (!tok.ok) throw new Error(`token exchange failed: ${googleError(tok)}`);
  const refreshToken = tok.body.refresh_token;
  if (!refreshToken) throw new Error('Google returned no refresh token. Remove Maya at https://myaccount.google.com/permissions and rerun.');
  const missing = missingScopes(tok.body.scope);
  if (missing.length) throw new Error(`you did not grant: ${missing.map((s) => s.split('/').pop()).join(', ')}. Rerun and tick every box. Nothing was saved.`);

  console.log('Checking the new token against Gmail, Calendar and Drive...');
  const access = tok.body.access_token;
  const profile = await getJson('https://gmail.googleapis.com/gmail/v1/users/me/profile', access);
  if (!profile.ok) throw new Error(`Gmail check failed: ${profile.status}`);
  const who = String(profile.body.emailAddress || '').toLowerCase();
  if (who !== expected) await revokeQuietly(refreshToken);
  if (who !== expected) throw new Error(`signed in as ${who || 'unknown'}, but Maya uses ${expected}. Nothing was saved; rerun and pick the right account.`);
  const checks = {
    'Gmail labels': 'https://www.googleapis.com/gmail/v1/users/me/labels',
    'Calendar events': 'https://www.googleapis.com/calendar/v3/calendars/primary/events?maxResults=1',
    'Drive files': 'https://www.googleapis.com/drive/v3/files?pageSize=1',
  };
  for (const [name, url] of Object.entries(checks)) {
    const r = await getJson(url, access);
    if (!r.ok) throw new Error(`${name} check failed: HTTP ${r.status}. Is that API enabled for this Google Cloud project? Nothing was saved.`);
    console.log(`  ok  ${name}`);
  }
  const round = await postForm('https://oauth2.googleapis.com/token', {
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  if (!round.ok) throw new Error(`refresh round-trip failed: ${googleError(round)}. Nothing was saved.`);
  console.log('  ok  refresh round-trip (exactly what the app does)');
  if (tok.body.refresh_token_expires_in) {
    const days = Math.round(Number(tok.body.refresh_token_expires_in) / 86400);
    console.log(`\nWARNING: this token expires in ~${days} days because the OAuth app is in "Testing" status.`);
    console.log('Google Cloud Console > APIs & Services > OAuth consent screen (Audience) > Publish app, or it will break again.');
  }

  // Re-read now: the browser step can take minutes, and anything edited meanwhile must survive.
  const current = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
  const after = upsertEnvText(current, ENV_KEY, refreshToken);
  assertEnvIntegrity(current, after, ENV_KEY);
  const tmp = `${envFile}.tmp`;
  try {
    fs.rmSync(tmp, { force: true }); // a stale tmp would keep its old permissions
    fs.writeFileSync(tmp, after, { mode: 0o600 });
    fs.renameSync(tmp, envFile);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  console.log('\nSaved GOOGLE_REFRESH_TOKEN to .env.local');

  if (skipVercel) return console.log('Skipped Vercel (--no-vercel).');
  if (!process.stdin.isTTY) return console.log('Not a terminal, so Vercel was not touched. Rerun in a terminal, or update the variable yourself.');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const yes = /^y/i.test((await rl.question('\nUpdate GOOGLE_REFRESH_TOKEN in Vercel Production now? [y/N] ')).trim());
  rl.close();
  if (!yes) return console.log('Left Vercel unchanged. Production keeps the old token until you update it and redeploy.');
  const run = (sub) => execFileSync('vercel', ['env', sub, ENV_KEY, 'production', '--yes'], { cwd: HERE, input: `${refreshToken}\n`, stdio: ['pipe', 'pipe', 'pipe'], timeout: 60000 });
  const why = (e) => `${e.code || 'exit ' + (e.status ?? 'n/a')}`; // code or exit status only, never command output
  const byHand = 'The new token is saved in .env.local; set GOOGLE_REFRESH_TOKEN in Vercel Production by hand.';
  try {
    run('update');
  } catch (e) {
    // `add` is only right when the variable does not exist; any other failure (auth, network, timeout) must not fall through
    if (!/not found|does not exist|no environment variable/i.test(`${e.stderr || ''}${e.stdout || ''}`)) throw new Error(`could not update Vercel (${why(e)}). ${byHand}`);
    try {
      run('add');
    } catch (e2) {
      throw new Error(`could not add the variable in Vercel (${why(e2)}). ${byHand}`);
    }
  }
  console.log('Updated GOOGLE_REFRESH_TOKEN in Vercel Production.');
  console.log('Production still runs the old token until you redeploy:  vercel --prod --yes');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    () => process.exit(0),
    (e) => {
      console.error(`\nFailed: ${e.message}`);
      process.exit(1);
    },
  );
}
