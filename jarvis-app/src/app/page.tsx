'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { marked } from 'marked';

marked.setOptions({ breaks: true });

type Tab = 'chat' | 'notes' | 'reminders' | 'fitness';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  ts: Date;
}

interface Note { id: string; content: string; tags: string[]; created_at: string; }
interface Reminder { id: string; text: string; remind_at: string; fired: boolean; }
interface Workout { id: string; type: string; duration_min?: number; notes?: string; logged_at: string; }

function renderMd(text: string): string {
  return marked.parse(text) as string;
}

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

  const [notes, setNotes] = useState<Note[]>([]);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [workouts, setWorkouts] = useState<Workout[]>([]);
  const [dashLoading, setDashLoading] = useState(false);

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
        const reg = await navigator.serviceWorker.ready;
        const existing = await reg.pushManager.getSubscription();
        if (existing) return; // already subscribed
        const perm = await Notification.requestPermission();
        if (perm !== 'granted') return;
        const sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(vapidKey),
        });
        await fetch('/api/push/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ subscription: sub }),
        });
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

  const send = useCallback(async (text: string) => {
    if (!text.trim() || loading) return;
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

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';

        for (const part of parts) {
          if (!part.startsWith('data: ')) continue;
          const data = part.slice(6).trim();
          if (data === '[DONE]') break;
          try {
            const { chunk } = JSON.parse(data) as { chunk: string };
            if (chunk) {
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
      }
    } catch (e) {
      setMessages(prev => prev.map(m =>
        m.id === assistantId ? { ...m, content: `Error: ${(e as Error).message}` } : m
      ));
    } finally {
      setLoading(false);
    }
  }, [loading]);

  const stopListening = useCallback((action: 'cancel' | 'pause' | 'send' = 'pause') => {
    shouldListenRef.current = false;
    recognitionRef.current?.stop();
    setListening(false);
    const final = transcriptRef.current;
    setTranscript('');
    transcriptRef.current = '';
    if (action === 'send' && final.trim()) {
      send(final);
    } else if (action === 'pause' && final.trim()) {
      setInput(final);
    }
  }, [send]);

  const startListening = useCallback(() => {
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
      };
      recognitionRef.current = { stop: () => recognition.abort() };
      recognition.start();
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    launch(SpeechRecognition as unknown as new () => any);
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

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-dvh bg-zinc-950">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800 bg-zinc-900 shrink-0">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-blue-400" />
          <span className="text-sm font-medium text-zinc-200 tracking-widest uppercase">MAYA</span>
        </div>
        <button onClick={logout} className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors px-2 py-1">
          Sign out
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden">

        {/* ── CHAT TAB ── */}
        {tab === 'chat' && (
          <div className="flex flex-col h-full">
            <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
              {messages.length === 0 && (
                <div className="text-center text-zinc-600 text-sm mt-16">
                  <div className="text-2xl mb-2">◈</div>
                  <p>Tap mic to speak, or type below.</p>
                  <p className="mt-2 text-xs text-zinc-700 space-y-1">
                    "Remind me to call the bank in 2 hours"<br />
                    "Log expense: ₹500 food"<br />
                    "Morning briefing"
                  </p>
                </div>
              )}
              {messages.map(m => (
                <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                    m.role === 'user'
                      ? 'bg-blue-600 text-white rounded-br-sm'
                      : 'bg-zinc-800 text-zinc-100 rounded-bl-sm'
                  }`}>
                    {m.role === 'assistant'
                      ? m.content
                        ? <div className="prose prose-invert prose-sm max-w-none"
                            dangerouslySetInnerHTML={{ __html: renderMd(m.content) }} />
                        : <div className="flex gap-1 items-center py-0.5">
                            <span className="w-1.5 h-1.5 bg-zinc-400 rounded-full dot-1" />
                            <span className="w-1.5 h-1.5 bg-zinc-400 rounded-full dot-2" />
                            <span className="w-1.5 h-1.5 bg-zinc-400 rounded-full dot-3" />
                          </div>
                      : <p className="whitespace-pre-wrap">{m.content}</p>
                    }
                    <p className={`text-[10px] mt-1 ${m.role === 'user' ? 'text-blue-300' : 'text-zinc-500'}`}>
                      {formatTime(m.ts)}
                    </p>
                  </div>
                </div>
              ))}
              <div ref={bottomRef} />
            </div>

            {listening ? (
              /* ── Recording bar ── */
              <div className="px-3 py-3 border-t border-zinc-800 bg-zinc-900 flex items-center gap-2">
                {/* Cancel */}
                <button onClick={() => stopListening('cancel')}
                  className="w-9 h-9 rounded-full bg-zinc-700 flex items-center justify-center shrink-0 active:scale-95 transition-transform">
                  <svg className="w-4 h-4 text-zinc-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
                {/* Live transcript */}
                <div className="flex-1 text-sm text-zinc-300 italic truncate px-1 min-w-0">
                  {transcript || <span className="text-zinc-500">Listening…</span>}
                </div>
                {/* Mic (tap = pause → puts transcript in input) */}
                <button onClick={() => stopListening('pause')}
                  className="w-11 h-11 rounded-full bg-red-600 flex items-center justify-center shrink-0 relative active:scale-95 transition-all">
                  <span className="absolute inset-0 rounded-full bg-red-600 pulse-ring" />
                  <svg className="w-5 h-5 text-white" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3zm-1 19.93A8.001 8.001 0 0 1 4 13H2a10.001 10.001 0 0 0 9 9.93V23h2v-.07A10.001 10.001 0 0 0 22 13h-2a8.001 8.001 0 0 1-7 7.93z"/>
                  </svg>
                </button>
                {/* Send immediately */}
                <button onClick={() => stopListening('send')} disabled={!transcript.trim()}
                  className="w-9 h-9 rounded-full bg-blue-600 flex items-center justify-center shrink-0 active:scale-95 transition-transform disabled:opacity-30">
                  <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 19V5m0 0l-7 7m7-7l7 7" />
                  </svg>
                </button>
              </div>
            ) : (
              /* ── Default input bar ── */
              <div className="px-3 py-3 border-t border-zinc-800 bg-zinc-900 flex items-center gap-2">
                <input
                  className="flex-1 bg-zinc-800 text-zinc-100 text-sm rounded-full px-4 py-2.5 outline-none placeholder:text-zinc-500"
                  placeholder="Type a message..."
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && send(input)}
                  disabled={loading}
                />
                {input.trim() ? (
                  <button onClick={() => send(input)} disabled={loading}
                    className="w-10 h-10 rounded-full bg-blue-600 flex items-center justify-center shrink-0 active:scale-95 transition-transform">
                    <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 19V5m0 0l-7 7m7-7l7 7" />
                    </svg>
                  </button>
                ) : (
                  <button onClick={startListening} disabled={loading}
                    className="w-12 h-12 rounded-full bg-zinc-700 flex items-center justify-center shrink-0 active:scale-95 transition-all">
                    <svg className="w-5 h-5 text-white" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3zm-1 19.93A8.001 8.001 0 0 1 4 13H2a10.001 10.001 0 0 0 9 9.93V23h2v-.07A10.001 10.001 0 0 0 22 13h-2a8.001 8.001 0 0 1-7 7.93z"/>
                    </svg>
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── NOTES TAB ── */}
        {tab === 'notes' && (
          <div className="h-full overflow-y-auto px-4 py-4">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-medium text-zinc-300">Notes <span className="text-zinc-600">({notes.length})</span></h2>
              <button onClick={loadDashboard} className="text-xs text-zinc-500">↻ Refresh</button>
            </div>
            {dashLoading ? (
              <p className="text-zinc-600 text-sm text-center mt-16">Loading…</p>
            ) : notes.length === 0 ? (
              <p className="text-zinc-600 text-sm text-center mt-16">No notes yet. Ask Maya to save one.</p>
            ) : (
              <div className="space-y-2">
                {notes.map(n => (
                  <div key={n.id} className="bg-zinc-800/60 rounded-xl px-4 py-3 flex items-start gap-3">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-zinc-100 leading-relaxed">{n.content}</p>
                      <p className="text-[10px] text-zinc-600 mt-1">{formatIST(n.created_at)}</p>
                      {n.tags?.length > 0 && (
                        <div className="flex gap-1 mt-1 flex-wrap">
                          {n.tags.map(t => (
                            <span key={t} className="text-[10px] bg-zinc-700 text-zinc-400 px-2 py-0.5 rounded-full">{t}</span>
                          ))}
                        </div>
                      )}
                    </div>
                    <button onClick={() => handleDeleteNote(n.id)}
                      className="text-zinc-600 hover:text-red-400 transition-colors shrink-0 mt-0.5">
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── REMINDERS TAB ── */}
        {tab === 'reminders' && (
          <div className="h-full overflow-y-auto px-4 py-4">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-medium text-zinc-300">Reminders <span className="text-zinc-600">({reminders.length})</span></h2>
              <button onClick={loadDashboard} className="text-xs text-zinc-500">↻ Refresh</button>
            </div>
            {dashLoading ? (
              <p className="text-zinc-600 text-sm text-center mt-16">Loading…</p>
            ) : reminders.length === 0 ? (
              <p className="text-zinc-600 text-sm text-center mt-16">No upcoming reminders.</p>
            ) : (
              <div className="space-y-2">
                {reminders.map(r => {
                  const overdue = new Date(r.remind_at) < now;
                  return (
                    <div key={r.id} className={`rounded-xl px-4 py-3 flex items-center gap-3 ${overdue ? 'bg-red-950/40 border border-red-900/40' : 'bg-zinc-800/60'}`}>
                      <div className="flex-1 min-w-0">
                        <p className={`text-sm font-medium ${overdue ? 'text-red-300' : 'text-zinc-100'}`}>{r.text}</p>
                        <p className={`text-[10px] mt-0.5 ${overdue ? 'text-red-500' : 'text-zinc-500'}`}>
                          {overdue ? '⚠ Overdue · ' : ''}{formatIST(r.remind_at)}
                        </p>
                      </div>
                      <button onClick={() => handleReminderDone(r.id)}
                        className="w-7 h-7 rounded-full border border-zinc-600 flex items-center justify-center text-zinc-500 hover:border-green-500 hover:text-green-400 transition-colors shrink-0">
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                      </button>
                      <button onClick={() => handleDeleteReminder(r.id)}
                        className="text-zinc-600 hover:text-red-400 transition-colors shrink-0">
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* ── FITNESS TAB ── */}
        {tab === 'fitness' && (
          <div className="h-full overflow-y-auto px-4 py-4">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-medium text-zinc-300">Fitness <span className="text-zinc-600">(last 14 days)</span></h2>
              <button onClick={loadDashboard} className="text-xs text-zinc-500">↻ Refresh</button>
            </div>
            {dashLoading ? (
              <p className="text-zinc-600 text-sm text-center mt-16">Loading…</p>
            ) : (
              <>
                {/* Stats bar */}
                <div className="grid grid-cols-3 gap-2 mb-4">
                  {[
                    { label: 'Sessions', value: workouts.length },
                    { label: 'Total min', value: workouts.reduce((s, w) => s + (w.duration_min ?? 0), 0) },
                    { label: 'This week', value: workouts.filter(w => new Date(w.logged_at) > new Date(Date.now() - 7 * 86400000)).length },
                  ].map(s => (
                    <div key={s.label} className="bg-zinc-800/60 rounded-xl px-3 py-3 text-center">
                      <p className="text-xl font-semibold text-zinc-100">{s.value}</p>
                      <p className="text-[10px] text-zinc-500 mt-0.5">{s.label}</p>
                    </div>
                  ))}
                </div>
                {workouts.length === 0 ? (
                  <p className="text-zinc-600 text-sm text-center mt-8">No workouts logged yet.</p>
                ) : (
                  <div className="space-y-2">
                    {workouts.map(w => (
                      <div key={w.id} className="bg-zinc-800/60 rounded-xl px-4 py-3">
                        <div className="flex items-center justify-between">
                          <p className="text-sm font-medium text-zinc-100">{w.type}</p>
                          {w.duration_min && (
                            <span className="text-xs text-zinc-400 bg-zinc-700 px-2 py-0.5 rounded-full">{w.duration_min} min</span>
                          )}
                        </div>
                        {w.notes && <p className="text-xs text-zinc-500 mt-1">{w.notes}</p>}
                        <p className="text-[10px] text-zinc-600 mt-1">{formatIST(w.logged_at)}</p>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* Bottom nav */}
      <div className="border-t border-zinc-800 bg-zinc-900 flex shrink-0">
        {([
          { id: 'chat', icon: '💬', label: 'Chat' },
          { id: 'notes', icon: '📝', label: 'Notes' },
          { id: 'reminders', icon: '⏰', label: 'Reminders' },
          { id: 'fitness', icon: '🏃', label: 'Fitness' },
        ] as { id: Tab; icon: string; label: string }[]).map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`flex-1 flex flex-col items-center py-2.5 gap-0.5 transition-colors ${tab === t.id ? 'text-blue-400' : 'text-zinc-600 active:text-zinc-400'}`}>
            <span className="text-lg leading-none">{t.icon}</span>
            <span className="text-[9px] font-medium uppercase tracking-wider">{t.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
