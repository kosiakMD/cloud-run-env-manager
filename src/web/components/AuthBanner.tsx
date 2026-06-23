import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { fetchHealth } from '../api.js';
import { ProjectSelector } from './ProjectSelector.js';
import { PILL } from '../ui-tokens.js';

const LOGIN_CMD = 'gcloud auth login';

interface Props {
  projectId: string;
  onProjectChange: (id: string) => void;
  canWrite: boolean;
}

export function AuthBanner({ projectId, onProjectChange, canWrite }: Props) {
  const qc = useQueryClient();
  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['health'],
    queryFn: fetchHealth,
    // While unauthenticated, re-check every 3s so the banner flips green
    // automatically after the user completes `gcloud auth login` (local mode)
    // or the OAuth callback returns (cloud mode).
    refetchInterval: (query) => (query.state.data?.ok ? false : 3000),
  });

  const prevOk = useRef<boolean | null>(null);
  useEffect(() => {
    if (data?.ok && prevOk.current === false) {
      qc.invalidateQueries({ queryKey: ['envs'] });
      toast.success(`Authenticated as ${data.account ?? 'unknown'}`);
    }
    if (data) prevOk.current = data.ok;
  }, [data?.ok, data?.account, qc]);

  async function copyCommand() {
    try {
      await navigator.clipboard.writeText(LOGIN_CMD);
      toast.success('Copied — paste into Terminal');
    } catch {
      toast.error('Clipboard blocked — copy manually');
    }
  }

  if (isLoading) {
    return <AuthLoadingBanner onReset={hardReset} />;
  }
  if (!data) return null;

  const available = data.availableAuth ?? [];
  const oauthAvailable = available.includes('oauth');
  const localAvailable = available.includes('local');
  // Whether the *active* session was obtained via OAuth (drives the
  // sign-out button — gcloud sessions don't have anything to sign out from
  // server-side, the user just runs `gcloud auth revoke`).
  const signedInViaOAuth = data.via === 'oauth';

  async function signOut() {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch {
      // ignore — we're discarding the session either way
    }
    // Hard reload so react-query refetches health with the cleared cookie.
    window.location.href = '/';
  }

  /**
   * "Got stuck on auth?" escape hatch. Calls the server's logout for the
   * happy path, then wipes every visible cookie for this domain — Cloudflare
   * Access tokens, the OAuth session, the OAuth CSRF nonce — and finally
   * does a cache-busting hard reload. `localStorage` is left alone on
   * purpose: local groups live there and they're consumer config, not auth
   * state.
   */
  async function hardReset() {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch {
      // ignore — best-effort
    }
    // Clear every readable cookie for the current host (HttpOnly stays —
    // those are the server's problem and logout above handles the OAuth
    // one; CF Access CF_Authorization isn't HttpOnly so this catches it).
    for (const c of document.cookie.split(';')) {
      const name = c.split('=')[0]?.trim();
      if (!name) continue;
      const host = location.hostname;
      // Wipe at root and at parent domains (CF Access sets on the apex).
      const parts = host.split('.');
      for (let i = 0; i < parts.length - 1; i++) {
        const domain = parts.slice(i).join('.');
        document.cookie = `${name}=; Path=/; Max-Age=0; Domain=${domain}`;
      }
      document.cookie = `${name}=; Path=/; Max-Age=0`;
    }
    window.location.href = `/?reset=${Date.now()}`;
  }

  if (data.ok) {
    // Top-level project picker lives here — it's a higher-order choice than
    // service tabs (below) so putting it in the signed-in strip matches the
    // visual hierarchy. Static projects label (was just a list of all GCP
    // project IDs) became redundant once the selector shows that info in its
    // trigger + dropdown.
    return (
      <div className="px-3 py-1 md:py-1.5 bg-emerald-50 dark:bg-emerald-950 border-b border-emerald-200 dark:border-emerald-900 text-[10px] md:text-xs flex items-center gap-2">
        <span className="truncate">
          {data.via === 'oauth' ? 'signed in' : 'gcloud'}: <strong>{data.account}</strong>
        </span>
        <span className="ml-auto flex items-center gap-2 shrink-0">
          {!canWrite && (
            <span
              className="px-1.5 py-0.5 rounded bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-200 text-[10px] font-medium"
              title="You have read-only access on this project — IAM role probably run.viewer."
            >
              🔒 read-only
            </span>
          )}
          <ProjectSelector active={projectId} onChange={onProjectChange} />
          {signedInViaOAuth && (
            <button
              onClick={signOut}
              className={`${PILL} bg-emerald-100 text-emerald-900 hover:bg-emerald-200 dark:bg-emerald-900 dark:text-emerald-100 dark:hover:bg-emerald-800 font-medium`}
              title="Sign out"
            >
              Sign out
            </button>
          )}
        </span>
      </div>
    );
  }

  // ------------------ Not signed in — render whatever options the server supports ------------------
  return (
    <div className="p-4 bg-red-50 dark:bg-red-950 border-b border-red-300 dark:border-red-900 text-sm space-y-3">
      <div className="flex items-center gap-3">
        <div className="font-semibold text-red-900 dark:text-red-200">
          Sign in required
        </div>
        <button
          onClick={hardReset}
          className="ml-auto px-2 py-1 rounded bg-red-100 dark:bg-red-900 text-red-900 dark:text-red-100 text-xs font-medium hover:bg-red-200 dark:hover:bg-red-800"
          title="Reset — clear cookies (Access + OAuth) and reload. Use when sign-in keeps looping. Local groups stay."
        >
          ↻ Reset cookies
        </button>
      </div>
      <div className="text-slate-700 dark:text-slate-300 leading-relaxed">
        This tool reads &amp; writes Cloud Run env vars on your behalf.
        Projects: {data.projects.map((p) => <strong key={p.id} className="font-mono">{p.projectId} </strong>)}
      </div>

      {oauthAvailable && (
        <div className="flex items-center gap-3 pt-1">
          <a
            href={data.loginUrl ?? '/api/auth/login'}
            className="px-3 py-1.5 rounded bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-400"
          >
            Sign in with Google
          </a>
          <span className="text-xs text-slate-500 dark:text-slate-400">
            {localAvailable ? 'Or use the gcloud option below.' : data.hint}
          </span>
        </div>
      )}

      {localAvailable && (
        <>
          <div className="text-xs text-slate-500 dark:text-slate-400">
            {oauthAvailable ? 'Alternatively, use your local gcloud credentials:' : 'Use your local gcloud credentials:'}
          </div>

          <ol className="list-decimal pl-5 space-y-2 text-slate-700 dark:text-slate-300">
            <li>
              Open a <strong>Terminal</strong> window and run:
              <div className="mt-1 flex items-center gap-2 max-w-xl">
                <code className="flex-1 font-mono bg-slate-900 text-slate-100 px-2 py-1 rounded select-all">
                  {LOGIN_CMD}
                </code>
                <button
                  onClick={copyCommand}
                  className="px-2 py-1 text-xs rounded bg-slate-200 hover:bg-slate-300 dark:bg-slate-700 dark:hover:bg-slate-600 dark:text-slate-100"
                  title="Copy command to clipboard"
                >
                  📋 Copy
                </button>
              </div>
            </li>
            <li>Sign in with your Google account in the browser window that opens.</li>
            <li>
              This banner turns green automatically (polled every 3s). Or hit the button below.
            </li>
          </ol>

          <div className="flex items-center gap-3 pt-1">
            <button
              onClick={() => refetch()}
              disabled={isFetching}
              className="px-3 py-1 rounded bg-slate-200 text-slate-900 ring-1 ring-slate-400 text-xs font-semibold disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900 dark:ring-0"
            >
              {isFetching ? '↻ Checking…' : '↻ Check now'}
            </button>
            <span className="text-xs text-slate-500 dark:text-slate-400">
              {data.hint ?? `No active account. Re-run \`${LOGIN_CMD}\` if the sign-in browser was cancelled.`}
            </span>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Initial "Checking auth…" splash. On a healthy network this is gone in
 * <500ms. If the /api/health call hangs (CF Access redirect loop, stale
 * cookie, etc.) we surface a manual escape hatch after 4s so the user
 * isn't trapped staring at a spinner.
 */
function AuthLoadingBanner({ onReset }: { onReset: () => void }) {
  const [showReset, setShowReset] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setShowReset(true), 4000);
    return () => clearTimeout(id);
  }, []);
  return (
    <div className="p-4 bg-slate-200 dark:bg-slate-800 text-sm flex items-center gap-3 flex-wrap">
      <span>Checking auth…</span>
      {showReset && (
        <>
          <span className="text-xs text-slate-500 dark:text-slate-400">
            Stuck? Clearing cookies usually fixes a hung Access / OAuth handshake.
          </span>
          <button
            onClick={onReset}
            className="ml-auto px-2 py-1 rounded bg-slate-300 dark:bg-slate-700 text-slate-800 dark:text-slate-100 text-xs font-medium hover:bg-slate-400 dark:hover:bg-slate-600"
            title="Clear cookies and reload. Local groups are kept."
          >
            ↻ Reset cookies + reload
          </button>
        </>
      )}
    </div>
  );
}
