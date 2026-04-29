/**
 * Cloudflare Worker entry.
 *
 * The same Hono app from `routes.ts` runs here, just with a different
 * delivery surface: CF Workers Assets serves the built frontend, and API
 * routes (`/api/*`) are handled by this Worker.
 *
 * Only OAuth is available in the Worker runtime — LocalAuth uses execa/
 * child_process which wrangler's bundler can't (and shouldn't) bundle.
 */

import { createApp } from './server/routes.js';
import { createOAuthProvider, type AuthConfigEnv } from './server/auth/index.js';

interface Env extends AuthConfigEnv {
  /** Workers Assets binding declared in wrangler.toml. */
  ASSETS: Fetcher;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      const oauth = createOAuthProvider(env);
      // Worker bundle ships only OAuth — LocalAuth pulls execa /
      // child_process which wrangler can't bundle. Hence the empty `local`.
      const app = createApp(env, { oauth });
      return app.fetch(request, env, ctx);
    }

    // SPA deep-link fallback: if the asset serve returns 404, re-request
    // index.html so the React router takes over.
    const assetResponse = await env.ASSETS.fetch(request);
    if (assetResponse.status !== 404) return assetResponse;
    const indexUrl = new URL('/', url);
    return env.ASSETS.fetch(new Request(indexUrl.toString(), request));
  },
};
