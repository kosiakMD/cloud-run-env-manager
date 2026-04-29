import { runGcloud } from '../gcloud/run-gcloud.js';
import type { AuthProvider, AuthSession, AuthStatus } from './provider.js';

/**
 * LocalAuth reads gcloud CLI credentials from the developer's machine.
 */
export class LocalAuth implements AuthProvider {
  async status(): Promise<AuthStatus> {
    const token = await runGcloud(['auth', 'print-access-token']);
    if (!token.ok) {
      return { ok: false, hint: 'Run: gcloud auth login' };
    }
    const account = await runGcloud(['config', 'get-value', 'account']);
    return { ok: true, account: account.ok ? account.data.trim() : undefined };
  }

  async session(): Promise<AuthSession | null> {
    const token = await runGcloud(['auth', 'print-access-token']);
    if (!token.ok) return null;
    const account = await runGcloud(['config', 'get-value', 'account']);
    return {
      accessToken: token.data.trim(),
      account: account.ok ? account.data.trim() : 'gcloud',
    };
  }
}
