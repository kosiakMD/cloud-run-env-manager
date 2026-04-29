import { useQuery } from '@tanstack/react-query';
import { fetchHealth, isAgnostic, type ProjectInfo } from './api.js';
import { config } from '../shared/config.js';
import { useLocalGroups } from './local-groups.js';

/**
 * Source of truth for the project list on the client. Combines:
 *  1. `health.projects` (static config in normal mode, synthesized list
 *     in agnostic mode), and
 *  2. user-defined local groups from localStorage — additive, layered
 *     after server-supplied projects so existing ids win.
 *
 * The static config is a pre-hydration fallback used until /api/health
 * resolves, so the selector + matrix have something to draw on first
 * paint.
 */
export function useProjects(): ProjectInfo[] {
  const { data } = useQuery({
    queryKey: ['health'],
    queryFn: fetchHealth,
  });
  const local = useLocalGroups();

  // Pre-hydration fallback uses the static config so the matrix has
  // something to draw before /api/health resolves. In agnostic mode the
  // static config is *wrong* — those are server-side defined groups, not
  // raw Cloud Run services — so we render nothing until the synthesized
  // list arrives instead of flashing configured projects.
  const base: ProjectInfo[] = data?.projects
    ?? (isAgnostic
      ? []
      : config.projects.map((p) => ({
          id: p.id,
          label: p.label,
          emoji: p.emoji,
          projectId: p.projectId,
          region: p.region,
          environments: p.environments,
          services: p.services,
        })));

  // Local groups appended at the end. If a local group reuses an
  // existing id, the server-supplied entry wins (no override).
  const baseIds = new Set(base.map((p) => p.id));
  const merged = [...base, ...local.filter((g) => !baseIds.has(g.id))];
  return merged;
}

export function useFindProject(projectId: string): ProjectInfo | undefined {
  const projects = useProjects();
  return projects.find((p) => p.id === projectId);
}
