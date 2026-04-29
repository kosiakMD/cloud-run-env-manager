import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { EnvironmentConfig, ServiceId } from '../../shared/config.js';
import { patchEnvs, type EnvsResponse } from '../api.js';
import { parseDotEnv } from '../dotenv-io.js';

interface Props {
  projectId: string;
  service: ServiceId;
  environments: EnvironmentConfig[];
  /** Envs that were visible in the matrix when the user opened Import — default target set. */
  visibleEnvs: Record<string, boolean>;
  /** Full current env map from the matrix query, used to classify each imported key. */
  currentEnvs: Record<string, Record<string, string>>;
  onClose: () => void;
}

type Step = 'input' | 'preview';
type CellStatus = 'new' | 'override' | 'same';

interface PreviewRow {
  key: string;
  /** Editable new value. Starts from parsed file, user can tweak before apply. */
  newValue: string;
  /** Per-env status + per-env user decision. */
  cells: Record<string, { status: CellStatus; currentValue: string | undefined; checked: boolean }>;
}

function classifyCell(
  newValue: string,
  currentValue: string | undefined,
): CellStatus {
  if (currentValue === undefined) return 'new';
  if (currentValue === newValue) return 'same';
  return 'override';
}

function defaultCheckedFor(status: CellStatus): boolean {
  // "same" is noise — user usually doesn't want to re-send identical writes.
  // "new" and "override" are both write intents, so pre-check them.
  return status !== 'same';
}

export function ImportModal({
  projectId,
  service,
  environments,
  visibleEnvs,
  currentEnvs,
  onClose,
}: Props) {
  const qc = useQueryClient();
  const [step, setStep] = useState<Step>('input');
  const [inputText, setInputText] = useState('');
  const [rows, setRows] = useState<PreviewRow[]>([]);
  const [targetEnvs, setTargetEnvs] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(environments.map((e) => [e.name, !!visibleEnvs[e.name]])),
  );
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // ------ Parse step -------------------------------------------------------

  const parsed = useMemo(() => parseDotEnv(inputText), [inputText]);
  const parsedKeyCount = Object.keys(parsed).length;

  function buildRows(): PreviewRow[] {
    return Object.entries(parsed)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, newValue]) => {
        const cells: PreviewRow['cells'] = {};
        for (const env of environments) {
          const currentValue = currentEnvs[env.name]?.[key];
          const status = classifyCell(newValue, currentValue);
          cells[env.name] = {
            status,
            currentValue,
            checked: !!targetEnvs[env.name] && defaultCheckedFor(status),
          };
        }
        return { key, newValue, cells };
      });
  }

  function goPreview() {
    if (parsedKeyCount === 0) {
      toast.error('No KEY=VALUE pairs found in input');
      return;
    }
    setRows(buildRows());
    setStep('preview');
  }

  // When user toggles a target env on/off after entering preview, re-sync the
  // `checked` defaults on every cell of the affected env. Deliberately only
  // touches cells the user hasn't hand-modified would be nicer, but tracking
  // dirty flags is more complexity than this flow needs — the expected use
  // is "select target envs up front, leave alone".
  function toggleTargetEnv(name: string, checked: boolean) {
    setTargetEnvs((prev) => ({ ...prev, [name]: checked }));
    setRows((prev) =>
      prev.map((row) => {
        const cell = row.cells[name];
        if (!cell) return row;
        return {
          ...row,
          cells: {
            ...row.cells,
            [name]: { ...cell, checked: checked && defaultCheckedFor(cell.status) },
          },
        };
      }),
    );
  }

  // ------ Preview-level helpers --------------------------------------------

  function setCellChecked(key: string, envName: string, checked: boolean) {
    setRows((prev) =>
      prev.map((row) => {
        if (row.key !== key) return row;
        const cell = row.cells[envName];
        if (!cell) return row;
        return { ...row, cells: { ...row.cells, [envName]: { ...cell, checked } } };
      }),
    );
  }

  function setRowValue(key: string, newValue: string) {
    setRows((prev) =>
      prev.map((row) => {
        if (row.key !== key) return row;
        // Recompute cell statuses against the edited value.
        const cells: PreviewRow['cells'] = {};
        for (const env of environments) {
          const prevCell = row.cells[env.name]!;
          const nextStatus = classifyCell(newValue, prevCell.currentValue);
          // Preserve the user's explicit checked choice; just update status so
          // the badge colour reflects reality.
          cells[env.name] = { ...prevCell, status: nextStatus };
        }
        return { ...row, newValue, cells };
      }),
    );
  }

  function toggleColumn(envName: string, checked: boolean) {
    setRows((prev) =>
      prev.map((row) => {
        const cell = row.cells[envName];
        if (!cell) return row;
        // Don't auto-check `same` cells on "select all" — they're no-ops and
        // would cost an unnecessary PATCH round-trip.
        if (checked && cell.status === 'same') return row;
        return { ...row, cells: { ...row.cells, [envName]: { ...cell, checked } } };
      }),
    );
  }

  function toggleRow(key: string, checked: boolean) {
    setRows((prev) =>
      prev.map((row) => {
        if (row.key !== key) return row;
        const cells: PreviewRow['cells'] = {};
        for (const env of environments) {
          const cell = row.cells[env.name]!;
          if (checked && cell.status === 'same') {
            cells[env.name] = cell;
            continue;
          }
          // Only operate on target envs — row checkbox shouldn't forcibly
          // enable writes to envs the user deselected at the top.
          if (!targetEnvs[env.name]) {
            cells[env.name] = cell;
            continue;
          }
          cells[env.name] = { ...cell, checked };
        }
        return { ...row, cells };
      }),
    );
  }

  // ------ Apply ------------------------------------------------------------

  const summary = useMemo(() => {
    let writes = 0;
    const envsTouched = new Set<string>();
    for (const row of rows) {
      for (const env of environments) {
        if (row.cells[env.name]?.checked) {
          writes++;
          envsTouched.add(env.name);
        }
      }
    }
    return { writes, envs: envsTouched.size };
  }, [rows, environments]);

  const mutation = useMutation({
    mutationFn: async () => {
      // Group updates per env — one PATCH per env with all its checked keys
      // is both correct and bundle-efficient (the backend already fans one
      // request out into parallel describe+patch calls in cloud-run.ts).
      const perEnv: Record<string, Record<string, string>> = {};
      for (const row of rows) {
        for (const env of environments) {
          if (row.cells[env.name]?.checked) {
            if (!perEnv[env.name]) perEnv[env.name] = {};
            perEnv[env.name]![row.key] = row.newValue;
          }
        }
      }

      const results: Record<string, { ok: boolean; error?: string }> = {};
      await Promise.all(
        Object.entries(perEnv).map(async ([envName, updates]) => {
          try {
            const res = await patchEnvs(projectId, service, {
              environments: [envName],
              updates,
            });
            Object.assign(results, res.status);

            // Optimistic cache update so the matrix reflects the new values
            // without waiting for the next refetch.
            const cached = qc.getQueryData<EnvsResponse>(['envs', projectId, service]);
            if (cached) {
              const nextEnvs = { ...cached.envs };
              if (res.status[envName]?.ok) {
                nextEnvs[envName] = { ...(nextEnvs[envName] ?? {}), ...updates };
              }
              qc.setQueryData<EnvsResponse>(['envs', projectId, service], {
                ...cached,
                envs: nextEnvs,
              });
            }
          } catch (err) {
            results[envName] = { ok: false, error: String(err) };
          }
        }),
      );
      return results;
    },
    onSuccess: (results) => {
      const failures = Object.entries(results).filter(([, s]) => !s.ok);
      if (failures.length === 0) {
        toast.success(`Imported ${summary.writes} variable${summary.writes === 1 ? '' : 's'} across ${summary.envs} env${summary.envs === 1 ? '' : 's'}`);
        onClose();
      } else {
        const msg = `Import: ${failures.length} env${failures.length === 1 ? '' : 's'} failed — ${failures.map(([n, s]) => `${n}: ${s.error}`).join('; ')}`;
        toast.error(msg, { duration: Infinity, closeButton: true });
        setErrorMsg(msg);
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

  // ------ Render -----------------------------------------------------------

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-2 md:p-6"
      onClick={() => { if (!pending) onClose(); }}
    >
      <div
        className="bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 rounded-lg shadow-xl w-full max-w-5xl max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-4 py-3 border-b dark:border-slate-700 flex items-center justify-between gap-2 shrink-0">
          <h2 className="text-lg font-bold">
            {step === 'input' ? 'Import .env' : `Import preview — ${rows.length} key${rows.length === 1 ? '' : 's'}`}
          </h2>
          <button
            onClick={onClose}
            disabled={pending}
            className="text-slate-500 hover:text-slate-900 dark:hover:text-slate-100 text-xl leading-none disabled:opacity-50"
            title="Close (Esc)"
          >
            ✕
          </button>
        </header>

        {step === 'input' ? (
          <InputStep
            value={inputText}
            onChange={setInputText}
            parsedKeyCount={parsedKeyCount}
          />
        ) : (
          <PreviewStep
            rows={rows}
            environments={environments}
            targetEnvs={targetEnvs}
            onToggleTargetEnv={toggleTargetEnv}
            onCellChecked={setCellChecked}
            onRowValue={setRowValue}
            onToggleColumn={toggleColumn}
            onToggleRow={toggleRow}
          />
        )}

        {errorMsg && (
          <div className="mx-4 mb-2 p-2 rounded bg-red-50 dark:bg-red-950 border border-red-300 dark:border-red-900 text-red-800 dark:text-red-200 text-xs font-mono whitespace-pre-wrap">
            {errorMsg}
          </div>
        )}

        <footer className="px-4 py-3 border-t dark:border-slate-700 flex items-center justify-between gap-2 shrink-0">
          <span className="text-xs text-slate-500 dark:text-slate-400">
            {step === 'input'
              ? `${parsedKeyCount} key${parsedKeyCount === 1 ? '' : 's'} parsed`
              : `${summary.writes} write${summary.writes === 1 ? '' : 's'} across ${summary.envs} env${summary.envs === 1 ? '' : 's'}`}
          </span>
          <span className="flex items-center gap-2">
            {step === 'preview' && (
              <button
                onClick={() => setStep('input')}
                disabled={pending}
                className="px-3 py-1 rounded bg-slate-200 dark:bg-slate-700 dark:text-slate-100 text-sm disabled:opacity-50"
              >
                ← Back
              </button>
            )}
            <button
              onClick={onClose}
              disabled={pending}
              className="px-3 py-1 rounded bg-slate-200 dark:bg-slate-700 dark:text-slate-100 text-sm disabled:opacity-50"
            >
              {errorMsg ? 'Close' : 'Cancel'}
            </button>
            {step === 'input' ? (
              <button
                onClick={goPreview}
                disabled={parsedKeyCount === 0}
                className="px-3 py-1 rounded bg-blue-100 text-blue-700 ring-1 ring-blue-300 text-sm font-semibold hover:bg-blue-200 dark:bg-blue-800 dark:text-blue-100 dark:ring-0 dark:hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Preview →
              </button>
            ) : (
              <button
                onClick={() => { setErrorMsg(null); mutation.mutate(); }}
                disabled={pending || summary.writes === 0}
                className="px-3 py-1 rounded bg-blue-100 text-blue-700 ring-1 ring-blue-300 text-sm font-semibold hover:bg-blue-200 dark:bg-blue-800 dark:text-blue-100 dark:ring-0 dark:hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {pending ? 'Applying…' : errorMsg ? 'Retry' : `Apply ${summary.writes}`}
              </button>
            )}
          </span>
        </footer>
      </div>
    </div>
  );
}

// ----------------------------- Sub-components -----------------------------

function InputStep({
  value,
  onChange,
  parsedKeyCount,
}: {
  value: string;
  onChange: (v: string) => void;
  parsedKeyCount: number;
}) {
  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    file.text().then((text) => onChange(text));
  }

  return (
    <div className="p-4 flex flex-col gap-3 overflow-auto">
      <p className="text-sm text-slate-600 dark:text-slate-300">
        Paste the contents of a <code className="font-mono bg-slate-100 dark:bg-slate-800 px-1 rounded">.env</code> file,
        or pick one from disk. Lines like <code className="font-mono">KEY=value</code> or{' '}
        <code className="font-mono">KEY="value with spaces"</code> are parsed. Comments (<code>#</code>) and blanks are ignored.
      </p>

      <label className="flex items-center gap-2 text-sm">
        <span>File:</span>
        <input
          type="file"
          accept=".env,text/plain"
          onChange={onFileChange}
          className="text-xs"
        />
      </label>

      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={'# Paste KEY=value lines here\nAPI_URL=https://api.example.com\nLOG_LEVEL=info'}
        className="flex-1 min-h-[240px] w-full px-3 py-2 font-mono text-sm rounded border bg-white dark:bg-slate-800 dark:border-slate-700 dark:text-slate-100"
      />

      <p className="text-xs text-slate-500 dark:text-slate-400">
        {parsedKeyCount === 0
          ? 'Nothing parsed yet.'
          : `Parsed ${parsedKeyCount} key${parsedKeyCount === 1 ? '' : 's'}.`}
      </p>
    </div>
  );
}

function PreviewStep({
  rows,
  environments,
  targetEnvs,
  onToggleTargetEnv,
  onCellChecked,
  onRowValue,
  onToggleColumn,
  onToggleRow,
}: {
  rows: PreviewRow[];
  environments: EnvironmentConfig[];
  targetEnvs: Record<string, boolean>;
  onToggleTargetEnv: (name: string, checked: boolean) => void;
  onCellChecked: (key: string, envName: string, checked: boolean) => void;
  onRowValue: (key: string, value: string) => void;
  onToggleColumn: (envName: string, checked: boolean) => void;
  onToggleRow: (key: string, checked: boolean) => void;
}) {
  return (
    <div className="flex flex-col min-h-0 flex-1">
      <div className="px-4 py-2 border-b dark:border-slate-700 flex items-center gap-2 flex-wrap text-sm shrink-0">
        <span className="text-slate-500 dark:text-slate-400">Apply to:</span>
        {environments.map((env) => (
          <label key={env.name} className="flex items-center gap-1 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={!!targetEnvs[env.name]}
              onChange={(e) => onToggleTargetEnv(env.name, e.target.checked)}
            />
            <span>{env.emoji} {env.name}</span>
          </label>
        ))}
      </div>

      <div className="overflow-auto flex-1">
        <table className="w-full text-sm border-collapse">
          <thead className="sticky top-0 bg-slate-100 dark:bg-slate-800 text-xs uppercase tracking-wider">
            <tr>
              <th className="text-left px-2 py-2 w-8 sticky left-0 bg-slate-100 dark:bg-slate-800 z-10">
                <span className="sr-only">row</span>
              </th>
              <th className="text-left px-2 py-2 w-44 max-w-[11rem] sticky left-8 bg-slate-100 dark:bg-slate-800 z-10">KEY</th>
              <th className="text-left px-2 py-2 w-40 min-w-[10rem]">New value</th>
              {environments.map((env) => {
                const colRows = rows.filter((r) => !!targetEnvs[env.name] && r.cells[env.name]?.status !== 'same');
                const allChecked = colRows.length > 0 && colRows.every((r) => r.cells[env.name]!.checked);
                const someChecked = colRows.some((r) => r.cells[env.name]!.checked);
                return (
                  <th key={env.name} className={`text-left px-2 py-2 w-32 min-w-[7.5rem] ${!targetEnvs[env.name] ? 'opacity-40' : ''}`}>
                    <label className="flex items-center gap-1 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        disabled={!targetEnvs[env.name] || colRows.length === 0}
                        checked={allChecked}
                        ref={(el) => {
                          if (el) el.indeterminate = !allChecked && someChecked;
                        }}
                        onChange={(e) => onToggleColumn(env.name, e.target.checked)}
                      />
                      <span>{env.emoji} {env.name}</span>
                    </label>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const rowCheckable = environments.filter(
                (env) => targetEnvs[env.name] && row.cells[env.name]?.status !== 'same',
              );
              const rowAll = rowCheckable.length > 0 && rowCheckable.every((env) => row.cells[env.name]!.checked);
              const rowSome = rowCheckable.some((env) => row.cells[env.name]!.checked);
              return (
                <tr key={row.key} className="border-t dark:border-slate-800">
                  <td className="px-2 py-1 w-8 sticky left-0 bg-white dark:bg-slate-900 z-10">
                    <input
                      type="checkbox"
                      disabled={rowCheckable.length === 0}
                      checked={rowAll}
                      ref={(el) => {
                        if (el) el.indeterminate = !rowAll && rowSome;
                      }}
                      onChange={(e) => onToggleRow(row.key, e.target.checked)}
                      title="Toggle this key across selected envs"
                    />
                  </td>
                  <td
                    className="px-2 py-1 w-44 max-w-[11rem] sticky left-8 bg-white dark:bg-slate-900 z-10 font-mono text-xs truncate"
                    title={row.key}
                  >
                    {row.key}
                  </td>
                  <td className="px-2 py-1">
                    <input
                      value={row.newValue}
                      onChange={(e) => onRowValue(row.key, e.target.value)}
                      className="w-full px-2 py-1 border rounded font-mono text-xs bg-white dark:bg-slate-800 dark:border-slate-700"
                    />
                  </td>
                  {environments.map((env) => (
                    <ImportCell
                      key={env.name}
                      envActive={!!targetEnvs[env.name]}
                      cell={row.cells[env.name]!}
                      onChange={(checked) => onCellChecked(row.key, env.name, checked)}
                    />
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ImportCell({
  envActive,
  cell,
  onChange,
}: {
  envActive: boolean;
  cell: { status: CellStatus; currentValue: string | undefined; checked: boolean };
  onChange: (checked: boolean) => void;
}) {
  const disabled = !envActive || cell.status === 'same';
  const bg =
    !envActive ? 'bg-slate-50 dark:bg-slate-900 opacity-40'
    : cell.status === 'new' ? 'bg-emerald-50 dark:bg-emerald-950'
    : cell.status === 'override' ? 'bg-amber-50 dark:bg-amber-950'
    : 'bg-slate-50 dark:bg-slate-900 opacity-60';

  const label =
    cell.status === 'new' ? '+ new'
    : cell.status === 'override' ? '~ override'
    : '= same';

  return (
    <td className={`px-2 py-1 font-mono text-[11px] ${bg}`}>
      <label className={`flex items-center gap-1 ${disabled ? 'cursor-default' : 'cursor-pointer'}`}>
        <input
          type="checkbox"
          disabled={disabled}
          checked={cell.checked}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span className="shrink-0 text-slate-600 dark:text-slate-400">{label}</span>
      </label>
      {cell.status === 'override' && cell.currentValue !== undefined && (
        <div className="mt-0.5 text-[10px] text-slate-500 dark:text-slate-400 truncate" title={cell.currentValue}>
          <span className="line-through">{cell.currentValue}</span>
        </div>
      )}
    </td>
  );
}
