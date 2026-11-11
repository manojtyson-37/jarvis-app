// Runs fn over items with at most `limit` in flight; results keep the input order. Gmail answers 429 when too many
// requests run at once, so every bulk Gmail read goes through this.
export async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

// Reads a paged listing (newest first) until `max` ids or `maxPages` pages. null only when the FIRST page fails (never
// mistaken for "no mail"); a later page failing keeps what was read, and the unread older mail is simply picked up by a
// later run because nothing was claimed for it.
export async function collectPages(
  getPage: (pageToken: string) => Promise<{ ids: string[]; next?: string } | null>, max: number, maxPages: number,
): Promise<string[] | null> {
  const out: string[] = [];
  let token = '';
  for (let page = 0; page < maxPages && out.length < max; page++) {
    const r = await getPage(token);
    if (!r) return page === 0 ? null : out;
    out.push(...r.ids);
    if (!r.next) break;
    token = r.next;
  }
  return out.slice(0, max);
}
