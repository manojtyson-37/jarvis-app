'use client';

import { useCallback, useEffect, useState } from 'react';
import { CheckIcon, TrashIcon, XIcon } from '@/components/icons';

// Standing rules Maya follows in every reply. Saying one in chat ("be polite", "from now on…") adds it here too.
type Rule = { id: string; fact: string };

const card = 'rounded-2xl border border-white/10 bg-zinc-900/60';
const iconBtn = 'w-11 h-11 rounded-full flex items-center justify-center shrink-0 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-400 active:scale-95';
const field = 'w-full bg-zinc-950 border border-white/10 rounded-xl px-3 py-2.5 text-[0.9375rem] text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-indigo-400';

export default function RulesPanel() {
  const [rules, setRules] = useState<Rule[]>([]);
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const call = useCallback(async (method: string, body?: object) => {
    setBusy(true); setError('');
    try {
      const res = await fetch('/api/rules', {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data.error ?? `Error ${res.status}`); return false; }
      setRules(data.rules ?? []);
      return true;
    } catch {
      setError('Could not reach Maya. Check your connection.');
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => { call('GET'); }, [call]);

  async function add() {
    if (!draft.trim()) return;
    if (await call('POST', { text: draft })) setDraft('');
  }
  async function save(id: string) {
    if (!editText.trim()) return;
    if (await call('PATCH', { id, text: editText })) setEditing(null);
  }

  return (
    <section aria-labelledby="rules-heading" className="mb-8">
      <h2 id="rules-heading" className="text-sm font-semibold text-zinc-200">Rules Maya follows</h2>
      <p className="text-xs text-zinc-400 mt-1 mb-3">Applied to every reply. Tell Maya in chat (&ldquo;be polite&rdquo;, &ldquo;from now on…&rdquo;) or add one here.</p>

      <div className="space-y-2.5">
        {rules.map(r => (
          <div key={r.id} className={`${card} pl-4 pr-1 py-2 flex items-center gap-2`}>
            {editing === r.id ? (
              <>
                <label className="sr-only" htmlFor={`rule-${r.id}`}>Edit rule</label>
                <input id={`rule-${r.id}`} className={field} value={editText} maxLength={300} autoFocus
                  onChange={e => setEditText(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') save(r.id); if (e.key === 'Escape') setEditing(null); }} />
                <button onClick={() => save(r.id)} disabled={busy} aria-label="Save rule" className={`${iconBtn} text-emerald-300 hover:bg-white/5 disabled:opacity-50`}>
                  <CheckIcon className="w-[18px] h-[18px]" />
                </button>
                <button onClick={() => setEditing(null)} aria-label="Cancel edit" className={`${iconBtn} text-zinc-400 hover:bg-white/5`}>
                  <XIcon className="w-[18px] h-[18px]" />
                </button>
              </>
            ) : (
              <>
                <p className="flex-1 min-w-0 py-1.5 text-[0.9375rem] text-zinc-100 leading-relaxed break-words">{r.fact}</p>
                <button onClick={() => { setEditing(r.id); setEditText(r.fact); }} className="min-h-[44px] px-3 rounded-full text-sm text-zinc-300 hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-400">
                  Edit
                </button>
                <button onClick={() => call('DELETE', { id: r.id })} disabled={busy} aria-label={`Remove rule: ${r.fact}`} className={`${iconBtn} text-zinc-400 hover:text-red-300 hover:bg-white/5 disabled:opacity-50`}>
                  <TrashIcon className="w-[18px] h-[18px]" />
                </button>
              </>
            )}
          </div>
        ))}
      </div>

      <form className="mt-3 flex gap-2" onSubmit={e => { e.preventDefault(); add(); }}>
        <label className="sr-only" htmlFor="new-rule">New rule</label>
        <input id="new-rule" className={field} placeholder="e.g. Keep replies to two lines" value={draft} maxLength={300} onChange={e => setDraft(e.target.value)} />
        <button type="submit" disabled={busy || !draft.trim()} className="min-h-[44px] px-4 rounded-xl bg-indigo-500 text-white text-sm font-medium disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-300">
          Add
        </button>
      </form>
      {error && <p role="alert" className="text-sm text-red-300 mt-2">{error}</p>}
    </section>
  );
}
