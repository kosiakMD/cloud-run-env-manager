/**
 * App configuration. The only file most consumers need to edit:
 *
 *   - `projects` describes every GCP project the tool should expose.
 *   - Each project carries its own `services` (groups like web/api/queue)
 *     because real GCP projects don't share the same set — one project
 *     might have a queue service that another doesn't.
 *   - `environments` are the matrix columns inside a project. The final
 *     Cloud Run service name is built per cell as
 *     `${env.servicePrefix ?? `${env.name}-`}${service.suffix}` —
 *     covering both the prefixed shape (`{env}-service-web`) and the
 *     unprefixed `service-web` (when `servicePrefix` is `''`).
 *
 * Almost everything except `id` / `projectId` / `region` / `name` /
 * `suffix` has a sensible default, so a minimal config can be ~10 lines.
 */

/** Free-form service identifier. Use snake_case ids like `web`, `api`,
 *  `queue`, etc. — open string so per-project service shapes can vary. */
export type ServiceId = string;

export interface EnvironmentConfig {
  name: string;
  /** Optional emoji shown in column header. Defaults to none. */
  emoji?: string;
  /** Override the default `${name}-` prefix. Use `''` for no prefix. */
  servicePrefix?: string;
}

export interface ServiceConfig {
  id: ServiceId;
  /** Suffix combined with the environment's prefix, e.g. `service-web`. */
  suffix: string;
  /** Optional label shown on the service tab. Defaults to `id.toUpperCase()`. */
  label?: string;
  /** Optional emoji prepended to the label. Defaults to none. */
  emoji?: string;
}

export interface ProjectConfig {
  id: string;
  label: string;
  /** Optional emoji shown in the project selector trigger + dropdown. */
  emoji?: string;
  projectId: string;
  region: string;
  environments: EnvironmentConfig[];
  /** Per-project service groups — different projects can have different
   *  service shapes (e.g. one project has a queue, another doesn't). */
  services: ServiceConfig[];
}

export interface AppConfig {
  /** UI title shown in the header. Defaults to `"Env Manager"`. */
  title?: string;
  projects: ProjectConfig[];
}

/**
 * Example config — replace the contents below with your own GCP projects.
 * The placeholder `project-1` / `project-2` / `dev`, `staging`, `prod`
 * shape is just to show the schema; nothing here is wired to anything
 * real. See README for a walk-through of common patterns.
 */
export const config: AppConfig = {
  title: 'Env Manager',
  projects: [
    {
      id: 'project-1',
      label: 'Project 1',
      emoji: '🚀',
      projectId: 'my-gcp-project-id',
      region: 'us-west1',
      environments: [
        { name: 'dev',     emoji: '🛠️' },
        { name: 'staging', emoji: '🧪' },
        { name: 'prod',    emoji: '🚀' },
      ],
      services: [
        { id: 'web', label: 'WEB', emoji: '🌐', suffix: 'service-web' },
        { id: 'api', label: 'API', emoji: '⚙️', suffix: 'service-api' },
      ],
    },
    {
      id: 'project-2',
      label: 'Project 2',
      emoji: '🛡️',
      projectId: 'my-other-gcp-project',
      region: 'us-central1',
      environments: [
        { name: 'main', servicePrefix: '' },
        { name: 'lt',   emoji: '🧪', servicePrefix: 'lt-' },
      ],
      services: [
        { id: 'web',   label: 'WEB',   emoji: '🌐', suffix: 'service-web' },
        { id: 'api',   label: 'API',   emoji: '⚙️', suffix: 'service-api' },
        { id: 'queue', label: 'Queue', emoji: '📋', suffix: 'service-api-queue' },
      ],
    },
  ],
};

export function findProject(projectId: string): ProjectConfig | undefined {
  return config.projects.find((p) => p.id === projectId);
}

export function findService(project: ProjectConfig, serviceId: string): ServiceConfig | undefined {
  return project.services.find((s) => s.id === serviceId);
}

export function serviceLabel(s: ServiceConfig): string {
  // Default tab label = id uppercased ("api" → "API"). Emoji prepended if set.
  const label = s.label ?? s.id.toUpperCase();
  return s.emoji ? `${s.emoji} ${label}` : label;
}

export function serviceName(env: EnvironmentConfig, service: ServiceConfig): string {
  const prefix = env.servicePrefix ?? `${env.name}-`;
  return `${prefix}${service.suffix}`;
}
