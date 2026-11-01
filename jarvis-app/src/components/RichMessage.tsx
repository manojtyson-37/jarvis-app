'use client';
import { useMemo, useState } from 'react';
import { marked } from 'marked';
import { parseRich, type EmailItem, type FileItem } from '@/lib/rich';
import { MailIcon, FileIcon, ChevronIcon } from '@/components/icons';

// Email/tool text is untrusted: raw HTML in it must never reach the DOM, and links must be safe.
const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
marked.use({
  breaks: true,
  renderer: {
    html: ({ text }) => escapeHtml(text),
    link({ href, title, tokens }) {
      const inner = this.parser.parseInline(tokens);
      if (!/^(https?:|mailto:)/i.test(href)) return inner;
      return `<a href="${escapeHtml(href)}"${title ? ` title="${escapeHtml(title)}"` : ''} target="_blank" rel="noopener noreferrer">${inner}</a>`;
    },
    image: ({ text }) => escapeHtml(text),
  },
});

const initials = (name: string) => name.replace(/[^A-Za-z0-9 ]/g, '').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?';

function EmailRow({ e, onAsk, busy }: { e: EmailItem; onAsk: (t: string) => void; busy: boolean }) {
  return (
    <button onClick={() => onAsk(`Show me email ${e.id}`)} disabled={busy}
      className="w-full text-left flex gap-3 px-3 py-3 min-h-[56px] rounded-xl hover:bg-white/5 active:bg-white/10 disabled:opacity-60 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-400">
      <span className={`w-9 h-9 shrink-0 rounded-full flex items-center justify-center text-xs font-semibold ${e.automated ? 'bg-zinc-800 text-zinc-300' : 'bg-indigo-500/20 text-indigo-300'}`}>{initials(e.from)}</span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className="text-sm font-medium text-zinc-100 truncate">{e.from}</span>
          {e.date && <span className="text-xs text-zinc-400 shrink-0">{e.date.replace(/\s\d{4},/, ',')}</span>}
        </span>
        <span className="block text-sm text-zinc-200 truncate">{e.subject || '(no subject)'}</span>
        {e.snippet && <span className="block text-xs text-zinc-400 line-clamp-2 mt-0.5">{e.snippet}</span>}
      </span>
    </button>
  );
}

function EmailList({ items, onAsk, busy }: { items: EmailItem[]; onAsk: (t: string) => void; busy: boolean }) {
  const [showAuto, setShowAuto] = useState(false);
  const look = items.filter(i => !i.automated);
  const auto = items.filter(i => i.automated);
  const tagged = items.some(i => i.tagged);
  return (
    <div className="rounded-2xl border border-white/10 bg-zinc-900/60 overflow-hidden w-full">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-white/10 text-xs text-zinc-300">
        <MailIcon className="w-4 h-4 text-indigo-300" />
        <span className="font-medium">{items.length} email{items.length === 1 ? '' : 's'}</span>
        {tagged && <span className="text-zinc-400">· {look.length} need a look · {auto.length} automated</span>}
      </div>
      {look.length > 0 && <div className="p-1.5">{look.map(e => <EmailRow key={e.id} e={e} onAsk={onAsk} busy={busy} />)}</div>}
      {tagged && look.length === 0 && <p className="px-4 py-3 text-sm text-zinc-300">None of these look like they need a reply.</p>}
      {auto.length > 0 && (
        <div className="border-t border-white/10">
          <button onClick={() => setShowAuto(s => !s)} aria-expanded={showAuto}
            className="w-full flex items-center justify-between px-4 py-3 min-h-[44px] text-xs font-medium text-zinc-300 hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-400">
            <span>Automated ({auto.length})</span>
            <ChevronIcon className={`w-4 h-4 transition-transform ${showAuto ? 'rotate-180' : ''}`} />
          </button>
          {showAuto && <div className="p-1.5 pt-0">{auto.map(e => <EmailRow key={e.id} e={e} onAsk={onAsk} busy={busy} />)}</div>}
        </div>
      )}
    </div>
  );
}

function FileList({ items, onAsk, busy }: { items: FileItem[]; onAsk: (t: string) => void; busy: boolean }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-zinc-900/60 overflow-hidden w-full p-1.5">
      {items.map(f => (
        // Send only the id: the file name is third-party text and must not reach the model prompt.
        <button key={f.id} onClick={() => onAsk(`Read Drive file id ${f.id}`)} disabled={busy}
          className="w-full text-left flex items-center gap-3 px-3 py-2.5 min-h-[52px] rounded-xl hover:bg-white/5 active:bg-white/10 disabled:opacity-60 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-400">
          <FileIcon className="w-5 h-5 text-indigo-300 shrink-0" />
          <span className="min-w-0 flex-1">
            <span className="block text-sm text-zinc-100 truncate">{f.name}</span>
            <span className="block text-xs text-zinc-400">{f.kind.replace('google-', 'Google ')} · {f.modified}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

export default function RichMessage({ content, onAsk, busy = false }: { content: string; onAsk: (t: string) => void; busy?: boolean }) {
  // Parsing and markdown run on every stream chunk otherwise.
  const segs = useMemo(() => parseRich(content), [content]);
  return (
    <div className="space-y-3">
      {segs.map((s, i) => {
        if (s.type === 'emails') return <EmailList key={i} items={s.items} onAsk={onAsk} busy={busy} />;
        if (s.type === 'files') return <FileList key={i} items={s.items} onAsk={onAsk} busy={busy} />;
        if (s.type === 'email') {
          return (
            <div key={i} className="rounded-2xl border border-white/10 bg-zinc-900/60 overflow-hidden w-full">
              <div className="px-4 py-3 border-b border-white/10">
                <p className="text-sm font-semibold text-zinc-100 break-words">{s.subject || '(no subject)'}</p>
                <p className="text-xs text-zinc-300 mt-1">{s.from} <span className="text-zinc-400">· {s.date}</span></p>
                <p className="text-xs text-zinc-400">To {s.to}</p>
              </div>
              <pre className="px-4 py-3 text-sm text-zinc-200 whitespace-pre-wrap break-words font-sans leading-relaxed">{s.body}</pre>
            </div>
          );
        }
        return <div key={i} className="md" dangerouslySetInnerHTML={{ __html: marked.parse(s.text) as string }} />;
      })}
    </div>
  );
}
