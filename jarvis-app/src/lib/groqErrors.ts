// Groq answers 400 "tool_use_failed" when the model writes a tool call it cannot parse
// (2026-11-11: "anything from HDFC bank?" produced web_search with `< parameter="query">`).
// The output is sampled, so the same request usually succeeds when sent again.
export function isToolUseFailed(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const err = e as { status?: number; message?: string; error?: { error?: { code?: string } } };
  if (err.status !== 400) return false;
  return err.error?.error?.code === 'tool_use_failed' || /tool_use_failed/.test(err.message ?? '');
}

// A retry started after this point would most likely be cut off by the 52s turn deadline in the chat route.
export const TOOL_RETRY_MAX_ELAPSED_MS = 40000;

// When the retry itself fails, report the error that explains the turn: a retry that only hit the primary's
// rate limit should not turn a malformed tool call into "I'm at my rate limit".
export function reportedError(first: unknown, retry: unknown): unknown {
  const status = (x: unknown) => (x && typeof x === 'object' ? (x as { status?: number }).status : undefined);
  return status(retry) === 429 && status(first) !== 429 ? first : retry;
}

export const shouldRetryToolUseFailed = (e: unknown, elapsedMs: number) =>
  isToolUseFailed(e) && elapsedMs < TOOL_RETRY_MAX_ELAPSED_MS;
