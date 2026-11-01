import type {
  CampaignDetail,
  CampaignInvite,
  CampaignSettings,
  CampaignSummary,
  Character,
  GameState,
} from '@tavern/protocol';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { pgStore } from '../agent/store.js';
import type { AuthContext } from '../auth/sessions.js';
import { config } from '../config.js';
import { q, q1, tx } from '../db/pool.js';
import { badRequest, conflict, forbidden, notFound, parse } from '../errors.js';
import { requireUser } from '../http/security.js';
import { usageTotals } from '../llm/usage.js';
import { listMessages } from '../realtime/messages.js';
import { endSession, getRoom } from '../realtime/room.js';
import { areFriends } from './friends.js';

const uuid = z.string().uuid();
const MAX_MEMBERS = 8;

const createSchema = z.object({
  name: z.string().trim().min(2).max(80),
  systemId: uuid,
  premise: z.string().trim().max(2000).default(''),
  tone: z.string().trim().max(300).default(''),
});
const patchSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  premise: z.string().trim().max(2000).optional(),
  tone: z.string().trim().max(300).optional(),
  gatherWindowSeconds: z.number().int().min(5).max(600).optional(),
  status: z.enum(['active', 'archived']).optional(),
});
const sheetValue = z.union([z.string().max(1500), z.number().finite()]);
const characterSchema = z.object({
  name: z.string().trim().min(1).max(60),
  maxHp: z.number().int().min(1).max(9999),
  hp: z.number().int().min(0).max(9999).optional(),
  sheet: z
    .record(z.string().regex(/^[\w ]{1,40}$/), sheetValue)
    .refine((s) => Object.keys(s).length <= 40, 'Too many fields'),
  inventory: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(80),
        qty: z.number().int().min(1).max(9999),
        notes: z.string().max(200).optional(),
      }),
    )
    .max(100)
    .optional(),
  privateNotes: z.string().max(4000).optional(),
});

interface Membership {
  auth: AuthContext;
  role: 'owner' | 'player';
  campaignId: string;
}

/** Every campaign route goes through this: no membership, no data (and no hint the campaign exists). */
async function requireMember(
  req: FastifyRequest<{ Params: { id: string } }>,
  ownerOnly = false,
): Promise<Membership> {
  const auth = requireUser(req);
  const campaignId = parse(uuid, req.params.id);
  const row = await q1<{ role: 'owner' | 'player' }>(
    'SELECT role FROM campaign_members WHERE campaign_id = $1 AND user_id = $2',
    [campaignId, auth.user.id],
  );
  if (!row) throw notFound('Campaign not found');
  if (ownerOnly && row.role !== 'owner') throw forbidden('Only the campaign owner can do that.');
  return { auth, role: row.role, campaignId };
}

function settingsOf(raw: Partial<CampaignSettings>): CampaignSettings {
  return {
    gatherWindowSeconds: raw.gatherWindowSeconds ?? config().DEFAULT_GATHER_WINDOW_SECONDS,
    tone: raw.tone ?? '',
  };
}

const SUMMARY_SQL = `SELECT c.id, c.name, c.premise, c.system_id, s.name AS system_name, c.owner_id, c.status,
                            c.settings, c.scene, m.role,
                            (SELECT count(*)::int FROM campaign_members x WHERE x.campaign_id = c.id) AS member_count
                       FROM campaigns c
                       JOIN campaign_members m ON m.campaign_id = c.id AND m.user_id = $1
                       JOIN game_systems s ON s.id = c.system_id`;

function toSummary(r: Record<string, unknown>): CampaignSummary {
  return {
    id: r.id as string,
    name: r.name as string,
    premise: r.premise as string,
    systemId: r.system_id as string,
    systemName: r.system_name as string,
    ownerId: r.owner_id as string,
    status: r.status as 'active' | 'archived',
    memberCount: r.member_count as number,
    role: r.role as 'owner' | 'player',
  };
}

export async function campaignRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/campaigns', async (req) => {
    const auth = requireUser(req);
    const rows = await q(`${SUMMARY_SQL} ORDER BY c.status, c.created_at DESC`, [auth.user.id]);
    return { campaigns: rows.map(toSummary) };
  });

  app.post('/api/campaigns', async (req) => {
    const auth = requireUser(req);
    const body = parse(createSchema, req.body);
    if (!(await q1('SELECT 1 FROM game_systems WHERE id = $1', [body.systemId])))
      throw badRequest('Unknown game system.');
    const id = await tx(async (client) => {
      const row = await q1<{ id: string }>(
        `INSERT INTO campaigns (system_id, owner_id, name, premise, settings) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [body.systemId, auth.user.id, body.name, body.premise, JSON.stringify({ tone: body.tone })],
        client,
      );
      await client.query(
        `INSERT INTO campaign_members (campaign_id, user_id, role) VALUES ($1, $2, 'owner')`,
        [row!.id, auth.user.id],
      );
      return row!.id;
    });
    return { id };
  });

  app.get<{ Params: { id: string } }>('/api/campaigns/:id', async (req) => {
    const { auth, role, campaignId } = await requireMember(req);
    const row = await q1(`${SUMMARY_SQL} WHERE c.id = $2`, [auth.user.id, campaignId]);
    if (!row) throw notFound();
    const members = await q(
      `SELECT u.id, u.username, u.display_name, m.role, ch.name AS character
         FROM campaign_members m JOIN users u ON u.id = m.user_id
         LEFT JOIN characters ch ON ch.campaign_id = m.campaign_id AND ch.user_id = m.user_id
        WHERE m.campaign_id = $1 ORDER BY m.joined_at`,
      [campaignId],
    );
    const pending =
      role === 'owner'
        ? await q(
            `SELECT i.id, u.id AS uid, u.username, u.display_name FROM campaign_invites i JOIN users u ON u.id = i.invitee_id
              WHERE i.campaign_id = $1 AND i.status = 'pending'`,
            [campaignId],
          )
        : [];
    const detail: CampaignDetail = {
      ...toSummary(row),
      settings: settingsOf(row.settings),
      scene: row.scene,
      members: members.map((m) => ({
        id: m.id,
        username: m.username,
        displayName: m.display_name,
        role: m.role,
        characterName: m.character,
      })),
      pendingInvites: pending.map((p) => ({
        id: p.id,
        invitee: { id: p.uid, username: p.username, displayName: p.display_name },
      })),
    };
    return { campaign: detail };
  });

  app.patch<{ Params: { id: string } }>('/api/campaigns/:id', async (req) => {
    const { campaignId } = await requireMember(req, true);
    const body = parse(patchSchema, req.body);
    const settings: Partial<CampaignSettings> = {};
    if (body.tone !== undefined) settings.tone = body.tone;
    if (body.gatherWindowSeconds !== undefined) settings.gatherWindowSeconds = body.gatherWindowSeconds;
    await q(
      `UPDATE campaigns SET name = coalesce($2, name), premise = coalesce($3, premise),
                            status = coalesce($4, status), settings = settings || $5::jsonb WHERE id = $1`,
      [campaignId, body.name ?? null, body.premise ?? null, body.status ?? null, JSON.stringify(settings)],
    );
    const room = getRoom(campaignId);
    if (room && body.gatherWindowSeconds) room.collector.windowMs = body.gatherWindowSeconds * 1000;
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/api/campaigns/:id', async (req) => {
    const { campaignId } = await requireMember(req, true);
    const room = getRoom(campaignId);
    for (const u of room?.present() ?? []) room?.kick(u.id);
    await q('DELETE FROM campaigns WHERE id = $1', [campaignId]);
    return { ok: true };
  });

  // ---- invitations: an owner can invite accepted friends ----
  app.post<{ Params: { id: string } }>('/api/campaigns/:id/invites', async (req) => {
    const { auth, campaignId } = await requireMember(req, true);
    const { userId } = parse(z.object({ userId: uuid }), req.body);
    if (!(await areFriends(auth.user.id, userId))) throw forbidden('You can only invite friends.');
    if (
      await q1('SELECT 1 FROM campaign_members WHERE campaign_id = $1 AND user_id = $2', [campaignId, userId])
    ) {
      throw conflict('They are already in this campaign.');
    }
    await q(
      `INSERT INTO campaign_invites (campaign_id, inviter_id, invitee_id) VALUES ($1, $2, $3)
       ON CONFLICT (campaign_id, invitee_id) DO UPDATE SET status = 'pending', inviter_id = $2, created_at = now(), responded_at = NULL`,
      [campaignId, auth.user.id, userId],
    );
    return { ok: true };
  });

  app.get('/api/campaign-invites', async (req) => {
    const auth = requireUser(req);
    const rows = await q(
      `SELECT i.id, c.id AS campaign_id, c.name, u.id AS uid, u.username, u.display_name
         FROM campaign_invites i JOIN campaigns c ON c.id = i.campaign_id JOIN users u ON u.id = i.inviter_id
        WHERE i.invitee_id = $1 AND i.status = 'pending' ORDER BY i.created_at DESC`,
      [auth.user.id],
    );
    const invites: CampaignInvite[] = rows.map((r) => ({
      id: r.id,
      campaignId: r.campaign_id,
      campaignName: r.name,
      inviter: { id: r.uid, username: r.username, displayName: r.display_name },
    }));
    return { invites };
  });

  app.post<{ Params: { id: string } }>('/api/campaign-invites/:id/respond', async (req) => {
    const auth = requireUser(req);
    const id = parse(uuid, req.params.id);
    const { accept } = parse(z.object({ accept: z.boolean() }), req.body);
    const campaignId = await tx(async (client) => {
      const inv = await q1<{ campaign_id: string }>(
        `UPDATE campaign_invites SET status = $3, responded_at = now()
          WHERE id = $1 AND invitee_id = $2 AND status = 'pending' RETURNING campaign_id`,
        [id, auth.user.id, accept ? 'accepted' : 'declined'],
        client,
      );
      if (!inv) throw notFound();
      if (accept) {
        const count = await q1<{ n: number }>(
          'SELECT count(*)::int AS n FROM campaign_members WHERE campaign_id = $1',
          [inv.campaign_id],
          client,
        );
        if ((count?.n ?? 0) >= MAX_MEMBERS) throw conflict('That campaign is full.');
        await client.query(
          `INSERT INTO campaign_members (campaign_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [inv.campaign_id, auth.user.id],
        );
      }
      return inv.campaign_id;
    });
    return { ok: true, campaignId: accept ? campaignId : null };
  });

  /** The owner removes a player, or a player leaves. */
  app.delete<{ Params: { id: string; userId: string } }>(
    '/api/campaigns/:id/members/:userId',
    async (req) => {
      const { auth, role, campaignId } = await requireMember(req);
      const target = parse(uuid, req.params.userId);
      if (target !== auth.user.id && role !== 'owner')
        throw forbidden('Only the campaign owner can remove players.');
      const rows = await q(
        `DELETE FROM campaign_members WHERE campaign_id = $1 AND user_id = $2 AND role <> 'owner' RETURNING user_id`,
        [campaignId, target],
      );
      if (!rows.length) throw badRequest('The owner cannot leave; delete or archive the campaign instead.');
      getRoom(campaignId)?.kick(target);
      return { ok: true };
    },
  );

  // ---- play data ----
  app.get<{ Params: { id: string }; Querystring: { before?: string } }>(
    '/api/campaigns/:id/messages',
    async (req) => {
      const { campaignId } = await requireMember(req);
      const before = req.query.before ? parse(z.coerce.number().int().positive(), req.query.before) : null;
      return { messages: await listMessages(campaignId, before, 60) };
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/campaigns/:id/state',
    async (req): Promise<{ state: GameState }> => {
      const { auth, campaignId } = await requireMember(req);
      const [chars, entities, flags, scene, events, notes] = await Promise.all([
        pgStore.characters(campaignId),
        pgStore.entities(campaignId),
        pgStore.flags(campaignId),
        pgStore.scene(campaignId),
        q(
          `SELECT id, turn_id, actor, tool, summary, created_at FROM state_events WHERE campaign_id = $1 ORDER BY id DESC LIMIT 40`,
          [campaignId],
        ),
        q1<{ private_notes: string }>(
          'SELECT private_notes FROM characters WHERE campaign_id = $1 AND user_id = $2',
          [campaignId, auth.user.id],
        ),
      ]);
      const characters: Character[] = chars.map((c) => ({
        id: c.id,
        campaignId,
        userId: c.userId,
        name: c.name,
        sheet: c.sheet,
        hp: c.hp,
        maxHp: c.maxHp,
        tempHp: c.tempHp,
        conditions: c.conditions,
        inventory: c.inventory,
        // Private notes go to their author only.
        ...(c.userId === auth.user.id ? { privateNotes: notes?.private_notes ?? '' } : {}),
      }));
      return {
        state: {
          scene,
          characters,
          // Unrevealed secrets never leave the server, not even for the owner, who is usually a player too.
          entities: entities.map((e) => ({
            id: e.id,
            kind: e.kind,
            name: e.name,
            summary: e.summary,
            status: e.status,
            secretRevealed: e.secretRevealed,
            ...(e.secret && e.secretRevealed ? { secret: e.secret } : {}),
          })),
          flags,
          events: events.map((e) => ({
            id: e.id,
            turnId: e.turn_id,
            actor: e.actor,
            tool: e.tool,
            summary: e.summary,
            createdAt: e.created_at.toISOString(),
          })),
        },
      };
    },
  );

  /** Create or edit your own character. Nobody can write another player's sheet through the API. */
  app.put<{ Params: { id: string } }>('/api/campaigns/:id/character', async (req) => {
    const { auth, campaignId } = await requireMember(req);
    const body = parse(characterSchema, req.body);
    const hp = Math.min(body.hp ?? body.maxHp, body.maxHp);
    await q(
      `INSERT INTO characters (campaign_id, user_id, name, sheet, hp, max_hp, inventory, private_notes)
       VALUES ($1, $2, $3, $4, $5, $6, coalesce($7::jsonb, '[]'), coalesce($8, ''))
       ON CONFLICT (campaign_id, user_id) DO UPDATE
         SET name = $3, sheet = $4, max_hp = $6,
             hp = least(CASE WHEN $9 THEN $5 ELSE characters.hp END, $6),
             inventory = coalesce($7::jsonb, characters.inventory),
             private_notes = coalesce($8, characters.private_notes), updated_at = now()`,
      [
        campaignId,
        auth.user.id,
        body.name,
        JSON.stringify(body.sheet),
        hp,
        body.maxHp,
        body.inventory ? JSON.stringify(body.inventory) : null,
        body.privateNotes ?? null,
        body.hp !== undefined,
      ],
    );
    getRoom(campaignId)?.broadcast({ type: 'state_changed' });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/campaigns/:id/end-session', async (req) => {
    const { campaignId } = await requireMember(req, true);
    if (getRoom(campaignId)?.busy) throw conflict('Wait for the current turn to finish.');
    const open = await q1<{ id: string }>(
      'SELECT id FROM play_sessions WHERE campaign_id = $1 AND ended_at IS NULL',
      [campaignId],
    );
    if (!open) throw badRequest('There is no session in progress.');
    await endSession(campaignId, open.id);
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>('/api/campaigns/:id/usage', async (req) => {
    const { campaignId } = await requireMember(req);
    return {
      day: await usageTotals({ campaignId, hours: 24 }),
      month: await usageTotals({ campaignId, hours: 24 * 30 }),
    };
  });
}
