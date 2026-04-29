import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { type ServiceId } from '../../shared/config.js';
import { patchEnvs, type EnvsResponse } from '../api.js';
import { useFindProject } from '../use-projects.js';

interface Props {
  projectId: string;
  service: ServiceId;
  envKey: string;
  valuesByEnv: Record<string, string | undefined>;
  visibleEnvs: Record<string, boolean>;
  onClose: () => void;
}

export function DeleteConfirmModal({ projectId, service, envKey, valuesByEnv, visibleEnvs, onClose }: Props) {
  const qc = useQueryClient();
  const project = useFindProject(projectId);
  const environments = project?.environments ?? [];
  const [selected, setSelected] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(
      environments.map((e) => [
        e.name,
        !!visibleEnvs[e.name] && valuesByEnv[e.name] !== undefined,
      ]),
    ),
  );
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: async (envs: string[]) => {
      const res = await patchEnvs(projectId, service, { environments: envs, deletes: [envKey] });
      const cached = qc.getQueryData<EnvsResponse>(['envs', projectId, service]);
      if (cached) {
        const nextEnvs = { ...cached.envs };
        for (const name of envs) {
          if (res.status[name]?.ok && nextEnvs[name]) {
            const { [envKey]: _removed, ...rest } = nextEnvs[name];
            nextEnvs[name] = rest;
          }
        }
        qc.setQueryData<EnvsResponse>(['envs', projectId, service], { ...cached, envs: nextEnvs });
      }
      return res;
    },
    onSuccess: (res) => {
      const failures = Object.entries(res.status).filter(([, s]) => !s.ok);
      const total = Object.keys(res.status).length;
      if (failures.length === 0) {
        toast.success(`Deleted ${envKey} (${total} env${total === 1 ? '' : 's'})`);
        onClose();
      } else {
        const msg = failures.length === total
          ? `Failed to delete ${envKey} — all ${total} envs failed`
          : `Deleted ${envKey}: ${total - failures.length}/${total} succeeded — ${failures.length} failed`;
        toast.error(msg, { duration: Infinity, closeButton: true });
        setErrorMsg(msg);
        console.error('Delete failures:', failures);
      }
    },
    onError: (err) => {
      const msg = String(err);
      toast.error(msg, { duration: Infinity, closeButton: true });
      setErrorMsg(msg);
    },
  });

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !mutation.isPending) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [mutation.isPending, onClose]);

  const chosen = environments.filter((e) => selected[e.name]).map((e) => e.name);
  const canConfirm = chosen.length > 0 && !mutation.isPending;
  const pending = mutation.isPending;

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      onClick={() => { if (!pending) onClose(); }}
    >
      <div className="bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 rounded-lg p-6 w-[500px] max-w-[95vw]" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-bold mb-2">Delete environment variable</h2>
        <p className="text-sm text-slate-600 dark:text-slate-300 mb-4">
          Remove <span className="font-mono font-semibold">{envKey}</span> from the selected environments.
        </p>

        <div className="space-y-2 mb-4">
          {environments.map((e) => {
            const existing = valuesByEnv[e.name];
            const present = existing !== undefined;
            return (
              <label
                key={e.name}
                className={`flex items-center gap-2 text-sm select-none ${present && !pending ? 'cursor-pointer' : ''}`}
              >
                <input
                  type="checkbox"
                  checked={!!selected[e.name]}
                  disabled={!present || pending}
                  onChange={(ev) => setSelected({ ...selected, [e.name]: ev.target.checked })}
                />
                <span className="w-32">{e.emoji} {e.name}</span>
                <span className={`flex-1 font-mono text-xs truncate ${present ? 'text-slate-700 dark:text-slate-200' : 'text-slate-400 dark:text-slate-500'}`}
                      title={present ? existing : 'not set'}>
                  {present ? existing : '— not set —'}
                </span>
              </label>
            );
          })}
        </div>

        {errorMsg && (
          <div className="mb-3 p-2 rounded bg-red-50 dark:bg-red-950 border border-red-300 dark:border-red-900 text-red-800 dark:text-red-200 text-xs font-mono whitespace-pre-wrap">
            {errorMsg}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={pending}
            className="px-3 py-1 rounded bg-slate-200 dark:bg-slate-700 dark:text-slate-100 disabled:opacity-50"
          >
            {errorMsg ? 'Close' : 'Cancel'}
          </button>
          <button
            onClick={() => { setErrorMsg(null); mutation.mutate(chosen); }}
            disabled={!canConfirm}
            className="px-3 py-1 rounded bg-red-100 text-red-700 ring-1 ring-red-300 font-semibold disabled:opacity-50 hover:bg-red-200 dark:bg-red-800 dark:text-red-100 dark:ring-0 dark:hover:bg-red-700"
          >
            {pending
              ? 'Deleting… (cannot close)'
              : errorMsg
                ? 'Retry'
                : `Delete from ${chosen.length} env${chosen.length === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </div>
  );
}
