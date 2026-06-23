import { useEffect, useMemo, useRef, useState } from 'react';
import { useFindProject, useProjects } from '../use-projects.js';
import { useLocalGroups } from '../local-groups.js';
import { config } from '../../shared/config.js';
import { PILL } from '../ui-tokens.js';

interface Props {
  active: string;
  onChange: (id: string) => void;
}

/**
 * AWS-console-style project picker. Renders as a compact button showing the
 * active project; click to open a dropdown with all projects, click outside
 * or pick one to close. Keeps the top header concise regardless of how many
 * projects we add down the road.
 *
 * In agnostic mode (`?agnostic=1`) all config-flavoured details are hidden:
 * no friendly label, no emoji, no listed environments — just the raw GCP
 * projectId and region. The agnostic view is meant to be free of any
 * consumer-specific naming, so the project picker has to follow suit.
 */
const isAgnostic = typeof window !== 'undefined'
  && new URLSearchParams(window.location.search).get('agnostic') === '1';

export function ProjectSelector({ active, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const allProjects = useProjects();
  const localGroups = useLocalGroups();
  // Local groups appear as chips next to "+" in the header — listing them
  // again in the selector creates duplicates that look identical to their
  // base GCP project (same projectId / region) and confuse the user.
  const projects = useMemo(() => {
    const localIds = new Set(localGroups.map((g) => g.id));
    return allProjects.filter((p) => !localIds.has(p.id));
  }, [allProjects, localGroups]);
  const project = useFindProject(active) ?? projects[0] ?? config.projects[0]!;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className={`${PILL} gap-1 bg-emerald-100 hover:bg-emerald-200 text-emerald-900 dark:bg-emerald-900 dark:hover:bg-emerald-800 dark:text-emerald-100 font-medium`}
        title={`Project: ${project.projectId} · ${project.region}`}
      >
        {!isAgnostic && project.emoji && (
          <span className="leading-none">{project.emoji}</span>
        )}
        <span className="font-mono">{project.projectId}</span>
        {/* Show region too — in agnostic mode the same GCP projectId can
            appear once per region (synth splits by location), so without
            the suffix the trigger is ambiguous. */}
        {isAgnostic && (
          <span className="font-mono text-[10px] opacity-70 leading-none">{project.region}</span>
        )}
        <svg
          aria-hidden
          className={`w-3 h-3 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
          viewBox="0 0 20 20"
          fill="currentColor"
        >
          <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.06l3.71-3.83a.75.75 0 111.08 1.04l-4.25 4.39a.75.75 0 01-1.08 0L5.21 8.27a.75.75 0 01.02-1.06z" clipRule="evenodd" />
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 mt-1 w-64 rounded-md shadow-lg bg-white dark:bg-slate-800 ring-1 ring-black/10 dark:ring-slate-700 z-50 overflow-hidden">
          <div className="py-1">
            {projects.map((p) => {
              const isActive = p.id === active;
              return (
                <button
                  key={p.id}
                  onClick={() => { onChange(p.id); setOpen(false); }}
                  className={`w-full text-left px-3 py-2 flex items-start gap-2 text-sm ${
                    isActive
                      ? 'bg-blue-50 dark:bg-blue-950 text-blue-900 dark:text-blue-100'
                      : 'hover:bg-slate-50 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200'
                  }`}
                >
                  {!isAgnostic && p.emoji && (
                    <span className="text-base leading-tight mt-0.5">{p.emoji}</span>
                  )}
                  <span className="flex-1 min-w-0">
                    {/* Friendly label and the env list both come straight from
                        config — both hidden in agnostic mode where we want
                        zero consumer-specific naming, just GCP coordinates. */}
                    {!isAgnostic && (
                      <span className="font-medium block">{p.label}</span>
                    )}
                    <span className={`font-mono ${isAgnostic ? 'text-sm font-medium' : 'text-[11px] text-slate-500 dark:text-slate-400'} block truncate`}>
                      {p.projectId}
                    </span>
                    <span className="font-mono text-[11px] text-slate-500 dark:text-slate-400 block truncate">
                      {p.region}
                    </span>
                    {!isAgnostic && (
                      <span className="text-[11px] text-slate-500 dark:text-slate-400 block truncate">
                        {p.environments.map((e) => e.name).join(', ')}
                      </span>
                    )}
                  </span>
                  {isActive && (
                    <span aria-label="active" className="text-blue-600 dark:text-blue-400">✓</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
