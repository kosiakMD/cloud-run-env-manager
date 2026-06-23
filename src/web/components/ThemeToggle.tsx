import { useEffect, useState } from 'react';

type Mode = 'light' | 'dark';

function currentMode(): Mode {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

export function ThemeToggle() {
  const [mode, setMode] = useState<Mode>(() => (typeof document !== 'undefined' ? currentMode() : 'light'));

  useEffect(() => {
    document.documentElement.classList.toggle('dark', mode === 'dark');
    try { localStorage.setItem('theme', mode); } catch {}
  }, [mode]);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent) => {
      try {
        if (!localStorage.getItem('theme')) setMode(e.matches ? 'dark' : 'light');
      } catch {
        setMode(e.matches ? 'dark' : 'light');
      }
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  return (
    <button
      onClick={() => setMode((m) => (m === 'dark' ? 'light' : 'dark'))}
      // Reference height for the rest of the header — chips and + button
      // match it so the strip lines up at the same baseline.
      className="h-7 inline-flex items-center px-2 rounded text-xs font-semibold bg-slate-200 hover:bg-slate-300 text-slate-800 dark:bg-slate-700 dark:hover:bg-slate-600 dark:text-slate-200"
      title={mode === 'dark' ? 'Switch to light' : 'Switch to dark'}
    >
      {mode === 'dark' ? '☀ Light' : '🌙 Dark'}
    </button>
  );
}
