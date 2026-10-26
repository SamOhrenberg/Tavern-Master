import type { UsageReport } from '@tavern/protocol';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { createInvite } from '../auth/invites.js';
import { revokeAllSessions } from '../auth/sessions.js';
import { q } from '../db/pool.js';
import { badRequest, notFound, parse } from '../errors.js';
import { enforceLimit, rateLimiters, requireAdmin } from '../http/security.js';
import { toTotals, usageByCampaign, usageByUser } from '../llm/usage.js';

const inviteSchema = z.object({
  role: z.enum(['user', 'admin']).default('user'),
  note: z.string().trim().max(120).default(''),
  maxUses: z.number().int().min(1).max(50).default(1),
  expiresInDays: z.number().int().min(1).max(365).nullable().default(14),
});
const userPatchSchema = z.object({
  status: z.enum(['active', 'disabled']).optional(),
  role: z.enum(['user', 'admin']).optional(),
  dailyTokenBudget: z.number().int().min(0).max(1e12).nullable().optional(),
});
const uuid = z.string().uuid();

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  // ---- invites ----
  app.get('/api/admin/invites', async (req) => {
    requireAdmin(req);
    const rows = await q(
      `SELECT i.id, i.code_hint, i.role, i.note, i.max_uses, i.uses, i.expires_at, i.revoked_at, i.created_at,
              u.display_name AS created_by
         FROM invites i LEFT JOIN users u ON u.id = i.created_by ORDER BY i.created_at DESC LIMIT 200`,
    );
    return {
      invites: rows.map((r) => ({
        id: r.id,
        hint: r.code_hint,
        role: r.role,
        note: r.note,
        maxUses: r.max_uses,
        uses: r.uses,
        expiresAt: r.expires_at,
        revoked: !!r.revoked_at,
        createdAt: r.created_at,
        createdBy: r.created_by,
      })),
    };
  });

  app.post('/api/admin/invites', async (req) => {
    const auth = requireAdmin(req);
    enforceLimit(rateLimiters().auth, `invite:${auth.user.id}`);
    const body = parse(inviteSchema, req.body ?? {});
    const invite = await createInvite({ ...body, createdBy: auth.user.id });
    await audit('invite.created', {
      actorId: auth.user.id,
      targetType: 'invite',
      targetId: invite.id,
      ip: req.ip,
      meta: { role: body.role, maxUses: body.maxUses },
    });
    // The only time the plain code is ever shown.
    return { id: invite.id, code: invite.code };
  });

  app.delete<{ Params: { id: string } }>('/api/admin/invites/:id', async (req) => {
    const auth = requireAdmin(req);
    const id = parse(uuid, req.params.id);
    const rows = await q(
      'UPDATE invites SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING id',
      [id],
    );
    if (!rows.length) throw notFound();
    await audit('invite.revoked', { actorId: auth.user.id, targetType: 'invite', targetId: id, ip: req.ip });
    return { ok: true };
  });

  // ---- users ----
  app.get('/api/admin/users', async (req) => {
    requireAdmin(req);
    const rows = await q(
      `SELECT id, username, display_name, role, status, totp_enabled_at IS NOT NULL AS totp,
              daily_token_budget, created_at, last_login_at FROM users ORDER BY created_at`,
    );
    return {
      users: rows.map((r) => ({
        id: r.id,
        username: r.username,
        displayName: r.display_name,
        role: r.role,
        status: r.status,
        totpEnabled: r.totp,
        dailyTokenBudget: r.daily_token_budget,
        createdAt: r.created_at,
        lastLoginAt: r.last_login_at,
      })),
    };
  });

  app.patch<{ Params: { id: string } }>('/api/admin/users/:id', async (req) => {
    const auth = requireAdmin(req);
    const id = parse(uuid, req.params.id);
    const body = parse(userPatchSchema, req.body);
    if (id === auth.user.id && (body.status === 'disabled' || body.role === 'user')) {
      throw badRequest('You cannot disable or demote your own account.');
    }
    const rows = await q(
      `UPDATE users SET status = coalesce($2, status), role = coalesce($3, role),
                        daily_token_budget = CASE WHEN $4 THEN $5::bigint ELSE daily_token_budget END
        WHERE id = $1 RETURNING id`,
      [
        id,
        body.status ?? null,
        body.role ?? null,
        body.dailyTokenBudget !== undefined,
        body.dailyTokenBudget ?? null,
      ],
    );
    if (!rows.length) throw notFound();
    if (body.status === 'disabled') await revokeAllSessions(id);
    await audit('user.updated', {
      actorId: auth.user.id,
      targetType: 'user',
      targetId: id,
      ip: req.ip,
      meta: body,
    });
    return { ok: true };
  });

  // ---- audit log ----
  app.get<{ Querystring: { before?: string } }>('/api/admin/audit', async (req) => {
    requireAdmin(req);
    const before = req.query.before ? parse(z.coerce.number().int().positive(), req.query.before) : null;
    const rows = await q(
      `SELECT a.id, a.at, a.action, a.target_type, a.target_id, a.ip, a.meta, u.username AS actor
         FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
        WHERE ($1::bigint IS NULL OR a.id < $1) ORDER BY a.id DESC LIMIT 100`,
      [before],
    );
    return {
      entries: rows.map((r) => ({
        id: r.id,
        at: r.at,
        action: r.action,
        actor: r.actor,
        targetType: r.target_type,
        targetId: r.target_id,
        ip: r.ip,
        meta: r.meta,
      })),
    };
  });

  // ---- usage ----
  app.get<{ Querystring: { window?: string } }>('/api/admin/usage', async (req): Promise<UsageReport> => {
    requireAdmin(req);
    const window = req.query.window === '30d' ? '30d' : '24h';
    const hours = window === '30d' ? 24 * 30 : 24;
    const [users, campaigns] = await Promise.all([usageByUser(hours), usageByCampaign(hours)]);
    return {
      window,
      byUser: users.map((r) => ({
        user: { id: r.id, username: r.username, displayName: r.display_name },
        ...toTotals(r),
      })),
      byCampaign: campaigns.map((r) => ({ campaignId: r.id, name: r.name, ...toTotals(r) })),
    };
  });
}
