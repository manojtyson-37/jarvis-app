import { NextResponse } from 'next/server';
import { getDashboardData, markReminderDone, deleteReminder, deleteNote } from '@/lib/supabase';

const USER_ID = 'manoj';

export async function GET() {
  const data = await getDashboardData(USER_ID);
  return NextResponse.json(data);
}

export async function POST(req: Request) {
  const { action, id } = await req.json();
  switch (action) {
    case 'reminder_done':
      await markReminderDone(USER_ID, id);
      break;
    case 'delete_reminder':
      await deleteReminder(USER_ID, id);
      break;
    case 'delete_note':
      await deleteNote(USER_ID, id);
      break;
    default:
      return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
