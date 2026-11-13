// Which device a chat message came from. Decided on the server from how the request was authenticated, so a page
// or a prompt can never pick an arbitrary label: the value is always one of CHANNELS.
export const CHANNELS = ['web', 'pet', 'telegram', 'system'] as const;
export type Channel = (typeof CHANNELS)[number];

export function resolveChannel(input: { brainKey: boolean; clientHeader?: string | null; userAgent?: string | null }): Channel {
  // The Telegram bridge is the only caller holding the brain key.
  if (input.brainKey) return 'telegram';
  const claimed = (input.clientHeader ?? '').trim().toLowerCase();
  if (claimed === 'pet' || claimed === 'web') return claimed;
  // Mac pet builds from before the X-Maya-Client header: URLSession's default agent names the app and CFNetwork.
  if (/\bMayaPet\b|\bCFNetwork\b/i.test(input.userAgent ?? '')) return 'pet';
  return 'web';
}

export const isChannel = (v: unknown): v is Channel => typeof v === 'string' && (CHANNELS as readonly string[]).includes(v);
