// Turns raw tool output that arrives as assistant text (email lists, a single email, Drive results)
// into structured segments so the UI can render cards instead of a wall of text.
// Pure and dependency-free so it can be tested on its own.

// `tagged` is false for the older list format that had no [automated]/[needs-look] flag, so the UI must not claim a triage result.
export interface EmailItem { id: string; automated: boolean; tagged: boolean; from: string; date: string; subject: string; snippet: string }
export interface FileItem { id: string; name: string; kind: string; modified: string }
export type Segment =
  | { type: 'text'; text: string }
  | { type: 'emails'; items: EmailItem[] }
  | { type: 'email'; from: string; date: string; subject: string; to: string; body: string }
  | { type: 'files'; items: FileItem[] };

// Matches listRecentEmails output: `[automated] [id] Sender (date) — "Subject"` + optional `  snippet` line.
const EMAIL_RE = /^\[(automated|needs-look)\]\s+\[([A-Za-z0-9]+)\]\s+(.*?)(?:\s+\(([^()]*)\))?\s+—\s+"(.*)"\s*$/;
// Older format: `[id] From: Name email@x.com — "Subject"`.
const LEGACY_EMAIL_RE = /^\[([A-Za-z0-9]+)\]\s+From:\s+(.*?)\s+—\s+"(.*)"\s*$/;
// Matches searchDrive output: `name [type] modified 2026-10-04 — id: <id>`
const FILE_RE = /^(.+?)\s+\[([^\]]+)\]\s+modified\s+(\d{4}-\d{2}-\d{2})\s+—\s+id:\s+([A-Za-z0-9_-]+)\s*$/;
// Matches getEmail output header block.
const SINGLE_EMAIL_RE = /^From: (.*)\nDate: (.*)\nSubject: (.*)\nTo: (.*)\n\n([\s\S]*)$/;

// Lines longer than this are never list rows; skipping them also bounds regex backtracking on hostile input.
const MAX_ROW = 500;

export function parseRich(content: string): Segment[] {
  // A Drive file read is arbitrary third-party text: never turn any of it into cards (it could forge them).
  if (/^UNTRUSTED FILE CONTENT/.test(content)) return [{ type: 'text', text: content.replace(/^UNTRUSTED FILE CONTENT[^\n]*\n/, '') }];
  const text = content;
  const single = SINGLE_EMAIL_RE.exec(text.trim());
  if (single) {
    return [{ type: 'email', from: single[1], date: single[2], subject: single[3], to: single[4], body: single[5].trim() }];
  }

  // Only genuine tool output starts with a list row. Prose that merely contains a row-shaped line stays plain text.
  const first = text.trimStart().split('\n', 1)[0];
  const isRow = (l: string) => l.length < MAX_ROW && (EMAIL_RE.test(l) || LEGACY_EMAIL_RE.test(l) || FILE_RE.test(l));
  if (!isRow(first)) return [{ type: 'text', text: content }];

  const segments: Segment[] = [];
  let buf: string[] = [];
  const flush = () => {
    const t = buf.join('\n').trim();
    if (t) segments.push({ type: 'text', text: t });
    buf = [];
  };
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const short = lines[i].length < MAX_ROW;
    const m = short ? EMAIL_RE.exec(lines[i]) : null;
    const lg = m || !short ? null : LEGACY_EMAIL_RE.exec(lines[i]);
    const f = m || lg || !short ? null : FILE_RE.exec(lines[i]);
    if (m || lg) {
      flush();
      let snippet = '';
      const next = lines[i + 1] ?? '';
      const isNext = EMAIL_RE.test(next.trim()) || LEGACY_EMAIL_RE.test(next.trim());
      // New format indents the snippet; the older format put it on the very next unindented line.
      if (!isNext && (/^\s{2}\S/.test(next) || (lg && next.trim() && !next.trim().startsWith('[')))) {
        snippet = lines[i + 1].trim();
        i++;
      }
      const item: EmailItem = m
        ? { id: m[2], automated: m[1] === 'automated', tagged: true, from: m[3].trim(), date: m[4] ?? '', subject: m[5], snippet }
        : { id: lg![1], automated: false, tagged: false, from: lg![2].replace(/\s*<?[\w.+-]+@[\w.-]+>?\s*$/, '').trim() || lg![2], date: '', subject: lg![3], snippet };
      const last = segments[segments.length - 1];
      if (last?.type === 'emails') last.items.push(item); else segments.push({ type: 'emails', items: [item] });
    } else if (f) {
      flush();
      const item: FileItem = { name: f[1], kind: f[2], modified: f[3], id: f[4] };
      const last = segments[segments.length - 1];
      if (last?.type === 'files') last.items.push(item); else segments.push({ type: 'files', items: [item] });
    } else {
      buf.push(lines[i]);
    }
  }
  flush();
  return segments.length ? segments : [{ type: 'text', text: content }];
}
