// Pure rules for the stuck to-do nudge: which to-dos get a push, and what the push says. No network, no database.
export const NUDGE_AFTER_DAYS = 3;
export const MAX_NUDGES_PER_RUN = 2;
const DAY_MS = 86_400_000;

export interface StuckRow { id: string; text: string; status: string; created_at: string; source: string }

// Only to-dos the runner is responsible for: created since the runner existed, from a runnable source, still open.
// Older to-dos (pre-runner meeting items) are never nudged, or every old item would fire at once.
export function stuckTodos(rows: StuckRow[], nowMs: number, alreadyNudged: Set<string>, runnerSinceIso: string, runnableSources: string[]): StuckRow[] {
  const runnerSince = Date.parse(runnerSinceIso);
  return rows
    .filter(r => (r.status === 'pending' || r.status === 'awaiting_approval'))
    .filter(r => runnableSources.includes(r.source))
    .filter(r => { const t = Date.parse(r.created_at); return !Number.isNaN(t) && t >= runnerSince && nowMs - t >= NUDGE_AFTER_DAYS * DAY_MS; })
    .filter(r => !alreadyNudged.has(r.id))
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
    .slice(0, MAX_NUDGES_PER_RUN);
}

export function nudgePush(row: StuckRow, nowMs: number): { title: string; body: string; tag: string } {
  const days = Math.floor((nowMs - Date.parse(row.created_at)) / DAY_MS);
  const one = row.text.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
  const text = one.length > 120 ? `${one.slice(0, 119).trimEnd()}…` : one;
  const waiting = row.status === 'awaiting_approval' ? 'waiting for your approval' : 'still open';
  // Email-sourced text can hold email content: keep it off the lock screen, same rule as approval pushes.
  const body = row.source === 'email'
    ? `A to-do from your email is ${waiting}. Open Maya to see it.`
    : `${text}. Tell me in chat to do it, change it or drop it.`;
  return { title: `Maya · To-do ${waiting} ${days} days`, body, tag: `todo-nudge-${row.id}` };
}
