// Plain-language status shown while Maya is working, from the tool events the chat stream emits.
export const TOOL_LABELS: Record<string, string> = {
  list_emails: 'Checking Gmail', get_email: 'Opening the email', send_email: 'Preparing the email', list_labels: 'Checking Gmail labels',
  search_drive: 'Searching Drive', read_drive_file: 'Reading the file',
  get_calendar_events: 'Checking your calendar', create_calendar_event: 'Preparing the event', delete_calendar_event: 'Preparing the change',
  save_note: 'Saving the note', search_notes: 'Searching notes', get_recent_notes: 'Opening notes', delete_note: 'Deleting the note',
  set_reminder: 'Setting the reminder', list_reminders: 'Checking reminders', mark_reminder_done: 'Updating the reminder',
  log_workout: 'Logging the workout', get_recent_workouts: 'Checking workouts',
  log_expense: 'Logging the expense', log_income: 'Logging the income', get_finance_summary: 'Totalling your spending',
  get_morning_briefing: 'Putting your briefing together', web_search: 'Searching the web', read_url: 'Reading the page',
  list_job_applications: 'Checking your applications', get_job_profile: 'Checking your job facts', set_job_profile: 'Saving your job facts', clear_job_ask: 'Clearing the reply',
  get_today_activity: 'Looking back at today', search_conversations: 'Searching our past chats', list_tasks: 'Checking every task list', get_pipeline: 'Checking prospects and sales',
  get_meeting_notes: 'Opening meeting notes', get_action_items: 'Checking action items', complete_action_item: 'Updating the item', add_todos: 'Adding to-dos',
};
