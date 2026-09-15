'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function LoginPage() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        router.replace('/');
      } else {
        setError('Wrong password.');
      }
    } catch {
      setError('Connection error. Try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col items-center justify-center h-dvh bg-zinc-950 px-6">
      <div className="w-2 h-2 rounded-full bg-blue-400 mb-4" />
      <h1 className="text-2xl font-semibold text-zinc-100 tracking-widest uppercase mb-8">Maya</h1>
      <form onSubmit={handleLogin} className="w-full max-w-xs flex flex-col gap-3">
        <input
          type="password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          placeholder="Password"
          autoFocus
          autoComplete="current-password"
          className="w-full bg-zinc-800 text-zinc-100 text-sm rounded-xl px-4 py-3 outline-none placeholder:text-zinc-500 focus:ring-1 focus:ring-blue-500"
        />
        {error && <p className="text-red-400 text-xs text-center">{error}</p>}
        <button
          type="submit"
          disabled={loading || !password}
          className="w-full bg-blue-600 text-white text-sm font-medium rounded-xl py-3 active:scale-95 transition-transform disabled:opacity-50"
        >
          {loading ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
