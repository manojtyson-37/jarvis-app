// Standing rules: things Manoj tells Maya about how to behave ("be polite", "from now on reply in Hindi",
// "never use emoji"). They are captured deterministically, not left to the model: on 2026-11-10 "Remember to be
// polite. I am your boss" was said twice and never stuck, because nothing stored it.

// A time cue means a reminder ("remember to call mom at 6"), not a rule about behaviour.
const TIME_CUE = /\b(at \d|\d{1,2}(?::\d{2})?\s?(?:am|pm)\b|tomorrow|tonight|today|this (?:morning|afternoon|evening|week|weekend)|next (?:week|month|year|mon|tue|wed|thu|fri|sat|sun)\w*|on (?:mon|tues|wednes|thurs|fri|satur|sun)day|in \d+ ?(?:min|minute|hour|hr|day|week)s?\b|every (?:day|morning|evening|night|week|month|(?:mon|tues|wednes|thurs|fri|satur|sun)day))/i;

// Verbs that describe how Maya replies or behaves. "Remember to call mom" is a to-do; "remember to call me Sir" is a rule.
const BEHAVIOUR = /^(?:be|sound|act|stay|keep|call me|address me|refer to me|reply|respond|answer|talk|speak|write|use|avoid|not|never|always|stop|ask me|tell me|give me|show me|greet|mention|include|format|confirm|double-check|check with me)\b/i;

const PERSIST = /\b(?:ever|again|anymore|any more|from now on|going forward|in (?:the )?future|henceforth)\b/i;
const REPLY_HABIT = /^(?:stop|quit|don'?t|do not)\s+(?:being|calling me|using|saying|replying|answering|adding|giving me|talking|writing|starting|ending|sending me|asking me|apologi[sz]ing|repeating)\b/i;

export type StandingRule = { rule: string; kind: 'instruction' | 'fact' };

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const tidy = (s: string) => cap(s.trim().replace(/\s+/g, ' ').replace(/^[,:;\-–—\s]+/, ''));

export function parseStandingInstruction(raw: string): StandingRule | null {
  let m = raw.trim();
  if (!m || m.length > 300 || /\?\s*$/.test(m)) return null;
  // Leading address and courtesy words carry no meaning here.
  m = m.replace(/^(?:(?:hey|hi|ok(?:ay)?|so|and|also)\s*,?\s+)*(?:maya\s*[,:]?\s+)?(?:please\s+)?/i, '').trim();
  if (!m) return null;

  // A rule plus a request ("be polite and check my inbox") is not captured: saving it would drop the request.
  if (/\b(?:and|then|also|but)\s+(?:please\s+)?(?:check|show|tell me|send|remind|what|find|list|read|set|add|log|save|search|get|delete|reply|email|look)\b/i.test(m)
    || /[.!;]\s*(?:please\s+)?(?:check|show|tell me|send|remind|what|find|list|read|set|add|log|save|search|get|delete|reply|email|look|can you|could you)\b/i.test(m)) return null;
  // A time cue means a reminder, even after "from now on" ("from now on remind me every morning at 8").
  if (TIME_CUE.test(m)) return null;

  let r: RegExpExecArray | null;
  if ((r = /^(?:from now on|going forward|in (?:the )?future|henceforth)\b[,:]?\s*(.{3,})$/i.exec(m))) {
    return { rule: tidy(r[1]), kind: 'instruction' };
  }

  if ((r = /^remember\s+that\s+(.{3,})$/i.exec(m))) return { rule: tidy(r[1]), kind: 'fact' };
  if ((r = /^(?:remember|make sure|i want you|i'?d like you|i would like you)\s+to\s+(.{3,})$/i.exec(m))) {
    return BEHAVIOUR.test(r[1]) ? { rule: tidy(r[1]), kind: 'instruction' } : null;
  }
  if (/^(?:always|never)\s+\S/i.test(m) && !/^never\s?mind\b/i.test(m)) return { rule: tidy(m), kind: 'instruction' };
  if (/^call me\s+\S/i.test(m)) return { rule: tidy(m), kind: 'instruction' };
  if (/^(?:be|sound|act|stay)\s+(?:more\s+|less\s+|a bit\s+|very\s+)?[a-z]+\b/i.test(m) && m.split(/\s+/).length <= 10) {
    return { rule: tidy(m), kind: 'instruction' };
  }
  if (/^(?:stop|quit|don'?t|do not)\b/i.test(m) && (PERSIST.test(m) || REPLY_HABIT.test(m))) {
    return { rule: tidy(m), kind: 'instruction' };
  }
  if ((r = /^i (?:prefer|want) (?:that )?you (?:to )?((?:always|never|be|reply|respond|answer|keep|use|talk|speak|write)\b.{2,})$/i.exec(m))) {
    return { rule: tidy(r[1]), kind: 'instruction' };
  }
  return null;
}

// Two rules are the same when they differ only in case, punctuation or spacing.
export const ruleKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export function rulesBlock(rules: string[]): string {
  if (!rules.length) return '';
  return `MANOJ'S STANDING RULES (he set these himself; they override every style rule above when they conflict; follow all of them in every reply):\n${rules.map(r => `- ${r}`).join('\n')}`;
}

export function ruleSavedReply(r: StandingRule): string {
  return r.kind === 'fact'
    ? `Noted, Manoj. I'll remember that: ${r.rule.replace(/\.$/, '')}.`
    : `Understood, Manoj. I'll follow this from now on: ${r.rule.replace(/\.$/, '')}. You can edit it under Notes → Rules.`;
}
