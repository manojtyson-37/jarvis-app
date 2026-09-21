interface DataPrimeResult {
  result?: {
    results?: { userData?: string }[];
  };
}

export async function searchLogs(query: string, hours = 1): Promise<string> {
  const url = process.env.CORALOGIX_URL;
  const key = process.env.CORALOGIX_API_KEY;
  if (!url || !key) return 'Coralogix not configured.';

  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - hours * 3600000);

  const res = await fetch(`${url}/api/v1/dataprime/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query,
      metadata: {
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
        tier: 'TIER_FREQUENT_SEARCH',
      },
    }),
  });
  if (!res.ok) return `Coralogix query failed: ${res.status} — ${(await res.text()).slice(0, 200)}`;

  const text = await res.text();
  const lines = text.split('\n').filter(Boolean);
  const rows: string[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as DataPrimeResult;
      for (const r of parsed.result?.results ?? []) {
        if (r.userData) rows.push(r.userData.slice(0, 300));
      }
    } catch {
      // skip malformed line
    }
  }
  if (!rows.length) return `No logs matched in the last ${hours}h.`;
  return rows.slice(0, 20).join('\n---\n') + (rows.length > 20 ? `\n...(${rows.length - 20} more)` : '');
}
