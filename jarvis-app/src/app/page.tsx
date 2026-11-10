'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import RichMessage from '@/components/RichMessage';
import RulesPanel from '@/components/RulesPanel';
import { TOOL_LABELS } from '@/lib/toolLabels';
import { ChatIcon, NoteIcon, BellIcon, ActivityIcon, MicIcon, SendIcon, XIcon, CheckIcon, LogOutIcon, WaveIcon, MailIcon, CalendarIcon, SparkIcon, TrashIcon, RefreshIcon, ShieldIcon } from '@/components/icons';

type Tab = 'chat' | 'notes' | 'reminders' | 'fitness';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  ts: Date;
}

interface PendingAction { id: string; tool: string; summary: string; created_at: string; hash: string; detail?: string; long?: boolean; }

// Whole-utterance only. Approval needs a deliberate word ("approve"/"confirm") — never "yes", "ok"
// or "do it", which open-mic background speech or casual chat could trigger. Rejecting is safe, so it stays broad.
function voiceVerdict(text: string): 'approve' | 'reject' | null {
  const t = text.toLowerCase().replace(/[^a-z' ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t || t.split(' ').length > 4) return null;
  if (/^(approve|approved|confirm|confirmed)( it| that)?$/.test(t)) return 'approve';
  if (/^(cancel|reject|discard|never mind|nevermind)( it| that)?$/.test(t)) return 'reject';
  return null;
}

function plainForSpeech(text: string): string {
  return text.replace(/```[\s\S]*?```/g, ' ').replace(/https?:\/\/\S+/g, 'link').replace(/[*_`#>\[\]()]/g, '').replace(/\s+/g, ' ').trim().slice(0, 600);
}

interface Note { id: string; content: string; tags: string[]; created_at: string; }
interface Reminder { id: string; text: string; remind_at: string; fired: boolean; }
interface Workout { id: string; type: string; duration_min?: number; notes?: string; logged_at: string; }

function formatIST(iso: string) {
  return new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
}

function formatTime(d: Date) {
  return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
}

function urlBase64ToUint8Array(base64String: string): ArrayBuffer {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr.buffer;
}

async function dashboardAction(action: string, id: string) {
  return fetch('/api/dashboard', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, id }),
  });
}

const iconBtn = 'w-11 h-11 rounded-full flex items-center justify-center shrink-0 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-400 active:scale-95';
const card = 'rounded-2xl border border-white/10 bg-zinc-900/60';

type IconC = (p: { className?: string }) => React.ReactElement;

function PageHeader({ title, count, sub, onRefresh }: { title: string; count?: number; sub?: string; onRefresh: () => void }) {
  return (
    <div className="flex items-center justify-between mb-5">
      <div>
        <h1 className="text-xl font-semibold text-zinc-100">{title}{count !== undefined && <span className="ml-2 text-sm font-normal text-zinc-400">{count}</span>}</h1>
        {sub && <p className="text-sm text-zinc-400 mt-0.5">{sub}</p>}
      </div>
      <button onClick={onRefresh} aria-label={`Refresh ${title}`} className={`${iconBtn} text-zinc-300 hover:bg-white/5`}>
        <RefreshIcon className="w-5 h-5" />
      </button>
    </div>
  );
}

function Empty({ Icon, title, hint }: { Icon: IconC; title: string; hint: string }) {
  return (
    <div className="flex flex-col items-center text-center mt-20 px-6">
      <div className="w-12 h-12 rounded-2xl bg-white/5 flex items-center justify-center mb-3"><Icon className="w-6 h-6 text-zinc-300" /></div>
      <p className="text-sm font-medium text-zinc-200">{title}</p>
      <p className="text-sm text-zinc-400 mt-1">{hint}</p>
    </div>
  );
}

export default function MayaPage() {
  const [tab, setTab] = useState<Tab>('chat');
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [listening, setListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const transcriptRef = useRef('');
  const recognitionRef = useRef<{ stop: () => void } | null>(null);
  const shouldListenRef = useRef(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [pending, setPending] = useState<PendingAction[]>([]);
  const pendingRef = useRef<PendingAction[]>([]);
  const [handsFree, setHandsFree] = useState(false);
  const handsFreeRef = useRef(false);
  const decidingRef = useRef(false);
  const [deciding, setDeciding] = useState(false);
  const startListeningRef = useRef<() => void>(() => {});
  const stopListeningRef = useRef<(a?: 'cancel' | 'pause' | 'send') => void>(() => {});

  const [notes, setNotes] = useState<Note[]>([]);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [workouts, setWorkouts] = useState<Workout[]>([]);
  const [dashLoading, setDashLoading] = useState(false);
  const [greeting, setGreeting] = useState('Hello');
  const [activity, setActivity] = useState('');

  useEffect(() => {
    const h = Number(new Date().toLocaleString('en-IN', { hour: 'numeric', hour12: false, timeZone: 'Asia/Kolkata' }));
    setGreeting(h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening');
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  // Load conversation history on mount
  useEffect(() => {
    fetch('/api/chat')
      .then(r => r.json())
      .then(({ history }) => {
        if (!history?.length) return;
        setMessages(
          history
            .filter((h: { content: string }) => h.content?.trim())
            .map((h: { role: 'user' | 'assistant'; content: string; ts: string }) => ({
              id: crypto.randomUUID(),
              role: h.role,
              content: h.content,
              ts: new Date(h.ts),
            }))
        );
      })
      .catch(() => { /* silent — fresh start on error */ });
  }, []);

  // Listen for prefill messages from service worker (question notifications)
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const handler = (event: MessageEvent) => {
      if (event.data?.type === 'PREFILL_QUESTION' && event.data.question) {
        setInput(event.data.question);
        setTab('chat');
      }
    };
    navigator.serviceWorker.addEventListener('message', handler);
    return () => navigator.serviceWorker.removeEventListener('message', handler);
  }, []);

  // Register push subscription on mount
  useEffect(() => {
    async function subscribePush() {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
      const vapidKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
      if (!vapidKey) return;
      try {
        // next-pwa's `register: true` injects its register script into the Pages Router's
        // `main.js` webpack entry — App Router pages load `main-app.js` instead, so that
        // script never ships here and a service worker is never registered. Without this,
        // `navigator.serviceWorker.ready` waits forever for a registration that's never
        // created. Guarded to production only: next-pwa's `disable` option skips rebuilding
        // public/sw.js in dev, so a stale production sw.js left on disk from a prior build
        // would otherwise get installed and serve cached responses during local dev.
        if (process.env.NODE_ENV === 'production') {
          await navigator.serviceWorker.register('/sw.js');
        }
        const reg = await navigator.serviceWorker.ready;
        let sub = await reg.pushManager.getSubscription();
        if (!sub) {
          const perm = await Notification.requestPermission();
          if (perm !== 'granted') return;
          sub = await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(vapidKey),
          });
        }
        // Always re-register with the backend, even for an existing browser subscription —
        // the server-side record can be lost independently (e.g. a database migration)
        // while the browser's own subscription object persists. This POST is idempotent.
        const res = await fetch('/api/push/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ subscription: sub }),
        });
        if (!res.ok) console.warn('Push subscribe backend rejected:', res.status);
      } catch (e) {
        console.warn('Push subscription failed:', e);
      }
    }
    subscribePush();
  }, []);

  const loadDashboard = useCallback(async () => {
    setDashLoading(true);
    try {
      const res = await fetch('/api/dashboard');
      const data = await res.json();
      setNotes(data.notes ?? []);
      setReminders(data.reminders ?? []);
      setWorkouts(data.workouts ?? []);
    } finally {
      setDashLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tab !== 'chat') loadDashboard();
  }, [tab, loadDashboard]);

  const loadPending = useCallback(async () => {
    try {
      const res = await fetch('/api/actions');
      if (!res.ok) return;
      const { actions } = await res.json() as { actions: PendingAction[] };
      pendingRef.current = actions;
      setPending(actions);
    } catch { /* offline — keep last known list */ }
  }, []);

  useEffect(() => {
    loadPending();
    const t = setInterval(loadPending, 15000);
    return () => clearInterval(t);
  }, [loadPending]);

  // Speak a reply, then (hands-free) reopen the mic so the conversation keeps flowing.
  const speak = useCallback((text: string) => {
    if (!handsFreeRef.current) return;
    // onend is unreliable on some mobile browsers, so a timer backs it up; resume only once.
    let resumed = false;
    const resume = () => {
      if (resumed) return;
      resumed = true;
      if (handsFreeRef.current) startListeningRef.current();
    };
    const synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined;
    const clean = plainForSpeech(text);
    if (!synth || !clean) { resume(); return; }
    synth.cancel();
    const u = new SpeechSynthesisUtterance(clean);
    u.lang = 'en-IN';
    u.onend = resume;
    u.onerror = resume;
    synth.speak(u);
    setTimeout(resume, Math.min(60000, 4000 + clean.length * 90));
  }, []);

  const decide = useCallback(async (action: PendingAction, decision: 'approve' | 'reject') => {
    // One decision at a time: a second tap or an echoed word must not resolve a different action.
    if (decidingRef.current) return;
    decidingRef.current = true;
    setDeciding(true);
    try {
      let message: string;
      try {
        const res = await fetch(`/api/actions/${action.id}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // The server only runs the action if the hash of its FULL content still equals the one on this card.
          body: JSON.stringify({ decision, hash: action.hash }),
        });
        message = ((await res.json()) as { message?: string }).message ?? 'Done.';
      } catch {
        message = 'Could not reach the server. Nothing was changed.';
      }
      setMessages(prev => [...prev, { id: crypto.randomUUID(), role: 'assistant', content: message, ts: new Date() }]);
      await loadPending();
      const left = pendingRef.current;
      speak(
        left.length === 1 && left[0].long ? `${message} Next one has long text. Open Full text on screen and tap Approve.`
        : left.length === 1 ? `${message} Next: ${left[0].summary}. Say approve or cancel.`
        : left.length > 1 ? `${message} ${left.length} more are waiting. Use the buttons on screen.`
        : message,
      );
    } finally {
      decidingRef.current = false;
      setDeciding(false);
    }
  }, [loadPending, speak]);

  const send = useCallback(async (text: string) => {
    if (!text.trim() || loading) return;

    // Spoken yes/no resolves the oldest pending action directly — it never goes through the
    // model, so the model cannot approve (or be talked into approving) its own actions.
    const verdict = voiceVerdict(text);
    if (verdict && pendingRef.current.length > 0) {
      setMessages(prev => [...prev, { id: Date.now().toString(), role: 'user', content: text.trim(), ts: new Date() }]);
      setInput('');
      // Only resolve by voice when exactly one action is waiting, so the word can only mean that one.
      // With several waiting (an old one, a duplicate, an injected one) the buttons are required.
      // A long email/note can't be fully heard or seen in the spoken summary, so it needs the on-screen button.
      if (verdict === 'approve' && pendingRef.current.length === 1 && pendingRef.current[0].long) {
        const msg = 'That one has long text I can\'t read out in full — open Full text and tap Approve.';
        setMessages(prev => [...prev, { id: crypto.randomUUID(), role: 'assistant', content: msg, ts: new Date() }]);
        speak(msg);
        return;
      }
      if (pendingRef.current.length !== 1) {
        const msg = `${pendingRef.current.length} actions are waiting — use the Approve / Cancel buttons so I don't pick the wrong one.`;
        setMessages(prev => [...prev, { id: crypto.randomUUID(), role: 'assistant', content: msg, ts: new Date() }]);
        speak(msg);
        return;
      }
      await decide(pendingRef.current[0], verdict);
      return;
    }
    const userMsg: Message = { id: Date.now().toString(), role: 'user', content: text.trim(), ts: new Date() };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setLoading(true);

    const assistantId = crypto.randomUUID();
    setMessages(prev => [...prev, { id: assistantId, role: 'assistant', content: '', ts: new Date() }]);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text.trim() }),
      });
      if (!res.ok || !res.body) {
        const errText = await res.text().catch(() => `Error ${res.status}`);
        throw new Error(errText);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let fullContent = '';
      let streamDone = false;

      outer: while (!streamDone) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';

        for (const part of parts) {
          if (!part.startsWith('data: ')) continue;
          const data = part.slice(6).trim();
          if (data === '[DONE]') { streamDone = true; break outer; }
          try {
            const evt = JSON.parse(data) as { chunk?: string; tool?: string; phase?: string };
            if (evt.tool && evt.phase === 'start') setActivity(TOOL_LABELS[evt.tool] ?? 'Working on it');
            const chunk = evt.chunk;
            if (chunk) {
              setActivity('');
              fullContent += chunk;
              setMessages(prev => prev.map(m =>
                m.id === assistantId ? { ...m, content: fullContent } : m
              ));
            }
          } catch { /* ignore malformed SSE chunks */ }
        }
      }

      if (!fullContent.trim()) {
        setMessages(prev => prev.map(m =>
          m.id === assistantId ? { ...m, content: 'Something went wrong. Try again.' } : m
        ));
        speak('Something went wrong. Try again.');
      } else {
        speak(fullContent);
      }
    } catch (e) {
      setMessages(prev => prev.map(m =>
        m.id === assistantId ? { ...m, content: `Error: ${(e as Error).message}` } : m
      ));
      speak('Something went wrong. Try again.');
    } finally {
      setLoading(false);
      setActivity('');
      loadPending();
    }
  }, [loading, decide, speak, loadPending]);

  const stopListening = useCallback((action: 'cancel' | 'pause' | 'send' = 'pause') => {
    shouldListenRef.current = false;
    recognitionRef.current?.stop();
    setListening(false);
    if (action === 'cancel') {
      // Cancelling the mic also ends hands-free, otherwise the next spoken reply would reopen it.
      handsFreeRef.current = false;
      setHandsFree(false);
      window.speechSynthesis?.cancel();
    }
    const final = transcriptRef.current;
    setTranscript('');
    transcriptRef.current = '';
    if (action === 'send' && final.trim()) {
      send(final);
    } else if (action === 'pause' && final.trim()) {
      setInput(final);
    }
  }, [send]);

  stopListeningRef.current = stopListening;

  const startListening = useCallback(() => {
    window.speechSynthesis?.cancel();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    const SpeechRecognition = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!SpeechRecognition) { alert('Voice not supported. Use Chrome on Android.'); return; }
    shouldListenRef.current = true;
    setListening(true);
    setTranscript('');
    transcriptRef.current = '';

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const launch = (SpeechRecognitionCtor: new () => any) => {
      const recognition = new SpeechRecognitionCtor();
      recognition.lang = 'en-IN';
      recognition.continuous = false;
      recognition.interimResults = true;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      recognition.onresult = (e: any) => {
        let interim = '';
        for (let i = 0; i < e.results.length; i++) {
          if (e.results[i].isFinal) {
            transcriptRef.current = (transcriptRef.current + ' ' + (e.results[i][0].transcript as string)).trim();
            interim = '';
          } else {
            interim = e.results[i][0].transcript as string;
          }
        }
        setTranscript((transcriptRef.current + (interim ? ' ' + interim : '')).trim());
      };

      recognition.onend = () => {
        if (!shouldListenRef.current) return;
        // Hands-free: the recognizer ended after the user stopped talking — send what was said.
        if (handsFreeRef.current && transcriptRef.current.trim()) {
          stopListeningRef.current('send');
          return;
        }
        // 250ms delay drains the mic buffer before next session — prevents overlap
        setTimeout(() => {
          if (shouldListenRef.current) {
            try { launch(SpeechRecognitionCtor); } catch { /* give up */ }
          }
        }, 250);
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      recognition.onerror = (e: any) => {
        if (e.error === 'aborted' || e.error === 'no-speech') return;
        shouldListenRef.current = false;
        setListening(false);
        // A real mic error (permission, network) must not leave "Hands-free ON" showing with a dead mic.
        handsFreeRef.current = false;
        setHandsFree(false);
      };
      recognitionRef.current = { stop: () => recognition.abort() };
      recognition.start();
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    launch(SpeechRecognition as unknown as new () => any);
  }, []);
  startListeningRef.current = startListening;

  const toggleHandsFree = useCallback(() => {
    if (handsFreeRef.current) {
      handsFreeRef.current = false;
      setHandsFree(false);
      window.speechSynthesis?.cancel();
      stopListeningRef.current('cancel');
    } else {
      handsFreeRef.current = true;
      setHandsFree(true);
      startListeningRef.current();
    }
  }, []);

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.href = '/login';
  }

  // ── Dashboard helpers ────────────────────────────────────────────────────

  async function handleReminderDone(id: string) {
    await dashboardAction('reminder_done', id);
    setReminders(r => r.filter(x => x.id !== id));
  }
  async function handleDeleteReminder(id: string) {
    await dashboardAction('delete_reminder', id);
    setReminders(r => r.filter(x => x.id !== id));
  }
  async function handleDeleteNote(id: string) {
    await dashboardAction('delete_note', id);
    setNotes(n => n.filter(x => x.id !== id));
  }

  const now = new Date();

  const NAV: { id: Tab; label: string; Icon: IconC }[] = [
    { id: 'chat', label: 'Chat', Icon: ChatIcon },
    { id: 'notes', label: 'Notes', Icon: NoteIcon },
    { id: 'reminders', label: 'Reminders', Icon: BellIcon },
    { id: 'fitness', label: 'Fitness', Icon: ActivityIcon },
  ];

  const SUGGESTIONS = [
    'Morning briefing',
    'Any email I need to respond to?',
    "What's on my calendar today?",
    'Search my Drive for Urban Company',
  ];

  const toolMeta = (tool: string) =>
    tool.includes('email') ? { label: 'Send email', Icon: MailIcon }
    : tool.includes('calendar') ? { label: 'Calendar', Icon: CalendarIcon }
    : { label: 'Freshdesk', Icon: ShieldIcon };

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="flex h-dvh bg-zinc-950 text-zinc-100">
      {/* Desktop side rail */}
      <nav aria-label="Main" className="hidden md:flex flex-col items-center w-[84px] shrink-0 border-r border-white/10 py-5 gap-1">
        <div className="w-10 h-10 rounded-2xl bg-indigo-500/20 flex items-center justify-center mb-4" aria-hidden="true">
          <SparkIcon className="w-5 h-5 text-indigo-300" />
        </div>
        {NAV.map(({ id, label, Icon }) => (
          <button key={id} onClick={() => setTab(id)} aria-current={tab === id ? 'page' : undefined}
            className={`w-16 py-2.5 rounded-xl flex flex-col items-center gap-1 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-400 ${tab === id ? 'bg-white/10 text-zinc-50' : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-200'}`}>
            <Icon className="w-5 h-5" />
            <span className="text-[11px] font-medium">{label}</span>
          </button>
        ))}
        <div className="flex-1" />
        <button onClick={logout} aria-label="Sign out" className={`${iconBtn} text-zinc-400 hover:bg-white/5 hover:text-zinc-200`}>
          <LogOutIcon className="w-5 h-5" />
        </button>
      </nav>

      <div className="flex flex-col flex-1 min-w-0">
        {/* Mobile header */}
        <header className="md:hidden flex items-center justify-between pl-4 pr-1 h-14 border-b border-white/10 shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-indigo-500/20 flex items-center justify-center" aria-hidden="true"><SparkIcon className="w-4 h-4 text-indigo-300" /></div>
            <span className="text-base font-semibold">Maya</span>
          </div>
          <button onClick={logout} aria-label="Sign out" className={`${iconBtn} text-zinc-400 hover:bg-white/5`}>
            <LogOutIcon className="w-5 h-5" />
          </button>
        </header>

        <main className="flex-1 overflow-hidden">

          {/* ── CHAT ── */}
          {tab === 'chat' && (
            <div className="flex flex-col h-full">
              <div className="flex-1 overflow-y-auto">
                <div className="mx-auto w-full max-w-3xl px-4 py-6 space-y-6">
                  {messages.length === 0 && (
                    <div className="flex flex-col items-center text-center pt-12 md:pt-24">
                      <div className="w-14 h-14 rounded-2xl bg-indigo-500/20 flex items-center justify-center mb-5"><SparkIcon className="w-7 h-7 text-indigo-300" /></div>
                      <h1 className="text-2xl font-semibold text-zinc-50">{greeting}, Manoj</h1>
                      <p className="text-zinc-400 mt-1.5">Ask, speak, or pick one to start.</p>
                      <div className="mt-7 flex flex-wrap justify-center gap-2 max-w-xl">
                        {SUGGESTIONS.map(s => (
                          <button key={s} onClick={() => send(s)}
                            className="min-h-[44px] px-4 rounded-full border border-white/10 bg-zinc-900 text-sm text-zinc-200 hover:bg-white/5 active:scale-95 transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-400">
                            {s}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {messages.map(m => (
                    m.role === 'user' ? (
                      <div key={m.id} className="flex flex-col items-end">
                        <div className="max-w-[85%] md:max-w-[70%] rounded-2xl rounded-br-md bg-indigo-500/15 border border-indigo-400/20 px-4 py-2.5 text-[0.9375rem] leading-relaxed text-zinc-50 whitespace-pre-wrap break-words">
                          {m.content}
                        </div>
                        <span className="text-[11px] text-zinc-400 mt-1 pr-1">{formatTime(m.ts)}</span>
                      </div>
                    ) : (
                      <div key={m.id} className="flex gap-3">
                        <div className="w-8 h-8 shrink-0 rounded-full bg-indigo-500/20 flex items-center justify-center mt-0.5" aria-hidden="true"><SparkIcon className="w-4 h-4 text-indigo-300" /></div>
                        <div className="min-w-0 flex-1">
                          {m.content
                            ? <RichMessage content={m.content} onAsk={send} busy={loading} />
                            : <div className="flex gap-1.5 items-center h-8" role="status" aria-label="Maya is thinking">
                                <span className="w-2 h-2 bg-zinc-400 rounded-full dot-1" />
                                <span className="w-2 h-2 bg-zinc-400 rounded-full dot-2" />
                                <span className="w-2 h-2 bg-zinc-400 rounded-full dot-3" />
                                {activity && <span className="ml-2 text-sm text-zinc-400">{activity}…</span>}
                              </div>}
                          {m.content && <span className="block text-[11px] text-zinc-400 mt-1.5">{formatTime(m.ts)}</span>}
                        </div>
                      </div>
                    )
                  ))}
                  <div ref={bottomRef} />
                </div>
              </div>

              <div className="shrink-0 px-3 pt-2 pb-3">
                <div className="mx-auto w-full max-w-3xl space-y-2">
                  {pending.map((a, i) => {
                    const { label, Icon } = toolMeta(a.tool);
                    return (
                      <div key={a.id} role="group" aria-label={`Approval needed: ${label}`} className="rounded-2xl border border-amber-400/30 bg-amber-500/10 p-3.5">
                        <div className="flex items-center gap-2 text-xs">
                          <span className="w-6 h-6 rounded-lg bg-amber-400/20 flex items-center justify-center"><Icon className="w-3.5 h-3.5 text-amber-300" /></span>
                          <span className="font-semibold text-amber-200">{label} · needs your approval</span>
                        </div>
                        <p className="text-sm text-zinc-100 mt-2 break-words">{a.summary}</p>
                        {pending.length === 1 && i === 0 && !a.long && <p className="text-xs text-amber-200/80 mt-1">Or say “approve” / “cancel”.</p>}
                        {a.detail && (
                          <details className="mt-2">
                            <summary className="text-xs text-amber-200 cursor-pointer min-h-[44px] flex items-center">Full text{a.long ? ` (${a.detail.length} characters)` : ''}</summary>
                            <pre className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap break-words text-xs text-zinc-300 font-sans">{a.detail}</pre>
                          </details>
                        )}
                        <div className="flex gap-2 mt-3">
                          <button disabled={deciding} onClick={() => decide(a, 'approve')}
                            className="flex-1 h-11 rounded-xl bg-emerald-500 text-zinc-950 text-sm font-semibold active:scale-[0.98] transition disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300">
                            Approve
                          </button>
                          <button disabled={deciding} onClick={() => decide(a, 'reject')}
                            className="flex-1 h-11 rounded-xl border border-white/15 text-zinc-200 text-sm font-medium hover:bg-white/5 active:scale-[0.98] transition disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-400">
                            Cancel
                          </button>
                        </div>
                      </div>
                    );
                  })}

                  {handsFree && !listening && (
                    <div className="flex items-center justify-center gap-2 text-xs text-emerald-300" role="status">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />Hands-free on — I’ll listen after I reply
                    </div>
                  )}

                  {listening ? (
                    <div className="flex items-center gap-2 rounded-3xl border border-white/10 bg-zinc-900 px-2 py-2">
                      <button onClick={() => stopListening('cancel')} aria-label="Cancel voice input" className={`${iconBtn} bg-zinc-800 text-zinc-200 hover:bg-zinc-700`}>
                        <XIcon className="w-5 h-5" />
                      </button>
                      <div className="flex items-center gap-1 h-6 shrink-0" aria-hidden="true">
                        {[0, 1, 2, 3, 4].map(i => <span key={i} className="bar w-1 h-5 rounded-full bg-red-400" style={{ animationDelay: `${i * 0.12}s` }} />)}
                      </div>
                      <div className="flex-1 min-w-0 text-[0.9375rem] text-zinc-200 truncate" aria-live="polite">
                        {transcript || <span className="text-zinc-400">Listening…</span>}
                      </div>
                      <button onClick={() => stopListening('pause')} aria-label="Stop listening and edit text" className={`${iconBtn} bg-red-500 text-white relative`}>
                        <span className="absolute inset-0 rounded-full bg-red-500 pulse-ring" />
                        <MicIcon className="w-5 h-5 relative" />
                      </button>
                      <button onClick={() => stopListening('send')} disabled={!transcript.trim()} aria-label="Send voice message"
                        className={`${iconBtn} bg-indigo-600 text-white disabled:opacity-30`}>
                        <SendIcon className="w-5 h-5" />
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5 rounded-3xl border border-white/10 bg-zinc-900 px-2 py-2 focus-within:border-indigo-400 focus-within:ring-2 focus-within:ring-indigo-400/40 transition-colors">
                      <button onClick={toggleHandsFree} aria-pressed={handsFree} aria-label={handsFree ? 'Turn hands-free off' : 'Turn hands-free on'} title="Hands-free voice conversation"
                        className={`${iconBtn} ${handsFree ? 'bg-emerald-500 text-zinc-950' : 'text-zinc-300 hover:bg-white/5'}`}>
                        <WaveIcon className="w-5 h-5" />
                      </button>
                      <input
                        className="flex-1 min-w-0 h-11 bg-transparent text-base text-zinc-100 outline-none placeholder:text-zinc-400"
                        placeholder="Message Maya"
                        aria-label="Message Maya"
                        value={input}
                        onChange={e => setInput(e.target.value)}
                        onKeyDown={e => e.key === 'Enter' && send(input)}
                        disabled={loading}
                      />
                      {input.trim() ? (
                        <button onClick={() => send(input)} disabled={loading} aria-label="Send message" className={`${iconBtn} bg-indigo-600 text-white hover:bg-indigo-500`}>
                          <SendIcon className="w-5 h-5" />
                        </button>
                      ) : (
                        <button onClick={startListening} disabled={loading} aria-label="Speak" className={`${iconBtn} bg-zinc-800 text-zinc-100 hover:bg-zinc-700`}>
                          <MicIcon className="w-5 h-5" />
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* ── NOTES ── */}
          {tab === 'notes' && (
            <div className="h-full overflow-y-auto">
              <div className="mx-auto w-full max-w-3xl px-4 py-6">
                <PageHeader title="Notes" count={notes.length} onRefresh={loadDashboard} />
                <RulesPanel />
                {dashLoading ? (
                  <p className="text-sm text-zinc-400 text-center mt-20" role="status">Loading…</p>
                ) : notes.length === 0 ? (
                  <Empty Icon={NoteIcon} title="No notes yet" hint="Ask Maya to save one." />
                ) : (
                  <div className="space-y-2.5">
                    {notes.map(n => (
                      <div key={n.id} className={`${card} pl-4 pr-1 py-3 flex items-start gap-2`}>
                        <div className="flex-1 min-w-0 py-1">
                          <p className="text-[0.9375rem] text-zinc-100 leading-relaxed whitespace-pre-wrap break-words">{n.content}</p>
                          <p className="text-xs text-zinc-400 mt-1.5">{formatIST(n.created_at)}</p>
                          {n.tags?.length > 0 && (
                            <div className="flex gap-1.5 mt-2 flex-wrap">
                              {n.tags.map(t => <span key={t} className="text-xs bg-zinc-800 text-zinc-300 px-2.5 py-0.5 rounded-full">{t}</span>)}
                            </div>
                          )}
                        </div>
                        <button onClick={() => handleDeleteNote(n.id)} aria-label="Delete note" className={`${iconBtn} text-zinc-400 hover:text-red-300 hover:bg-white/5`}>
                          <TrashIcon className="w-[18px] h-[18px]" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── REMINDERS ── */}
          {tab === 'reminders' && (
            <div className="h-full overflow-y-auto">
              <div className="mx-auto w-full max-w-3xl px-4 py-6">
                <PageHeader title="Reminders" count={reminders.length} onRefresh={loadDashboard} />
                {dashLoading ? (
                  <p className="text-sm text-zinc-400 text-center mt-20" role="status">Loading…</p>
                ) : reminders.length === 0 ? (
                  <Empty Icon={BellIcon} title="No upcoming reminders" hint="Say “remind me to call the bank in 2 hours”." />
                ) : (
                  <div className="space-y-2.5">
                    {reminders.map(r => {
                      const overdue = new Date(r.remind_at) < now;
                      return (
                        <div key={r.id} className={`rounded-2xl border pl-4 pr-1 py-2 flex items-center gap-1 ${overdue ? 'border-red-400/30 bg-red-500/10' : 'border-white/10 bg-zinc-900/60'}`}>
                          <div className="flex-1 min-w-0 py-1.5">
                            <p className={`text-[0.9375rem] font-medium break-words ${overdue ? 'text-red-200' : 'text-zinc-100'}`}>{r.text}</p>
                            <p className={`text-xs mt-0.5 ${overdue ? 'text-red-300' : 'text-zinc-400'}`}>{overdue ? 'Overdue · ' : ''}{formatIST(r.remind_at)}</p>
                          </div>
                          <button onClick={() => handleReminderDone(r.id)} aria-label="Mark reminder done" className={`${iconBtn} text-zinc-300 hover:text-emerald-300 hover:bg-white/5`}>
                            <CheckIcon className="w-5 h-5" />
                          </button>
                          <button onClick={() => handleDeleteReminder(r.id)} aria-label="Delete reminder" className={`${iconBtn} text-zinc-400 hover:text-red-300 hover:bg-white/5`}>
                            <TrashIcon className="w-[18px] h-[18px]" />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── FITNESS ── */}
          {tab === 'fitness' && (
            <div className="h-full overflow-y-auto">
              <div className="mx-auto w-full max-w-3xl px-4 py-6">
                <PageHeader title="Fitness" sub="Last 14 days" onRefresh={loadDashboard} />
                {dashLoading ? (
                  <p className="text-sm text-zinc-400 text-center mt-20" role="status">Loading…</p>
                ) : (
                  <>
                    <div className="grid grid-cols-3 gap-2.5 mb-5">
                      {[
                        { label: 'Sessions', value: workouts.length },
                        { label: 'Total minutes', value: workouts.reduce((s, w) => s + (w.duration_min ?? 0), 0) },
                        { label: 'This week', value: workouts.filter(w => new Date(w.logged_at) > new Date(Date.now() - 7 * 86400000)).length },
                      ].map(s => (
                        <div key={s.label} className={`${card} px-3 py-4 text-center`}>
                          <p className="text-2xl font-semibold text-zinc-50">{s.value}</p>
                          <p className="text-xs text-zinc-400 mt-1">{s.label}</p>
                        </div>
                      ))}
                    </div>
                    {workouts.length === 0 ? (
                      <Empty Icon={ActivityIcon} title="No workouts logged yet" hint="Tell Maya what you did today." />
                    ) : (
                      <div className="space-y-2.5">
                        {workouts.map(w => (
                          <div key={w.id} className={`${card} px-4 py-3`}>
                            <div className="flex items-center justify-between gap-2">
                              <p className="text-[0.9375rem] font-medium text-zinc-100">{w.type}</p>
                              {w.duration_min && <span className="text-xs text-zinc-300 bg-zinc-800 px-2.5 py-0.5 rounded-full">{w.duration_min} min</span>}
                            </div>
                            {w.notes && <p className="text-sm text-zinc-400 mt-1">{w.notes}</p>}
                            <p className="text-xs text-zinc-400 mt-1.5">{formatIST(w.logged_at)}</p>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          )}
        </main>

        {/* Mobile bottom nav */}
        <nav aria-label="Main" className="md:hidden border-t border-white/10 bg-zinc-950 flex shrink-0 pb-[env(safe-area-inset-bottom)]">
          {NAV.map(({ id, label, Icon }) => (
            <button key={id} onClick={() => setTab(id)} aria-current={tab === id ? 'page' : undefined}
              className={`flex-1 min-h-[56px] flex flex-col items-center justify-center gap-1 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-400 ${tab === id ? 'text-indigo-300' : 'text-zinc-400 active:text-zinc-200'}`}>
              <Icon className="w-6 h-6" />
              <span className="text-[11px] font-medium">{label}</span>
            </button>
          ))}
        </nav>
      </div>
    </div>
  );
}
