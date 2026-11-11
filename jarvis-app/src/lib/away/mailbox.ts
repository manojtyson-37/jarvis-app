// Strict single-mailbox parsing for the From header. A reply goes to exactly one address, and only when that address is
// unambiguous: a header that could be read two ways (comma lists, groups, quoted local parts, brackets inside quotes)
// returns null and Away Mode refuses to reply. The header is attacker-controlled; a regex guess here is a mis-sent email.

const ATOM = String.raw`[A-Za-z0-9!#$%&'*+/=?^_${'`'}{|}~-]+`;
const LOCAL_RE = new RegExp(`^${ATOM}(?:\\.${ATOM})*$`);
const LABEL_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

// dot-atom local part, hostname domain with at least two labels, 254 characters at most. No quoted locals, no literals.
export function isValidAddr(a: string): boolean {
  if (a.length > 254 || a.length < 6) return false;
  const at = a.lastIndexOf('@');
  if (at < 1 || a.indexOf('@') !== at) return false;
  const local = a.slice(0, at), domain = a.slice(at + 1);
  if (local.length > 64 || !LOCAL_RE.test(local)) return false;
  const labels = domain.split('.');
  if (labels.length < 2 || !labels.every(l => LABEL_RE.test(l))) return false;
  return /^[A-Za-z]{2,}$/.test(labels[labels.length - 1]) || /^xn--[A-Za-z0-9-]+$/.test(labels[labels.length - 1]);
}

export interface Mailbox { addr: string; rawName: string }

// One mailbox: `addr`, or `name <addr>` (name may be a quoted string). Anything else is null.
export function parseMailbox(header: string): Mailbox | null {
  if (typeof header !== 'string' || header.length === 0 || header.length > 998) return null;
  if (/[\r\n\0]/.test(header)) return null;
  let inQuote = false, lt = -1, gt = -1;
  for (let i = 0; i < header.length; i++) {
    const c = header[i];
    if (inQuote) {
      if (c === '\\') i++;
      else if (c === '"') inQuote = false;
      continue;
    }
    if (c === '"') inQuote = true;
    else if (c === ',' || c === ';' || c === ':') return null; // a list or a group: more than one possible target
    else if (c === '<') { if (lt !== -1) return null; lt = i; }
    else if (c === '>') { if (gt !== -1 || lt === -1) return null; gt = i; }
  }
  if (inQuote) return null;
  const h = header.trim();
  if (lt === -1 && gt === -1) return isValidAddr(h) ? { addr: h, rawName: '' } : null; // bare address, nothing around it
  if (lt === -1 || gt === -1 || gt < lt || header.slice(gt + 1).trim() !== '') return null;
  const addr = header.slice(lt + 1, gt);
  if (!isValidAddr(addr)) return null;
  return { addr, rawName: header.slice(0, lt).trim() };
}

// A display name safe to show and to hand to a model: no quotes, brackets, '@' (so it cannot pose as an address) or
// control characters, one line, short.
export function cleanName(name: string): string {
  return name.replace(/[\x00-\x1f\x7f<>@"\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
}
