interface RedashResults {
  query_result?: {
    data?: {
      columns: { name: string }[];
      rows: Record<string, unknown>[];
    };
    retrieved_at?: string;
  };
}

interface RedashQuerySummary { id: number; name: string; tags?: string[] }
interface RedashQueryListResponse { count?: number; results?: RedashQuerySummary[] }

// getQueryResults requires already knowing a specific query ID — there was no way to
// discover what queries actually exist ("what's in my Redash folder"). Redash's own search
// endpoint covers this; its plain list endpoint also works for a bare browse with no term.
export async function listQueries(search?: string): Promise<string> {
  const url = process.env.REDASH_URL;
  const key = process.env.REDASH_API_KEY;
  if (!url || !key) return 'Redash not configured.';

  const endpoint = search?.trim()
    ? `${url}/api/queries?q=${encodeURIComponent(search.trim())}&page_size=20`
    : `${url}/api/queries?page_size=20`;
  const res = await fetch(endpoint, { headers: { Authorization: `Key ${key}` } });
  if (!res.ok) return `Redash query list failed: ${res.status}`;

  const data = await res.json() as RedashQueryListResponse;
  const queries = data.results ?? [];
  if (!queries.length) return search ? `No Redash queries match "${search}".` : 'No Redash queries found.';

  return queries.slice(0, 20).map(q => {
    const tags = q.tags?.length ? ` [${q.tags.join(', ')}]` : '';
    return `#${q.id} "${q.name}"${tags}`;
  }).join('\n');
}

export async function getQueryResults(queryId: string): Promise<string> {
  const url = process.env.REDASH_URL;
  const key = process.env.REDASH_API_KEY;
  if (!url || !key) return 'Redash not configured.';
  if (!/^\d+$/.test(queryId)) return 'Invalid query ID — must be numeric.';

  const res = await fetch(`${url}/api/queries/${queryId}/results.json`, {
    headers: { Authorization: `Key ${key}` },
  });
  if (res.status === 404) return `Query #${queryId} not found.`;
  if (!res.ok) return `Redash fetch failed: ${res.status}`;

  const data = await res.json() as RedashResults;
  const rows = data.query_result?.data?.rows ?? [];
  const columns = data.query_result?.data?.columns ?? [];
  if (!rows.length) return `Query #${queryId} returned no rows.`;

  const cols = columns.map(c => c.name);
  const header = cols.join(' | ');
  const lines = rows.slice(0, 20).map(r => cols.map(c => String(r[c] ?? '')).join(' | '));
  const retrieved = data.query_result?.retrieved_at ? ` (as of ${new Date(data.query_result.retrieved_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })})` : '';
  return `${header}\n${lines.join('\n')}${retrieved}${rows.length > 20 ? `\n...(${rows.length - 20} more rows)` : ''}`;
}
