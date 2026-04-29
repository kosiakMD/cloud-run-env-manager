import { useEffect, useState } from 'react';
import type { ProjectConfig } from '../shared/config.js';

/**
 * Local groups extend `ProjectConfig` with `_baseId` — the routing id of
 * the GCP project they were created from. We need it because the backend
 * only recognises the static config's project ids; to fetch/patch envs
 * for a local group we re-route the request to its base id with
 * `?agnostic=1` so the server synthesises a matching project.
 */
export interface LocalProjectConfig extends ProjectConfig {
  _baseId: string;
}

/**
 * User-defined groups stored in localStorage as full `ProjectConfig`
 * entries. Layered on top of the static / health-supplied projects so
 * a developer can tag raw Cloud Run services into env+service groups
 * without touching the shared TS config.
 *
 * Schema is identical to `ProjectConfig` so the matrix and modals
 * consume them through the same code path.
 */
const KEY = 'cloudRunEnv.localGroups.v1';

export function readLocalGroups(): LocalProjectConfig[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function writeLocalGroups(groups: LocalProjectConfig[]): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(KEY, JSON.stringify(groups));
  // Notify other components / hooks in the same tab.
  window.dispatchEvent(new CustomEvent('cloudRunEnv:localGroupsChanged'));
}

export function addLocalGroup(group: LocalProjectConfig): void {
  const all = readLocalGroups();
  // Replace by id if already present so re-saving same id updates instead
  // of duplicating.
  const idx = all.findIndex((g) => g.id === group.id);
  if (idx >= 0) all[idx] = group;
  else all.push(group);
  writeLocalGroups(all);
}

export function removeLocalGroup(id: string): void {
  writeLocalGroups(readLocalGroups().filter((g) => g.id !== id));
}

/**
 * Reactive snapshot of local groups. Re-reads on the custom event
 * dispatched by `addLocalGroup` / `removeLocalGroup` and on cross-tab
 * `storage` events so chips/selectors update without a page reload.
 */
/**
 * Repoint stale `_baseId` values onto the currently visible synth ids.
 * After multi-region discovery shipped, base ids changed shape from
 * routing keys like `dev` to `<projectId>:<region>` like
 * `my-gcp-project:us-west1`. Old saved groups still reference the old
 * id, so their fetches hit "unknown project" 404s. We migrate by GCP
 * projectId — the one stable thing across schema changes.
 */
export function migrateBaseIds(
  currentProjects: Array<{ id: string; projectId: string }>,
): boolean {
  const groups = readLocalGroups();
  if (groups.length === 0) return false;
  let changed = false;
  const out = groups.map((g) => {
    if (currentProjects.some((p) => p.id === g._baseId)) return g;
    const match = currentProjects.find((p) => p.projectId === g.projectId);
    if (!match) return g;
    changed = true;
    return { ...g, _baseId: match.id };
  });
  if (changed) writeLocalGroups(out);
  return changed;
}

export function useLocalGroups(): LocalProjectConfig[] {
  const [groups, setGroups] = useState<LocalProjectConfig[]>(() => readLocalGroups());
  useEffect(() => {
    const onChange = () => setGroups(readLocalGroups());
    window.addEventListener('cloudRunEnv:localGroupsChanged', onChange);
    window.addEventListener('storage', onChange);
    return () => {
      window.removeEventListener('cloudRunEnv:localGroupsChanged', onChange);
      window.removeEventListener('storage', onChange);
    };
  }, []);
  return groups;
}
