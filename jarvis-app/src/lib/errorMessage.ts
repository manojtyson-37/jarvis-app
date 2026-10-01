// Supabase/Postgrest errors are plain objects (not `instanceof Error`), so the common
// `e instanceof Error ? e.message : String(e)` pattern collapses them to "[object Object]".
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === 'object' && 'message' in e && typeof (e as { message: unknown }).message === 'string') {
    return (e as { message: string }).message;
  }
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}
