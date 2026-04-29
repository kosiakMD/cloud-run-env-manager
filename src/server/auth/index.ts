import { OAuthAuth } from './oauth.js';
import type { AuthProvider } from './provider.js';

export type { AuthProvider, AuthSession, AuthStatus } from './provider.js';
export { OAuthAuth } from './oauth.js';

export interface AuthConfigEnv {
  AUTH_MODE?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  OAUTH_REDIRECT_URI?: string;
  SESSION_SECRET?: string;
}

/** Identifier the UI uses to render different sign-in affordances. */
export type AuthMethod = 'oauth' | 'local';

function requireEnv(env: AuthConfigEnv, name: keyof AuthConfigEnv): string {
  const v = env[name];
  if (!v) throw new Error(`Missing required env var: ${String(name)}`);
  return v;
}

/**
 * Build the OAuth provider from any env bag (Node `process.env` or a
 * Cloudflare Worker bindings object). Both Node and Worker entries call
 * this; LocalAuth (with its `execa` dep) is only constructed by the Node
 * entry — see src/server/index.ts.
 */
export function createOAuthProvider(env: AuthConfigEnv): OAuthAuth {
  return new OAuthAuth({
    clientId: requireEnv(env, 'GOOGLE_CLIENT_ID'),
    clientSecret: requireEnv(env, 'GOOGLE_CLIENT_SECRET'),
    redirectUri: requireEnv(env, 'OAUTH_REDIRECT_URI'),
    sessionSecret: requireEnv(env, 'SESSION_SECRET'),
  });
}

export function hasOAuthConfig(env: AuthConfigEnv): boolean {
  return Boolean(
    env.GOOGLE_CLIENT_ID &&
      env.GOOGLE_CLIENT_SECRET &&
      env.OAUTH_REDIRECT_URI &&
      env.SESSION_SECRET,
  );
}

/**
 * Bag of providers wired into the route layer. Each entry is tried in turn
 * until one resolves a session. Local dev typically passes both — gcloud
 * CLI for the developer's workflow, OAuth for testing the prod sign-in
 * flow side-by-side. Cloud Worker passes only OAuth.
 */
export interface AuthProviders {
  oauth?: OAuthAuth;
  local?: AuthProvider;
}

export function availableMethods(p: AuthProviders): AuthMethod[] {
  const out: AuthMethod[] = [];
  if (p.oauth) out.push('oauth');
  if (p.local) out.push('local');
  return out;
}
