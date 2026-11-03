import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import type { Role } from '@tavern/protocol';
import { q1, type Queryable } from '../db/pool.js';
import { sha256 } from '../security/crypto.js';

// Crockford-style alphabet: no 0/O or 1/I/L to mistype when reading a code aloud.
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

function generateCode(): string {
  const bytes = randomBytes(16);
  let out = '';
  for (let i = 0; i < 16; i++) {
    out += ALPHABET[bytes[i]! % ALPHABET.length];
    if (i % 4 === 3 && i < 15) out += '-';
  }
  return out;
}

export function normaliseCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function hashCode(code: string): Buffer {
  return sha256(`invite:${normaliseCode(code)}`);
}

export interface NewInvite {
  role: Role;
  note: string;
  maxUses: number;
  expiresInDays: number | null;
  createdBy: string | null;
}

/** Create an invite. The plain code is returned once and only its hash is stored. */
export async function createInvite(input: NewInvite, on?: Queryable): Promise<{ id: string; code: string }> {
  const code = generateCode();
  const row = await q1<{ id: string }>(
    `INSERT INTO invites (code_hash, code_hint, role, note, max_uses, expires_at, created_by)
     VALUES ($1, $2, $3, $4, $5,
             CASE WHEN $6::int IS NULL THEN NULL ELSE now() + make_interval(days => $6::int) END, $7)
     RETURNING id`,
    [
      hashCode(code),
      code.slice(0, 4),
      input.role,
      input.note,
      input.maxUses,
      input.expiresInDays,
      input.createdBy,
    ],
    on,
  );
  return { id: row!.id, code };
}

/**
 * Consume one use of an invite inside the caller's transaction.
 * Returns the role it grants, or undefined if the code is unknown, expired,
 * revoked or used up. The UPDATE's WHERE clause makes concurrent redemption safe.
 */
export async function redeemInvite(code: string, client: pg.PoolClient): Promise<Role | undefined> {
  const row = await q1<{ role: Role }>(
    `UPDATE invites SET uses = uses + 1
      WHERE code_hash = $1
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > now())
        AND uses < max_uses
      RETURNING role`,
    [hashCode(code)],
    client,
  );
  return row?.role;
}
