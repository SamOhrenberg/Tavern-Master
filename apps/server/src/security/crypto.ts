import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { config } from '../config.js';

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(input: string | Buffer): Buffer {
  return createHash('sha256').update(input).digest();
}

export function sha256Hex(input: string | Buffer): string {
  return sha256(input).toString('hex');
}

export function hmac(purpose: string, value: string): string {
  return createHmac('sha256', config().SECRET_KEY).update(`${purpose}:${value}`).digest('base64url');
}

/** Constant-time string comparison that does not leak length via early exit. */
export function safeEqual(a: string, b: string): boolean {
  const ab = sha256(a);
  const bb = sha256(b);
  return timingSafeEqual(ab, bb) && a.length === b.length;
}

// ---- encryption at rest (BYO API keys, TOTP secrets) ----

let encKey: Buffer | undefined;
function key(): Buffer {
  // Derive a fixed-size key so ENCRYPTION_KEY can be any 32+ char string.
  encKey ??= Buffer.from(
    hkdfSync('sha256', config().ENCRYPTION_KEY, 'tavern-master', 'secrets-at-rest-v1', 32),
  );
  return encKey;
}

/** AES-256-GCM. Output: v1.<iv>.<tag>.<ciphertext>, base64url parts. */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [
    'v1',
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    ct.toString('base64url'),
  ].join('.');
}

export function decryptSecret(blob: string): string {
  const [version, iv, tag, ct] = blob.split('.');
  if (version !== 'v1' || !iv || !tag || ct === undefined) throw new Error('unrecognised secret format');
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
}

/** Forget derived keys (tests swap configs). */
export function resetCryptoForTests(): void {
  encKey = undefined;
}
