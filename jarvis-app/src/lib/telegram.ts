// Telegram delivery for Away Mode (escalations and the nightly report). A no-op until TELEGRAM_BOT_TOKEN and
// TELEGRAM_CHAT_ID are set, so push keeps working on its own. The token is never logged.
export async function sendTelegram(text: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: text.slice(0, 4000), disable_web_page_preview: true }),
    });
    if (!res.ok) console.error('telegram send failed:', res.status);
    return res.ok;
  } catch (e) {
    console.error('telegram send error:', (e as Error).name);
    return false;
  }
}
