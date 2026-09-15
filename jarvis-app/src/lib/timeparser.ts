const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function nowIST() {
  return new Date(Date.now() + IST_OFFSET_MS);
}

function toUTC(istDate: Date) {
  return new Date(istDate.getTime() - IST_OFFSET_MS);
}

export function parseReminderTime(expr: string): Date | null {
  if (!expr) return null;
  const lower = expr.toLowerCase().trim();
  const now = nowIST();

  const inMatch = lower.match(/in\s+(\d+)\s+(minute|minutes|min|hour|hours|hr|day|days)/);
  if (inMatch) {
    const n = parseInt(inMatch[1]);
    const unit = inMatch[2];
    const ms = unit.startsWith('min') ? n * 60000
      : unit.startsWith('h') ? n * 3600000
      : n * 86400000;
    return new Date(Date.now() + ms);
  }

  if (lower.startsWith('tomorrow')) {
    const timeStr = lower.replace('tomorrow', '').trim();
    const tomorrow = new Date(now);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    return applyTimeString(tomorrow, timeStr) ?? setHour(tomorrow, 9, 0);
  }

  if (lower.startsWith('tonight') || lower.startsWith('today')) {
    const timeStr = lower.replace(/^(tonight|today)/, '').trim();
    return applyTimeString(new Date(now), timeStr) ?? setHour(new Date(now), 20, 0);
  }

  const days = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  for (let i = 0; i < days.length; i++) {
    if (lower.startsWith(days[i])) {
      const timeStr = lower.replace(days[i], '').trim();
      const target = new Date(now);
      let diff = (i - target.getUTCDay() + 7) % 7;
      const candidate = applyTimeString(new Date(target), timeStr) ?? setHour(new Date(target), 9, 0);
      if (diff === 0 && candidate <= new Date()) diff = 7;
      target.setUTCDate(target.getUTCDate() + diff);
      return applyTimeString(target, timeStr) ?? setHour(target, 9, 0);
    }
  }

  return null;
}

function applyTimeString(date: Date, timeStr: string): Date | null {
  if (!timeStr) return null;
  const match = timeStr.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!match) return null;
  let h = parseInt(match[1]);
  const m = parseInt(match[2] ?? '0');
  const meridiem = (match[3] ?? '').toLowerCase();
  if (meridiem === 'pm' && h < 12) h += 12;
  if (meridiem === 'am' && h === 12) h = 0;
  return setHour(date, h, m);
}

function setHour(date: Date, h: number, m: number): Date {
  const d = new Date(date);
  d.setUTCHours(h, m, 0, 0);
  return toUTC(d);
}
