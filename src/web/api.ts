import type { EnvironmentConfig, ServiceConfig, ServiceId } from '../shared/config.js';

export interface ProjectInfo {
  id: string;
  label: string;
  emoji?: string;
  projectId: string;
  region: string;
  environments: EnvironmentConfig[];
  services: ServiceConfig[];
}

export interface HealthResponse {
  ok: boolean;
  account?: string;
  /** UI title from config, defaults to "Env Manager". */
  title?: string;
  projects: ProjectInfo[];
  /**
   * Per-project IAM probe result. Empty when not signed in. Keyed by
   * `ProjectInfo.id`. Absence of an entry means the probe didn't run —
   * treat as unknown (the UI defaults unknown to read-only-safe).
   */
  permissions?: Record<string, { canWrite: boolean }>;
  hint?: string;
  /** Set when OAuth is available and user isn't signed in; URL to redirect to. */
  loginUrl?: string;
  /**
   * Method that satisfied the active session. `null` when not signed in.
   */
  via?: 'oauth' | 'local' | null;
  /**
   * Methods this server supports. Local Node typically has both; the
   * Cloudflare Worker has only `oauth`. Drives which sign-in affordances
   * the AuthBanner renders.
   */
  availableAuth?: ('oauth' | 'local')[];
}

export interface EnvsResponse {
  ok: boolean;
  envs: Record<string, Record<string, string>>;
  errors: Record<string, string>;
}

export interface PatchBody {
  environments: string[];
  updates?: Record<string, string>;
  deletes?: string[];
}

export interface PatchResponse {
  ok: boolean;
  status: Record<string, { ok: boolean; error?: string }>;
}

/**
 * Read once at module load — agnostic mode is set via `?agnostic=1` URL
 * param, applied to every API call so the server synthesizes a config
 * where each Cloud Run service is its own env (no friendly labels, no
 * groups). Toggle requires a page reload, which is fine for a side-by-side
 * mode flag.
 */
export const isAgnostic = typeof window !== 'undefined'
  && new URLSearchParams(window.location.search).get('agnostic') === '1';

function withAgnostic(url: string, extra?: Record<string, string>): string {
  const params = new URLSearchParams(extra ?? {});
  if (isAgnostic) params.set('agnostic', '1');
  const q = params.toString();
  return q ? `${url}${url.includes('?') ? '&' : '?'}${q}` : url;
}

export async function fetchHealth(): Promise<HealthResponse> {
  const r = await fetch(withAgnostic('/api/health'));
  return r.json();
}

/**
 * Local groups don't exist on the server — they're a per-browser overlay.
 * Re-route their requests to the base GCP project's routing id with
 * `?agnostic=1` so the server's synthesizer treats each picked Cloud
 * Run service name as its own env. The result has the same shape, the
 * matrix doesn't need to know about local groups at all.
 */
function resolveLocalRoute(projectId: string): { id: string; agnostic: boolean } | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem('cloudRunEnv.localGroups.v1');
    if (!raw) return null;
    const groups = JSON.parse(raw) as Array<{
      id: string;
      _baseId?: string;
      projectId?: string;
      region?: string;
    }>;
    const match = groups.find((g) => g.id === projectId);
    if (!match) return null;
    // The synth id format is `${gcpProjectId}:${region}`. Older saved
    // groups carry only a routing key like `dev` in `_baseId` — derive
    // the modern synth id from the group's `projectId` + `region` so
    // the request hits a project the synthesizer actually returned.
    const baseId =
      match._baseId && match._baseId.includes(':')
        ? match._baseId
        : match.projectId && match.region
          ? `${match.projectId}:${match.region}`
          : match._baseId;
    if (!baseId) return null;
    return { id: baseId, agnostic: true };
  } catch {
    return null;
  }
}

function buildEnvsUrl(
  projectId: string,
  service: ServiceId,
  envs?: string[],
): string {
  const local = resolveLocalRoute(projectId);
  const routedId = local?.id ?? projectId;
  const routedService = local ? '_' : service;
  const extra: Record<string, string> = {};
  if (envs && envs.length > 0) extra.envs = envs.join(',');
  if (local?.agnostic) extra.agnostic = '1';
  const params = new URLSearchParams(extra);
  // Only fall through to global isAgnostic when the request itself
  // didn't already force agnostic via local-group routing.
  if (isAgnostic && !local?.agnostic) params.set('agnostic', '1');
  const q = params.toString();
  const base = `/api/projects/${routedId}/services/${routedService}/envs`;
  return q ? `${base}?${q}` : base;
}

export async function fetchEnvs(
  projectId: string,
  service: ServiceId,
  /**
   * Optional list of env names to fetch. Server returns only matching
   * envs — important for local groups where the base project may have
   * many services but only a subset is in the group.
   */
  envs?: string[],
): Promise<EnvsResponse> {
  const r = await fetch(buildEnvsUrl(projectId, service, envs));
  return r.json();
}

export async function patchEnvs(
  projectId: string,
  service: ServiceId,
  body: PatchBody,
): Promise<PatchResponse> {
  const r = await fetch(buildEnvsUrl(projectId, service), {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
}

export interface AgnosticProject {
  /** Routing key matching config.projects[i].id, used by the compare endpoint. */
  id: string;
  /** GCP project ID — the only project label the agnostic view shows. */
  projectId: string;
  region: string;
  /** Raw Cloud Run service short-names, sorted. */
  services: string[];
  /** Set when the list call failed for this project (e.g. permission error). */
  error?: string;
}

export interface AgnosticResponse {
  ok: boolean;
  projects: AgnosticProject[];
}

export async function fetchAgnosticProjects(): Promise<AgnosticResponse> {
  const r = await fetch('/api/agnostic-projects');
  return r.json();
}

export interface AgnosticServiceEnvs {
  /** Routing key (config.projects[i].id), needed to round-trip back to backend. */
  projectId: string;
  /** Raw Cloud Run service name. */
  name: string;
  envs?: Record<string, string>;
  error?: string;
}

export interface AgnosticEnvsResponse {
  ok: boolean;
  services: AgnosticServiceEnvs[];
}

export async function fetchAgnosticEnvs(
  services: Array<{ projectId: string; name: string }>,
): Promise<AgnosticEnvsResponse> {
  const r = await fetch('/api/agnostic/envs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ services }),
  });
  return r.json();
}
