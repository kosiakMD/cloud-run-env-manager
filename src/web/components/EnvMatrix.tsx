import { useEffect, useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { type ServiceId } from '../../shared/config.js';
import { fetchEnvs, isAgnostic } from '../api.js';
import { useFindProject } from '../use-projects.js';
import { useLocalGroups } from '../local-groups.js';
import { triggerDotEnvDownload } from '../dotenv-io.js';
import { EnvCell } from './EnvCell.js';
import { DeleteConfirmModal } from './DeleteConfirmModal.js';
import { AddVarModal } from './AddVarModal.js';
import { ImportModal } from './ImportModal.js';
import { CopyVarModal } from './CopyVarModal.js';

interface Props {
  projectId: string;
  service: ServiceId;
  /**
   * Whether the signed-in user can write env vars on this project (IAM
   * probe result from `/api/health`). When false the UI hides + Add,
   * disables per-row edit/delete icons, and turns cell click-to-edit
   * into a no-op so read-only users don't waste a round-trip on a 403.
   */
  canWrite: boolean;
}

type RowCategory = 'same' | 'diff' | 'unique';
type FilterMode = 'all' | 'diff' | 'unique';

export function EnvMatrix({ projectId, service, canWrite }: Props) {
  const project = useFindProject(projectId);
  const environments = useMemo(() => project?.environments ?? [], [project]);

  const [search, setSearch] = useState('');
  const [filterMode, setFilterMode] = useState<FilterMode>('all');
  // Visibility default by project flavour:
  //   - agnostic raw GCP project (synth) → all OFF, user picks which to load
  //   - local group (curated subset) → all ON, the picks ARE the group
  //   - config / configured project → all ON
  // Selecting a service triggers its fetch; deselecting drops it from
  // the matrix. This keeps the agnostic discovery view useful with 50+
  // services without spamming the API on every project switch.
  const localGroups = useLocalGroups();
  const isLocalGroup = localGroups.some((g) => g.id === projectId);
  const defaultAllOn = !isAgnostic || isLocalGroup;
  const [visibleEnvs, setVisibleEnvs] = useState<Record<string, boolean>>(() =>
    defaultAllOn ? Object.fromEntries(environments.map((e) => [e.name, true])) : {},
  );
  useEffect(() => {
    setVisibleEnvs(
      defaultAllOn ? Object.fromEntries(environments.map((e) => [e.name, true])) : {},
    );
  }, [projectId, environments, defaultAllOn]);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [copyingKey, setCopyingKey] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);

  async function copyToClipboard(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`Copied ${label}`);
    } catch (err) {
      toast.error(`Copy failed: ${String(err)}`);
    }
  }

  function exportEnv(envName: string) {
    const envs = data?.envs?.[envName];
    if (!envs) return;
    // Filename shape: `{projectId}-{envName}-{service}.env` — projectId keeps
    // exports from different GCP projects distinguishable when they sit
    // next to each other in someone's Downloads folder.
    const filename = `${project?.projectId ?? projectId}-${envName}-${service}.env`;
    triggerDotEnvDownload(filename, envs);
  }

  // Lazy fetch: pass only checked env names to the backend so an agnostic
  // project with 20+ services doesn't fetch them all at once. Sorted to
  // give React Query a stable cache key — toggling order shouldn't refetch.
  const visibleEnvNames = useMemo(
    () => environments.filter((e) => visibleEnvs[e.name]).map((e) => e.name).sort(),
    [environments, visibleEnvs],
  );

  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: ['envs', projectId, service, visibleEnvNames.join(',')],
    queryFn: () => fetchEnvs(projectId, service, visibleEnvNames),
    enabled: visibleEnvNames.length > 0,
  });

  const visibleCols = useMemo(
    () => environments.filter((e) => visibleEnvs[e.name]),
    [environments, visibleEnvs],
  );
  const singleCol = visibleCols.length <= 1;

  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia('(max-width: 767px)').matches : false,
  );
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    const sync = (e: MediaQueryListEvent | MediaQueryList) => setIsMobile(e.matches);
    sync(mq);
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  useEffect(() => {
    if (singleCol && filterMode !== 'all') setFilterMode('all');
  }, [singleCol, filterMode]);

  const allKeys = useMemo(() => {
    if (!data?.envs) return [];
    const keys = new Set<string>();
    for (const env of Object.values(data.envs)) {
      for (const k of Object.keys(env)) keys.add(k);
    }
    return [...keys].sort();
  }, [data]);

  function categorize(key: string): RowCategory {
    if (!data?.envs) return 'same';
    const values = visibleCols.map((e) => data.envs[e.name]?.[key]);
    const missing = values.filter((v) => v === undefined).length;
    if (missing > 0) return 'unique';
    const uniq = new Set(values as string[]);
    return uniq.size === 1 ? 'same' : 'diff';
  }

  function rowBadge(cat: RowCategory) {
    const base = 'inline-block px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider';
    if (cat === 'diff') {
      return <span title="Values differ across environments" className={`${base} bg-amber-200 text-amber-800 dark:bg-amber-900 dark:text-amber-300`}>DIFF</span>;
    }
    if (cat === 'unique') {
      return <span title="Missing from at least one environment" className={`${base} bg-rose-200 text-rose-800 dark:bg-red-900 dark:text-red-300`}>GAP</span>;
    }
    return <span title="Same value across all visible environments" className={`${base} bg-slate-200 text-slate-500 dark:bg-slate-700 dark:text-slate-300`}>SYNC</span>;
  }

  function rowBgClass(cat: RowCategory) {
    if (cat === 'diff') return 'bg-amber-50 dark:bg-[#1a1708]';
    if (cat === 'unique') return 'bg-rose-50 dark:bg-[#1a0a0a]';
    return 'dark:bg-slate-950';
  }

  // Hover colours, one step deeper than the base row bg so the hover is
  // visibly distinct on every category. Without per-category hover the
  // default slate-50 became invisible against amber-50/rose-50 rows.
  function rowHoverClass(cat: RowCategory) {
    if (cat === 'diff') return 'md:hover:bg-amber-100 md:dark:hover:bg-[#2a2410]';
    if (cat === 'unique') return 'md:hover:bg-rose-100 md:dark:hover:bg-[#261012]';
    return 'md:hover:bg-slate-100 md:dark:hover:bg-slate-800';
  }

  function stickyBgSolid(cat: RowCategory) {
    if (cat === 'diff') return 'bg-amber-50 dark:bg-[#1a1708]';
    if (cat === 'unique') return 'bg-rose-50 dark:bg-[#1a0a0a]';
    return 'bg-slate-50 dark:bg-slate-950';
  }

  // Sticky cells sit on their own layer above the row and don't inherit the
  // row's hover bg — they need their own `group-hover:*` matching the row
  // hover above, otherwise the STATE/ENV/edit/delete columns stay the base
  // colour while the middle of the row shifts.
  function stickyHoverBg(cat: RowCategory) {
    if (cat === 'diff') return 'md:group-hover:bg-amber-100 md:dark:group-hover:bg-[#2a2410]';
    if (cat === 'unique') return 'md:group-hover:bg-rose-100 md:dark:group-hover:bg-[#261012]';
    return 'md:group-hover:bg-slate-100 md:dark:group-hover:bg-slate-800';
  }

  function borderClass(cat: RowCategory) {
    if (cat === 'diff') return 'border-l-4 border-amber-400 dark:border-amber-700';
    if (cat === 'unique') return 'border-l-4 border-rose-400 dark:border-red-800';
    return 'border-l-4 border-slate-200 dark:border-slate-700';
  }

  function valuesByEnv(key: string): Record<string, string | undefined> {
    const out: Record<string, string | undefined> = {};
    for (const e of environments) out[e.name] = data?.envs[e.name]?.[key];
    return out;
  }

  // Render-state is decided inside the matrix body so the toolbar +
  // services-row stay visible while the user has nothing toggled, is
  // loading, or hit an error. Earlier we returned early at the component
  // root which also hid the only UI for picking a service in agnostic
  // mode — leaving the user stuck with "Failed to load envs" and no way
  // to pick a column.
  const noneVisible = visibleEnvNames.length === 0;
  const failed = !noneVisible && (error || !data);

  const filteredKeys = (data ? allKeys : []).filter((k) => {
    if (search && !k.toLowerCase().includes(search.toLowerCase())) return false;
    const cat = categorize(k);
    if (filterMode === 'all') return true;
    return cat === filterMode;
  });

  // On mobile shrink the ENV label column and give the env value columns a
  // tighter min width so a project with only 2 envs (QA) fits without
  // horizontal scroll, and 4-env projects only needs a short scroll.
  // The user can always tap a row to see the full cell contents in the edit
  // modal; the cell is a preview, not the source of truth.
  const mobileEnvMin = visibleCols.length <= 2 ? 130 : 90;
  const mobileLabelWidth = visibleCols.length <= 2 ? 140 : 120;
  // Right-side action columns: copy → edit → delete. Widths picked so
  // the icons sit comfortably and sticky offsets compose cleanly.
  const gridTemplate = isMobile
    ? `${mobileLabelWidth}px repeat(${visibleCols.length}, minmax(${mobileEnvMin}px, 1fr)) 32px 36px 40px`
    : `60px 200px repeat(${visibleCols.length}, minmax(180px, 1fr)) 40px 44px 48px`;
  // Sum of column minimums — drives the matrix container's `min-width`
  // so columns share viewport space equally via `1fr` until the natural
  // minimum exceeds the viewport, at which point we scroll horizontally
  // with every column locked at its minimum (instead of one column
  // ballooning to fit its longest value while others squish).
  const minMatrixWidth = isMobile
    ? mobileLabelWidth + visibleCols.length * mobileEnvMin + 32 + 36 + 40
    : 60 + 200 + visibleCols.length * 180 + 40 + 44 + 48;
  const rightCopy = isMobile ? 'right-[76px]' : 'right-[92px]';
  const rightEdit = isMobile ? 'right-[40px]' : 'right-[48px]';

  const filterButtons: Array<{ id: FilterMode; label: string; activeClass: string; inactiveClass: string; title: string }> = [
    { id: 'all', label: 'All', activeClass: 'bg-slate-200 text-slate-800 ring-1 ring-slate-400 dark:bg-slate-200 dark:text-slate-900', inactiveClass: 'bg-slate-100 text-slate-400 dark:bg-slate-700 dark:text-slate-400', title: 'Show every env key' },
    { id: 'diff', label: 'DIFF', activeClass: 'bg-amber-200 text-amber-800 ring-1 ring-amber-400 dark:bg-amber-800 dark:text-amber-200', inactiveClass: 'bg-amber-50 text-amber-400 dark:bg-amber-950 dark:text-amber-500', title: 'All environments have the key but values differ' },
    { id: 'unique', label: 'GAP', activeClass: 'bg-rose-200 text-rose-800 ring-1 ring-rose-400 dark:bg-red-800 dark:text-red-200', inactiveClass: 'bg-rose-50 text-rose-400 dark:bg-red-950 dark:text-red-500', title: 'At least one environment is missing the key' },
  ];

  // Visibility row: when env count is small enough to coexist with the
  // filter toolbar in one line, it sits to the right of the toolbar.
  // For larger lists (8 environments) the inline right-side is too cramped
  // and CSS flex-wrap would push the checkboxes BELOW the filters, which
  // hides the just-added env row visually. Promote into a dedicated row
  // ABOVE the filters instead, so envs always read top-down: services →
  // filters → matrix.
  const SERVICES_INLINE_THRESHOLD = 4;
  const servicesAbove = environments.length > SERVICES_INLINE_THRESHOLD;

  const allEnvsOn = environments.every((e) => visibleEnvs[e.name]);
  // Same row height for All-button and checkbox-labels so the wrapped
  // grid stays aligned. `h-7` is ~28px, fits a 16px checkbox + label
  // baseline without the button looking inflated.
  const servicesNode = (
    <div className="flex items-center gap-x-3 gap-y-1 text-sm flex-wrap">
      <button
        onClick={() =>
          setVisibleEnvs(Object.fromEntries(environments.map((e) => [e.name, true])))
        }
        disabled={allEnvsOn}
        title={allEnvsOn ? 'All environments already shown' : 'Show all environments'}
        className="h-7 inline-flex items-center px-2 rounded text-sm font-semibold bg-slate-100 text-slate-600 hover:bg-slate-200 disabled:opacity-40 disabled:cursor-not-allowed dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
      >
        All
      </button>
      {environments.map((e) => (
        <label key={e.name} className="h-7 flex items-center gap-1.5 cursor-pointer">
          <input
            type="checkbox"
            className="w-4 h-4"
            checked={!!visibleEnvs[e.name]}
            onChange={(ev) => setVisibleEnvs({ ...visibleEnvs, [e.name]: ev.target.checked })}
          />
          <span className="hidden md:inline whitespace-nowrap">{e.emoji} {e.name}</span>
          <span className="md:hidden">{e.emoji}</span>
        </label>
      ))}
    </div>
  );

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
      {servicesAbove && (
        <div className="flex items-center gap-3 px-2 md:px-3 py-2 border-b bg-slate-50 dark:bg-slate-900 dark:border-slate-700 shrink-0">
          <span className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 shrink-0">Services</span>
          {servicesNode}
        </div>
      )}
      <div className="flex items-center gap-2 p-2 md:p-3 border-b bg-slate-50 dark:bg-slate-900 dark:border-slate-700 text-sm shrink-0">
        <input
          placeholder="Search keys…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-40 md:w-48 px-2 py-1 border rounded bg-white dark:bg-slate-800 dark:border-slate-700 dark:text-slate-100"
        />
        <div className="flex rounded border dark:border-slate-700 overflow-hidden">
          {filterButtons.map((b) => {
            const disabled = singleCol && b.id !== 'all';
            return (
              <button
                key={b.id}
                disabled={disabled}
                onClick={() => setFilterMode(b.id)}
                title={disabled ? 'Show at least 2 environments to use this filter' : b.title}
                className={`px-2 py-1 text-xs font-bold uppercase tracking-wider border-r last:border-r-0 dark:border-slate-700 disabled:opacity-40 disabled:cursor-not-allowed ${
                  filterMode === b.id ? b.activeClass : b.inactiveClass
                }`}
              >
                {b.label}
              </button>
            );
          })}
        </div>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="px-2 py-1 rounded bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-200 disabled:opacity-50 text-xs"
          title="Refetch from Cloud Run"
        >
          {isFetching ? '↻…' : '↻ Refresh'}
        </button>
        {canWrite && (
          <button
            onClick={() => setAdding(true)}
            className="px-2 py-1 rounded bg-emerald-100 text-emerald-700 ring-1 ring-emerald-300 text-xs font-semibold hover:bg-emerald-200 dark:bg-emerald-700 dark:text-emerald-100 dark:ring-0 dark:hover:bg-emerald-600"
          >
            + Add
          </button>
        )}
        {canWrite && (
          <button
            onClick={() => setImporting(true)}
            className="px-2 py-1 rounded bg-blue-100 text-blue-700 ring-1 ring-blue-300 text-xs font-semibold hover:bg-blue-200 dark:bg-blue-800 dark:text-blue-100 dark:ring-0 dark:hover:bg-blue-700"
            title="Import .env into one or more environments"
          >
            📥 Import
          </button>
        )}
        {!servicesAbove && <div className="ml-auto">{servicesNode}</div>}
      </div>

      <div className="flex-1 min-h-0 overflow-auto bg-slate-50 dark:bg-slate-950">
        {isLoading ? (
          <div className="p-6 text-slate-700 dark:text-slate-200">Loading envs for {service}…</div>
        ) : noneVisible ? (
          <div className="p-6 text-slate-500 dark:text-slate-400">Pick at least one service above to see its env vars.</div>
        ) : failed ? (
          <div className="p-6 text-red-600 dark:text-red-400">Failed to load envs.</div>
        ) : data ? (
          // Single shared wrapper so every row picks up the same total
          // width — without this each row sized to its own content, and
          // `sticky right-0` ended up at *that row's* right edge instead
          // of the viewport edge. The explicit `minWidth` makes the
          // `1fr` columns split the viewport equally when there's room
          // and falls back to per-column minimums (with horizontal
          // scroll) when there isn't, so a single long value can't
          // hijack a column's width.
          <div style={{ minWidth: `${minMatrixWidth}px` }}>
        <div className="grid sticky top-0 z-20 bg-slate-100 dark:bg-slate-800 dark:text-slate-200 font-semibold text-xs uppercase tracking-wider border-b dark:border-slate-700"
             style={{ gridTemplateColumns: gridTemplate }}>
          {!isMobile && (
            <div className="px-3 py-2 sticky left-0 bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 z-30">STATE</div>
          )}
          <div className={`px-3 py-2 sticky ${isMobile ? 'left-0' : 'left-[60px]'} bg-slate-100 dark:bg-slate-800 z-30`}>
            ENV
          </div>
          {visibleCols.map((e) => (
            <div key={e.name} className="px-3 py-2 truncate flex items-center gap-1">
              <span className="truncate">{e.emoji} {e.name}</span>
              <button
                onClick={() => exportEnv(e.name)}
                disabled={!data?.envs?.[e.name]}
                className="shrink-0 text-slate-400 hover:text-blue-600 dark:hover:text-blue-400 disabled:opacity-30 disabled:cursor-not-allowed text-xs leading-none"
                title={`Export ${e.name} as .env`}
              >
                ⬇
              </button>
            </div>
          ))}
          <div className={`sticky ${rightCopy} bg-slate-100 dark:bg-slate-800 z-30`}></div>
          <div className={`sticky ${rightEdit} bg-slate-100 dark:bg-slate-800 z-30`}></div>
          <div className="sticky right-0 bg-slate-100 dark:bg-slate-800 z-30"></div>
        </div>
        {filteredKeys.map((key) => {
          const cat = categorize(key);
          const rowBg = rowBgClass(cat);
          const rowHover = rowHoverClass(cat);
          const solidBg = stickyBgSolid(cat);
          const stickyHover = stickyHoverBg(cat);
          const border = borderClass(cat);
          return (
            <div
              key={key}
              className={`group grid border-b dark:border-slate-800 ${rowBg} ${rowHover}`}
              style={{ gridTemplateColumns: gridTemplate }}
            >
              {!isMobile && (
                <div className={`px-2 py-2 sticky left-0 flex items-center justify-center ${solidBg} ${stickyHover} z-10`}>
                  {rowBadge(cat)}
                </div>
              )}
              <div
                className={`px-3 py-2 sticky ${isMobile ? 'left-0' : 'left-[60px]'} font-mono text-sm truncate flex items-center gap-1 ${solidBg} ${stickyHover} ${border} z-10`}
                title={key}
              >
                <span className="truncate flex-1">{key}</span>
                {/* Quick-copy of the (potentially truncated) key. Hidden
                    until row hover so it doesn't crowd the matrix. */}
                <button
                  onClick={() => copyToClipboard(key, `key ${key}`)}
                  className="opacity-0 group-hover:opacity-100 transition-opacity shrink-0 text-slate-400 hover:text-blue-600 dark:hover:text-blue-400 text-xs"
                  title="Copy key"
                >
                  📋
                </button>
              </div>
              {visibleCols.map((e) => {
                const v = data.envs[e.name]?.[key];
                return (
                  <EnvCell
                    key={e.name}
                    projectId={projectId}
                    service={service}
                    envName={e.name}
                    envKey={key}
                    value={v}
                    isMobile={isMobile}
                    canWrite={canWrite}
                  />
                );
              })}
              <button
                onClick={() => setCopyingKey(key)}
                className={`flex items-center justify-center text-slate-400 text-sm leading-none sticky ${rightCopy} ${solidBg} ${stickyHover} z-10 hover:text-blue-600 dark:hover:text-blue-400`}
                title={`Copy ${key} to another project / service`}
              >
                📋
              </button>
              <button
                onClick={() => canWrite && setEditingKey(key)}
                disabled={!canWrite}
                className={`flex items-center justify-center text-slate-400 text-base leading-none sticky ${rightEdit} ${solidBg} ${stickyHover} z-10 ${
                  canWrite
                    ? 'hover:text-blue-600 dark:hover:text-blue-400'
                    : 'opacity-40 cursor-not-allowed'
                }`}
                title={canWrite ? `Mass-edit ${key}` : 'Read-only access to this project'}
              >
                ✏️
              </button>
              <button
                onClick={() => canWrite && setDeletingKey(key)}
                disabled={!canWrite}
                className={`flex items-center justify-center text-slate-400 text-base leading-none sticky right-0 ${solidBg} ${stickyHover} z-10 ${
                  canWrite
                    ? 'hover:text-red-600 dark:hover:text-red-400'
                    : 'opacity-40 cursor-not-allowed'
                }`}
                title={canWrite ? `Delete ${key}` : 'Read-only access to this project'}
              >
                🗑
              </button>
            </div>
          );
        })}
          </div>
        ) : null}
      </div>

      {deletingKey !== null && (
        <DeleteConfirmModal
          projectId={projectId}
          service={service}
          envKey={deletingKey}
          valuesByEnv={valuesByEnv(deletingKey)}
          visibleEnvs={visibleEnvs}
          onClose={() => setDeletingKey(null)}
        />
      )}
      {adding && (
        <AddVarModal
          projectId={projectId}
          currentService={service}
          visibleEnvs={visibleEnvs}
          onClose={() => setAdding(false)}
        />
      )}
      {editingKey !== null && (
        <AddVarModal
          projectId={projectId}
          currentService={service}
          visibleEnvs={visibleEnvs}
          editingKey={editingKey}
          initialValues={valuesByEnv(editingKey)}
          onClose={() => setEditingKey(null)}
        />
      )}
      {importing && data?.envs && (
        <ImportModal
          projectId={projectId}
          service={service}
          environments={environments}
          visibleEnvs={visibleEnvs}
          currentEnvs={data.envs}
          onClose={() => setImporting(false)}
        />
      )}
      {copyingKey !== null && project && (
        <CopyVarModal
          sourceProject={project}
          sourceService={service}
          envKey={copyingKey}
          sourceValuesByEnv={valuesByEnv(copyingKey)}
          onClose={() => setCopyingKey(null)}
        />
      )}
    </div>
  );
}
