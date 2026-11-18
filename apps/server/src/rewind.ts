import type pg from 'pg';
import { q, q1, tx, type Queryable } from './db/pool.js';
import { badRequest, conflict, notFound } from './errors.js';
import { carrySheets } from './sheet-versions.js';

/**
 * Rewinding play. The game state is saved before every turn is resolved and
 * before the opening scene, so the host can take the story back to any of
 * the DM's narrations, or to the start of a session, and the world goes back
 * with it. Characters keep their names, players and personas (those belong to
 * the players, not to play); everything play changes is restored.
 */

/** Tables restored row for row. Each has a campaign_id and nothing references its rows by key. */
const ROW_TABLES = ['entities', 'flags', 'gm_notes', 'memories', 'summaries'] as const;
/** Snapshots kept per campaign. Older points can no longer be rewound to. */
const KEEP = 300;
/**
 * Bump when a migration changes the columns of the tables a snapshot copies
 * (characters and ROW_TABLES). Snapshots of another version are refused at
 * rewind time with a clear message, not half-restored into the wrong shape.
 * Snapshots saved before there was a version are version 1.
 */
const SNAPSHOT_VERSION = 1;

/** Save the game as it stands now. Call before the DM changes anything for a turn. */
export async function snapshotState(
  campaignId: string,
  turnId: string | null,
  on?: Queryable,
): Promise<void> {
  const rows = ROW_TABLES.map(
    (t) => `'${t}', (SELECT coalesce(jsonb_agg(to_jsonb(r)), '[]') FROM ${t} r WHERE r.campaign_id = $1)`,
  ).join(',\n         ');
  await q(
    `INSERT INTO state_snapshots (campaign_id, after_message_id, turn_id, state)
     SELECT $1, coalesce((SELECT max(id) FROM messages WHERE campaign_id = $1), 0), $2,
       jsonb_build_object(
         'version', ${SNAPSHOT_VERSION},
         'scene', (SELECT scene FROM campaigns WHERE id = $1),
         'sheetVersion', (SELECT sheet_version FROM campaigns WHERE id = $1),
         'characters', (SELECT coalesce(jsonb_agg(jsonb_build_object(
             'id', id, 'hp', hp, 'max_hp', max_hp, 'temp_hp', temp_hp, 'conditions', conditions,
             'inventory', inventory, 'sheet', sheet, 'whereabouts', whereabouts)), '[]')
           FROM characters WHERE campaign_id = $1),
         ${rows})`,
    [campaignId, turnId],
    on,
  );
  await q(
    `DELETE FROM state_snapshots WHERE campaign_id = $1 AND id < (
       SELECT min(id) FROM (SELECT id FROM state_snapshots WHERE campaign_id = $1 ORDER BY id DESC LIMIT $2) k)`,
    [campaignId, KEEP],
    on,
  );
}

async function restore(c: pg.PoolClient, campaignId: string, state: Record<string, unknown>): Promise<void> {
  if (((state.version as number | undefined) ?? 1) !== SNAPSHOT_VERSION) {
    throw conflict(
      'The game state from that point was saved by an older version of the app and can no longer be restored, so the story cannot go back that far.',
      'too_old',
    );
  }
  await q('UPDATE campaigns SET scene = $2 WHERE id = $1', [campaignId, state.scene ?? ''], c);
  // Sheets saved before the host updated the campaign's sheet are carried to the version it is on now.
  // Snapshots from before there were versions were all saved on the first.
  const now = await q1<{ system_id: string; sheet_version: number }>(
    'SELECT system_id, sheet_version FROM campaigns WHERE id = $1',
    [campaignId],
    c,
  );
  const characters = now
    ? await carrySheets(
        now.system_id,
        (state.sheetVersion as number | undefined) ?? 1,
        now.sheet_version,
        (state.characters ?? []) as { sheet: Record<string, unknown> }[],
        c,
      )
    : state.characters;
  // Characters made since are kept as they are: they belong to the players.
  await q(
    `UPDATE characters c SET hp = (s->>'hp')::int, max_hp = (s->>'max_hp')::int, temp_hp = (s->>'temp_hp')::int,
            conditions = s->'conditions', inventory = s->'inventory', sheet = s->'sheet',
            whereabouts = coalesce(s->>'whereabouts', ''), updated_at = now()
       FROM jsonb_array_elements($2::jsonb) s
      WHERE c.campaign_id = $1 AND c.id = (s->>'id')::uuid`,
    [campaignId, JSON.stringify(characters ?? [])],
    c,
  );
  for (const t of ROW_TABLES) {
    await q(`DELETE FROM ${t} WHERE campaign_id = $1`, [campaignId], c);
    await q(
      `INSERT INTO ${t} SELECT * FROM jsonb_populate_recordset(NULL::${t}, $1::jsonb)`,
      [JSON.stringify(state[t] ?? [])],
      c,
    );
  }
  // Messages that were folded into a summary that no longer exists are unsummarised again.
  await q(
    `UPDATE messages SET summary_id = NULL
      WHERE campaign_id = $1 AND summary_id IS NOT NULL
        AND summary_id NOT IN (SELECT id FROM summaries WHERE campaign_id = $1)`,
    [campaignId],
    c,
  );
}

export interface RewindResult {
  /** No narration is left, so the DM writes the opening scene again. */
  reopen: boolean;
  /** Messages removed. */
  removed: number;
}

/**
 * Take the campaign back to just after message `keep` (0: before anything
 * was said): later messages, turns, rolls and sessions go, and the game state
 * returns to how it stood at that point.
 */
async function rewindAfter(
  campaignId: string,
  keep: number,
  /** The session play resumes in; by default the one the kept message belongs to. */
  resumeIn: string | undefined,
  /** What happened, as Claude is told it ("The host took the story back to…"). */
  what: string,
): Promise<RewindResult> {
  return tx(async (c) => {
    const at =
      keep > 0
        ? await q1<{ created_at: Date; session_id: string | null }>(
            'SELECT created_at, session_id FROM messages WHERE id = $1 AND campaign_id = $2',
            [keep, campaignId],
            c,
          )
        : { created_at: new Date(0), session_id: null };
    if (!at) throw notFound('That message is not in this campaign.');
    const snap = await q1<{ id: number; state: Record<string, unknown>; created_at: Date }>(
      `SELECT id, state, created_at FROM state_snapshots
        WHERE campaign_id = $1 AND after_message_id >= $2 ORDER BY after_message_id, id LIMIT 1`,
      [campaignId, keep],
      c,
    );
    const laterNarration = await q1(
      `SELECT 1 FROM messages WHERE campaign_id = $1 AND id > $2 AND kind = 'dm' LIMIT 1`,
      [campaignId, keep],
      c,
    );
    if (laterNarration && !snap) {
      throw conflict(
        'The game state from that point was not saved (it is from before rewinding existed, or too long ago), so the story cannot go back that far.',
        'too_old',
      );
    }

    // Turns that began after the kept message. What belongs to one goes with it, even an action sent
    // while the DM was still writing (it has an older id than the scene but belongs to the next turn).
    const gone = `(SELECT id FROM turns WHERE campaign_id = $1 AND opened_at > $2)`;
    const removed = await q(
      `DELETE FROM messages WHERE campaign_id = $1 AND (id > $3 OR turn_id IN ${gone}) RETURNING id`,
      [campaignId, at.created_at, keep],
      c,
    );
    await q(
      `DELETE FROM dice_rolls WHERE campaign_id = $1 AND (created_at > $2 OR turn_id IN ${gone})`,
      [campaignId, at.created_at],
      c,
    );
    // Rolls the DM asked for after that point were never asked; ones answered or dropped since are open again.
    await q(
      `DELETE FROM roll_requests WHERE campaign_id = $1 AND created_at > $2`,
      [campaignId, at.created_at],
      c,
    );
    await q(
      `UPDATE roll_requests SET status = 'pending', closed_at = NULL, roll_id = NULL
        WHERE campaign_id = $1 AND closed_at > $2`,
      [campaignId, at.created_at],
      c,
    );
    if (snap) {
      await q(
        `DELETE FROM state_events WHERE campaign_id = $1 AND (created_at > $3 OR turn_id IN ${gone})`,
        [campaignId, at.created_at, snap.created_at],
        c,
      );
      await restore(c, campaignId, snap.state);
      // Futures that no longer happened.
      await q('DELETE FROM state_snapshots WHERE campaign_id = $1 AND id > $2', [campaignId, snap.id], c);
    }
    await q('DELETE FROM turns WHERE campaign_id = $1 AND opened_at > $2', [campaignId, at.created_at], c);
    const droppedSessions = await q<{ id: string }>(
      `DELETE FROM play_sessions s WHERE s.campaign_id = $1 AND s.started_at > $2
          AND s.id IS DISTINCT FROM $3::uuid
          AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.id)
        RETURNING s.id`,
      [campaignId, at.created_at, resumeIn ?? null],
      c,
    );
    // Play picks up in the session the kept message belongs to, or the one asked for.
    const session = resumeIn ?? at.session_id;
    if (session) {
      // Picked up now, so old messages do not make it look abandoned and get it wrapped up at once.
      await q(
        `UPDATE play_sessions SET ended_at = CASE WHEN id = $2 THEN NULL ELSE coalesce(ended_at, now()) END,
                resumed_at = CASE WHEN id = $2 THEN now() ELSE resumed_at END
          WHERE campaign_id = $1 AND (id = $2 OR ended_at IS NULL)`,
        [campaignId, session],
        c,
      );
    }
    // Chronicle requests about the play that is gone are dropped, and only those: the session
    // play went back into (its summary would cover erased play), the sessions removed, and
    // stretch summaries still being written. Other sessions' requests are still good.
    const affected = [...droppedSessions.map((s) => s.id), session, at.session_id].flatMap((id) =>
      id ? [`session:${id}`] : [],
    );
    await q(
      `UPDATE dm_work SET status = 'cancelled', finished_at = now()
        WHERE campaign_id = $1 AND kind = 'chronicle' AND status IN ('waiting', 'claimed')
          AND (subject_id = 'chunk' OR subject_id = ANY($2::text[]))`,
      [campaignId, affected],
      c,
    );
    const narrated = await q1(
      `SELECT 1 FROM messages WHERE campaign_id = $1 AND kind = 'dm' LIMIT 1`,
      [campaignId],
      c,
    );
    const note =
      `${what} ${removed.length} message${removed.length === 1 ? '' : 's'} after that point ` +
      'never happened and are gone, and the game state (hit points, inventory, codex, flags, notebook, scene, ' +
      'memories and the story so far) went back to how it stood then. Anything you remember from after that ' +
      'point is wrong: forget it and continue from here.' +
      (narrated ? '' : ' The opening scene is yours to write again.');
    await q(
      `UPDATE campaigns SET brief_at = NULL, resting_since = NULL,
              opened_at = CASE WHEN $2 THEN opened_at ELSE NULL END,
              rewound_at = now(), rewound_note = $3
        WHERE id = $1`,
      [campaignId, !!narrated, note],
      c,
    );
    return { reopen: !narrated, removed: removed.length };
  });
}

const excerpt = (text: string, max = 240) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};

/** Back to just after one of the DM's narrations. */
export async function rewindTo(campaignId: string, messageId: number): Promise<RewindResult> {
  const m = await q1<{ kind: string; content: string }>(
    'SELECT kind, content FROM messages WHERE id = $1 AND campaign_id = $2',
    [messageId, campaignId],
  );
  if (!m) throw notFound('That message is not in this campaign.');
  if (m.kind !== 'dm')
    throw badRequest('The story can be taken back to one of the Dungeon Master’s narrations.');
  return rewindAfter(
    campaignId,
    messageId,
    undefined,
    `The host rewound the story to just after this scene of yours: "${excerpt(m.content)}".`,
  );
}

/**
 * Start the latest session again from its beginning: back to the last thing
 * said before it. For the first session that is before the opening scene,
 * which the DM then writes again.
 */
export async function restartSession(campaignId: string): Promise<RewindResult & { number: number }> {
  const s = await q1<{ id: string; number: number; first: string | null }>(
    `SELECT s.id, s.number, (SELECT min(id) FROM messages m WHERE m.session_id = s.id) AS first
       FROM play_sessions s WHERE s.campaign_id = $1 ORDER BY s.number DESC LIMIT 1`,
    [campaignId],
  );
  if (!s?.first) throw conflict('Nothing has been played in this session yet.');
  const before = await q1<{ id: string | null }>(
    'SELECT max(id) AS id FROM messages WHERE campaign_id = $1 AND id < $2',
    [campaignId, s.first],
  );
  const out = await rewindAfter(
    campaignId,
    Number(before?.id ?? 0),
    s.id,
    `The host started session ${s.number} over from its beginning.`,
  );
  return { ...out, number: s.number };
}
