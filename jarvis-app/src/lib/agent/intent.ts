// Decides, in code, when a chat message is a multi-step goal for the background agent loop.
// Starting a run is safe either way (every sensitive step still waits for Manoj's yes), so this only needs to catch
// real chains of work, not every possible phrasing. Anything it misses goes to the normal one-turn chat.
const PREFIX = /^\s*\/?(?:goal|agent)\s*[:\-–]\s*([\s\S]+)$/i;
// Sequencing words that join two pieces of work.
const CHAIN = /\b(?:and then|then|after that|afterwards|once (?:that'?s|it'?s|you'?re) done|followed by)\b/i;
const VERBS = /\b(find|search|look ?up|check|draft|write|prepare|compose|send|email|mail|book|schedule|set ?up|create|invite|share|summari[sz]e|read|research|remind|add|save|reply|forward|compare|collect|gather|attach|plan)\b/gi;
const NEGATED_START = /^\s*(?:don'?t|do not|never|stop|cancel)\b/i;
const MAX_LEN = 1000;

// "cancel my goal", "stop the agent", "abort goals": stops every goal in progress.
const CANCEL = /^\s*(?:please\s+)?(?:cancel|stop|abort|kill)\s+(?:the\s+|my\s+|that\s+|this\s+|all\s+(?:my\s+)?)?(?:goals?|agent(?: runs?)?|runs?|background (?:work|tasks?))\s*[.!]*\s*$/i;
export const parseCancelGoal = (message: string): boolean => CANCEL.test(message ?? '');

export function parseGoalIntent(message: string): string | null {
  const text = (message ?? '').trim();
  if (!text || text.length > MAX_LEN) return null;
  const p = PREFIX.exec(text);
  if (p) {
    const goal = p[1].trim();
    return goal.length >= 4 ? goal : null;
  }
  if (text.length < 20 || NEGATED_START.test(text) || !CHAIN.test(text)) return null;
  const verbs = new Set((text.match(VERBS) ?? []).map(v => v.toLowerCase().replace(/\s+/g, '')));
  return verbs.size >= 2 ? text : null;
}
