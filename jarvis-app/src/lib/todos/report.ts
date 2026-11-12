// One report per batch: a chat message and one push. Pure, so the wording is tested.
import type { Tier } from './classify';

export interface Outcome { text: string; tier: Tier; status: 'done' | 'awaiting_approval' | 'manual' | 'failed'; detail: string }

const MAX_DETAIL = 700;
const clip = (t: string) => (t.length > MAX_DETAIL ? `${t.slice(0, MAX_DETAIL).trimEnd()}… (full result in Notes)` : t);

export function buildReport(outcomes: Outcome[]): { chat: string; push: { title: string; body: string } } | null {
  if (!outcomes.length) return null;
  const by = (s: Outcome['status']) => outcomes.filter(o => o.status === s);
  const done = by('done'), waiting = by('awaiting_approval'), manual = by('manual'), failed = by('failed');
  const parts: string[] = [];
  if (done.length) parts.push(done.map(o => `✅ **Done: ${o.text}**\n${clip(o.detail)}`).join('\n\n'));
  if (waiting.length) parts.push(waiting.map(o => `⏳ **Waiting for your approval: ${o.text}**\n${clip(o.detail)}`).join('\n\n'));
  if (manual.length) parts.push(manual.map(o => `🙋 **Needs you: ${o.text}**: ${o.detail}`).join('\n'));
  if (failed.length) parts.push(failed.map(o => `⚠️ **Couldn't finish: ${o.text}**: ${o.detail}`).join('\n'));
  const counts = [
    done.length && `${done.length} done`, waiting.length && `${waiting.length} waiting for approval`,
    manual.length && `${manual.length} need you`, failed.length && `${failed.length} couldn't finish`,
  ].filter(Boolean).join(', ');
  return {
    chat: `To-do update: ${counts}.\n\n${parts.join('\n\n')}`,
    push: { title: 'Maya · To-dos', body: `${counts}. ${outcomes[0].text}${outcomes.length > 1 ? ` +${outcomes.length - 1} more` : ''}`.slice(0, 180) },
  };
}

export function manualReason(kind: string, approvalFromOthers: boolean): string {
  if (approvalFromOthers) return 'this came from an email or meeting, so I won\'t send or change anything for it. Tell me in chat if you want it done.';
  if (kind === 'money') return 'it moves money, which I never do.';
  if (kind === 'credential' || kind === 'settings') return 'it touches passwords or account settings, which I never do.';
  return 'this one needs you.';
}
