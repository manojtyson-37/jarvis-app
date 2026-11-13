// Pure: the text of the "needs your approval" push. Lock-screen text is seen by anyone holding the phone, so it names
// the action (recipient, subject, event title) but never an email body, note or event description.
const clip = (t: string, max: number) => {
  const one = t.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
};
const str = (v: unknown) => (typeof v === 'string' ? v : '');

export function approvalPush(tool: string, args: Record<string, unknown>, pendingId: string): { title: string; body: string; tag: string } {
  let body: string;
  if (tool === 'send_email') {
    const subject = clip(str(args.subject), 80);
    body = `Send email to ${clip(str(args.to), 120)}${subject ? ` · "${subject}"` : ''}`;
  } else if (tool === 'create_calendar_event') {
    body = `Add to calendar: "${clip(str(args.title), 100)}"`;
  } else if (tool === 'delete_calendar_event') {
    body = `Delete from calendar: "${clip(str(args.event_title), 100) || 'an event'}"`;
  } else {
    body = 'An action is waiting for your approval';
  }
  // Tapping the notification opens the app on Chat, where the approval cards (full text, Approve, Cancel) are shown.
  return { title: 'Maya · Needs your approval', body: `${body}. Open Maya to approve or cancel.`.slice(0, 180), tag: `approval-${pendingId}` };
}
