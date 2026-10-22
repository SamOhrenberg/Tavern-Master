import { randomBytes } from 'node:crypto';
import * as OTPAuth from 'otpauth';
import { sha256Hex } from '../security/crypto.js';

const ISSUER = 'Tavern Master';

function totp(secretBase32: string, label: string): OTPAuth.TOTP {
  return new OTPAuth.TOTP({
    issuer: ISSUER,
    label,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secretBase32),
  });
}

export function newTotpSecret(username: string): { secret: string; uri: string } {
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  return { secret, uri: totp(secret, username).toString() };
}

/** Accepts the current code and one step either side for clock drift. */
export function verifyTotp(secretBase32: string, code: string): boolean {
  const token = code.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(token)) return false;
  return totp(secretBase32, 'user').validate({ token, window: 1 }) !== null;
}

/** Current code for a secret; used by tests and the bootstrap script. */
export function currentTotp(secretBase32: string): string {
  return totp(secretBase32, 'user').generate();
}

export function newRecoveryCodes(count = 8): { plain: string[]; hashed: string[] } {
  const plain = Array.from({ length: count }, () => {
    const raw = randomBytes(5).toString('hex');
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
  return { plain, hashed: plain.map(hashRecoveryCode) };
}

export function hashRecoveryCode(code: string): string {
  return sha256Hex(`recovery:${code.trim().toLowerCase()}`);
}
