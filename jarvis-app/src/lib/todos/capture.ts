// Turns a to-do list message into items. Two shapes only, both anchored at the start of the message, so a
// mid-sentence "my to-dos" or a question about them never becomes a capture:
//   "My to-dos: a, b and c"  (the check-in push prefills exactly this, and "My to-dos for tomorrow: " at EOD)
//   "add X to my to-dos" / "add to my to-do list: X"
// 'assistant' = added by the model through the add_todos tool: the model may have been steered by an email or page it
// read, so like email and meeting items it is never trusted with outward actions.
export type TodoSource = 'chat' | 'checkin' | 'email' | 'meeting' | 'assistant';
export const UNTRUSTED_SOURCES: ReadonlySet<TodoSource> = new Set(['email', 'meeting', 'assistant']);
export interface TodoCapture { items: string[]; source: TodoSource }

const MAX_ITEMS = 10;
const MAX_LEN = 500;
const TODO = 'to-?\\s?dos?(?:\\s+list)?';
const LIST_PREFIX = new RegExp(`^\\s*(my\\s+)?${TODO}(?:\\s+for\\s+(?:today|tomorrow|tonight|the day|this week|next week))?\\s*[:\\-–—]\\s*([\\s\\S]*)$`, 'i');
const ADD_COLON = new RegExp(`^\\s*(?:please\\s+)?add\\s+(?:these\\s+|this\\s+)?(?:to|on)\\s+my\\s+${TODO}\\s*[:\\-–—]\\s*([\\s\\S]+)$`, 'i');
const ADD_INLINE = new RegExp(`^\\s*(?:please\\s+)?add\\s+([\\s\\S]+?)\\s+(?:to|on)\\s+my\\s+${TODO}\\s*[.!]?\\s*$`, 'i');
const NOTHING = /^(?:nothing(?: much)?|none|no|nope|nil|n\/?a|-+|all done|na)[.!]?$/i;
// " and " splits only when the next words start a new task ("research X and draft Y"), not inside one ("salt and pepper").
const VERB = '(?:research|find|look up|lookup|check|draft|write|summari[sz]e|remind|call|email|mail|message|text|book|schedule|pay|send|buy|order|read|review|prepare|plan|compare|note|reply|follow up|cancel|renew|submit|apply|update|fix|clean|go|get|ask|tell|set up|create|make)';
const AND_SPLIT = new RegExp(`\\s+and\\s+(?=${VERB}\\b)`, 'i');

function split(body: string): string[] {
  const lines = body.split(/\n+/).map(l => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim()).filter(Boolean);
  const parts = lines.length > 1 ? lines : lines.flatMap(l => l.split(/\s*;\s*/)).flatMap(l => l.split(/\s*,\s*/));
  return parts.flatMap(p => p.split(AND_SPLIT)).map(p => p.trim().replace(/[.!]+$/, '').trim()).filter(Boolean);
}

export function parseTodoCapture(message: string): TodoCapture | null {
  let body: string | undefined, source: TodoSource = 'chat';
  const m = LIST_PREFIX.exec(message);
  if (m) { body = m[2]; source = m[1] ? 'checkin' : 'chat'; }
  else body = ADD_COLON.exec(message)?.[1] ?? ADD_INLINE.exec(message)?.[1];
  if (!body?.trim() || NOTHING.test(body.trim())) return null;
  const seen = new Set<string>();
  const items: string[] = [];
  for (const raw of split(body)) {
    const item = raw.slice(0, MAX_LEN);
    const key = item.toLowerCase();
    if (NOTHING.test(item) || seen.has(key)) continue;
    seen.add(key); items.push(item);
    if (items.length >= MAX_ITEMS) break;
  }
  return items.length ? { items, source } : null;
}

// Model-extracted to-dos (from email or meeting text) are untrusted output: strings only, trimmed, capped.
export function cleanExtracted(raw: unknown, max = 5): string[] {
  const list = (raw as { todos?: unknown })?.todos;
  if (!Array.isArray(list)) return [];
  return list.filter((t): t is string => typeof t === 'string')
    .map(t => t.replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, 300)).filter(t => t.length >= 3).slice(0, max);
}
