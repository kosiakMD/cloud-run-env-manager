import { Hono } from 'hono';
import { config, type ProjectConfig } from '../shared/config.js';
import type { AuthConfigEnv, AuthProviders, AuthSession } from './auth/index.js';
import { availableMethods } from './auth/index.js';
import { describeServiceEnvs, describeServiceEnvsByName, listAccessibleProjects, listProjectServicesAllRegions, listServices, testWritePermission, updateServiceEnvs } from './gcloud/cloud-run.js';

/**
 * Cache of synthesized agnostic project configs, keyed by `accessToken +
 * projectId`. Listing all Cloud Run services in a project takes ~300ms
 * round-trip; without caching, the dashboard's matrix + selector + IAM
 * probe would each retrigger the same listing on every request. The
 * cache is keyed by access token so different signed-in users don't see
 * each other's view.
 */
const agnosticCache = new Map<string, { at: number; projects: ProjectConfig[] }>();
const AGNOSTIC_CACHE_TTL_MS = 30_000;

/**
 * Build a synthetic ProjectConfig for every GCP project + region the
 * caller can see. Steps:
 *  1. Cloud Resource Manager `projects.list` → all accessible projects.
 *  2. Cloud Run wildcard list (`locations/-`) per project → every
 *     service across every region in one call.
 *  3. Group services by region; each (projectId, region) becomes one
 *     ProjectConfig with raw service names as environments and a single
 *     `_` service group, so `serviceName(env, service)` resolves back
 *     to the Cloud Run name and existing endpoints keep working.
 *
 * The previous version iterated only `config.projects` — fine for
 * configured use but blind to anything outside the static config.
 */
async function synthesizeAgnosticProjects(accessToken: string): Promise<ProjectConfig[]> {
  const cacheKey = accessToken;
  const cached = agnosticCache.get(cacheKey);
  if (cached && Date.now() - cached.at < AGNOSTIC_CACHE_TTL_MS) {
    return cached.projects;
  }

  const projectsRes = await listAccessibleProjects(accessToken);
  if (!projectsRes.ok) {
    // If discovery fails (e.g. resourcemanager API not enabled), fall
    // back to the static config so the UI at least shows the known set.
    return config.projects.map((p) => ({
      id: p.id,
      label: p.projectId,
      projectId: p.projectId,
      region: p.region,
      environments: [],
      services: [{ id: '_', suffix: '' }],
    }));
  }

  // Per-project wildcard listing in parallel. Failures (no run.services.list
  // permission, API disabled, etc.) drop that project from the agnostic view
  // rather than failing the whole call.
  const perProject = await Promise.all(
    projectsRes.data.map(async (p) => {
      const r = await listProjectServicesAllRegions(p.projectId, accessToken);
      return { project: p, services: r.ok ? r.data : [] };
    }),
  );

  const out: ProjectConfig[] = [];
  for (const { project, services } of perProject) {
    if (services.length === 0) continue;
    // Bucket services by region — one ProjectConfig per (projectId, region).
    const byRegion = new Map<string, string[]>();
    for (const s of services) {
      const list = byRegion.get(s.region) ?? [];
      list.push(s.name);
      byRegion.set(s.region, list);
    }
    for (const [region, names] of byRegion) {
      // Routing id stays unique across (projectId, region). Use ":" as
      // a separator since neither GCP projectIds nor regions contain it.
      const id = `${project.projectId}:${region}`;
      out.push({
        id,
        label: project.projectId,
        projectId: project.projectId,
        region,
        environments: names.sort().map((name) => ({ name, servicePrefix: name })),
        services: [{ id: '_', suffix: '' }],
      });
    }
  }
  // Sort by env count descending so the busiest project lands first —
  // an alphabetical sort puts `<projectId>:us-central1` (often a stray
  // test service or two) ahead of `<projectId>:us-west1` (the real
  // workload), leaving the user staring at a near-empty matrix on
  // first load.
  out.sort((a, b) => b.environments.length - a.environments.length || a.id.localeCompare(b.id));

  agnosticCache.set(cacheKey, { at: Date.now(), projects: out });
  return out;
}

function isAgnosticReq(c: import('hono').Context): boolean {
  return c.req.query('agnostic') === '1';
}

function findInProjects(projects: ProjectConfig[], id: string): ProjectConfig | undefined {
  return projects.find((p) => p.id === id);
}

/**
 * Build the Hono app with one or more auth providers. The Node entry
 * passes both OAuth (when configured) AND LocalAuth, so a developer
 * running the tool on their machine can sign in either way. The Worker
 * entry passes only OAuth — `execa` / `child_process` aren't available
 * there, so LocalAuth is never imported into that bundle.
 *
 * Session resolution order: OAuth cookie first (if present), then gcloud
 * CLI. That way OAuth always wins when both are configured, but a fresh
 * browser without the cookie still falls back to the dev's gcloud login.
 */
export function createApp(env: AuthConfigEnv, providers: AuthProviders) {
  const app = new Hono();
  const oauth = providers.oauth;
  const local = providers.local;
  const methods = availableMethods(providers);

  /**
   * Resolve the project list for the current request — either the static
   * config or a synthesized agnostic version where each Cloud Run service
   * is its own env. Needs an access token because synthesizing requires
   * calling Cloud Run's list API.
   */
  async function getProjects(c: import('hono').Context, accessToken: string): Promise<ProjectConfig[]> {
    if (isAgnosticReq(c)) {
      return synthesizeAgnosticProjects(accessToken);
    }
    return config.projects;
  }

  // Request timing — skip /api/health because the client polls every 3s
  app.use('*', async (c, next) => {
    const started = Date.now();
    await next();
    const ms = Date.now() - started;
    const path = c.req.path;
    if (path !== '/api/health') {
      console.log(`[http] ${c.req.method.padEnd(5)} ${path}   ${c.res.status}   ${ms}ms`);
    }
  });

  async function resolveSession(c: import('hono').Context): Promise<AuthSession | null> {
    if (oauth) {
      const { session, setCookie } = await oauth.getSessionWithRotation(c.req.raw);
      if (setCookie) c.header('set-cookie', setCookie);
      if (session) return session;
    }
    if (local) {
      const session = await local.session(c.req.raw);
      if (session) return session;
    }
    return null;
  }

  /**
   * Aggregate auth status across providers. Returns the first method that
   * reports ok=true (priority: OAuth before Local), so when both are
   * available the UI shows the active session's account.
   */
  async function aggregateStatus(req: Request) {
    if (oauth) {
      const s = await oauth.status(req);
      if (s.ok) return { ...s, via: 'oauth' as const };
    }
    if (local) {
      const s = await local.status(req);
      if (s.ok) return { ...s, via: 'local' as const };
    }
    // Nobody is signed in — return whichever provider has the more useful
    // hint. OAuth's hint is the loginUrl callback; local's is "run gcloud
    // auth login". The UI rendering decides which to surface based on
    // `methods`.
    if (oauth) return { ...(await oauth.status(req)), via: null };
    if (local) return { ...(await local.status(req)), via: null };
    return { ok: false, hint: 'No auth providers configured.', via: null };
  }

  app.get('/api/health', async (c) => {
    const status = await aggregateStatus(c.req.raw);

    const permissions: Record<string, { canWrite: boolean }> = {};
    // Pre-auth: in agnostic mode return an empty list — the static config
    // is server-side authoritative groups, NOT raw Cloud Run services, so
    // exposing it here would mislead the agnostic UI. Configured mode
    // continues to return the static config so the UI can draw something
    // before the user signs in.
    let projects: ProjectConfig[] = isAgnosticReq(c) ? [] : config.projects;
    if (status.ok) {
      const session = await resolveSession(c);
      if (session) {
        // In agnostic mode `projects` is a synthesized list with raw
        // service names as environments. We always probe the first env ×
        // first service of each project; for static config that's
        // `first env × first service` and for agnostic that's the first raw service
        // (e.g. `admin-svc` × `_`). Either way `serviceName(env, service)`
        // resolves back to a real Cloud Run service for the IAM probe.
        projects = await getProjects(c, session.accessToken);
        await Promise.all(
          projects.map(async (p) => {
            const envCfg = p.environments[0];
            const service = p.services[0];
            if (!envCfg || !service) {
              permissions[p.id] = { canWrite: false };
              return;
            }
            const canWrite = await testWritePermission(p, envCfg, service, session.accessToken);
            permissions[p.id] = { canWrite };
          }),
        );
      }
    }

    return c.json({
      ok: status.ok,
      account: status.account,
      title: config.title ?? 'Env Manager',
      projects: projects.map((p) => ({
        id: p.id,
        label: p.label,
        // `emoji` is undefined on synthesized agnostic projects on purpose.
        emoji: (p as ProjectConfig).emoji,
        projectId: p.projectId,
        region: p.region,
        environments: p.environments,
        services: p.services,
      })),
      permissions,
      hint: status.hint,
      loginUrl: status.loginUrl,
      via: status.via,
      availableAuth: methods,
    });
  });

  // ----------------------------- OAuth endpoints -----------------------------

  if (oauth) {
    app.get('/api/auth/login', (c) => {
      // Random CSRF nonce in a short-lived cookie; compared on callback.
      const stateBytes = crypto.getRandomValues(new Uint8Array(16));
      let s = '';
      for (let i = 0; i < stateBytes.length; i++) s += String.fromCharCode(stateBytes[i]);
      const state = btoa(s).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
      c.header(
        'set-cookie',
        `pem_oauth_state=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600`,
      );
      return c.redirect(oauth.buildAuthorizeUrl(state));
    });

    app.get('/api/auth/callback', async (c) => {
      const code = c.req.query('code');
      const returnedState = c.req.query('state');
      const error = c.req.query('error');
      if (error) {
        return c.html(`<h1>Login failed</h1><pre>${error}</pre><a href="/">Back</a>`, 400);
      }
      if (!code || !returnedState) {
        return c.html('<h1>Missing code/state</h1><a href="/">Back</a>', 400);
      }

      const cookies = c.req.header('cookie') ?? '';
      const stateMatch = /(?:^|;\s*)pem_oauth_state=([^;]+)/.exec(cookies);
      if (!stateMatch || stateMatch[1] !== returnedState) {
        return c.html('<h1>State mismatch — possible CSRF</h1><a href="/">Back</a>', 400);
      }

      try {
        const payload = await oauth.exchangeCodeForSession(code);
        c.header('set-cookie', await oauth.buildCookie(payload), { append: true });
        c.header('set-cookie', 'pem_oauth_state=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0', {
          append: true,
        });
        return c.redirect('/');
      } catch (err) {
        return c.html(`<h1>Token exchange failed</h1><pre>${String(err)}</pre>`, 500);
      }
    });

    app.post('/api/auth/logout', (c) => {
      c.header('set-cookie', oauth.buildLogoutCookie());
      return c.json({ ok: true });
    });
  }

  // ----------------------------- Agnostic discovery -----------------------------

  // Lists raw Cloud Run service names per configured project. Powers the
  // ?agnostic=1 picker: the user selects any subset of services across any
  // projects to compare side-by-side, regardless of how config groups them.
  // We deliberately don't surface project labels/emoji here — agnostic mode
  // is meant to be config-flavour-free.
  app.get('/api/agnostic-projects', async (c) => {
    const session = await resolveSession(c);
    if (!session) return c.json({ ok: false, error: 'unauthenticated' }, 401);

    const results = await Promise.all(
      config.projects.map(async (p) => {
        const r = await listServices(p, session.accessToken);
        return {
          // `id` is the routing key the compare endpoint expects in its body.
          id: p.id,
          projectId: p.projectId,
          region: p.region,
          services: r.ok ? r.data : [],
          error: r.ok ? undefined : r.error,
        };
      }),
    );
    return c.json({ ok: true, projects: results });
  });

  /**
   * Compare a user-picked set of Cloud Run services. Body shape:
   *   { services: [{ projectId: "project-1", name: "svc-web" }, …] }
   * `projectId` here matches `config.projects[i].id` (NOT the GCP projectId)
   * because we still need the region + GCP projectId pair to build the URL,
   * and `config` is the only source we have for that mapping.
   *
   * Returns `{ ok, services: [{ projectId, name, envs?, error? }] }`. The
   * frontend builds its matrix from the union of env keys and colour-codes
   * cells DIFF/SAME/GAP just like the configured view.
   */
  app.post('/api/agnostic/envs', async (c) => {
    const session = await resolveSession(c);
    if (!session) return c.json({ ok: false, error: 'unauthenticated' }, 401);

    const body = (await c.req.json()) as { services?: Array<{ projectId: string; name: string }> };
    const requested = Array.isArray(body.services) ? body.services : [];

    const results = await Promise.all(
      requested.map(async (s) => {
        // For agnostic raw-name compare, the "projectId" here is the
        // routing key from the static config (we always need a real GCP
        // projectId + region to build the URL).
        const project = config.projects.find((p) => p.id === s.projectId);
        if (!project) {
          return { projectId: s.projectId, name: s.name, error: 'unknown project' };
        }
        const r = await describeServiceEnvsByName(project, s.name, session.accessToken);
        if (!r.ok) return { projectId: s.projectId, name: s.name, error: r.error };
        return { projectId: s.projectId, name: s.name, envs: r.data };
      }),
    );
    return c.json({ ok: true, services: results });
  });

  // ----------------------------- Service endpoints -----------------------------

  app.get('/api/projects/:project/services/:service/envs', async (c) => {
    const session = await resolveSession(c);
    if (!session) return c.json({ ok: false, error: 'unauthenticated' }, 401);

    const projects = await getProjects(c, session.accessToken);
    const project = findInProjects(projects, c.req.param('project'));
    if (!project) return c.json({ ok: false, error: 'unknown project' }, 404);
    const service = project.services.find((s) => s.id === c.req.param('service'));
    if (!service) return c.json({ ok: false, error: 'unknown service' }, 404);

    // `?envs=name1,name2` lets the frontend fetch only the envs that are
    // currently visible — important in agnostic mode where a project can
    // have 20+ services and we want lazy loading instead of "fetch
    // everything on first paint".
    const envFilter = c.req.query('envs')?.split(',').filter(Boolean);
    const targets = envFilter
      ? project.environments.filter((e) => envFilter.includes(e.name))
      : project.environments;

    const results = await Promise.all(
      targets.map(async (env) => {
        const r = await describeServiceEnvs(project, env, service, session.accessToken);
        return [env.name, r] as const;
      }),
    );

    const envs: Record<string, Record<string, string>> = {};
    const errors: Record<string, string> = {};
    for (const [name, r] of results) {
      if (r.ok) envs[name] = r.data;
      else errors[name] = r.error;
    }
    return c.json({ ok: true, envs, errors });
  });

  interface PatchBody {
    environments: string[];
    updates?: Record<string, string>;
    deletes?: string[];
  }

  app.patch('/api/projects/:project/services/:service/envs', async (c) => {
    const session = await resolveSession(c);
    if (!session) return c.json({ ok: false, error: 'unauthenticated' }, 401);

    const projects = await getProjects(c, session.accessToken);
    const project = findInProjects(projects, c.req.param('project'));
    if (!project) return c.json({ ok: false, error: 'unknown project' }, 404);
    const service = project.services.find((s) => s.id === c.req.param('service'));
    if (!service) return c.json({ ok: false, error: 'unknown service' }, 404);

    const body = (await c.req.json()) as PatchBody;
    const updates = body.updates ?? {};
    const deletes = body.deletes ?? [];
    const targets = project.environments.filter((e) => body.environments.includes(e.name));

    const results = await Promise.all(
      targets.map(async (env) => {
        const r = await updateServiceEnvs(project, env, service, updates, session.accessToken, deletes);
        return [env.name, r] as const;
      }),
    );

    const status: Record<string, { ok: boolean; error?: string }> = {};
    for (const [name, r] of results) {
      status[name] = r.ok ? { ok: true } : { ok: false, error: r.error };
    }
    return c.json({ ok: true, status });
  });

  return app;
}
