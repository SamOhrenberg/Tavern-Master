import type {
  CampaignDetail,
  CampaignInvite,
  CampaignSettings,
  CampaignSummary,
  Character,
  Entity,
  GameState,
} from '@tavern/protocol';
import { rm } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { entityMatches, scopeEntity } from '../agent/codex.js';
import { pgStore } from '../agent/store.js';
import { config } from '../config.js';
import { projectInstructions } from '../connector/instructions.js';
import { CONNECTOR_PATH } from '../connector/mcp.js';
import { dmModeOf } from '../connector/mode.js';
import { dropSheetFile } from '../connector/uploads.js';
import { cancelWork } from '../connector/work.js';
import { enqueue } from '../jobs/queue.js';
import { q, q1, tx } from '../db/pool.js';
import { badRequest, conflict, forbidden, notFound, parse } from '../errors.js';
import { requireMember } from '../http/membership.js';
import { requireUser } from '../http/security.js';
import { builtInAiFor } from '../llm/index.js';
import { usageTotals } from '../llm/usage.js';
import { listMessages } from '../realtime/messages.js';
import { dmStatusOf, endSession, getRoom } from '../realtime/room.js';
import { uploadPath } from '../storage.js';
import { areFriends } from './friends.js';

const uuid = z.string().uuid();

/** Run when a campaign becomes Claude's; the chronicle registers what it needs. */
let switchedToClaude: (campaignId: string) => Promise<void> = async () => undefined;
export function onSwitchToClaude(fn: (campaignId: string) => Promise<void>): void {
  switchedToClaude = fn;
}
const afterSwitchToClaude = (campaignId: string) => switchedToClaude(campaignId).catch(() => undefined);
const MAX_MEMBERS = 8;

const createSchema = z.object({
  name: z.string().trim().min(2).max(80),
  systemId: uuid,
  premise: z.string().trim().max(2000).default(''),
  tone: z.string().trim().max(300).default(''),
  sheets: z.enum(['players', 'gm']).default('players'),
  dm: z.enum(['server', 'claude']).optional(),
});
const NO_BUILT_IN = 'This server has no built-in AI. Choose Claude.';
const patchSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  premise: z.string().trim().max(2000).optional(),
  tone: z.string().trim().max(300).optional(),
  gatherWindowSeconds: z.number().int().min(5).max(600).optional(),
  sheets: z.enum(['players', 'gm']).optional(),
  dm: z.enum(['server', 'claude']).optional(),
  status: z.enum(['active', 'archived']).optional(),
});
function settingsOf(raw: Partial<CampaignSettings>): CampaignSettings {
  return {
    gatherWindowSeconds: raw.gatherWindowSeconds ?? config().DEFAULT_GATHER_WINDOW_SECONDS,
    tone: raw.tone ?? '',
    sheets: raw.sheets === 'gm' ? 'gm' : 'players',
    dm: dmModeOf(raw),
  };
}

const SUMMARY_SQL = `SELECT c.id, c.name, c.premise, c.system_id, s.name AS system_name, c.owner_id, c.status,
                            c.phase, c.settings, c.scene, m.role, m.wishes,
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
    phase: r.phase as 'prep' | 'active',
    memberCount: r.member_count as number,
    role: r.role as 'owner' | 'player',
    dm: dmModeOf(r.settings as { dm?: unknown }),
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
    const builtIn = await builtInAiFor(auth.user.id);
    const dm = body.dm ?? (builtIn ? 'server' : 'claude');
    if (dm === 'server' && !builtIn) throw badRequest(NO_BUILT_IN, 'no_built_in_ai');
    const id = await tx(async (client) => {
      const row = await q1<{ id: string }>(
        `INSERT INTO campaigns (system_id, owner_id, name, premise, settings) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [
          body.systemId,
          auth.user.id,
          body.name,
          body.premise,
          JSON.stringify({ tone: body.tone, sheets: body.sheets, dm }),
        ],
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
      `SELECT u.id, u.username, u.display_name, m.role,
              (SELECT ch.name FROM characters ch JOIN character_players p ON p.character_id = ch.id
                WHERE ch.campaign_id = m.campaign_id AND p.user_id = m.user_id AND ch.controller = 'player'
                ORDER BY ch.created_at LIMIT 1) AS character
         FROM campaign_members m JOIN users u ON u.id = m.user_id
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
      myWishes: row.wishes,
      dmStatus: await dmStatusOf(campaignId, dmModeOf(row.settings)),
    };
    return { campaign: detail };
  });

  app.patch<{ Params: { id: string } }>('/api/campaigns/:id', async (req) => {
    const { auth, campaignId } = await requireMember(req, true);
    const body = parse(patchSchema, req.body);
    if (body.dm === 'server' && !(await builtInAiFor(auth.user.id)))
      throw badRequest(NO_BUILT_IN, 'no_built_in_ai');
    const settings: Partial<CampaignSettings> = {};
    if (body.tone !== undefined) settings.tone = body.tone;
    if (body.gatherWindowSeconds !== undefined) settings.gatherWindowSeconds = body.gatherWindowSeconds;
    if (body.sheets !== undefined) settings.sheets = body.sheets;
    if (body.dm !== undefined) settings.dm = body.dm;
    await q(
      `UPDATE campaigns SET name = coalesce($2, name), premise = coalesce($3, premise),
                            status = coalesce($4, status), settings = settings || $5::jsonb WHERE id = $1`,
      [campaignId, body.name ?? null, body.premise ?? null, body.status ?? null, JSON.stringify(settings)],
    );
    const room = getRoom(campaignId);
    if (room && body.gatherWindowSeconds) room.collector.windowMs = body.gatherWindowSeconds * 1000;
    if (body.dm === 'server') {
      // Nothing waits for Claude any more: turns go back to the table, requests are cancelled.
      room?.releaseDesk();
      const cancelled = await cancelWork(campaignId);
      for (const item of cancelled.filter((w) => w.kind === 'sheet')) {
        await q(`UPDATE dm_work SET status = 'failed', error = $2 WHERE id = $1`, [
          item.id,
          'This campaign switched to the built-in AI. Upload it again.',
        ]);
        await dropSheetFile(item.payload);
        if (item.requestedBy)
          room?.tellUser(item.requestedBy, { type: 'sheet', id: item.id, status: 'failed' });
      }
      // The built-in chronicler catches up on whatever Claude had not written.
      await enqueue('summarize_campaign', { campaignId });
    }
    if (body.dm) await room?.setMode(body.dm);
    if (body.dm === 'claude') await afterSwitchToClaude(campaignId);
    room?.broadcast({ type: 'state_changed' });
    if (body.dm === 'server') void room?.maybeOpen();
    return { ok: true };
  });

  /** What the owner needs to run this campaign from the Claude app. */
  app.get<{ Params: { id: string } }>('/api/campaigns/:id/connector', async (req) => {
    const { campaignId } = await requireMember(req, true);
    const row = await q1<{ name: string }>('SELECT name FROM campaigns WHERE id = $1', [campaignId]);
    if (!row) throw notFound('Campaign not found');
    return {
      url: new URL(CONNECTOR_PATH, config().baseUrl).toString(),
      projectInstructions: projectInstructions(row.name),
    };
  });

  /**
   * Leave the lobby and begin. The DM plans the story and writes the opening
   * scene as soon as the table is connected; nothing here waits for it.
   */
  app.post<{ Params: { id: string } }>('/api/campaigns/:id/start', async (req) => {
    const { campaignId } = await requireMember(req, true);
    const rows = await q(
      `UPDATE campaigns SET phase = 'active', started_at = now()
        WHERE id = $1 AND phase = 'prep' AND status = 'active' RETURNING id`,
      [campaignId],
    );
    if (!rows.length) throw conflict('This campaign has already begun.');
    const room = getRoom(campaignId);
    room?.broadcast({ type: 'state_changed' });
    // A polling Claude hears about the opening at once.
    await room?.workChanged();
    void room?.maybeOpen();
    return { ok: true };
  });

  /** The owner hands a turn that is waiting for Claude back to the table. */
  app.post<{ Params: { id: string } }>('/api/campaigns/:id/desk/release', async (req) => {
    const { campaignId } = await requireMember(req, true);
    const room = getRoom(campaignId);
    if (!room?.releaseDesk()) throw conflict('Nothing is waiting for Claude.');
    return { ok: true };
  });

  /** What you hope the story holds. Read by you and by the DM, and by nobody else at the table. */
  app.put<{ Params: { id: string } }>('/api/campaigns/:id/wishes', async (req) => {
    const { auth, campaignId } = await requireMember(req);
    const { wishes } = parse(z.object({ wishes: z.string().trim().max(1200) }), req.body);
    await q('UPDATE campaign_members SET wishes = $3 WHERE campaign_id = $1 AND user_id = $2', [
      campaignId,
      auth.user.id,
      wishes,
    ]);
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/api/campaigns/:id', async (req) => {
    const { campaignId } = await requireMember(req, true);
    const room = getRoom(campaignId);
    for (const u of room?.present() ?? []) room?.kick(u.id);
    const files = await q<{ storage_name: string }>(
      'SELECT storage_name FROM documents WHERE campaign_id = $1',
      [campaignId],
    );
    await q('DELETE FROM campaigns WHERE id = $1', [campaignId]);
    for (const f of files) await rm(uploadPath(f.storage_name), { force: true });
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
      // Their characters stay in the party, unassigned, for the owner to hand on.
      getRoom(campaignId)?.kick(target);
      getRoom(campaignId)?.partyChanged();
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
        q<{ id: string; private_notes: string }>(
          `SELECT c.id, c.private_notes FROM characters c JOIN character_players p ON p.character_id = c.id
            WHERE c.campaign_id = $1 AND p.user_id = $2`,
          [campaignId, auth.user.id],
        ),
      ]);
      const myNotes = new Map(notes.map((n) => [n.id, n.private_notes]));
      const characters: Character[] = chars.map((c) => ({
        id: c.id,
        campaignId,
        kind: c.kind,
        controller: c.controller,
        playerIds: c.playerIds,
        name: c.name,
        sheet: c.sheet,
        hp: c.hp,
        maxHp: c.maxHp,
        tempHp: c.tempHp,
        conditions: c.conditions,
        inventory: c.inventory,
        persona: c.persona,
        // Private notes go only to the players who run the character.
        ...(c.playerIds.includes(auth.user.id) ? { privateNotes: myNotes.get(c.id) ?? '' } : {}),
      }));
      return {
        state: {
          scene,
          characters,
          // Unrevealed secrets never leave the server, not even for the owner, who is usually a player too.
          entities: entities.map(scopeEntity),
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

  // The browsable codex: every player-visible entry the world has grown, scoped
  // so secrets never leak. `?kind=` filters to one kind, `?q=` is a text search
  // over name, aliases, summary and article. Bookkeeping entities (in_codex=false)
  // are left out.
  app.get<{ Params: { id: string }; Querystring: { kind?: string; q?: string } }>(
    '/api/campaigns/:id/codex',
    async (req): Promise<{ entries: Entity[] }> => {
      const { campaignId } = await requireMember(req);
      const kind = req.query.kind
        ? parse(z.enum(['npc', 'location', 'quest', 'item', 'faction', 'event', 'term']), req.query.kind)
        : null;
      const query = typeof req.query.q === 'string' ? req.query.q.slice(0, 120) : '';
      const rows = await pgStore.entities(campaignId);
      const entries = rows
        .filter((e) => e.inCodex && (!kind || e.kind === kind) && entityMatches(e, query))
        .map(scopeEntity);
      return { entries };
    },
  );

  app.get<{ Params: { id: string; entityId: string } }>(
    '/api/campaigns/:id/codex/:entityId',
    async (req): Promise<{ entry: Entity }> => {
      const { campaignId } = await requireMember(req);
      const entityId = parse(uuid, req.params.entityId);
      const rows = await pgStore.entities(campaignId);
      const found = rows.find((e) => e.id === entityId && e.inCodex);
      if (!found) throw notFound('No such codex entry');
      return { entry: scopeEntity(found) };
    },
  );

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
