import { sendPush } from '@/lib/push';

export async function pushMeetingNotification(userId: string, title: string, actionItemCount: number) {
  await sendPush(userId, {
    title: 'Maya · Meeting processed',
    body: `"${title}" — ${actionItemCount} action item${actionItemCount !== 1 ? 's' : ''} extracted`,
    data: { prefill: 'Show me my action items from the last meeting' },
  });
}
