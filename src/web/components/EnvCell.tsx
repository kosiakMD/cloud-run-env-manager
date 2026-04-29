import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { patchEnvs } from '../api.js';
import type { EnvsResponse } from '../api.js';
import type { ServiceId } from '../../shared/config.js';

interface Props {
  projectId: string;
  service: ServiceId;
  envName: string;
  envKey: string;
  value: string | undefined;
  /** When true, edit opens in a full-screen modal. Desktop keeps inline edit. */
  isMobile?: boolean;
  /**
   * Client-side IAM probe result from `/api/health`. When false the cell
   * doesn't enter edit mode on click and drops its pointer affordances —
   * read-only users shouldn't see a "—" placeholder that looks editable.
   */
  canWrite?: boolean;
}

export function EnvCell({ projectId, service, envName, envKey, value, isMobile, canWrite = true }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? '');
  const qc = useQueryClient();

  useEffect(() => {
    if (!editing) setDraft(value ?? '');
  }, [value, editing]);

  const mutation = useMutation({
    mutationFn: (newValue: string) =>
      patchEnvs(projectId, service, { environments: [envName], updates: { [envKey]: newValue } }),
    onMutate: async (newValue) => {
      await qc.cancelQueries({ queryKey: ['envs', projectId, service] });
      const prev = qc.getQueryData<EnvsResponse>(['envs', projectId, service]);
      if (prev) {
        qc.setQueryData<EnvsResponse>(['envs', projectId, service], {
          ...prev,
          envs: {
            ...prev.envs,
            [envName]: { ...(prev.envs[envName] ?? {}), [envKey]: newValue },
          },
        });
      }
      return { prev };
    },
    onSuccess: (res) => {
      const status = res.status[envName];
      if (!status?.ok) {
        toast.error(`${envName}: ${status?.error ?? 'failed'}`);
        return;
      }
      toast.success(`Updated ${envKey} on ${envName}`);
    },
    onError: (err, _newValue, ctx) => {
      if (ctx?.prev) qc.setQueryData(['envs', projectId, service], ctx.prev);
      toast.error(String(err));
    },
    onSettled: () => setEditing(false),
  });

  function commit() {
    const next = draft;
    const original = value ?? '';
    if (next === original) {
      setEditing(false);
      return;
    }
    mutation.mutate(next);
  }

  function cancel() {
    setDraft(value ?? '');
    setEditing(false);
  }

  if (editing) {
    const pending = mutation.isPending;

    // Mobile: modal overlay. The inline cell is only ~100px wide on phones,
    // which makes the input unusable for anything longer than a few chars.
    if (isMobile) {
      return (
        <>
          <div
            onClick={() => { if (!editing) return; setDraft(value ?? ''); setEditing(true); }}
            className="px-3 py-2 font-mono text-sm truncate flex items-center bg-blue-100 dark:bg-blue-950"
            title={value ?? 'editing…'}
          >
            {value ?? <span className="text-slate-400 dark:text-slate-500">—</span>}
          </div>
          <div
            className="fixed inset-0 bg-black/50 flex items-start justify-center z-50 p-4 pt-20"
            onClick={() => { if (!pending) cancel(); }}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-md bg-white dark:bg-slate-900 rounded-lg p-4 space-y-3"
            >
              <div className="text-xs text-slate-500 dark:text-slate-400 font-mono">
                {envName} · {envKey}
              </div>
              <textarea
                autoFocus
                disabled={pending}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={4}
                className="w-full px-3 py-2 border-2 border-blue-400 font-mono text-sm rounded focus:outline-none bg-white disabled:bg-slate-100 dark:bg-slate-800 dark:text-slate-100 resize-y"
              />
              <div className="flex justify-end gap-2">
                <button
                  onClick={cancel}
                  disabled={pending}
                  className="px-3 py-1.5 rounded bg-slate-200 text-slate-700 text-sm disabled:opacity-50 dark:bg-slate-700 dark:text-slate-200"
                >
                  Cancel
                </button>
                <button
                  onClick={commit}
                  disabled={pending}
                  className="px-3 py-1.5 rounded bg-emerald-100 text-emerald-700 ring-1 ring-emerald-300 text-sm font-semibold disabled:opacity-50 hover:bg-emerald-200 dark:bg-emerald-700 dark:text-white dark:ring-0 dark:hover:bg-emerald-600"
                >
                  {pending ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>
          </div>
        </>
      );
    }

    // Desktop: inline edit stays — the cell is wide enough.
    return (
      <div className="p-1 flex items-center gap-1">
        <input
          autoFocus
          disabled={pending}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit(); }
            if (e.key === 'Escape') { e.preventDefault(); cancel(); }
          }}
          className="flex-1 min-w-0 px-2 py-1.5 border-2 border-blue-400 font-mono text-sm rounded focus:outline-none bg-white disabled:bg-slate-100 disabled:text-slate-500 disabled:cursor-wait dark:bg-slate-800 dark:text-slate-100 dark:disabled:bg-slate-700"
        />
        <button
          onMouseDown={(e) => { e.preventDefault(); commit(); }}
          disabled={pending}
          className="shrink-0 w-7 h-7 flex items-center justify-center rounded bg-emerald-100 text-emerald-700 text-xs disabled:opacity-50 hover:bg-emerald-200 dark:bg-emerald-700 dark:text-white dark:hover:bg-emerald-600"
          title={pending ? 'Saving…' : 'Save (Enter)'}
        >
          {pending ? '…' : '✓'}
        </button>
        <button
          onMouseDown={(e) => { e.preventDefault(); cancel(); }}
          disabled={pending}
          className="shrink-0 w-7 h-7 flex items-center justify-center rounded bg-slate-200 text-slate-700 text-xs disabled:opacity-50 hover:bg-slate-300 dark:bg-slate-700 dark:text-slate-200 dark:hover:bg-slate-600"
          title="Cancel (Esc)"
        >
          ✕
        </button>
      </div>
    );
  }

  return (
    <div
      onClick={canWrite ? () => { setDraft(value ?? ''); setEditing(true); } : undefined}
      className={`px-3 py-2 font-mono text-sm truncate flex items-center ${
        canWrite ? 'cursor-pointer hover:bg-blue-50 dark:hover:bg-blue-950' : ''
      }`}
      title={canWrite ? (value ?? 'missing — click to add') : (value ?? 'not set')}
    >
      {value ?? <span className="text-slate-400 dark:text-slate-500">—</span>}
    </div>
  );
}
