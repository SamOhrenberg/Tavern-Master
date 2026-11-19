import type { EntityFull } from '@tavern/protocol';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { fullEntity } from '../agent/codex.js';
import { pgStore } from '../agent/store.js';
import { q, q1 } from '../db/pool.js';
import { conflict, notFound, parse } from '../errors.js';
import { requireMember } from '../http/membership.js';
import { getRoom } from '../realtime/room.js';

/**
 * The campaign's owners editing the codex by hand: the people and creatures
 * on the NPCs tab, and any other entry. These are the only routes that send
 * spoilers (unrevealed secrets, hidden stat block lines, entries the party
 * has not met), so every one of them is for owners alone. The DM reads the
 * same rows, so what an owner changes is what it plays from.
 */

const uuid = z.string().uuid();
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
      getRoom(campaignId)?.broadcast({ type: 'state_changed' });
      return { ok: true };
    },
  );
}
