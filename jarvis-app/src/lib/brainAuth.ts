// Server-to-server access for the maya-brain Telegram bridge (runs on the droplet).
// The brain holds MAYA_BRAIN_KEY, never the session secret, and may only reach the chat
// and the pending-action routes. Everything else still needs the browser session cookie.
const BRAIN_PATHS = [/^\/api\/chat$/, /^\/api\/actions$/, /^\/api\/actions\/[0-9a-f-]{36}$/i, /^\/api\/linkedin\/(draft|gmail)$/];
const MIN_KEY_LEN = 32;

// Middleware runs on the edge runtime (no node:crypto), so compare in constant time by hand.
function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function brainAuthorized(pathname: string, authHeader: string | null, key: string | undefined): boolean {
  if (!key || key.length < MIN_KEY_LEN) return false; // unset or weak key never opens anything
  if (!BRAIN_PATHS.some(re => re.test(pathname))) return false;
  if (!authHeader?.startsWith('Bearer ')) return false;
  return sameString(authHeader.slice(7), key);
}
