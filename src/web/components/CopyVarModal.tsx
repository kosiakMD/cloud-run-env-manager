import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { ServiceId } from '../../shared/config.js';
import type { ProjectInfo } from '../api.js';
import { patchEnvs, type EnvsResponse } from '../api.js';
import { useProjects } from '../use-projects.js';

interface Props {
  sourceProject: ProjectInfo;
  sourceService: ServiceId;
  envKey: string;
  /**
   * Source values keyed by env name. Multiple values are common (one per
   * source env); the modal seeds target envs with values matched by env
   * name, falling back to the most-common source value otherwise.
   */
  sourceValuesByEnv: Record<string, string | undefined>;
  onClose: () => void;
}

/**
 * Copy an env var (key + values) from one project/service to another.
 *
 * The flow:
 *   1. Pick a target project (the source is excluded — copy-to-self is
 *      what the regular Edit modal already covers).
 *   2. Pick a target service from that project's services.
 *   3. Pick which target envs to write to. Each env gets a value seeded
 *      from a source env with the same name when one exists; otherwise
 *      it falls back to the most-common source value so the user has a
 *      sensible starting point. Values are editable per-env.
 *   4. Apply → PATCH against the target project/service.
 *
 * Cross-project copies always need value mapping because env names rarely
 * line up exactly. Trying to be too clever (auto-mapping by index, by
 * region, etc.) hides what's about to be written; explicit per-env
 * inputs keep it predictable.
 */
export function CopyVarModal({
  sourceProject,
  sourceService,
  envKey,
  sourceValuesByEnv,
  onClose,
}: Props) {
  const projects = useProjects();
  const qc = useQueryClient();

  // Targets: any project except the source (same-project copy is the
  // existing Mass-edit flow's job).
  const targetCandidates = useMemo(
    () => projects.filter((p) => p.id !== sourceProject.id),
    [projects, sourceProject.id],
  );

  const [targetProjectId, setTargetProjectId] = useState<string>(
    () => targetCandidates[0]?.id ?? '',
  );
  const targetProject = useMemo(
    () => targetCandidates.find((p) => p.id === targetProjectId),
    [targetCandidates, targetProjectId],
  );

  const [targetServiceId, setTargetServiceId] = useState<ServiceId>('');
  useEffect(() => {
    if (!targetProject) return;
    // Prefer matching the source service id so copying API↔API stays in
    // place; if absent, take whatever the target project lists first.
    const match = targetProject.services.find((s) => s.id === sourceService);
    setTargetServiceId(match?.id ?? targetProject.services[0]?.id ?? '');
  }, [targetProject, sourceService]);

  // Seed value for envs that don't share a name with any source env.
  const seedValue = useMemo(() => {
    const counts = new Map<string, number>();
    for (const v of Object.values(sourceValuesByEnv)) {
      if (v === undefined) continue;
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    let best = '';
    let bestCount = 0;
    for (const [v, c] of counts) {
      if (c > bestCount) { best = v; bestCount = c; }
    }
    return best;
  }, [sourceValuesByEnv]);

  const [perEnv, setPerEnv] = useState<Record<string, string>>({});
  const [enabled, setEnabled] = useState<Record<string, boolean>>({});

  // Re-seed whenever the target project changes — source values map by
  // matching env name; the rest fall back to the seed value.
  useEffect(() => {
    if (!targetProject) return;
    const next: Record<string, string> = {};
    const on: Record<string, boolean> = {};
    for (const e of targetProject.environments) {
      const matched = sourceValuesByEnv[e.name];
      next[e.name] = matched ?? seedValue;
      on[e.name] = true;
    }
    setPerEnv(next);
    setEnabled(on);
  }, [targetProject, sourceValuesByEnv, seedValue]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !mutation.isPending) onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  });

  const mutation = useMutation({
    mutationFn: async () => {
      if (!targetProject || !targetServiceId) {
        throw new Error('Target project / service not selected');
      }
      const targetEnvs = targetProject.environments.filter((e) => enabled[e.name]);
      if (targetEnvs.length === 0) {
        throw new Error('Pick at least one target env');
      }
      // Group target envs by value so we issue one PATCH per distinct
      // value rather than one per env. Same shape as AddVarModal does.
      const byValue = new Map<string, string[]>();
      for (const env of targetEnvs) {
        const v = perEnv[env.name] ?? '';
        if (!byValue.has(v)) byValue.set(v, []);
        byValue.get(v)!.push(env.name);
      }

      const settled = await Promise.allSettled(
        Array.from(byValue.entries()).map(async ([value, envs]) => {
          const res = await patchEnvs(targetProject.id, targetServiceId, {
            environments: envs,
            updates: { [envKey]: value },
          });
          // Patch the cache for the target so the matrix reflects the
          // new value without a refetch when the user navigates there.
          const cached = qc.getQueryData<EnvsResponse>(
            ['envs', targetProject.id, targetServiceId],
          );
          if (cached) {
            const nextEnvs = { ...cached.envs };
            for (const name of envs) {
              if (res.status[name]?.ok) {
                nextEnvs[name] = { ...(nextEnvs[name] ?? {}), [envKey]: value };
              }
            }
            qc.setQueryData<EnvsResponse>(
              ['envs', targetProject.id, targetServiceId],
              { ...cached, envs: nextEnvs },
            );
          }
          return res.status;
        }),
      );

      let failed = 0;
      let total = 0;
      for (const outcome of settled) {
        if (outcome.status === 'fulfilled') {
          for (const r of Object.values(outcome.value)) {
            total++;
            if (!r.ok) failed++;
          }
        }
      }
      return { total, failed };
    },
    onSuccess: ({ total, failed }) => {
      if (failed === 0) {
        toast.success(`Copied ${envKey} → ${targetProject?.label} (${total} write${total === 1 ? '' : 's'})`);
        onClose();
      } else {
        toast.error(`Copied ${total - failed}/${total}, ${failed} failed`, {
          duration: Infinity,
          closeButton: true,
        });
      }
    },
    onError: (err) => {
      toast.error(String(err), { duration: Infinity, closeButton: true });
    },
  });

  const pending = mutation.isPending;
  const targetEnvs = targetProject?.environments ?? [];
  const enabledCount = targetEnvs.filter((e) => enabled[e.name]).length;
  const canApply = !!targetProject && !!targetServiceId && enabledCount > 0 && !pending;

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      onClick={() => { if (!pending) onClose(); }}
    >
      <div
        className="bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 rounded-lg p-5 w-[640px] max-w-[95vw] max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-bold">Copy variable</h2>
        <p className="text-xs text-slate-500 dark:text-slate-400 mb-3">
          From <span className="font-mono">{sourceProject.label} / {sourceService} / {envKey}</span>
        </p>

        <div className="grid grid-cols-2 gap-2 mb-3">
          <div>
            <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1">Target project</label>
            <select
              value={targetProjectId}
              onChange={(e) => setTargetProjectId(e.target.value)}
              disabled={pending}
              className="w-full px-2 py-1 text-sm border rounded bg-white dark:bg-slate-800 dark:border-slate-700"
            >
              {targetCandidates.length === 0 && <option value="">— no other projects —</option>}
              {targetCandidates.map((p) => (
                <option key={p.id} value={p.id}>{p.label} ({p.projectId})</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1">Target service</label>
            <select
              value={targetServiceId}
              onChange={(e) => setTargetServiceId(e.target.value)}
              disabled={pending || !targetProject}
              className="w-full px-2 py-1 text-sm border rounded bg-white dark:bg-slate-800 dark:border-slate-700"
            >
              {targetProject?.services.map((s) => (
                <option key={s.id} value={s.id}>{s.label ?? s.id}</option>
              ))}
            </select>
          </div>
        </div>

        <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1">Target envs + values</label>
        <div className="flex-1 min-h-0 overflow-auto border rounded dark:border-slate-700 mb-3">
          {targetEnvs.length === 0 ? (
            <div className="p-3 text-xs text-slate-500">Pick a target project to see its envs.</div>
          ) : (
            <ul className="divide-y dark:divide-slate-800">
              {targetEnvs.map((e) => {
                const matched = sourceValuesByEnv[e.name] !== undefined;
                return (
                  <li key={e.name} className="flex items-center gap-2 px-2 py-1.5">
                    <label className="flex items-center gap-2 w-32 shrink-0 cursor-pointer">
                      <input
                        type="checkbox"
                        className="w-4 h-4"
                        checked={!!enabled[e.name]}
                        onChange={(ev) => setEnabled({ ...enabled, [e.name]: ev.target.checked })}
                        disabled={pending}
                      />
                      <span className="text-sm whitespace-nowrap">{e.emoji} {e.name}</span>
                    </label>
                    <input
                      value={perEnv[e.name] ?? ''}
                      onChange={(ev) => setPerEnv({ ...perEnv, [e.name]: ev.target.value })}
                      disabled={pending || !enabled[e.name]}
                      className={`flex-1 px-2 py-1 border rounded font-mono text-xs disabled:opacity-50 dark:bg-slate-800 dark:border-slate-700 ${
                        matched ? 'border-emerald-300 dark:border-emerald-700' : ''
                      }`}
                      title={matched ? 'Seeded from matching source env' : 'Seeded from most-common source value'}
                    />
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="flex justify-between items-center gap-2">
          <span className="text-xs text-slate-500">{enabledCount} env{enabledCount === 1 ? '' : 's'} selected</span>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              disabled={pending}
              className="px-3 py-1 rounded bg-slate-200 dark:bg-slate-700 dark:text-slate-100 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={() => mutation.mutate()}
              disabled={!canApply}
              className="px-3 py-1 rounded bg-blue-100 text-blue-700 ring-1 ring-blue-300 font-semibold dark:bg-slate-100 dark:text-slate-900 dark:ring-0 disabled:opacity-50"
            >
              {pending ? 'Copying…' : 'Copy'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
