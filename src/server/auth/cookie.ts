/**
 * AES-256-GCM session cookie helpers using the WebCrypto API.
 *
 * Runs unchanged in both Node (server) and Cloudflare Workers runtimes —
 * both ship `globalThis.crypto` with the SubtleCrypto interface, so we avoid
 * pulling in `node:crypto` which wouldn't compile for Workers.
 *
 * Wire format (base64url):
 *   [nonce:12][ciphertext][tag:16]   — tag is auto-appended to ciphertext by
 *   AES-GCM in WebCrypto; the overall envelope layout matches the Node version.
 */

const NONCE_LEN = 12;

/**
 * Derive a 32-byte key from the caller's secret. SHA-256 is deterministic and
 * fine here — the secret is expected to be high-entropy (openssl rand -hex 32).
 * We cache the imported CryptoKey per secret string so seal/unseal on a hot
 * path don't pay the import cost every call.
 */
const keyCache = new Map<string, Promise<CryptoKey>>();

function keyFor(secret: string): Promise<CryptoKey> {
  let pending = keyCache.get(secret);
  if (pending) return pending;
  pending = (async () => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
    return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  })();
  keyCache.set(secret, pending);
  return pending;
}

function toBase64Url(bytes: Uint8Array): string {
  // btoa only exists on strings; go byte → binary-string → b64 → url-safe.
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function fromBase64Url(str: string): Uint8Array {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  const b64 = str.replaceAll('-', '+').replaceAll('_', '/') + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function seal(payload: unknown, secret: string): Promise<string> {
  const key = await keyFor(secret);
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_LEN));
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const ct = new Uint8Array(
    // AES-GCM accepts any BufferSource — TS 5.7's narrower Uint8Array<ArrayBuffer>
    // signature misses plain Uint8Array from ArrayBufferLike.
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce as BufferSource }, key, plaintext as BufferSource),
  );
  const out = new Uint8Array(nonce.length + ct.length);
  out.set(nonce, 0);
  out.set(ct, nonce.length);
  return toBase64Url(out);
}

export async function unseal<T>(token: string, secret: string): Promise<T | null> {
  try {
    const buf = fromBase64Url(token);
    if (buf.length < NONCE_LEN + 16) return null;
    const nonce = buf.subarray(0, NONCE_LEN);
    const ct = buf.subarray(NONCE_LEN);
    const key = await keyFor(secret);
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce as BufferSource }, key, ct as BufferSource);
    return JSON.parse(new TextDecoder().decode(plaintext)) as T;
  } catch {
    // Any tamper, truncation, or secret-mismatch lands here — treat as "no session".
    return null;
  }
}

export const SESSION_COOKIE = 'pem_session';

export function parseCookies(header: string | null): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}
