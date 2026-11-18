import { randomBytes } from 'node:crypto';
import type { GmGuide, GuideTopicId } from '@tavern/protocol';
import { q, q1 } from './db/pool.js';

/**
 * A system's GM guide: how to run the game, topic by topic, and rulings that
 * settle what the rulebooks leave open. It is written in the workshop (by the
 * AI, with the admins) and read by the GM of every table on the system, the
 * built-in one and Claude alike, from its next turn on.
 */

export const TOPICS: { id: GuideTopicId; title: string; about: string }[] = [
  {
    id: 'resolution',
    title: 'Resolving actions',
    about: 'the core mechanic: what is rolled, against what, and what the results mean',
  },
  {
    id: 'rolls',
    title: 'Calling for rolls',
    about: 'when to ask for a roll, who rolls what, and which sheet values go into it',
  },
  {
    id: 'harm',
    title: 'Harm and recovery',
    about: 'damage, conditions, healing, and what happens at the limits',
  },
  { id: 'advancement', title: 'Advancement', about: 'how characters grow: experience, levels, milestones' },
  {
    id: 'scenes',
    title: 'Running scenes',
    about: 'how play moves: structure, pacing, downtime and the shape of a session',
  },
  { id: 'other', title: 'Other notes', about: 'anything else the GM must know to run this system well' },
];
export const TOPIC_IDS = TOPICS.map((t) => t.id) as [GuideTopicId, ...GuideTopicId[]];

export const GUIDE_LIMITS = { topic: 2000, ruling: 400, rulings: 40 } as const;

export const EMPTY_GUIDE: GmGuide = { version: 1, topics: [], rulings: [] };

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Whatever is stored, as a guide: unknown topics and empty entries are left out. */
export function toGuide(raw: unknown): GmGuide {
  if (!isObject(raw)) return EMPTY_GUIDE;
  const topics = (Array.isArray(raw.topics) ? raw.topics : [])
    .filter(isObject)
    .filter((t) => TOPIC_IDS.includes(t.id as GuideTopicId) && typeof t.text === 'string' && t.text.trim())
    .map((t) => ({ id: t.id as GuideTopicId, text: (t.text as string).trim().slice(0, GUIDE_LIMITS.topic) }));
  const rulings = (Array.isArray(raw.rulings) ? raw.rulings : [])
    .filter(isObject)
    .filter((r) => typeof r.id === 'string' && typeof r.text === 'string' && r.text.trim())
    .map((r) => ({
      id: r.id as string,
      text: (r.text as string).trim().slice(0, GUIDE_LIMITS.ruling),
      createdAt: typeof r.createdAt === 'string' ? r.createdAt : new Date(0).toISOString(),
    }));
  // One entry per topic, in the guide's own order.
  const order = new Map(TOPIC_IDS.map((id, i) => [id, i]));
  const unique = [...new Map(topics.map((t) => [t.id, t])).values()].sort(
    (a, b) => order.get(a.id)! - order.get(b.id)!,
  );
  return { version: 1, topics: unique, rulings };
}

export async function loadGuide(systemId: string): Promise<GmGuide> {
  const row = await q1<{ gm_guide: unknown }>('SELECT gm_guide FROM game_systems WHERE id = $1', [systemId]);
  return toGuide(row?.gm_guide);
}

export async function saveGuide(systemId: string, guide: GmGuide): Promise<void> {
  await q('UPDATE game_systems SET gm_guide = $2 WHERE id = $1', [systemId, JSON.stringify(toGuide(guide))]);
}

/** The guide with one topic rewritten. Empty text takes the topic out. */
export function withTopic(guide: GmGuide, id: GuideTopicId, text: string): GmGuide {
  const rest = guide.topics.filter((t) => t.id !== id);
  const clean = text.trim().slice(0, GUIDE_LIMITS.topic);
  return toGuide({ ...guide, topics: clean ? [...rest, { id, text: clean }] : rest });
}

/** The guide with a ruling added, and the new ruling's id. */
export function withRuling(guide: GmGuide, text: string): { guide: GmGuide; id: string } | undefined {
  if (guide.rulings.length >= GUIDE_LIMITS.rulings) return undefined;
  const id = randomBytes(4).toString('hex');
  const ruling = { id, text: text.trim().slice(0, GUIDE_LIMITS.ruling), createdAt: new Date().toISOString() };
  return { guide: toGuide({ ...guide, rulings: [...guide.rulings, ruling] }), id };
}

/** The guide without a ruling; undefined when there is no ruling by that id. */
export function withoutRuling(guide: GmGuide, id: string): GmGuide | undefined {
  if (!guide.rulings.some((r) => r.id === id)) return undefined;
  return { ...guide, rulings: guide.rulings.filter((r) => r.id !== id) };
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * The guide as the GM reads it in its instructions. Empty when nothing has
 * been written, so the instructions of a system without one are unchanged.
 */
export function guideText(raw: unknown): string {
  const guide = toGuide(raw);
  const parts = TOPICS.flatMap((t) => {
    const topic = guide.topics.find((x) => x.id === t.id);
    return topic ? [`### ${t.title}\n${topic.text}`] : [];
  });
  if (guide.rulings.length)
    parts.push(`### Rulings for every table\n${guide.rulings.map((r) => `- ${oneLine(r.text)}`).join('\n')}`);
  return parts.join('\n\n');
}
