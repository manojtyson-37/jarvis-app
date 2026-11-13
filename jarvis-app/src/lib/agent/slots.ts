// Free-slot finding is done in code, not by the model: date and overlap arithmetic is where models slip.
// Everything is IST (+05:30, no daylight saving).
const IST_MS = 330 * 60 * 1000;
const DAY_MS = 86400000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface Interval { start: string; end: string }

// "2026-11-16" -> epoch ms of 00:00 IST that day.
const istMidnight = (date: string) => Date.parse(`${date}T00:00:00+05:30`);

export function istIso(ms: number): string {
  const d = new Date(ms + IST_MS);
  return `${d.toISOString().slice(0, 19)}+05:30`;
}

export const istDate = (ms: number) => new Date(ms + IST_MS).toISOString().slice(0, 10);

// Monday..Friday of the week after the current IST week. On a Sunday that is the week starting tomorrow.
export function nextWeekRange(now: Date): { from: string; to: string } {
  const today = istMidnight(istDate(now.getTime()));
  const dow = new Date(today + IST_MS).getUTCDay(); // 0 = Sunday, in IST
  const toMonday = ((8 - dow) % 7) || 7;
  const mon = today + toMonday * DAY_MS;
  return { from: istDate(mon), to: istDate(mon + 4 * DAY_MS) };
}

export type SlotArgs = { from: string; to: string; minutes: number } | { error: string };

export function parseSlotArgs(raw: Record<string, unknown>): SlotArgs {
  const from = String(raw.from_date ?? '').trim(), to = String(raw.to_date ?? '').trim();
  const minutes = Number(raw.duration_minutes ?? 30);
  if (!DATE_RE.test(from) || !DATE_RE.test(to) || Number.isNaN(istMidnight(from)) || Number.isNaN(istMidnight(to))) {
    return { error: 'from_date and to_date must be YYYY-MM-DD.' };
  }
  if (istMidnight(to) < istMidnight(from)) return { error: 'to_date must be on or after from_date.' };
  if ((istMidnight(to) - istMidnight(from)) / DAY_MS > 13) return { error: 'Search at most 14 days at a time.' };
  if (!Number.isInteger(minutes) || minutes < 15 || minutes > 240) return { error: 'duration_minutes must be a whole number from 15 to 240.' };
  return { from, to, minutes };
}

// Weekday slots inside working hours that overlap no busy interval and start after `now`, on a 30-minute grid.
export function freeSlots(
  busy: Interval[], from: string, to: string, minutes: number,
  opts: { now: Date; dayStartHour?: number; dayEndHour?: number; stepMin?: number; max?: number },
): Interval[] {
  const { now, dayStartHour = 10, dayEndHour = 18, stepMin = 30, max = 8 } = opts;
  const blocks = busy
    .map(b => [Date.parse(b.start), Date.parse(b.end)] as const)
    .filter(([s, e]) => !Number.isNaN(s) && !Number.isNaN(e) && e > s);
  const out: Interval[] = [];
  for (let day = istMidnight(from); day <= istMidnight(to) && out.length < max; day += DAY_MS) {
    const dow = new Date(day + IST_MS).getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const last = day + dayEndHour * 3600000 - minutes * 60000;
    for (let s = day + dayStartHour * 3600000; s <= last && out.length < max; s += stepMin * 60000) {
      const e = s + minutes * 60000;
      if (s < now.getTime()) continue;
      if (blocks.some(([bs, be]) => s < be && e > bs)) continue;
      out.push({ start: istIso(s), end: istIso(e) });
    }
  }
  return out;
}

export function formatSlots(slots: Interval[], minutes: number): string {
  if (!slots.length) return `No free ${minutes}-minute slot on weekdays 10:00-18:00 IST in that range.`;
  const label = (iso: string) => new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  return `Free ${minutes}-minute slots (IST, weekdays 10:00-18:00):\n` +
    slots.map(s => `• ${label(s.start)} — start ${s.start}, end ${s.end}`).join('\n');
}
