import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AuthBanner } from './components/AuthBanner.js';
import { ServiceTabs } from './components/ServiceTabs.js';
import { EnvMatrix } from './components/EnvMatrix.js';
import { ThemeToggle } from './components/ThemeToggle.js';
import { LocalGroupModal } from './components/LocalGroupModal.js';
import { fetchHealth, isAgnostic } from './api.js';
import { useProjects, useFindProject } from './use-projects.js';
import { useLocalGroups, removeLocalGroup, migrateBaseIds } from './local-groups.js';
import { config, type ServiceId } from '../shared/config.js';

export function App() {
  // Project list now comes from health (so it reflects agnostic mode's
  // synthesized projects when `?agnostic=1`). The static config is just a
  // pre-hydration fallback inside `useProjects`.
  const projects = useProjects();
  const [projectId, setProjectId] = useState<string>(
    () => projects[0]?.id ?? config.projects[0]!.id,
  );
  const project = useFindProject(projectId) ?? projects[0];
  const [service, setService] = useState<ServiceId>(
    () => project?.services[0]?.id ?? config.projects[0]!.services[0]!.id,
  );

  // When the project changes (or when health resolves and the fallback
  // gets replaced), make sure the selected service still exists on the
  // active project — agnostic projects only have a single `_` service,
  // configured projects have web/api/queue, and switching between them
  // would otherwise leave a stale id selected.
  useEffect(() => {
    if (!project) return;
    const exists = project.services.some((s) => s.id === service);
    if (!exists && project.services[0]) {
      setService(project.services[0].id);
    }
  }, [project, service]);

  // Initial `projectId` state seeds from the pre-hydration fallback
  // (static config). After /api/health resolves — especially in agnostic
  // mode, where synth ids look like `${gcpProjectId}:${region}` and have
  // nothing in common with the static config's routing keys — that
  // seeded id no longer matches anything in the project list. The
  // selector's trigger has its own fallback so it looks fine, but
  // `useFindProject(projectId)` returns undefined inside the matrix,
  // leaving an empty services row + stuck "Pick at least one service
  // above" prompt. Repoint to the first real project as soon as one
  // shows up.
  useEffect(() => {
    if (projects.length === 0) return;
    if (projects.some((p) => p.id === projectId)) return;
    setProjectId(projects[0]!.id);
  }, [projects, projectId]);

  const { data: health } = useQuery({
    queryKey: ['health'],
    queryFn: fetchHealth,
  });
  const canWrite = health?.permissions?.[projectId]?.canWrite ?? true;
  const title = health?.title ?? config.title ?? 'Env Manager';
  const [localGroupOpen, setLocalGroupOpen] = useState(false);
  const localGroups = useLocalGroups();

  // Migrate `_baseId` values on stored local groups whenever the project
  // list refreshes. The synth ids changed shape across versions
  // (`dev` → `my-gcp-project:us-west1`); without migration old groups
  // route to non-existent ids and the matrix fails to load.
  useEffect(() => {
    if (projects.length === 0) return;
    migrateBaseIds(projects.map((p) => ({ id: p.id, projectId: p.projectId })));
  }, [projects]);

  return (
    <div className="h-screen flex flex-col overflow-hidden bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100">
      <AuthBanner
        projectId={projectId}
        onProjectChange={setProjectId}
        canWrite={canWrite}
      />
      <div className="flex items-start lg:items-center justify-between px-3 md:px-4 pt-2 pb-1 shrink-0 gap-2 flex-wrap">
        <h1 className="text-base md:text-xl font-bold truncate">
          {title}{isAgnostic && <span className="ml-2 text-xs font-mono text-amber-600 dark:text-amber-400">🔍 agnostic</span>}
        </h1>
        {/* The right cluster grows with every local group chip. On a
            phone with even a couple of groups it would otherwise push
            ThemeToggle off-screen. `flex-wrap` lets the cluster spill
            onto a second line, the outer header is `items-start` on
            mobile so the title stays anchored top-left. */}
        <div className="flex items-center gap-1.5 flex-wrap justify-end min-w-0">
          <button
            onClick={() => setLocalGroupOpen(true)}
            disabled={!project}
            title="Add local group (saved in this browser only)"
            // Mobile 36px sits at the smaller end of usable tap targets
            // while not looking visually oversized next to the 28px
            // chips. Desktop stays at 28px.
            className="w-9 h-9 lg:w-7 lg:h-7 inline-flex items-center justify-center rounded text-lg lg:text-base leading-none font-bold bg-slate-100 hover:bg-slate-200 text-slate-600 disabled:opacity-40 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-200"
            aria-label="Add local group"
          >
            +
          </button>
          {localGroups.map((g) => {
            const active = g.id === projectId;
            // Resolve the synth id the toggle-off should land on. Older
            // groups store the legacy routing key in `_baseId` (e.g.
            // `dev`); reconstruct the modern `${projectId}:${region}`
            // shape from the group's own fields so toggle-off lands on
            // a project that actually exists in the current synth list.
            const resolvedBaseId =
              g._baseId && g._baseId.includes(':')
                ? g._baseId
                : `${g.projectId}:${g.region}`;
            return (
              <span key={g.id} className="inline-flex items-center">
                <button
                  onClick={() => {
                    if (active) setProjectId(resolvedBaseId);
                    else setProjectId(g.id);
                  }}
                  title={active ? `Click to leave ${g.label}` : `Switch to ${g.label} (${g.environments.length} svc)`}
                  className={`h-7 inline-flex items-center px-2 rounded-l text-xs font-medium leading-none ${
                    active
                      ? 'bg-emerald-200 text-emerald-900 dark:bg-emerald-800 dark:text-emerald-100'
                      : 'bg-slate-100 hover:bg-slate-200 text-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-200'
                  }`}
                >
                  {g.emoji ?? '💾'} {g.label}
                </button>
                <button
                  onClick={() => {
                    // If we're removing the active chip, fall back to the
                    // base project rather than leaving the matrix on a
                    // dangling id.
                    if (active) setProjectId(resolvedBaseId);
                    removeLocalGroup(g.id);
                  }}
                  title={`Remove ${g.label}`}
                  className="h-7 inline-flex items-center px-1.5 rounded-r text-xs leading-none bg-slate-100 hover:bg-red-100 hover:text-red-700 text-slate-400 dark:bg-slate-800 dark:hover:bg-red-900 dark:hover:text-red-200 border-l border-slate-200 dark:border-slate-700"
                >
                  ✕
                </button>
              </span>
            );
          })}
          {/* Hide the service-tab strip whenever the active project's
              service list is the synthetic `_` shape — that's true for
              agnostic-mode synthesised projects AND for local groups. A
              single placeholder tab adds visual noise without giving the
              user anything to choose. */}
          {project && !(project.services.length === 1 && project.services[0]!.id === '_') && (
            <ServiceTabs
              services={project.services}
              active={service}
              onChange={setService}
            />
          )}
          <span className="h-4 w-px bg-slate-300 dark:bg-slate-600 mx-1" aria-hidden />
          <ThemeToggle />
        </div>
      </div>
      <EnvMatrix projectId={projectId} service={service} canWrite={canWrite} />
      {localGroupOpen && project && (
        <LocalGroupModal
          // When the active project is itself a local group, its
          // environments list is already filtered to that group's
          // selection — useless for picking new ones. Resolve the
          // underlying base (non-local) project by GCP projectId so
          // the modal sees ALL services for that GCP project.
          project={
            projects.find(
              (p) => p.projectId === project.projectId && !localGroups.some((g) => g.id === p.id),
            ) ?? project
          }
          onClose={() => setLocalGroupOpen(false)}
        />
      )}
    </div>
  );
}
