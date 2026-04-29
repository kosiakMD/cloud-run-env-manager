/**
 * Minimal .env read/write. Intentionally does NOT try to match dotenv-lib's
 * full grammar — Cloud Run env values don't have multi-line strings, shell
 * expansions, or $VAR substitution. We support:
 *
 *   KEY=value
 *   KEY="value with spaces"
 *   KEY='value'
 *   # comment line (ignored)
 *   blank lines (ignored)
 *
 * `parseDotEnv` is permissive — unknown syntax is skipped, not errored.
 * `generateDotEnv` quotes only when the value needs it (whitespace, quotes,
 * `#`, `=`, or empty) so diffs between exports stay minimal.
 */

export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
      // Unescape \" and \n only inside double quotes to match common dotenv
      // exporters.
      if (rawLine.trim().startsWith('"')) {
        value = value.replace(/\\n/g, '\n').replace(/\\"/g, '"');
      }
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    out[key] = value;
  }
  return out;
}

export function generateDotEnv(envs: Record<string, string>): string {
  const keys = Object.keys(envs).sort();
  const lines = keys.map((k) => {
    const v = envs[k] ?? '';
    // Values with whitespace, `#`, `=`, quotes, or backslashes get
    // double-quoted + escaped. Empty values are quoted too so reimporting
    // doesn't collapse them to undefined.
    if (v === '' || /[\s"#=\\]/.test(v)) {
      const escaped = v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
      return `${k}="${escaped}"`;
    }
    return `${k}=${v}`;
  });
  return lines.join('\n') + '\n';
}

export function triggerDotEnvDownload(filename: string, envs: Record<string, string>): void {
  const content = generateDotEnv(envs);
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke on next tick so the click's navigation can read the blob first.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
