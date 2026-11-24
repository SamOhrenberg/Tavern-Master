import { createReadStream } from 'node:fs';
import type { EntityFull } from '@tavern/protocol';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { fullEntity, playerVisible } from '../agent/codex.js';
import { pgStore } from '../agent/store.js';
import { q, q1 } from '../db/pool.js';
import { badRequest, conflict, notFound, parse } from '../errors.js';
import { requireMember } from '../http/membership.js';
import { discard, readHead, receiveFile } from '../http/upload.js';
import { npcPortraitUrl, setNpcPortrait, sweepNpcPortraits } from '../npc-portraits.js';
import { getRoom } from '../realtime/room.js';
import { sniffImage } from '../rules/parse.js';
import { uploadPath } from '../storage.js';

/**
 * The campaign's owners editing the codex by hand: the people and creatures
 * on the NPCs tab, and any other entry. These are the only routes that send
 * spoilers (unrevealed secrets, hidden stat block lines, entries the party
 * has not met), so every one of them is for owners alone. The DM reads the
 * same rows, so what an owner changes is what it plays from. Pictures of
 * people and creatures are the exception: anyone at the table may load the
 * picture of an entry they are sent.
 */

const uuid = z.string().uuid();
/** Pictures arrive cropped and shrunk by the app; this is room to spare. */
const PORTRAIT_MAX_BYTES = 2 * 1024 * 1024;
const PICTURED = new Set(['npc', 'creature']);
const text = (max: number) => z.string().trim().max(max);

const entityEdit = z.object({
  kind: z.enum(['npc', 'creature', 'location', 'quest', 'item', 'faction', 'event', 'term']),
  name: z.string().trim().min(1).max(120),
  aliases: z.array(z.string().trim().min(1).max(80)).max(12).default([]),
  summary: text(600).default(''),
  article: text(4000).default(''),
  status: text(80).default(''),
  sheet: z
    .array(z.object({ label: text(60).min(1), value: text(400).min(1), hidden: z.boolean().default(false) }))
    .max(40)
    .default([]),
  secret: text(600).default(''),
  articleSecret: text(4000).default(''),
  secretRevealed: z.boolean().default(false),
  hidden: z.boolean().default(false),
});
type EntityEditInput = z.infer<typeof entityEdit>;

/** The parameters every write shares, in the order the statements below number them. */
const values = (e: EntityEditInput) => [
  e.kind,
  e.name,
  JSON.stringify(e.aliases),
  e.summary,
  e.article,
  e.status,
  JSON.stringify(e.sheet),
  e.secret || null,
  e.articleSecret || null,
  // Nothing to reveal without a secret.
  e.secretRevealed && !!e.secret,
  e.hidden,
];

/** Postgres's unique_violation: another entry of that kind already has the name. */
function duplicate(err: unknown, e: EntityEditInput): never {
  if ((err as { code?: string }).code === '23505')
    throw conflict(
      `There is already a ${e.kind === 'npc' ? 'person' : e.kind} called ${e.name}.`,
      'duplicate',
    );
  throw err;
}

async function loadFull(campaignId: string, entityId: string): Promise<EntityFull> {
  const found = (await pgStore.entities(campaignId)).find((e) => e.id === entityId);
  if (!found) throw notFound('No such entry');
  return fullEntity(found);
}

export async function entityRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Every entry with everything in it, entries the party has not met
   * included; `?kinds=npc,creature` narrows it. Bookkeeping entries are left out.
   */
  app.get<{ Params: { id: string }; Querystring: { kinds?: string } }>(
    '/api/campaigns/:id/entities',
    async (req): Promise<{ entries: EntityFull[] }> => {
      const { campaignId } = await requireMember(req, 'owner');
      const kinds = typeof req.query.kinds === 'string' ? req.query.kinds.split(',').filter(Boolean) : [];
      const rows = await pgStore.entities(campaignId);
      return {
        entries: rows.filter((e) => e.inCodex && (!kinds.length || kinds.includes(e.kind))).map(fullEntity),
      };
    },
  );

  /** One entry with everything in it, spoilers included. */
  app.get<{ Params: { id: string; entityId: string } }>(
    '/api/campaigns/:id/entities/:entityId',
    async (req): Promise<{ entry: EntityFull }> => {
      const { campaignId } = await requireMember(req, 'owner');
      return { entry: await loadFull(campaignId, parse(uuid, req.params.entityId)) };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/campaigns/:id/entities',
    async (req): Promise<{ entry: EntityFull }> => {
      const { campaignId } = await requireMember(req, 'owner');
      const e = parse(entityEdit, req.body);
      const row = await q1<{ id: string }>(
        `INSERT INTO entities (campaign_id, kind, name, aliases, summary, article, status, sheet,
                             secret, article_secret, secret_revealed, hidden)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
        [campaignId, ...values(e)],
      ).catch((err) => duplicate(err, e));
      getRoom(campaignId)?.broadcast({ type: 'state_changed' });
      return { entry: await loadFull(campaignId, row!.id) };
    },
  );

  app.put<{ Params: { id: string; entityId: string } }>(
    '/api/campaigns/:id/entities/:entityId',
    async (req): Promise<{ entry: EntityFull }> => {
      const { campaignId } = await requireMember(req, 'owner');
      const entityId = parse(uuid, req.params.entityId);
      const e = parse(entityEdit, req.body);
      const rows = await q(
        `UPDATE entities
            SET kind = $3, name = $4, aliases = $5, summary = $6, article = $7, status = $8, sheet = $9,
                secret = $10, article_secret = $11, secret_revealed = $12, hidden = $13, updated_at = now()
          WHERE campaign_id = $1 AND id = $2 RETURNING id`,
        [campaignId, entityId, ...values(e)],
      ).catch((err) => duplicate(err, e));
      if (!rows.length) throw notFound('No such entry');
      getRoom(campaignId)?.broadcast({ type: 'state_changed' });
      return { entry: await loadFull(campaignId, entityId) };
    },
  );

  app.delete<{ Params: { id: string; entityId: string } }>(
    '/api/campaigns/:id/entities/:entityId',
    async (req): Promise<{ ok: true }> => {
      const { campaignId } = await requireMember(req, 'owner');
      const rows = await q('DELETE FROM entities WHERE campaign_id = $1 AND id = $2 RETURNING id', [
        campaignId,
        parse(uuid, req.params.entityId),
      ]);
      if (!rows.length) throw notFound('No such entry');
      await sweepNpcPortraits(campaignId);
      getRoom(campaignId)?.broadcast({ type: 'state_changed' });
      return { ok: true };
    },
  );

  /**
   * Put someone in the current scene or take them out of it, for when the DM
   * forgot. The DM sees the change in its next turn's state.
   */
  app.put<{ Params: { id: string; entityId: string } }>(
    '/api/campaigns/:id/entities/:entityId/scene',
    async (req): Promise<{ ok: true }> => {
      const { campaignId } = await requireMember(req, 'owner');
      const { inScene } = parse(z.object({ inScene: z.boolean() }), req.body);
      const rows = await q(
        `UPDATE entities SET in_scene = $3
          WHERE campaign_id = $1 AND id = $2 AND kind IN ('npc', 'creature') RETURNING id`,
        [campaignId, parse(uuid, req.params.entityId), inScene],
      );
      if (!rows.length) throw notFound('No such person or creature');
      getRoom(campaignId)?.broadcast({ type: 'state_changed' });
      return { ok: true };
    },
  );

  // ---- pictures of people and creatures ----

  /** Set a person's or creature's picture: a PNG, JPEG or WebP image, replacing any it had. */
  app.put<{ Params: { id: string; entityId: string } }>(
    '/api/campaigns/:id/entities/:entityId/portrait',
    async (req): Promise<{ portrait: string }> => {
      const { campaignId } = await requireMember(req, 'owner');
      const entityId = parse(uuid, req.params.entityId);
      // Check before taking the file, so nothing is written to disk for an entry that is not there.
      const entry = await q1<{ kind: string }>(
        'SELECT kind FROM entities WHERE campaign_id = $1 AND id = $2',
        [campaignId, entityId],
      );
      if (!entry) throw notFound('No such entry');
      if (!PICTURED.has(entry.kind)) throw badRequest('Only people and creatures have pictures.');
      const file = await receiveFile(req, PORTRAIT_MAX_BYTES);
      try {
        if (!sniffImage(await readHead(file.path))) throw badRequest('Choose a PNG, JPEG or WebP picture.');
        await setNpcPortrait(campaignId, entityId, file.storageName);
      } catch (err) {
        await discard(file);
        throw err;
      }
      // An entry deleted while the picture was on its way leaves nothing behind.
      await sweepNpcPortraits(campaignId);
      getRoom(campaignId)?.broadcast({ type: 'state_changed' });
      return { portrait: npcPortraitUrl(campaignId, entityId, file.storageName) };
    },
  );

  app.delete<{ Params: { id: string; entityId: string } }>(
    '/api/campaigns/:id/entities/:entityId/portrait',
    async (req): Promise<{ ok: true }> => {
      const { campaignId } = await requireMember(req, 'owner');
      await setNpcPortrait(campaignId, parse(uuid, req.params.entityId), null);
      getRoom(campaignId)?.broadcast({ type: 'state_changed' });
      return { ok: true };
    },
  );

  /**
   * Anyone at the table may see the picture of someone the party has met. Of
   * anyone else (still planned, or bookkeeping) only the owners may: to a
   * player there is no such picture, so it cannot give away who is coming.
   */
  app.get<{ Params: { id: string; entityId: string } }>(
    '/api/campaigns/:id/entities/:entityId/portrait',
    async (req, reply) => {
      const { campaignId, role } = await requireMember(req);
      const entityId = parse(uuid, req.params.entityId);
      const row = await q1<{ portrait: string; hidden: boolean; in_codex: boolean }>(
        `SELECT p.portrait, e.hidden, e.in_codex
           FROM npc_portraits p JOIN entities e ON e.id = p.entity_id AND e.campaign_id = p.campaign_id
          WHERE p.entity_id = $1 AND p.campaign_id = $2`,
        [entityId, campaignId],
      );
      if (!row) throw notFound('No picture');
      if (role !== 'owner' && !playerVisible({ inCodex: row.in_codex, hidden: row.hidden })) {
        throw notFound('No picture');
      }
      const path = uploadPath(row.portrait);
      const type = sniffImage(await readHead(path).catch(() => Buffer.alloc(0)));
      if (!type) throw notFound('No picture');
      // The address changes with every new picture, so this one never goes stale.
      return reply
        .header('Cache-Control', 'private, max-age=31536000, immutable')
        .type(type)
        .send(createReadStream(path));
    },
  );
}
