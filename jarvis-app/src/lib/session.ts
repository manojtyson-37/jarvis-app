export const SESSION_COOKIE = 'maya_session';
export const SESSION_MAX_AGE = 30 * 24 * 60 * 60; // 30 days in seconds

export async function createSessionToken(secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const ts = Date.now();
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`maya:${ts}`));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)));
  const tsB64 = btoa(ts.toString());
  return `${tsB64}.${sigB64}`;
}

export async function verifySessionToken(token: string, secret: string): Promise<boolean> {
  try {
    const [tsB64, sigB64] = token.split('.');
    if (!tsB64 || !sigB64) return false;
    const ts = parseInt(atob(tsB64));
    if (isNaN(ts) || Date.now() - ts > SESSION_MAX_AGE * 1000) return false;
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );
    const sigBytes = Uint8Array.from(atob(sigB64), c => c.charCodeAt(0));
    return crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(`maya:${ts}`));
  } catch {
    return false;
  }
}
