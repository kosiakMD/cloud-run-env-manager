import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import type { ProjectInfo } from '../api.js';
import { addLocalGroup, type LocalProjectConfig } from '../local-groups.js';

interface Props {
  /**
   * The base GCP project — supplies projectId/region for the saved group
   * and its environment list as the candidate services. The base's `id`
   * is stored as `_baseId` so backend requests for the local group can
   * be re-routed via the agnostic synth path.
   */
  project: ProjectInfo;
  onClose: () => void;
}

export function LocalGroupModal({ project, onClose }: Props) {
  const [name, setName] = useState('');
  const [filter, setFilter] = useState('');
  const [picked, setPicked] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const candidates = useMemo(
    () => project.environments.map((e) => e.name).sort(),
    [project.environments],
  );

  const filtered = useMemo(() => {
    if (!filter.trim()) return candidates;
    const q = filter.toLowerCase();
    return candidates.filter((s) => s.toLowerCase().includes(q));
  }, [candidates, filter]);

  const allFilteredOn = filtered.length > 0 && filtered.every((s) => picked[s]);
  function toggleAll() {
    const next = { ...picked };
    if (allFilteredOn) for (const s of filtered) delete next[s];
    else for (const s of filtered) next[s] = true;
    setPicked(next);
  }

  const pickedServices = Object.entries(picked).filter(([, v]) => v).map(([k]) => k);
  const canSave = name.trim().length > 0 && pickedServices.length > 0;

  function handleSave() {
    const trimmed = name.trim();
    const id = trimmed.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!id) {
      toast.error('Name must contain alphanumeric characters');
      return;
    }
    const group: LocalProjectConfig = {
      id,
      label: trimmed,
      emoji: '💾',
      projectId: project.projectId,
      region: project.region,
      environments: pickedServices.map((n) => ({ name: n, servicePrefix: n })),
      services: [{ id: '_', suffix: '' }],
      _baseId: project.id,
    };
    addLocalGroup(group);
    toast.success(`Saved "${trimmed}" — ${pickedServices.length} service${pickedServices.length === 1 ? '' : 's'}`);
    onClose();
  }

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        className="bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 rounded-lg p-5 w-[560px] max-w-[95vw] h-[560px] max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-bold">Add local group</h2>
        <p className="text-xs text-slate-500 dark:text-slate-400 mb-3">
          Project <span className="font-mono">{project.projectId}</span> · saved in this browser only.
        </p>

        <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1">Group name</label>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="my-group"
          className="w-full px-2 py-1 mb-3 text-sm border rounded bg-white dark:bg-slate-800 dark:border-slate-700"
        />

        <div className="flex items-center gap-2 mb-1">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter services…"
            className="flex-1 px-2 py-1 text-sm border rounded bg-white dark:bg-slate-800 dark:border-slate-700"
          />
          <button
            onClick={toggleAll}
            disabled={filtered.length === 0}
            className="px-2 py-1 rounded text-xs font-semibold bg-slate-100 hover:bg-slate-200 disabled:opacity-40 dark:bg-slate-800 dark:hover:bg-slate-700"
          >
            {allFilteredOn ? 'Unselect all' : 'Select all'}
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-auto border rounded dark:border-slate-700 mb-3">
          {filtered.length === 0 ? (
            <div className="p-3 text-xs text-slate-500">No services match.</div>
          ) : (
            <ul className="divide-y dark:divide-slate-800">
              {filtered.map((s) => (
                <li key={s}>
                  <label className="flex items-center gap-2 px-2 py-1 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800 text-sm font-mono">
                    <input
                      type="checkbox"
                      className="w-4 h-4"
                      checked={!!picked[s]}
                      onChange={(e) => setPicked({ ...picked, [s]: e.target.checked })}
                    />
                    <span className="truncate">{s}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex justify-between items-center gap-2">
          <span className="text-xs text-slate-500">{pickedServices.length} selected</span>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-3 py-1 rounded bg-slate-200 dark:bg-slate-700 dark:text-slate-100"
            >
              Close
            </button>
            <button
              onClick={handleSave}
              disabled={!canSave}
              className="px-3 py-1 rounded bg-blue-100 text-blue-700 ring-1 ring-blue-300 font-semibold dark:bg-slate-100 dark:text-slate-900 dark:ring-0 disabled:opacity-50"
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
