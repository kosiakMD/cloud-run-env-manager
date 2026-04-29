import { parseCookies, seal, unseal, SESSION_COOKIE } from './cookie.js';
import type { AuthProvider, AuthSession, AuthStatus } from './provider.js';

interface SessionPayload {
  accessToken: string;
  /** Unix ms. Set to (now + expires_in*1000 - 30s buffer) at issue time. */
  accessTokenExpiresAt: number;
  refreshToken?: string;
  account: string;
}

interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  sessionSecret: string;
}

interface GoogleTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
  token_type: string;
}

interface GoogleUserInfo {
  email: string;
}

const SCOPE = 'https://www.googleapis.com/auth/cloud-platform openid email profile';
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

/**
 * Deduplicate simultaneous refreshes. Without this a page that fires N
 * parallel fetches in parallel triggers N refreshes, and Google invalidates
 * all but one — we'd lose the session mid-render.
 */
const refreshInFlight = new Map<string, Promise<SessionPayload>>();

export class OAuthAuth implements AuthProvider {
  private cfg: OAuthConfig;
  constructor(cfg: OAuthConfig) {
    this.cfg = cfg;
  }

  async status(request: Request): Promise<AuthStatus> {
    const session = await this.session(request);
    if (session) return { ok: true, account: session.account };
    return {
      ok: false,
      hint: 'Sign in with Google to manage Cloud Run env vars.',
      loginUrl: '/api/auth/login',
    };
  }

  async session(request: Request): Promise<AuthSession | null> {
    const payload = await this.readCookie(request);
    if (!payload) return null;
    if (payload.accessTokenExpiresAt > Date.now() + 5_000) {
      return { accessToken: payload.accessToken, account: payload.account };
    }
    if (!payload.refreshToken) return null;
    try {
      const refreshed = await this.refreshAccessToken(payload);
      return { accessToken: refreshed.accessToken, account: refreshed.account };
    } catch {
      return null;
    }
  }

  /**
   * Writable variant — returns a Set-Cookie string when the access token was
   * just refreshed, so the API route can persist the new token back to the
   * client.
   */
  async getSessionWithRotation(
    request: Request,
  ): Promise<{ session: AuthSession | null; setCookie: string | null }> {
    const payload = await this.readCookie(request);
    if (!payload) return { session: null, setCookie: null };
    if (payload.accessTokenExpiresAt > Date.now() + 5_000) {
      return {
        session: { accessToken: payload.accessToken, account: payload.account },
        setCookie: null,
      };
    }
    if (!payload.refreshToken) return { session: null, setCookie: null };
    try {
      const refreshed = await this.refreshAccessToken(payload);
      return {
        session: { accessToken: refreshed.accessToken, account: refreshed.account },
        setCookie: await this.buildCookie(refreshed),
      };
    } catch {
      return { session: null, setCookie: null };
    }
  }

  buildAuthorizeUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.cfg.clientId,
      redirect_uri: this.cfg.redirectUri,
      response_type: 'code',
      scope: SCOPE,
      access_type: 'offline',
      // Force consent so we always get a refresh_token — Google only returns
      // one on first consent otherwise.
      prompt: 'consent',
      include_granted_scopes: 'true',
      state,
    });
    return `${GOOGLE_AUTH_URL}?${params.toString()}`;
  }

  async exchangeCodeForSession(code: string): Promise<SessionPayload> {
    const body = new URLSearchParams({
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: this.cfg.redirectUri,
    });
    const res = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) {
      throw new Error(`token exchange failed: ${res.status} ${await res.text()}`);
    }
    const token = (await res.json()) as GoogleTokenResponse;
    const email = await this.fetchEmail(token.access_token);
    return {
      accessToken: token.access_token,
      accessTokenExpiresAt: Date.now() + token.expires_in * 1000 - 30_000,
      refreshToken: token.refresh_token,
      account: email,
    };
  }

  async buildCookie(payload: SessionPayload): Promise<string> {
    const sealed = await seal(payload, this.cfg.sessionSecret);
    const isLocalhost = this.cfg.redirectUri.startsWith('http://localhost');
    const secure = isLocalhost ? '' : '; Secure';
    return `${SESSION_COOKIE}=${encodeURIComponent(sealed)}; Path=/; HttpOnly${secure}; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`;
  }

  buildLogoutCookie(): string {
    const isLocalhost = this.cfg.redirectUri.startsWith('http://localhost');
    const secure = isLocalhost ? '' : '; Secure';
    return `${SESSION_COOKIE}=; Path=/; HttpOnly${secure}; SameSite=Lax; Max-Age=0`;
  }

  private async readCookie(request: Request): Promise<SessionPayload | null> {
    const cookies = parseCookies(request.headers.get('cookie'));
    const raw = cookies[SESSION_COOKIE];
    if (!raw) return null;
    return unseal<SessionPayload>(raw, this.cfg.sessionSecret);
  }

  private async refreshAccessToken(payload: SessionPayload): Promise<SessionPayload> {
    if (!payload.refreshToken) throw new Error('no refresh token');
    const key = payload.refreshToken;
    const existing = refreshInFlight.get(key);
    if (existing) return existing;

    const pending = (async () => {
      try {
        const body = new URLSearchParams({
          client_id: this.cfg.clientId,
          client_secret: this.cfg.clientSecret,
          refresh_token: payload.refreshToken!,
          grant_type: 'refresh_token',
        });
        const res = await fetch(GOOGLE_TOKEN_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body,
        });
        if (!res.ok) {
          throw new Error(`refresh failed: ${res.status} ${await res.text()}`);
        }
        const token = (await res.json()) as GoogleTokenResponse;
        return {
          ...payload,
          accessToken: token.access_token,
          accessTokenExpiresAt: Date.now() + token.expires_in * 1000 - 30_000,
          refreshToken: token.refresh_token ?? payload.refreshToken,
        } satisfies SessionPayload;
      } finally {
        refreshInFlight.delete(key);
      }
    })();

    refreshInFlight.set(key, pending);
    return pending;
  }

  private async fetchEmail(accessToken: string): Promise<string> {
    const res = await fetch(GOOGLE_USERINFO_URL, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw new Error(`userinfo failed: ${res.status}`);
    const info = (await res.json()) as GoogleUserInfo;
    return info.email;
  }
}
