import type { ChatMessage, Citation, DiceRoll, EntityRef, MessageKind } from '@tavern/protocol';
import { q, q1 } from '../db/pool.js';

interface Row {
  id: number;
  kind: MessageKind;
  turn_id: string | null;
  user_id: string | null;
  username: string | null;
  display_name: string | null;
  character_name: string | null;
  content: string;
  meta: {
    citations?: Citation[];
    rolls?: DiceRoll[];
    refs?: EntityRef[];
    redacted?: boolean;
    ai?: boolean;
  };
  created_at: Date;
}

const SELECT = `SELECT m.id, m.kind, m.turn_id, m.user_id, u.username, u.display_name, m.character_name,
                       m.content, m.meta, m.created_at
                  FROM messages m LEFT JOIN users u ON u.id = m.user_id`;

function toChat(r: Row): ChatMessage {
  return {
    id: r.id,
    kind: r.kind,
    turnId: r.turn_id,
    user: r.user_id
      ? { id: r.user_id, username: r.username ?? '', displayName: r.display_name ?? 'Unknown' }
      : null,
    characterName: r.character_name,
    content: r.content,
    ...(r.meta.citations?.length ? { citations: r.meta.citations } : {}),
    ...(r.meta.rolls?.length ? { rolls: r.meta.rolls } : {}),
    ...(r.meta.refs?.length ? { refs: r.meta.refs } : {}),
    ...(r.meta.redacted ? { redacted: true } : {}),
    ...(r.meta.ai ? { ai: true } : {}),
    createdAt: r.created_at.toISOString(),
  };
}

export interface NewMessage {
  campaignId: string;
  sessionId: string | null;
  turnId: string | null;
  kind: MessageKind;
  userId: string | null;
  characterName?: string | null;
  content: string;
  meta?: Row['meta'];
}

export async function insertMessage(m: NewMessage): Promise<ChatMessage> {
  const row = await q1<{ id: number }>(
    `INSERT INTO messages (campaign_id, session_id, turn_id, kind, user_id, character_name, content, meta)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [
      m.campaignId,
      m.sessionId,
      m.turnId,
      m.kind,
      m.userId,
      m.characterName ?? null,
      m.content,
      JSON.stringify(m.meta ?? {}),
    ],
  );
  return (await getMessage(row!.id))!;
}

export async function getMessage(id: number): Promise<ChatMessage | undefined> {
  const row = await q1<Row>(`${SELECT} WHERE m.id = $1`, [id]);
  return row ? toChat(row) : undefined;
}

/** A page of history, oldest first. `before` is a message id to page backwards from. */
export async function listMessages(
  campaignId: string,
  before: number | null,
  limit: number,
): Promise<ChatMessage[]> {
  const rows = await q<Row>(
    `${SELECT} WHERE m.campaign_id = $1 AND ($2::bigint IS NULL OR m.id < $2) ORDER BY m.id DESC LIMIT $3`,
    [campaignId, before, limit],
  );
  return rows.reverse().map(toChat);
}
