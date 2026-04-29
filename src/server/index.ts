import 'dotenv/config';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createApp } from './routes.js';
import { createOAuthProvider, hasOAuthConfig, type AuthProviders } from './auth/index.js';
import { LocalAuth } from './auth/local.js';

const PORT = Number(process.env.PORT ?? 5174);

/**
 * Local Node entry — wires both auth providers when OAuth is configured,
 * so a developer can sign in either via gcloud CLI OR Google OAuth from
 * the browser. The Worker bundle uses a different entry (`worker.ts`) and
 * never imports LocalAuth, so this file is the only place execa /
 * child_process can leak in.
 *
 * - LocalAuth is always available locally (gcloud CLI is the dev's
 *   default workflow on their machine).
 * - OAuth is added too if `.env` has the four OAUTH_* vars filled in —
 *   matches the prod sign-in flow side-by-side with gcloud.
 */
const providers: AuthProviders = { local: new LocalAuth() };
if (hasOAuthConfig(process.env)) {
  providers.oauth = createOAuthProvider(process.env);
}
const app = createApp(process.env, providers);

const DIST_DIR = resolve(process.cwd(), 'dist/web');
const HAS_DIST = existsSync(DIST_DIR);

if (HAS_DIST) {
  app.use('/*', serveStatic({ root: './dist/web' }));
  const indexHtml = readFileSync(resolve(DIST_DIR, 'index.html'), 'utf8');
  app.get('*', (c) => c.html(indexHtml));
}

async function main() {
  serve({ fetch: app.fetch, port: PORT, hostname: '0.0.0.0' }, (info) => {
    const methods = [
      providers.oauth ? 'oauth' : null,
      providers.local ? 'local' : null,
    ].filter(Boolean).join('+');
    console.log(`cloud-run-env-manager (auth=${methods}) listening on http://0.0.0.0:${info.port}`);
    if (HAS_DIST) console.log(`  serving static frontend from ${DIST_DIR}`);
    else console.log('  no dist/web/ — frontend must run separately (vite dev)');
  });
}

main().catch((err) => {
  console.error('failed to start:', err);
  process.exit(1);
});
