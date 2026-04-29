# cloud-run-env-manager

Web dashboard for managing Google Cloud Run environment variables across
projects, environments, and services. One matrix view; pick what to
compare; edit, mass-update, import/export `.env`, all from the browser.

- **Backend:** Hono. Deploys to Cloudflare Workers (production) or runs
  locally with `tsx`.
- **Frontend:** React + Vite + Tailwind + TanStack Query.
- **Auth:** Google OAuth 2.0 (production) and/or `gcloud` CLI (local
  development) — both can be active simultaneously.
- **Modes:**
  - **Configured** — projects/environments/services declared in
    `src/shared/config.ts`. Best when you want consistent groupings
    shared with your team via git.
  - **Agnostic** (`?agnostic=1`) — auto-discovers every GCP project the
    signed-in user can see and lists raw Cloud Run service names.
    Useful for discovery, debugging, or compare across projects.
  - **Local groups** — pick a subset of raw services, name it, save as
    a chip in your browser. Layered additively over the configured
    list, never modifies it.

## Quick start (local)

```bash
git clone https://github.com/kosiakMD/cloud-run-env-manager.git
cd cloud-run-env-manager
npm install

# Edit src/shared/config.ts to point at your projects
$EDITOR src/shared/config.ts

# Two modes:
npm run dev          # Vite (web :5173) + tsx-watch API (:5174). Auth = gcloud CLI.
# OR with OAuth too:
cp .env.example .env # fill GOOGLE_CLIENT_ID/SECRET, SESSION_SECRET, OAUTH_REDIRECT_URI
npm run build && AUTH_MODE=oauth npm start
```

`gcloud auth login` (with the account that has `run.services.{get,update}`
on each project) is enough for the local flow.

## Configuration

```ts
// src/shared/config.ts
export const config: AppConfig = {
  title: 'Env Manager',
  projects: [
    {
      id: 'project-1',                    // routing key, your choice
      label: 'Project 1',
      emoji: '🚀',
      projectId: 'my-gcp-project-id',     // GCP project id
      region: 'us-west1',
      environments: [
        { name: 'dev' },
        { name: 'staging' },
        { name: 'prod' },
      ],
      services: [
        { id: 'web', suffix: 'service-web' },  // Cloud Run name = `${env}-${suffix}`
        { id: 'api', suffix: 'service-api' },
      ],
    },
  ],
};
```

The Cloud Run service name for each cell is built as
`${env.servicePrefix ?? `${env.name}-`}${service.suffix}`.

So:
- `dev` env + `web` service → `dev-service-web`
- `staging` env + `api` service → `staging-service-api`
- `{name: 'main', servicePrefix: ''}` + `service-web` → `service-web`
  (unprefixed, when your prod service has no env prefix)

## Production deploy (Cloudflare Workers)

`.cloudflare/worker/wrangler.toml` is the deploy entry. Steps:

1. **Set your account id** in `wrangler.toml` (`account_id` field).
2. **Set secrets:**
   ```bash
   cd .cloudflare/worker
   npx wrangler secret put GOOGLE_CLIENT_ID
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   npx wrangler secret put SESSION_SECRET   # openssl rand -hex 32
   ```
3. **Update `[vars]`** for `OAUTH_REDIRECT_URI` and `PUBLIC_ORIGIN` to
   match your custom domain.
4. **Deploy:**
   ```bash
   npx wrangler deploy
   ```
5. **Add a Custom Domain** for the worker in the CF dashboard.
6. **Protect with Zero Trust Access** — recommended. Add an Access
   Application matching your domain with a policy restricted to your
   organisation's emails so the dashboard isn't world-readable.

## Architecture notes

- The Worker entry (`src/worker.ts`) and the local Node entry
  (`src/server/index.ts`) share `createApp(env, providers)` from
  `src/server/routes.ts` — same Hono app on both runtimes.
- `LocalAuth` uses `execa` to call `gcloud` and is therefore imported
  **only** from the Node entry. The Worker bundle never sees it, so
  `child_process` doesn't leak into the edge runtime.
- The Cloud Run update path is `GET → merge → PATCH` with
  `updateMask=template`, which keeps `valueSource` (secret-ref) entries
  untouched when patching plain env vars.
- Local groups live in `localStorage` only; they're additive and never
  override anything from the static config.

## License

MIT — see `LICENSE`.
