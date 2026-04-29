/**
 * Auth provider abstraction — exposes a single primitive (`accessToken`) plus
 * a user-facing identity (`account`). The Cloud Run layer never knows whether
 * that token came from `gcloud auth print-access-token` or a Google OAuth flow.
 */

export interface AuthStatus {
  ok: boolean;
  account?: string;
  hint?: string;
  /** Populated only when the UI needs to kick off a redirect-based login. */
  loginUrl?: string;
}

export interface AuthSession {
  accessToken: string;
  account: string;
}

export interface AuthProvider {
  status(request: Request): Promise<AuthStatus>;
  session(request: Request): Promise<AuthSession | null>;
}
