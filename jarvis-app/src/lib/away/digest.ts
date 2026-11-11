// The nightly report: what Maya did while Manoj was away, shortest useful form. Plain text so it fits push and Telegram.
import type { AwaySession } from './engine';
import type { DecisionKind } from './policy';

export interface DigestRow {
  id: string; decision: DecisionKind | 'failed'; from: string; subject: string; summary: string;
  reason: string; reply?: string; delivered: boolean;
  n?: number; // a draft's permanent number: "send draft N" in chat sends exactly this one
}

// Every draft of the session in creation order. A draft keeps its number for the whole trip (sent ones keep theirs too),
// so a number printed in a report still means the same draft after others are sent.
export interface DraftRef { id: string; n: number; delivered: boolean; from: string; subject: string; reply: string }

// The report's rows plus EVERY pending draft of the trip, not only the ones inside the report window, each carrying its
// permanent number. Without this a day-2 report numbered its drafts 1..n while "send draft N" indexed the whole trip.
export function mergeDraftsIntoRows(rows: DigestRow[], all: DraftRef[]): DigestRow[] {
  const byId = new Map(all.map(d => [d.id, d]));
  const out = rows.map(r => (r.decision === 'draft' && byId.has(r.id) ? { ...r, n: byId.get(r.id)!.n, delivered: byId.get(r.id)!.delivered } : r));
  const seen = new Set(out.map(r => r.id));
  for (const d of all) {
    if (d.delivered || seen.has(d.id)) continue;
    out.push({ id: d.id, decision: 'draft', from: d.from, subject: d.subject, summary: '', reason: '', reply: d.reply, delivered: false, n: d.n });
  }
  return out;
}

const MAX_LEN = 3500; // Telegram allows 4096; leave room
const PER_SECTION = 8;
const DAY_MS = 86_400_000;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function formatDigest(session: AwaySession, rows: DigestRow[], now: Date): string {
  const total = Math.max(1, Math.ceil((session.endsAt.getTime() - session.startsAt.getTime()) / DAY_MS));
  const day = Math.min(total, Math.max(1, Math.floor((now.getTime() - session.startsAt.getTime()) / DAY_MS) + 1));
  const head = `Maya away report · Day ${day} of ${total}`;
  if (!rows.length) return `${head}\nNothing came in. All quiet.`;

  const by = (k: DigestRow['decision']) => rows.filter(r => r.decision === k);
  const answered = rows.filter(r => (r.decision === 'auto_reply' || r.decision === 'draft') && r.delivered);
  const drafts = by('draft').filter(r => !r.delivered).sort((a, b) => (a.n ?? 0) - (b.n ?? 0));
  const esc = by('escalate_now');
  const need = [...by('needs_you'), ...by('failed')];
  const ignored = by('ignore');
  const lines = [
    head,
    `${answered.length} answered · ${plural(drafts.length, 'draft')} · ${esc.length} escalated · ${need.length} need you · ${ignored.length} ignored`,
  ];

  const section = (title: string, list: DigestRow[], line: (r: DigestRow, i: number) => string) => {
    if (!list.length) return;
    lines.push('', title);
    list.slice(0, PER_SECTION).forEach((r, i) => lines.push(line(r, i)));
    if (list.length > PER_SECTION) lines.push(`+${list.length - PER_SECTION} more`);
  };
  section('ESCALATED', esc, r => `• ${clip(r.subject, 60)} — ${clip(r.from, 40)}: ${clip(r.reason, 100)}`);
  section('NEED YOU', need, r => `• ${clip(r.subject, 60)} — ${clip(r.from, 40)}: ${clip(r.reason, 100)}`);
  section('DRAFTS (the text is clipped here: say "show draft N" to read one in full, then "send draft N")', drafts, (r, i) => `${r.n ?? i + 1}. ${clip(r.subject, 50)} → ${clip(r.from, 40)}: "${clip(r.reply ?? '', 160)}"`);
  section('ANSWERED', answered, r => `• ${clip(r.subject, 60)} — ${clip(r.summary || r.from, 80)}`);

  const out = lines.join('\n');
  return out.length > MAX_LEN ? `${out.slice(0, MAX_LEN - 1)}…` : out;
}
