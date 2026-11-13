// Tier per tool for the multi-step agent loop. Set HERE, in code: the model can ask for a tool, never change its tier.
// Tiered autonomy, decided by Manoj 2026-11-01:
//   auto     : read, search, summarise, draft, notes, to-dos, reminders — runs inside the loop
//   approval : send email, calendar changes, deletes — queued in pending_actions; the run pauses until he decides
//   never    : anything else (money logs, deletes with no approval path, credentials, settings) — not offered at all
// A tool missing from this table is 'never', so a new tool is never exposed to the unattended loop by accident.
export type AgentTier = 'auto' | 'approval' | 'never';

export const AGENT_TOOL_TIER: Readonly<Record<string, AgentTier>> = {
  // auto: reads
  web_search: 'auto', read_url: 'auto',
  search_notes: 'auto', get_recent_notes: 'auto',
  list_reminders: 'auto', get_calendar_events: 'auto', find_free_slots: 'auto',
  get_meeting_notes: 'auto', get_action_items: 'auto',
  list_emails: 'auto', get_email: 'auto', list_labels: 'auto',
  search_drive: 'auto', read_drive_file: 'auto',
  get_morning_briefing: 'auto',
  // auto: safe writes that only touch Manoj's own lists
  save_note: 'auto', set_reminder: 'auto', add_todos: 'auto',
  // approval: go through the existing gate (GATED_TOOLS)
  send_email: 'approval', create_calendar_event: 'approval', delete_calendar_event: 'approval',
  // never in an unattended run
  delete_note: 'never', mark_reminder_done: 'never', complete_action_item: 'never',
  log_workout: 'never', log_expense: 'never', log_income: 'never',
  get_recent_workouts: 'never', get_finance_summary: 'never',
};

export const tierOf = (name: string): AgentTier =>
  Object.prototype.hasOwnProperty.call(AGENT_TOOL_TIER, name) ? AGENT_TOOL_TIER[name] : 'never';

// Tools that reach the open internet. A search query or URL can carry data out.
export const WEB_TOOLS: ReadonlySet<string> = new Set(['web_search', 'read_url']);

// Tools that return Manoj's private data. Once one has run, web tools are withdrawn for the rest of the run,
// so text injected into an email or file can never get private data sent out through a search or a URL.
export const PRIVATE_READERS: ReadonlySet<string> = new Set([
  'search_notes', 'get_recent_notes', 'list_reminders', 'get_calendar_events', 'find_free_slots',
  'get_meeting_notes', 'get_action_items', 'list_emails', 'get_email', 'list_labels',
  'search_drive', 'read_drive_file', 'get_morning_briefing',
]);

export function allowedTools(privateRead: boolean): Set<string> {
  const out = new Set<string>();
  for (const [name, tier] of Object.entries(AGENT_TOOL_TIER)) {
    if (tier === 'never') continue;
    if (privateRead && WEB_TOOLS.has(name)) continue;
    out.add(name);
  }
  return out;
}
