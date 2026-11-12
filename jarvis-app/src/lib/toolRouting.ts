// Sends the model only the tool definitions a message can plausibly need. All ~33 definitions cost ~3k tokens
// per call, and the free Groq tier allows 8k tokens/minute, so a full set made every second message wait ~40s.
const CATEGORIES: { tools: string[]; re: RegExp }[] = [
  { tools: ['list_emails', 'get_email', 'send_email', 'list_labels'],
    // Job-search updates arrive only by email; on 2026-11-10 "Any job roles where I am moved to next stage rejected?"
    // got "I don't have a tool to track job applications" whenever the chat before it was not about email.
    re: /\b(e-?mails?|mails?|gmail|inbox|unread|labels?|respond|reply|replied|message from|sender|newsletter|send|sent|write|wrote|reach(?:ed)? out|jobs?|applications?|applied|applying|candidacy|interviews?|shortlist(?:ed)?|reject(?:ed|ions?)?|recruiters?|hiring|offer letter|next (?:stage|round|steps?)|anything from|heard (?:back )?from|any (?:updates?|news) (?:from|on))\b|\b(?=[0-9a-f]*[a-f])[0-9a-f]{10,}\b|\[(?:automated|needs-look)\]/i },
  { tools: ['get_calendar_events', 'create_calendar_event', 'delete_calendar_event'],
    re: /\b(calendar|schedule|scheduled|reschedule|meeting|meetings|event|events|appointment|agenda|invite|book|free|busy|cancel|move|postpone|today|tomorrow|tonight|this week|next week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|\b\d{1,2}\s?(?:am|pm)\b/i },
  { tools: ['search_drive', 'read_drive_file'],
    re: /\b(drive|docs?|document|documents|sheets?|spreadsheet|slides?|deck|file|files|folder|pdf)\b/i },
  { tools: ['save_note', 'search_notes', 'get_recent_notes', 'delete_note'],
    re: /\b(notes?|jot|write (it )?down|remember that|note that|memo)\b/i },
  { tools: ['set_reminder', 'list_reminders', 'mark_reminder_done'],
    re: /\b(remind|reminders?|alarm|forget|nudge|ping me|follow up|mark|tick|done|finished|completed?)\b/i },
  { tools: ['log_workout', 'get_recent_workouts'],
    re: /\b(workouts?|run|ran|running|gym|lift|lifting|exercise|walk|walked|swim|cycling|cycle|fitness|steps|km|reps|yoga|training|trained)\b/i },
  { tools: ['log_expense', 'log_income', 'get_finance_summary'],
    re: /\b(expenses?|spent|spend|spending|income|salary|paid|pay|earned|budget|finance|rupees?|rs\.?|₹|cost|bought|bill|burn|burned|savings?)\b/i },
  { tools: ['get_morning_briefing'], re: /\b(briefing|brief me|morning|my day|rundown)\b/i },
  { tools: ['read_url'], re: /https?:\/\/|\bwww\./i },
  { tools: ['get_meeting_notes', 'get_action_items', 'complete_action_item'],
    re: /\b(meeting|meetings|minutes|action items?|to-?dos?|tasks?|transcript|call with)\b/i },
];

// Always available: cheap, and the most common intents that keywords alone can miss.
const CORE = ['web_search', 'save_note', 'set_reminder', 'get_calendar_events'];

export function selectToolNames(message: string, context: string[], forced?: string): Set<string> {
  const names = new Set<string>(CORE);
  const test = (text: string) => { for (const c of CATEGORIES) if (c.re.test(text)) c.tools.forEach(t => names.add(t)); };
  test(message);
  // A short follow-up ("summarise these", "reply to the second one") has no keywords of its own:
  // borrow the domain of the recent conversation.
  if (message.trim().split(/\s+/).length <= 14) context.forEach(test);
  if (forced) names.add(forced);
  return names;
}

export function selectTools<T extends { function: { name: string } }>(all: T[], message: string, context: string[], forced?: string): T[] {
  const names = selectToolNames(message, context, forced);
  return all.filter(t => names.has(t.function.name));
}
