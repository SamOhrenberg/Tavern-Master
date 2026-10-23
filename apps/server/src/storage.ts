import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { config } from './config.js';

export function uploadsDir(): string {
  return resolve(config().DATA_DIR, 'uploads');
}

export function modelsDir(): string {
  return resolve(config().DATA_DIR, 'models');
}

export async function ensureDataDirs(...dirs: string[]): Promise<void> {
  for (const dir of dirs) await mkdir(dir, { recursive: true });
}

/** Storage names are random hex: nothing a client sends ever becomes part of a path. */
export function newStorageName(): string {
  return randomBytes(16).toString('hex');
}

export function uploadPath(storageName: string): string {
  if (!/^[a-f0-9]{32}$/.test(storageName)) throw new Error('invalid storage name');
  const full = join(uploadsDir(), storageName);
  if (!full.startsWith(uploadsDir() + sep)) throw new Error('path escapes uploads directory');
  return full;
}
