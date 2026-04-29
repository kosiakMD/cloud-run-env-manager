import {
  serviceName,
  type EnvironmentConfig,
  type ProjectConfig,
  type ServiceConfig,
} from '../../shared/config.js';

export type EnvMap = Record<string, string>;

/**
 * Cloud Run Admin API v2 client.
 *
 * https://cloud.google.com/run/docs/reference/rest/v2/projects.locations.services
 *
 * Both LocalAuth (gcloud print-access-token) and OAuthAuth (user cookie)
 * resolve to a Bearer access_token we use here.
 */

const BASE = 'https://run.googleapis.com/v2';

interface V2Env {
  name: string;
  value?: string;
  valueSource?: unknown; // secretKeyRef — we preserve but skip from env map
}

interface V2Container {
  image?: string;
  env?: V2Env[];
  [k: string]: unknown;
}

interface V2Template {
  containers?: V2Container[];
  [k: string]: unknown;
}

export interface V2Service {
  name?: string;
  template?: V2Template;
  [k: string]: unknown;
}

export interface ApiOutcome<T> {
  ok: true;
  data: T;
}

export interface ApiFailure {
  ok: false;
  error: string;
  status?: number;
}

export type ApiResult<T> = ApiOutcome<T> | ApiFailure;

function resourceUrl(project: ProjectConfig, env: EnvironmentConfig, service: ServiceConfig): string {
  const name = serviceName(env, service);
  return `${BASE}/projects/${project.projectId}/locations/${project.region}/services/${name}`;
}

async function apiCall<T>(
  url: string,
  init: RequestInit,
  accessToken: string,
): Promise<ApiResult<T>> {
  const started = Date.now();
  const method = init.method ?? 'GET';
  try {
    const res = await fetch(url, {
      ...init,
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...(init.headers ?? {}),
      },
    });
    const ms = Date.now() - started;
    if (!res.ok) {
      const body = await res.text();
      process.stdout.write(`[run] ← ${method} ${url.replace(BASE, '')}   fail ${ms}ms   ${res.status}\n`);
      return { ok: false, error: `Cloud Run API ${res.status}: ${body}`, status: res.status };
    }
    process.stdout.write(`[run] ← ${method} ${url.replace(BASE, '')}   ok   ${ms}ms\n`);
    const data = (await res.json()) as T;
    return { ok: true, data };
  } catch (err) {
    const ms = Date.now() - started;
    process.stdout.write(`[run] ← ${method} ${url.replace(BASE, '')}   exc  ${ms}ms   ${String(err)}\n`);
    return { ok: false, error: String(err) };
  }
}

export async function describeService(
  project: ProjectConfig,
  env: EnvironmentConfig,
  service: ServiceConfig,
  accessToken: string,
): Promise<ApiResult<V2Service>> {
  return apiCall<V2Service>(resourceUrl(project, env, service), { method: 'GET' }, accessToken);
}

/**
 * Describe a Cloud Run service by its raw final name (e.g. "svc-web"
 * or "lt-service-api-queue"). Used by the agnostic comparison view, where the
 * user picks any combination of services regardless of grouping rules.
 */
export async function describeServiceByName(
  project: ProjectConfig,
  fullServiceName: string,
  accessToken: string,
): Promise<ApiResult<V2Service>> {
  const url = `${BASE}/projects/${project.projectId}/locations/${project.region}/services/${fullServiceName}`;
  return apiCall<V2Service>(url, { method: 'GET' }, accessToken);
}

export async function describeServiceEnvsByName(
  project: ProjectConfig,
  fullServiceName: string,
  accessToken: string,
): Promise<ApiResult<EnvMap>> {
  const r = await describeServiceByName(project, fullServiceName, accessToken);
  if (!r.ok) return r;
  return { ok: true, data: parseEnvsFromV2(r.data) };
}

/**
 * List every GCP project the caller can see via Cloud Resource Manager.
 * Used by the agnostic view to discover projects beyond the static
 * `config.projects` set — answers "show me everything I have access to,
 * not just what someone hard-coded".
 *
 * Returns active projects only (filters out DELETE_REQUESTED etc.). Up to
 * the first 200 — enough for a personal dev/prod split, more would
 * indicate something to scope manually.
 */
interface CrmProject {
  projectId?: string;
  name?: string;
  lifecycleState?: string;
}
interface CrmListResponse {
  projects?: CrmProject[];
  nextPageToken?: string;
}
export async function listAccessibleProjects(
  accessToken: string,
): Promise<ApiResult<{ projectId: string; name: string }[]>> {
  const out: { projectId: string; name: string }[] = [];
  let pageToken: string | undefined;
  let page = 0;
  do {
    const url = `https://cloudresourcemanager.googleapis.com/v1/projects${pageToken ? `?pageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const res = await apiCall<CrmListResponse>(url, { method: 'GET' }, accessToken);
    if (!res.ok) return res;
    for (const p of res.data.projects ?? []) {
      if (!p.projectId) continue;
      if (p.lifecycleState && p.lifecycleState !== 'ACTIVE') continue;
      out.push({ projectId: p.projectId, name: p.name ?? p.projectId });
    }
    pageToken = res.data.nextPageToken;
    if (++page > 4) break; // 4 pages × 50 default = 200, sanity cap
  } while (pageToken);
  return { ok: true, data: out };
}

/**
 * List Cloud Run services across every region in a GCP project. Cloud
 * Run's v2 API supports `locations/-` as a wildcard, so a single call
 * returns services from all regions the caller has access to. Returns
 * `[fullName, region]` pairs because consumers need region to build
 * subsequent URLs.
 */
interface V2WildcardListResponse {
  services?: Array<{ name?: string; [k: string]: unknown }>;
  nextPageToken?: string;
}
export async function listProjectServicesAllRegions(
  projectId: string,
  accessToken: string,
): Promise<ApiResult<Array<{ name: string; region: string }>>> {
  const base = `${BASE}/projects/${projectId}/locations/-/services`;
  const out: Array<{ name: string; region: string }> = [];
  let pageToken: string | undefined;
  let page = 0;
  do {
    const url = pageToken ? `${base}?pageToken=${encodeURIComponent(pageToken)}` : base;
    const res = await apiCall<V2WildcardListResponse>(url, { method: 'GET' }, accessToken);
    if (!res.ok) return res;
    for (const svc of res.data.services ?? []) {
      if (typeof svc.name !== 'string') continue;
      // svc.name = "projects/{p}/locations/{region}/services/{name}"
      const parts = svc.name.split('/');
      const region = parts[3];
      const short = parts[parts.length - 1];
      if (region && short) out.push({ name: short, region });
    }
    pageToken = res.data.nextPageToken;
    if (++page > 20) break;
  } while (pageToken);
  out.sort((a, b) => a.name.localeCompare(b.name));
  return { ok: true, data: out };
}

interface V2ServicesListResponse {
  services?: Array<{
    name?: string;        // full path: projects/{p}/locations/{r}/services/{name}
    [k: string]: unknown;
  }>;
  nextPageToken?: string;
}

/**
 * List every Cloud Run service in the given project + region. Used by the
 * "agnostic" view that ignores the user's static config and just shows
 * whatever GCP actually has — useful as a sanity check that config covers
 * everything (or as a starter view before any config exists).
 *
 * Pages through the API automatically; in practice we have <50 services so
 * it's typically one request.
 */
export async function listServices(
  project: ProjectConfig,
  accessToken: string,
): Promise<ApiResult<string[]>> {
  const base = `${BASE}/projects/${project.projectId}/locations/${project.region}/services`;
  const names: string[] = [];
  let pageToken: string | undefined;
  let page = 0;
  do {
    const url = pageToken ? `${base}?pageToken=${encodeURIComponent(pageToken)}` : base;
    const res = await apiCall<V2ServicesListResponse>(url, { method: 'GET' }, accessToken);
    if (!res.ok) return res;
    for (const svc of res.data.services ?? []) {
      // svc.name is `projects/.../services/{shortName}` — keep the short name only.
      if (typeof svc.name === 'string') {
        const short = svc.name.split('/').pop();
        if (short) names.push(short);
      }
    }
    pageToken = res.data.nextPageToken;
    if (++page > 20) break; // sanity stop
  } while (pageToken);
  names.sort();
  return { ok: true, data: names };
}

interface TestIamResponse {
  permissions?: string[];
}

/**
 * Ask Cloud Run whether the current caller is allowed to update env vars on
 * a specific service. Used by `/api/health` to decide whether to render
 * write-affordances in the UI — `run.services.update` is the permission
 * PATCH to a Service requires.
 *
 * This is a UX optimisation, not a security boundary: even if the probe
 * says "yes", GCP still enforces the real IAM check on the actual PATCH.
 * So on network errors / 5xx we optimistically say `canWrite: true` and
 * let the real PATCH surface the 403 if it comes to that.
 */
export async function testWritePermission(
  project: ProjectConfig,
  env: EnvironmentConfig,
  service: ServiceConfig,
  accessToken: string,
): Promise<boolean> {
  const url = `${resourceUrl(project, env, service)}:testIamPermissions`;
  const r = await apiCall<TestIamResponse>(
    url,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ permissions: ['run.services.update'] }),
    },
    accessToken,
  );
  if (!r.ok) {
    // 403/404 from IAM probe → caller lacks visibility on this service;
    // treat as read-only for the purposes of enabling write UI.
    // Any other failure (network, 5xx) → optimistic true; the real PATCH
    // will be the backstop.
    if (r.status === 403 || r.status === 404) return false;
    return true;
  }
  return Array.isArray(r.data.permissions) && r.data.permissions.includes('run.services.update');
}

export function parseEnvsFromV2(service: V2Service): EnvMap {
  const env = service.template?.containers?.[0]?.env ?? [];
  const out: EnvMap = {};
  for (const e of env) {
    if (e.valueSource !== undefined) continue;
    if (typeof e.value === 'string') out[e.name] = e.value;
  }
  return out;
}

/**
 * Produce a new env list from the current v2 Service with updates merged and
 * deletes removed. Secret-ref entries (valueSource) are preserved verbatim so
 * we don't wipe them on an unrelated update.
 */
export function mergeEnv(
  service: V2Service,
  updates: Record<string, string>,
  deletes: string[],
): V2Env[] {
  const existing = service.template?.containers?.[0]?.env ?? [];
  const deleteSet = new Set(deletes);
  const merged: V2Env[] = [];
  const seen = new Set<string>();

  for (const e of existing) {
    if (deleteSet.has(e.name)) continue;
    if (e.valueSource !== undefined) {
      merged.push(e);
      seen.add(e.name);
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(updates, e.name)) {
      merged.push({ name: e.name, value: updates[e.name] });
    } else {
      merged.push({ name: e.name, value: e.value });
    }
    seen.add(e.name);
  }
  for (const [k, v] of Object.entries(updates)) {
    if (!seen.has(k)) merged.push({ name: k, value: v });
  }
  return merged;
}

export async function updateServiceEnvs(
  project: ProjectConfig,
  env: EnvironmentConfig,
  service: ServiceConfig,
  updates: Record<string, string>,
  accessToken: string,
  deletes: string[] = [],
): Promise<ApiResult<true>> {
  if (Object.keys(updates).length === 0 && deletes.length === 0) {
    return { ok: true, data: true };
  }

  // v2 PATCH with updateMask=template replaces the ENTIRE template, so we
  // must GET first to preserve everything else (image, resources, etc).
  const current = await describeService(project, env, service, accessToken);
  if (!current.ok) return current;

  const currentTemplate = current.data.template;
  const currentContainer = currentTemplate?.containers?.[0];
  if (!currentContainer) {
    return { ok: false, error: 'service has no containers — cannot update env' };
  }

  const newEnv = mergeEnv(current.data, updates, deletes);

  const newTemplate: V2Template = {
    ...currentTemplate,
    containers: [
      { ...currentContainer, env: newEnv },
      ...(currentTemplate?.containers?.slice(1) ?? []),
    ],
  };

  const patchUrl = `${resourceUrl(project, env, service)}?updateMask=template`;
  return apiCall<V2Service>(
    patchUrl,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ template: newTemplate }),
    },
    accessToken,
  ).then((r) => (r.ok ? { ok: true, data: true } : r));
}

export async function describeServiceEnvs(
  project: ProjectConfig,
  env: EnvironmentConfig,
  service: ServiceConfig,
  accessToken: string,
): Promise<ApiResult<EnvMap>> {
  const r = await describeService(project, env, service, accessToken);
  if (!r.ok) return r;
  return { ok: true, data: parseEnvsFromV2(r.data) };
}
