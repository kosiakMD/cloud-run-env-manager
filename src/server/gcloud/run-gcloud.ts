import { execa, ExecaError } from 'execa';

export interface GcloudResult<T> {
  ok: true;
  data: T;
}

export interface GcloudFailure {
  ok: false;
  error: string;
  stderr?: string;
}

export type GcloudOutcome<T> = GcloudResult<T> | GcloudFailure;

function shortCmd(args: string[]): string {
  const visible = args.filter((a) => a !== '--format=json');
  return visible.slice(0, 6).join(' ') + (visible.length > 6 ? ' …' : '');
}

export async function runGcloud(args: string[]): Promise<GcloudOutcome<string>> {
  const cmd = shortCmd(args);
  const started = Date.now();
  process.stdout.write(`[gcloud] → ${cmd}\n`);
  try {
    const { stdout } = await execa('gcloud', args, { timeout: 120_000 });
    const ms = Date.now() - started;
    process.stdout.write(`[gcloud] ← ${cmd}   ok   ${ms}ms\n`);
    return { ok: true, data: stdout };
  } catch (err) {
    const e = err as ExecaError;
    const ms = Date.now() - started;
    process.stdout.write(`[gcloud] ← ${cmd}   fail ${ms}ms   ${e.shortMessage ?? String(err)}\n`);
    return { ok: false, error: e.shortMessage ?? String(err), stderr: e.stderr?.toString() };
  }
}
