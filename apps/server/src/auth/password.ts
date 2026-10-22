import { hash, verify } from '@node-rs/argon2';
import { z } from 'zod';

// OWASP-recommended argon2id parameters (19 MiB, t=2, p=1). Cheap enough for a
// small ARM board, expensive enough to make offline guessing slow.
// algorithm 2 = Argon2id (the enum is a const enum, unusable with isolated modules)
const OPTIONS = { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export const passwordSchema = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(200, 'Password is too long');

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export async function verifyPassword(storedHash: string, password: string): Promise<boolean> {
  try {
    return await verify(storedHash, password);
  } catch {
    return false;
  }
}

// Verifying against this when the user does not exist keeps response time the
// same for unknown and known usernames.
let dummy: Promise<string> | undefined;
export async function burnPasswordCheck(password: string): Promise<void> {
  dummy ??= hashPassword('not-a-real-password-placeholder');
  await verifyPassword(await dummy, password);
}
