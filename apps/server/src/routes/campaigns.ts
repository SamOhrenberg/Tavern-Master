import type {
  CampaignDetail,
  CampaignInvite,
  CampaignSettings,
  CampaignSummary,
  Character,
  Entity,
  GameState,
  Recap,
  RollKind,
  SheetUpdate,
} from '@tavern/protocol';
import { rm } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { entityMatches, scopeEntity } from '../agent/codex.js';
import { audit } from '../audit.js';
import { redactSecrets } from '../agent/loop.js';
import { pgStore } from '../agent/store.js';
import {
  endCurrentSession,
  insertCampaign,
  resumeSession,
  startCampaign,
  updateCampaign,
} from '../campaign.js';
import { queueChronicleIfDue } from '../agent/summarize.js';
import { config } from '../config.js';
import { projectInstructions } from '../connector/instructions.js';
import { kitFiles, slugOf } from '../connector/kit.js';
import { CONNECTOR_PATH, pinnedPath } from '../connector/mcp.js';
import { zipStore } from '../connector/zip.js';
import { dmMode, dmModeOf } from '../connector/mode.js';
import { dropSheetFile } from '../connector/uploads.js';
import { cancelWork } from '../connector/work.js';
import { enqueue } from '../jobs/queue.js';
import { q, q1, tx } from '../db/pool.js';
import { badRequest, conflict, forbidden, notFound, parse } from '../errors.js';
import { requireMember } from '../http/membership.js';
import { enforceLimit, rateLimiters, requireUser } from '../http/security.js';
import { builtInAiFor } from '../llm/index.js';
import { findOutsideAi } from '../llm/outside.js';
import { notifyUser } from '../notify/notify.js';
import { usageTotals } from '../llm/usage.js';
import { portraitUrl } from '../party.js';
import { editMessage, listMessages } from '../realtime/messages.js';
import { dmStatusOf, getRoom, openRoom } from '../realtime/room.js';
import { restartSession, rewindTo } from '../rewind.js';
import { CAMPAIGN_SHEET_SQL, toSchema } from '../sheet-schema.js';
import { applyUpdate, previewUpdate } from '../sheet-versions.js';
import { uploadPath } from '../storage.js';
import { claudeConnected } from './account.js';
import { areFriends } from './friends.js';

const uuid = z.string().uuid();

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
  // 0 waits until everyone present is done or has passed.
  gatherWindowSeconds: z.union([z.literal(0), z.number().int().min(5).max(600)]).optional(),
  sheets: z.enum(['players', 'gm']).optional(),
  dm: z.enum(['server', 'claude']).optional(),
  // The name of an outside AI to polish narration with; '' turns it off.
  polishWith: z.string().trim().max(80).optional(),
  status: z.enum(['active', 'archived']).optional(),
});
function settingsOf(raw: Partial<CampaignSettings>): CampaignSettings {
  return {
    gatherWindowSeconds: raw.gatherWindowSeconds ?? config().DEFAULT_GATHER_WINDOW_SECONDS,
    tone: raw.tone ?? '',
    sheets: raw.sheets === 'gm' ? 'gm' : 'players',
    dm: dmModeOf(raw),
    polishWith: typeof raw.polishWith === 'string' ? raw.polishWith : '',
  };
}

/** A campaign as a member sees it. Only the detail carries its sheet, so the list stays light. */
const summarySql = (
  detail: boolean,
) => `SELECT c.id, c.name, c.premise, c.system_id, s.name AS system_name, s.homebrew, c.owner_id, c.status,
                            c.phase, c.settings, c.scene, c.resting_since, m.role, m.wishes,
                            c.sheet_version, s.sheet_version AS latest_sheet_version,
                            ${detail ? `${CAMPAIGN_SHEET_SQL} AS sheet_template,` : ''}
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
    homebrew: r.homebrew as boolean,
  };
}

export async function campaignRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/campaigns', async (req) => {
    const auth = requireUser(req);
    const rows = await q(`${summarySql(false)} ORDER BY c.status, c.created_at DESC`, [auth.user.id]);
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
    const id = await insertCampaign({ ownerId: auth.user.id, ...body, dm });
    return { id };
  });

  app.get<{ Params: { id: string } }>('/api/campaigns/:id', async (req) => {
    const { auth, role, campaignId } = await requireMember(req);
    const row = await q1(`${summarySql(true)} WHERE c.id = $2`, [auth.user.id, campaignId]);
    if (!row) throw notFound();
    const members = await q(
      `SELECT u.id, u.username, u.display_name, m.role, m.ready_at IS NOT NULL AS ready,
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
        ready: m.ready,
      })),
      pendingInvites: pending.map((p) => ({
        id: p.id,
        invitee: { id: p.uid, username: p.username, displayName: p.display_name },
      })),
      myWishes: row.wishes,
      dmStatus: await dmStatusOf(campaignId, dmModeOf(row.settings)),
      restingSince: row.resting_since ? (row.resting_since as Date).toISOString() : null,
      sheetSchema: toSchema(row.sheet_template),
      sheetVersion: row.sheet_version,
      sheetUpdate:
        role === 'owner' && row.latest_sheet_version > row.sheet_version
          ? { version: row.latest_sheet_version }
          : null,
    };
    return { campaign: detail };
  });

  /** For the host: what updating to the latest version of the system's sheet would change. */
  app.get<{ Params: { id: string } }>(
    '/api/campaigns/:id/sheet-update',
    async (req): Promise<{ update: SheetUpdate | null }> => {
      const { campaignId } = await requireMember(req, true);
      return { update: await previewUpdate(campaignId) };
    },
  );

  /**
   * Update the campaign to the latest version of its system's sheet, carrying
   * every character's values across. `version` is the one the host was shown.
   */
  app.post<{ Params: { id: string } }>('/api/campaigns/:id/sheet-update', async (req) => {
    const { auth, campaignId } = await requireMember(req, true);
    const { version } = parse(z.object({ version: z.number().int().min(1) }), req.body);
    const update = await applyUpdate(campaignId, version);
    await audit('campaign.sheet_updated', {
      actorId: auth.user.id,
      targetType: 'campaign',
      targetId: campaignId,
      ip: req.ip,
      meta: { from: update.from, to: update.to },
    });
    // The sheet, the GM's notes on it and every character changed: everyone looks again.
    getRoom(campaignId)?.partyChanged();
    return { update };
  });

  app.patch<{ Params: { id: string } }>('/api/campaigns/:id', async (req) => {
    const { campaignId, host, hostId } = await requireMember(req, true);
    const body = parse(patchSchema, req.body);
    // Who runs the table is the host's: it is their AI, or their Claude, that plays every part.
    if (body.dm && !host) throw forbidden('Only the host, who made this campaign, can change who runs it.');
    if (body.dm === 'server' && !(await builtInAiFor(hostId)))
      throw badRequest(NO_BUILT_IN, 'no_built_in_ai');
    if (body.polishWith) {
      const ai = await findOutsideAi(body.polishWith);
      if (!ai) throw badRequest(`No other AI called "${body.polishWith}" is set up on this server.`);
      body.polishWith = ai.name;
    }
    await updateCampaign(campaignId, body);
    const room = getRoom(campaignId);
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
    // Claude picks the chronicle up from wherever the built-in one left it.
    if (body.dm === 'claude') await queueChronicleIfDue(campaignId).catch(() => undefined);
    room?.broadcast({ type: 'state_changed' });
    if (body.dm === 'server') void room?.maybeOpen();
    return { ok: true };
  });

  /** What the host needs to run this campaign from the Claude app. */
  app.get<{ Params: { id: string } }>('/api/campaigns/:id/connector', async (req) => {
    const { auth, campaignId } = await requireMember(req, 'host');
    const row = await q1<{ name: string }>('SELECT name FROM campaigns WHERE id = $1', [campaignId]);
    if (!row) throw notFound('Campaign not found');
    return {
      url: new URL(CONNECTOR_PATH, config().baseUrl).toString(),
      pinnedUrl: new URL(pinnedPath(campaignId), config().baseUrl).toString(),
      projectInstructions: projectInstructions(row.name),
      claudeConnected: await claudeConnected(auth.user.id),
    };
  });

  /**
   * The campaign folder for running the table from Claude Code, as a zip. It
   * holds no secret (Claude signs in on first use), so a plain link works.
   */
  app.get<{ Params: { id: string } }>('/api/campaigns/:id/connector/kit', async (req, reply) => {
    const { campaignId } = await requireMember(req, 'host');
    const row = await q1<{ name: string }>('SELECT name FROM campaigns WHERE id = $1', [campaignId]);
    if (!row) throw notFound('Campaign not found');
    const zip = zipStore(kitFiles({ id: campaignId, name: row.name }, config().baseUrl.origin));
    return reply
      .header('Content-Type', 'application/zip')
      .header('Content-Disposition', `attachment; filename="${slugOf(row.name)}-tavern.zip"`)
      .header('Cache-Control', 'no-store')
      .send(zip);
  });

  /**
   * Leave the lobby and begin. The DM plans the story and writes the opening
   * scene as soon as the table is connected; nothing here waits for it.
   */
  app.post<{ Params: { id: string } }>('/api/campaigns/:id/start', async (req) => {
    const { campaignId } = await requireMember(req, true);
    await startCampaign(campaignId);
    return { ok: true };
  });

  /**
   * A player says they are ready to begin, or takes it back. The host begins
   * once every player is ready, so it only means something in the lobby.
   */
  app.put<{ Params: { id: string } }>('/api/campaigns/:id/ready', async (req) => {
    const { auth, campaignId } = await requireMember(req);
    const { ready } = parse(z.object({ ready: z.boolean() }), req.body);
    // In the lobby, ready means the character is made: the campaign begins with whoever is ready.
    if (ready) {
      const lobby = await q1('SELECT 1 FROM campaigns WHERE id = $1 AND phase = $2', [campaignId, 'prep']);
      const hasCharacter = await q1(
        `SELECT 1 FROM character_players p JOIN characters c ON c.id = p.character_id
          WHERE c.campaign_id = $1 AND p.user_id = $2 AND c.controller = 'player'`,
        [campaignId, auth.user.id],
      );
      if (lobby && !hasCharacter)
        throw conflict('Create your character first, then ready up.', 'no_character');
    }
    const rows = await q(
      `UPDATE campaign_members m SET ready_at = CASE WHEN $3 THEN coalesce(m.ready_at, now()) END
         FROM campaigns c
        WHERE m.campaign_id = $1 AND m.user_id = $2 AND c.id = m.campaign_id
          AND (c.phase = 'prep' OR c.resting_since IS NOT NULL)
        RETURNING m.user_id`,
      [campaignId, auth.user.id, ready],
    );
    if (!rows.length) throw conflict('There is nothing to ready up for: the session is in play.');
    getRoom(campaignId)?.broadcast({ type: 'state_changed' });
    return { ok: true };
  });

  /** Start the next session from the recap, once every player is ready. */
  app.post<{ Params: { id: string } }>('/api/campaigns/:id/resume', async (req) => {
    const { campaignId } = await requireMember(req, true);
    const { anyway } = parse(z.object({ anyway: z.boolean().optional() }), req.body ?? {});
    return { number: await resumeSession(campaignId, { anyway }) };
  });

  /**
   * The adventure so far, for the recap between sessions: the chronicle as the
   * chronicler wrote it from what was said at the table.
   */
  app.get<{ Params: { id: string } }>('/api/campaigns/:id/recap', async (req): Promise<Recap> => {
    const { campaignId } = await requireMember(req);
    const [arcs, sessions, mode, entities, asked, queued] = await Promise.all([
      q<{ content: string }>(
        `SELECT content FROM summaries WHERE campaign_id = $1 AND kind = 'arc' AND superseded_at IS NULL
          ORDER BY created_at`,
        [campaignId],
      ),
      q<{ id: string; number: number; started_at: Date; ended_at: Date | null; summary: string | null }>(
        `SELECT s.id, s.number, s.started_at, s.ended_at,
                (SELECT x.content FROM summaries x WHERE x.session_id = s.id AND x.kind = 'session'
                    AND x.superseded_at IS NULL ORDER BY x.created_at DESC LIMIT 1) AS summary
           FROM play_sessions s WHERE s.campaign_id = $1 ORDER BY s.number`,
        [campaignId],
      ),
      dmMode(campaignId),
      pgStore.entities(campaignId),
      // Claude has been asked to chronicle these sessions...
      q<{ subject_id: string }>(
        `SELECT subject_id FROM dm_work WHERE campaign_id = $1 AND kind = 'chronicle'
            AND status IN ('waiting', 'claimed') AND subject_id LIKE 'session:%'`,
        [campaignId],
      ),
      // ...or the built-in chronicler is on it.
      q<{ session_id: string | null }>(
        `SELECT payload->>'sessionId' AS session_id FROM jobs
          WHERE kind = 'summarize_campaign' AND status IN ('queued', 'running') AND payload->>'campaignId' = $1`,
        [campaignId],
      ),
    ]);
    const askedClaude = new Set(asked.map((w) => w.subject_id.slice('session:'.length)));
    const working = new Set(queued.flatMap((j) => (j.session_id ? [j.session_id] : [])));
    // Stored summaries begin "Session N:", and the recap titles each with its number.
    // They are written for the DM, so what the party has not discovered is blacked out as in narration.
    const secrets = entities.flatMap((e) => (e.secret && !e.secretRevealed ? [e.secret] : []));
    const readable = (text: string) => redactSecrets(text.replace(/^Session \d+:\s*/, ''), secrets).text;
    return {
      arcs: arcs.map((a) => readable(a.content)),
      sessions: sessions
        // Sessions folded into an arc have no summary of their own left; the arc tells them.
        .filter((s, i) => s.summary || !arcs.length || i === sessions.length - 1)
        .map((s) => ({
          number: s.number,
          startedAt: s.started_at.toISOString(),
          endedAt: s.ended_at?.toISOString() ?? null,
          summary: s.summary ? readable(s.summary) : null,
          pending: s.summary
            ? null
            : mode === 'claude'
              ? askedClaude.has(s.id)
                ? ('claude' as const)
                : null
              : working.has(s.id)
                ? ('chronicler' as const)
                : null,
        })),
    };
  });

  /**
   * Change what a message says. The host may edit any narration or action; a
   * player may edit their own actions. Table talk and notices stay as said. An action
   * the DM has not resolved yet reaches it as edited.
   */
  app.patch<{ Params: { id: string; messageId: string } }>(
    '/api/campaigns/:id/messages/:messageId',
    async (req) => {
      const { auth, role, campaignId } = await requireMember(req);
      const messageId = parse(z.coerce.number().int().positive(), req.params.messageId);
      const { content } = parse(z.object({ content: z.string().trim().min(1).max(12000) }), req.body);
      const m = await q1<{ kind: string; user_id: string | null }>(
        'SELECT kind, user_id FROM messages WHERE id = $1 AND campaign_id = $2',
        [messageId, campaignId],
      );
      if (!m) throw notFound('That message is not in this campaign.');
      if (m.kind === 'system') throw badRequest('Notices from the table cannot be edited.');
      if (m.kind === 'ooc') throw badRequest('Table talk cannot be edited.');
      // An action is held to the length of one posted in the first place.
      if (m.kind === 'action' && content.length > 2000)
        throw badRequest('An action can be up to 2000 characters.');
      const own = m.user_id === auth.user.id && m.kind === 'action';
      if (role !== 'owner' && !own) throw forbidden('You can edit only your own actions.');
      if (m.kind === 'action' && getRoom(campaignId)?.editPending(messageId, content) === 'resolving') {
        throw conflict(
          'The Dungeon Master is resolving this turn right now. Edit it once the scene is posted.',
        );
      }
      const message = await editMessage(messageId, content, await pgStore.entities(campaignId));
      getRoom(campaignId)?.broadcast({ type: 'message', message });
      return { message };
    },
  );

  /**
   * The host takes the story back to just after one of the DM's narrations.
   * Everything said since goes, and the game state goes back with it.
   */
  app.post<{ Params: { id: string } }>('/api/campaigns/:id/rewind', async (req) => {
    const { campaignId } = await requireMember(req, true);
    const { messageId } = parse(z.object({ messageId: z.number().int().positive() }), req.body);
    const room = await openRoom(campaignId);
    const out = await room.rewrite(() => rewindTo(campaignId, messageId));
    if (out.reopen) void room.maybeOpen();
    await room.workChanged();
    return out;
  });

  /** The host starts the latest session over from its first line. */
  app.post<{ Params: { id: string } }>('/api/campaigns/:id/restart-session', async (req) => {
    const { campaignId } = await requireMember(req, true);
    const room = await openRoom(campaignId);
    const out = await room.rewrite(() => restartSession(campaignId));
    if (out.reopen) void room.maybeOpen();
    await room.workChanged();
    return out;
  });

  /** The host puts a character back with the party, when the DM left them cut off. */
  app.delete<{ Params: { id: string; characterId: string } }>(
    '/api/campaigns/:id/characters/:characterId/whereabouts',
    async (req) => {
      const { campaignId } = await requireMember(req, true);
      const characterId = parse(uuid, req.params.characterId);
      const rows = await q(
        `UPDATE characters SET whereabouts = '' WHERE id = $1 AND campaign_id = $2 RETURNING id`,
        [characterId, campaignId],
      );
      if (!rows.length) throw notFound('That character is not in this campaign.');
      getRoom(campaignId)?.broadcast({ type: 'state_changed' });
      return { ok: true };
    },
  );

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
    // Stamped only when the words change, so the GM hears about real changes once.
    await q(
      `UPDATE campaign_members SET wishes = $3,
              wishes_at = CASE WHEN wishes IS DISTINCT FROM $3 THEN now() ELSE wishes_at END
        WHERE campaign_id = $1 AND user_id = $2`,
      [campaignId, auth.user.id, wishes],
    );
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/api/campaigns/:id', async (req) => {
    const { campaignId } = await requireMember(req, 'host');
    const room = getRoom(campaignId);
    for (const u of room?.present() ?? []) room?.kick(u.id);
    const files = await q<{ storage_name: string }>(
      `SELECT storage_name FROM documents WHERE campaign_id = $1
       UNION ALL
       SELECT portrait FROM characters WHERE campaign_id = $1 AND portrait IS NOT NULL`,
      [campaignId],
    );
    await q('DELETE FROM campaigns WHERE id = $1', [campaignId]);
    for (const f of files) await rm(uploadPath(f.storage_name), { force: true });
    return { ok: true };
  });

  // ---- invitations: an owner can invite accepted friends ----
  app.post<{ Params: { id: string } }>('/api/campaigns/:id/invites', async (req) => {
    const { auth, campaignId } = await requireMember(req, true);
    // Each invitation buzzes someone's phone.
    enforceLimit(rateLimiters().auth, `invite:${auth.user.id}`);
    const { userId } = parse(z.object({ userId: uuid }), req.body);
    if (!(await areFriends(auth.user.id, userId))) throw forbidden('You can only invite friends.');
    if (
      await q1('SELECT 1 FROM campaign_members WHERE campaign_id = $1 AND user_id = $2', [campaignId, userId])
    ) {
      throw conflict('They are already in this campaign.');
    }
    // Asking again while an invitation is still pending changes nothing and notifies no one.
    const fresh = await q(
      `INSERT INTO campaign_invites (campaign_id, inviter_id, invitee_id) VALUES ($1, $2, $3)
       ON CONFLICT (campaign_id, invitee_id) DO UPDATE SET status = 'pending', inviter_id = $2, created_at = now(), responded_at = NULL
        WHERE campaign_invites.status <> 'pending'
       RETURNING id`,
      [campaignId, auth.user.id, userId],
    );
    if (!fresh.length) return { ok: true };
    const campaign = await q1<{ name: string }>('SELECT name FROM campaigns WHERE id = $1', [campaignId]);
    void notifyUser(userId, {
      title: 'Campaign invitation',
      body: `${auth.user.displayName} invited you to ${campaign?.name ?? 'a campaign'}.`,
      url: '/',
      tag: `invite:${campaignId}`,
    });
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

  /**
   * An owner removes a player, or anyone but the host leaves. Only the host
   * removes another owner, and nobody removes the host.
   */
  app.delete<{ Params: { id: string; userId: string } }>(
    '/api/campaigns/:id/members/:userId',
    async (req) => {
      const { auth, role, campaignId, hostId, host } = await requireMember(req);
      const target = parse(uuid, req.params.userId);
      if (target === hostId)
        throw badRequest('The host cannot leave; delete or archive the campaign instead.');
      if (target !== auth.user.id && role !== 'owner')
        throw forbidden('Only the campaign’s owners can remove players.');
      const rows = await q<{ role: string }>(
        `DELETE FROM campaign_members WHERE campaign_id = $1 AND user_id = $2
            AND ($3::boolean OR user_id = $4 OR role <> 'owner')
          RETURNING role`,
        [campaignId, target, host, auth.user.id],
      );
      if (!rows.length) {
        if (
          await q1('SELECT 1 FROM campaign_members WHERE campaign_id = $1 AND user_id = $2', [
            campaignId,
            target,
          ])
        )
          throw forbidden('Only the host can remove another owner.');
        throw notFound('They are not in this campaign.');
      }
      // Their characters stay in the party, unassigned, for the owners to hand on.
      getRoom(campaignId)?.kick(target);
      getRoom(campaignId)?.partyChanged();
      return { ok: true };
    },
  );

  /**
   * The host makes a player an owner, with everything the host can do at the
   * table, or makes an owner a player again. What stays the host's: who runs
   * the table (their AI, or their Claude), deleting the campaign, and this.
   */
  app.put<{ Params: { id: string; userId: string } }>(
    '/api/campaigns/:id/members/:userId/role',
    async (req) => {
      const { auth, campaignId, hostId } = await requireMember(req, 'host');
      const target = parse(uuid, req.params.userId);
      const { role } = parse(z.object({ role: z.enum(['owner', 'player']) }), req.body);
      if (target === hostId) throw badRequest('The host is always an owner.');
      const rows = await q(
        'UPDATE campaign_members SET role = $3 WHERE campaign_id = $1 AND user_id = $2 RETURNING user_id',
        [campaignId, target, role],
      );
      if (!rows.length) throw notFound('They are not in this campaign.');
      await audit('campaign.member_role', {
        actorId: auth.user.id,
        targetType: 'campaign',
        targetId: campaignId,
        ip: req.ip,
        meta: { userId: target, role },
      });
      // The socket reads each member's role per message, so nobody needs to reconnect.
      const room = getRoom(campaignId);
      room?.broadcast({ type: 'state_changed' });
      room?.partyChanged();
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
      const [chars, entities, flags, scene, events, notes, asks] = await Promise.all([
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
        q<{
          id: string;
          character_id: string;
          name: string;
          expression: string;
          reason: string;
          kind: RollKind;
        }>(
          `SELECT r.id, r.character_id, c.name, r.expression, r.reason, r.kind
             FROM roll_requests r JOIN characters c ON c.id = r.character_id
            WHERE r.campaign_id = $1 AND r.status = 'pending' AND r.shown ORDER BY r.created_at`,
          [campaignId],
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
        portrait: portraitUrl(campaignId, c.id, c.portrait),
        whereabouts: c.whereabouts,
        ...(c.createdBy ? { createdBy: c.createdBy } : {}),
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
          rollRequests: asks.map((r) => ({
            id: r.id,
            characterId: r.character_id,
            characterName: r.name,
            expression: r.expression,
            reason: r.reason,
            kind: r.kind,
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
    await endCurrentSession(campaignId);
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
