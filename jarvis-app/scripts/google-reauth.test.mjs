// Run: node --test scripts/google-reauth.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import {
  CALLBACK_PATH, REQUIRED_SCOPES, parseEnv, upsertEnvText, assertEnvIntegrity,
  makePkce, buildAuthUrl, missingScopes, waitForCallback,
} from './google-reauth.mjs';

test('upsertEnvText replaces in place, keeps order and other lines', () => {
  const before = 'A=1\nGOOGLE_REFRESH_TOKEN=old\nB=2\n';
  const after = upsertEnvText(before, 'GOOGLE_REFRESH_TOKEN', 'new');
  assert.equal(after, 'A=1\nGOOGLE_REFRESH_TOKEN=new\nB=2\n');
  assertEnvIntegrity(before, after, 'GOOGLE_REFRESH_TOKEN');
});

test('upsertEnvText appends when missing, handles no trailing newline and empty files', () => {
  assert.equal(upsertEnvText('A=1\nB=2', 'K', 'v'), 'A=1\nB=2\nK=v\n');
  assert.equal(upsertEnvText('', 'K', 'v'), 'K=v\n');
});

test('upsertEnvText collapses duplicate key lines to one', () => {
  const before = 'K=a\nX=1\nK=b\n';
  const after = upsertEnvText(before, 'K', 'c');
  assert.equal(after, 'K=c\nX=1\n');
  assertEnvIntegrity(before, after, 'K');
});

test('assertEnvIntegrity throws when another line is lost, changed, or the key is missing/duplicated', () => {
  assert.throws(() => assertEnvIntegrity('A=1\nB=2\nK=x\n', 'A=1\nK=y\n', 'K'));
  assert.throws(() => assertEnvIntegrity('A=1\nB=2\nK=x\n', 'A=1\nB=3\nK=y\n', 'K'));
  assert.throws(() => assertEnvIntegrity('A=1\nK=x\n', 'A=1\n', 'K'));
  assert.throws(() => assertEnvIntegrity('A=1\nK=x\n', 'A=1\nK=y\nK=z\n', 'K'));
});

test('parseEnv reads plain and quoted values', () => {
  assert.deepEqual(parseEnv('A=1\nB="two"\n# c\nC=\'3\'\nbad line\n'), { A: '1', B: 'two', C: '3' });
});

test('PKCE challenge is base64url(sha256(verifier)) and values are fresh', () => {
  const a = makePkce();
  assert.equal(a.challenge, crypto.createHash('sha256').update(a.verifier).digest('base64url'));
  assert.ok(a.verifier.length >= 43 && a.verifier.length <= 128);
  assert.notEqual(a.verifier, makePkce().verifier);
});

test('buildAuthUrl carries every security-relevant parameter', () => {
  const u = new URL(buildAuthUrl({ clientId: 'cid', redirectUri: 'http://127.0.0.1:1/oauth2callback', state: 'st', challenge: 'ch', loginHint: 'me@example.com' }));
  assert.equal(u.origin + u.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  const p = u.searchParams;
  assert.equal(p.get('response_type'), 'code');
  assert.equal(p.get('access_type'), 'offline');
  assert.equal(p.get('prompt'), 'consent');
  assert.equal(p.get('code_challenge_method'), 'S256');
  assert.equal(p.get('code_challenge'), 'ch');
  assert.equal(p.get('state'), 'st');
  assert.equal(p.get('login_hint'), 'me@example.com');
  assert.equal(p.get('scope'), REQUIRED_SCOPES.join(' '));
  assert.equal(p.get('client_secret'), null);
});

test('missingScopes reports exactly the ungranted scopes', () => {
  assert.deepEqual(missingScopes(REQUIRED_SCOPES.join(' ')), []);
  assert.deepEqual(missingScopes(REQUIRED_SCOPES.slice(0, 2).join(' ')), REQUIRED_SCOPES.slice(2));
  assert.deepEqual(missingScopes(''), REQUIRED_SCOPES);
  assert.deepEqual(missingScopes(undefined), REQUIRED_SCOPES);
});

// Loopback server helpers
const get = (port, pathAndQuery, host = `127.0.0.1:${port}`) =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathAndQuery, headers: { host } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
const start = (state, extra = {}) => {
  let resolvePort;
  const portReady = new Promise((r) => (resolvePort = r));
  const result = waitForCallback({ port: 0, state, timeoutMs: 5000, onListening: resolvePort, ...extra });
  return { portReady, result };
};

test('callback server: wrong host, path and state are rejected and it keeps waiting; the good callback resolves the code', async () => {
  const { portReady, result } = start('goodstate');
  const port = await portReady;
  assert.equal(await get(port, `${CALLBACK_PATH}?state=goodstate&code=x`, 'evil.example:80'), 400);
  assert.equal(await get(port, `/other?state=goodstate&code=x`), 404);
  assert.equal(await get(port, `${CALLBACK_PATH}?state=wrong&code=x`), 400);
  assert.equal(await get(port, `${CALLBACK_PATH}?code=x`), 400);
  assert.equal(await get(port, `${CALLBACK_PATH}?state=goodstate&code=THECODE`), 200);
  assert.equal(await result, 'THECODE');
});

test('callback server: Google error param rejects', async () => {
  const { portReady, result } = start('s1');
  const port = await portReady;
  const settled = assert.rejects(result, /access_denied/);
  assert.equal(await get(port, `${CALLBACK_PATH}?state=s1&error=access_denied`), 200);
  await settled;
});

test('callback server: times out when nobody signs in', async () => {
  const { result } = start('s2', { timeoutMs: 150 });
  await assert.rejects(result, /timed out/);
});

test('callback server: busy port gives a clear error', async () => {
  const { portReady, result } = start('s3');
  const port = await portReady;
  await assert.rejects(waitForCallback({ port, state: 's4', timeoutMs: 1000 }), /busy/);
  await get(port, `${CALLBACK_PATH}?state=s3&code=c`);
  await result;
});
