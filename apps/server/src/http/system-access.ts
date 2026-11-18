import type { FastifyRequest } from 'fastify';
import type { AuthContext } from '../auth/sessions.js';
import { config } from '../config.js';
import { q, q1 } from '../db/pool.js';
import { forbidden } from '../errors.js';
import { requireAdmin, requireUser } from './security.js';

/**
 * Who may shape one game system: the server's admins, and the players an
 * admin made owners of that system. Owners get everything an admin can do to
 * that system (rulebooks, sheet, workshop, GM guide), and nothing else.
 */

/** Whether a user owns a game system (as a player an admin trusted with it). */
export async function ownsSystem(systemId: string, userId: string): Promise<boolean> {
  return !!(await q1('SELECT 1 FROM game_system_owners WHERE system_id = $1 AND user_id = $2', [
    systemId,
    userId,
  ]));
}

/** The systems a user owns, for marking which ones they may change. */
export async function ownedSystems(userId: string): Promise<Set<string>> {
  const rows = await q<{ system_id: string }>('SELECT system_id FROM game_system_owners WHERE user_id = $1', [
    userId,
  ]);
  return new Set(rows.map((r) => r.system_id));
}

/** Whether a user may change a system, without throwing. Admins need 2FA when the server asks for it. */
export async function maySystem(
  user: { id: string; role: string; totpEnabled: boolean },
  systemId: string,
): Promise<boolean> {
  if (user.role === 'admin') return !config().ADMIN_REQUIRE_TOTP || user.totpEnabled;
  return ownsSystem(systemId, user.id);
}

/**
 * For a route about one system: an admin (by the usual admin rules), or an
 * owner of that system. Anyone else gets the same answer as before owners existed.
 */
export async function requireSystemEditor(req: FastifyRequest, systemId: string): Promise<AuthContext> {
  const auth = requireUser(req);
  if (auth.user.role === 'admin') return requireAdmin(req);
  if (await ownsSystem(systemId, auth.user.id)) return auth;
  throw forbidden('Only an admin or an owner of this game system can do that.');
}

/** For a route about one rulebook: the same, for the system it belongs to. */
export async function requireDocumentEditor(req: FastifyRequest, documentId: string): Promise<AuthContext> {
  requireUser(req);
  const row = await q1<{ system_id: string }>('SELECT system_id FROM documents WHERE id = $1', [documentId]);
  // No such document: an admin gets the route's own not-found; anyone else is simply refused.
  if (!row) return requireAdmin(req);
  return requireSystemEditor(req, row.system_id);
}
