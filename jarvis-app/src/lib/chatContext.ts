// Earlier raw email lists in the chat history invite the model to copy (and mangle) them instead of
// calling the tool, and they can be stale (e.g. from a previous account). Hide them in the model's
// context only; the stored history and what the user sees are unchanged.
const ROW = /^\[(?:automated|needs[- ]?look)\]\s+\[[A-Za-z0-9]+\]|^\[[A-Za-z0-9]{10,}\]\s+From:/i;
const STUB = '[An earlier email list is not shown here: it may be out of date. Call list_emails for current mail, and re-list before acting on "the second one" or "that email". Never recreate a list from memory.]';

export function forModel(role: 'user' | 'assistant', content: string): string {
  if (role !== 'assistant' || !content.split('\n').some(l => ROW.test(l))) return content;
  const lines = content.split('\n');
  const out: string[] = [];
  let stubbed = false;
  for (let i = 0; i < lines.length; i++) {
    if (!ROW.test(lines[i])) { out.push(lines[i]); continue; }
    if (!stubbed) { out.push(STUB); stubbed = true; }
    // Drop the row's snippet line too (indented in the current format, unindented in older ones).
    const next = lines[i + 1] ?? '';
    if (next.trim() && !ROW.test(next) && !next.trim().startsWith('[')) i++;
  }
  return out.join('\n');
}

// "gmail" alone forces the read-only inbox lookup, unless the message is clearly an action or another tool's job.
export function gmailLookupIntent(message: string): boolean {
  return /\bgmail\b/i.test(message) && !/\b(send|draft|compose|reply|forward|write|connect|redash)\b/i.test(message);
}
