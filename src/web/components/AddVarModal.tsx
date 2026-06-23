import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { serviceLabel, type ServiceId } from '../../shared/config.js';
import { patchEnvs, type EnvsResponse } from '../api.js';
import { useFindProject } from '../use-projects.js';

interface Props {
  projectId: string;
  currentService: ServiceId;
  visibleEnvs: Record<string, boolean>;
  onClose: () => void;
  /**
   * When set, the modal runs in "edit existing key" mode: the KEY field is
   * locked, services default to just the current one, and per-env values
   * are pre-seeded from `initialValues`. Functionally the PATCH is the same
   * — we just reuse the add flow.
   */
  editingKey?: string;
  initialValues?: Record<string, string | undefined>;
}

export function AddVarModal({ projectId, currentService, visibleEnvs, onClose, editingKey, initialValues }: Props) {
  const isEdit = editingKey !== undefined;
  const project = useFindProject(projectId);
  const environments = project?.environments ?? [];
  const projectServices = project?.services ?? [];
  const [key, setKey] = useState(editingKey ?? '');
  // In edit mode seed the "default value" with the most-common current value
  // across envs so the user has a sensible starting point if they want to
  // mass-change.
  const seedDefault = (() => {
    if (!initialValues) return '';
    const counts = new Map<string, number>();
    for (const v of Object.values(initialValues)) {
      if (v === undefined) continue;
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    let best = '';
    let bestCount = 0;
    for (const [v, c] of counts) if (c > bestCount) { best = v; bestCount = c; }
    return best;
  })();
  const [defaultValue, setDefaultValue] = useState(seedDefault);
  const [perEnv, setPerEnv] = useState<Record<string, string>>(
    initialValues
      ? Object.fromEntries(Object.entries(initialValues).map(([k, v]) => [k, v ?? '']))
      : {},
  );
  // In edit mode every pre-seeded env counts as "touched" so its current value
  // isn't silently overwritten when the user types in the default field.
  const [touched, setTouched] = useState<Record<string, boolean>>(
    initialValues
      ? Object.fromEntries(
          Object.entries(initialValues)
            .filter(([, v]) => v !== undefined)
            .map(([k]) => [k, true]),
        )
      : {},
  );
  const [envsOn, setEnvsOn] = useState<Record<string, boolean>>(
    Object.fromEntries(environments.map((e) => [e.name, !!visibleEnvs[e.name]])),
  );
  const [servicesOn, setServicesOn] = useState<Record<ServiceId, boolean>>(
    Object.fromEntries(projectServices.map((s) => [s.id, s.id === currentService])) as Record<ServiceId, boolean>,
  );
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const qc = useQueryClient();

  function effectiveValueFor(name: string): string {
    return touched[name] ? (perEnv[name] ?? '') : defaultValue;
  }

  function handleDefaultChange(v: string) {
    setDefaultValue(v);
    // Mirror only into the envs that are currently enabled AND not
    // individually edited. Mirroring into disabled envs is wasted work
    // and surprises the user when they later toggle one on and find a
    // value they didn't realise was already typed for them.
    const next = { ...perEnv };
    for (const e of environments) {
      if (envsOn[e.name] && !touched[e.name]) next[e.name] = v;
    }
    setPerEnv(next);
  }

  function handlePerEnvChange(name: string, v: string) {
    setPerEnv({ ...perEnv, [name]: v });
    setTouched({ ...touched, [name]: true });
  }

  function handleEnvToggle(name: string, on: boolean) {
    setEnvsOn({ ...envsOn, [name]: on });
    if (!on) {
      // Re-checking the env should pick up the *current* default value,
      // not a stale per-env override. Clear both flags so the toggle is
      // a clean reset back to "follow default".
      const nextPerEnv = { ...perEnv };
      delete nextPerEnv[name];
      const nextTouched = { ...touched };
      delete nextTouched[name];
      setPerEnv(nextPerEnv);
      setTouched(nextTouched);
    }
  }

  const allOn = environments.every((e) => envsOn[e.name]);
  function toggleAllEnvs() {
    if (allOn) {
      setEnvsOn(Object.fromEntries(environments.map((e) => [e.name, false])));
      setPerEnv({});
      setTouched({});
    } else {
      setEnvsOn(Object.fromEntries(environments.map((e) => [e.name, true])));
    }
  }

  const mutation = useMutation({
    mutationFn: async () => {
      const targetServices = projectServices.filter((s) => servicesOn[s.id]);
      const targetEnvs = environments.filter((e) => envsOn[e.name]);

      type Batch = { svcId: ServiceId; value: string; envs: string[] };
      const batches: Batch[] = [];
      for (const s of targetServices) {
        const byValue = new Map<string, string[]>();
        for (const env of targetEnvs) {
          const v = effectiveValueFor(env.name);
          if (!byValue.has(v)) byValue.set(v, []);
          byValue.get(v)!.push(env.name);
        }
        for (const [value, envs] of byValue) batches.push({ svcId: s.id, value, envs });
      }

      const settled = await Promise.allSettled(
        batches.map(async (b) => {
          const res = await patchEnvs(projectId, b.svcId, { environments: b.envs, updates: { [key]: b.value } });
          const cached = qc.getQueryData<EnvsResponse>(['envs', projectId, b.svcId]);
          if (cached) {
            const nextEnvs = { ...cached.envs };
            for (const name of b.envs) {
              if (res.status[name]?.ok) {
                nextEnvs[name] = { ...(nextEnvs[name] ?? {}), [key]: b.value };
              }
            }
            qc.setQueryData<EnvsResponse>(['envs', projectId, b.svcId], { ...cached, envs: nextEnvs });
          }
          return res.status;
        }),
      );

      const results: Record<string, Record<string, { ok: boolean; error?: string }>> = {};
      settled.forEach((outcome, i) => {
        const b = batches[i];
        const bucket = results[b.svcId] ?? (results[b.svcId] = {});
        if (outcome.status === 'fulfilled') {
          Object.assign(bucket, outcome.value);
        } else {
          for (const name of b.envs) bucket[name] = { ok: false, error: String(outcome.reason) };
        }
      });
      return results;
    },
    onSuccess: (results) => {
      let failed = 0;
      let total = 0;
      for (const svc of Object.values(results)) {
        for (const r of Object.values(svc)) {
          total++;
          if (!r.ok) failed++;
        }
      }
      const verb = isEdit ? 'Updated' : 'Added';
      const verbLower = isEdit ? 'update' : 'add';
      if (failed === 0) {
        toast.success(`${verb} ${key} (${total} ${total === 1 ? 'write' : 'writes'})`);
        onClose();
      } else {
        const msg =
          failed === total
            ? `Failed to ${verbLower} ${key} — ${total} failure${total === 1 ? '' : 's'}`
            : `${verb} ${key}: ${total - failed}/${total} succeeded — ${failed} failed`;
        toast.error(msg, { duration: Infinity, closeButton: true });
        setErrorMsg(msg);
        console.error('AddVar results:', results);
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

  const pending = mutation.isPending;

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      onClick={() => { if (!pending) onClose(); }}
    >
      <div className="bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 rounded-lg p-6 w-[600px] max-w-[95vw]" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-bold mb-4">
          {isEdit ? `Edit ${editingKey}` : 'Add environment variable'}
        </h2>

        <label className="block text-xs font-semibold mb-1">KEY</label>
        <input
          autoFocus={!isEdit}
          disabled={pending || isEdit}
          value={key}
          onChange={(e) => setKey(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ''))}
          placeholder="LOG_LEVEL"
          className="w-full px-2 py-1 border rounded font-mono mb-3 bg-white disabled:bg-slate-100 dark:bg-slate-800 dark:border-slate-700 dark:disabled:bg-slate-700"
        />

        {/*
          "Default value" only matters in add mode — in edit mode every env
          is pre-seeded with its current value and the user types changes
          directly in the per-env fields. The target-services picker is also
          hidden in edit mode: the row came from a specific service and
          cross-service edits would need different current values per
          service.
         */}
        {!isEdit && (
          <>
            <label className="block text-xs font-semibold mb-1">Default value (mirrors into untouched fields)</label>
            <input
              disabled={pending}
              value={defaultValue}
              onChange={(e) => handleDefaultChange(e.target.value)}
              className="w-full px-2 py-1 border rounded font-mono mb-3 bg-white disabled:bg-slate-100 dark:bg-slate-800 dark:border-slate-700 dark:disabled:bg-slate-700"
            />
          </>
        )}

        <div className="flex items-center justify-between mb-1">
          <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
            Apply to envs
          </span>
          {/* One button that toggles its label/action based on whether
              every env is currently selected. "All" → enable all (useful
              when you've narrowed down). "None" → clear and start fresh
              (useful when you only want a couple). */}
          <button
            onClick={toggleAllEnvs}
            disabled={pending}
            // Matches the matrix' Services-row toggle: 36px tall on
            // mobile (Apple HIG tap target), comfortable text size so
            // it doesn't read as a typo button.
            className="h-9 lg:h-8 inline-flex items-center px-3 rounded text-sm font-semibold bg-slate-100 hover:bg-slate-200 disabled:opacity-50 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-200"
          >
            {allOn ? 'None' : 'All'}
          </button>
        </div>
        <div className="space-y-2 mb-4">
          {environments.map((env) => (
            <div key={env.name} className="flex items-center gap-2">
              {/*
                Wrap the checkbox + env label in one <label> so tapping the
                name/emoji toggles the checkbox — the bare checkbox has a
                tiny hit area and the emoji is a more obvious target.
               */}
              <label className="flex items-center gap-2 w-40 cursor-pointer select-none">
                <input
                  type="checkbox"
                  disabled={pending}
                  checked={!!envsOn[env.name]}
                  onChange={(e) => handleEnvToggle(env.name, e.target.checked)}
                />
                <span>{env.emoji} {env.name}</span>
              </label>
              <input
                disabled={!envsOn[env.name] || pending}
                value={effectiveValueFor(env.name)}
                onChange={(e) => handlePerEnvChange(env.name, e.target.value)}
                className={`flex-1 px-2 py-1 border rounded font-mono text-sm disabled:bg-slate-100 dark:bg-slate-800 dark:border-slate-700 dark:disabled:bg-slate-700 ${
                  touched[env.name] ? 'border-amber-400 bg-amber-50 dark:bg-amber-900' : 'bg-white'
                }`}
              />
            </div>
          ))}
        </div>

        {!isEdit && (
          <>
            <label className="block text-xs font-semibold mb-1">Apply to services</label>
            <div className="flex gap-3 mb-4">
              {projectServices.map((s) => (
                <label key={s.id} className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    disabled={pending}
                    checked={servicesOn[s.id]}
                    onChange={(e) => setServicesOn({ ...servicesOn, [s.id]: e.target.checked })}
                  />
                  {serviceLabel(s)}
                </label>
              ))}
            </div>
          </>
        )}

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
            onClick={() => { setErrorMsg(null); mutation.mutate(); }}
            disabled={!key || pending}
            className="px-3 py-1 rounded bg-blue-100 text-blue-700 ring-1 ring-blue-300 font-semibold dark:bg-slate-100 dark:text-slate-900 dark:ring-0 disabled:opacity-50"
          >
            {pending ? 'Applying… (cannot close)' : errorMsg ? 'Retry' : 'Apply'}
          </button>
        </div>
      </div>
    </div>
  );
}
