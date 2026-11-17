import { z } from 'zod';
import {
  companionAction,
  companionOrder,
  companionPrompt,
  knownEntries,
  publicStory,
} from '../agent/companion.js';
import { pgStore, type CharRow } from '../agent/store.js';
import { infoOf, loadCampaign } from '../realtime/room.js';
import { own, openTable, ToolError, type ConnectorTool, type Table } from './toolkit.js';
import { addTools, addTurnNote } from './tools.js';

/**
 * Companions with an AI of their own, under Claude. The DM starts a blind
 * subagent per companion and hands it only the name; the subagent reads its
 * own view here, which holds nothing but public material, and records its
 * action. The blindness comes from the subagent's empty context, not from the
 * server telling callers apart, so the DM calling these itself is harmless.
 */

/** The own-AI companion called `name`, in a turn Claude holds. */
async function ownAiCompanion(
  t: Table,
  name: string,
): Promise<{ c: CharRow; turn: NonNullable<Table['room']['desk']['turn']> }> {
  const turn = t.room.desk.turn;
  if (!turn?.claimed) throw new ToolError('No turn is being resolved. These tools work only during a turn.');
  const chars = (await pgStore.characters(t.id)).filter((c) => c.controller === 'agent');
  const want = name.trim().toLowerCase();
  const c =
    chars.find((x) => x.name.toLowerCase() === want) ??
    chars.find((x) => x.name.toLowerCase().startsWith(want));
  if (!c) {
    throw new ToolError(
      `No companion with an AI of their own is called "${name}". ${chars.length ? `They are: ${chars.map((x) => x.name).join(', ')}.` : 'There are none in this party.'}`,
    );
  }
  return { c, turn };
}

// A turn tells the DM which own-AI companions still have to act in it, in the order they
// go: one after another, so each sees what the players and the ones before it did. The
// order is picked once per turn so reading the turn again does not reshuffle it.
addTurnNote(async (t, turn) => {
  const own = (await pgStore.characters(t.id)).filter((c) => c.controller === 'agent');
  const known = new Set(turn.companionOrder ?? []);
  const fresh = own.filter((c) => !known.has(c.name));
  if (fresh.length) {
    turn.companionOrder = [
      ...(turn.companionOrder ?? []),
      ...companionOrder(turn.input, fresh).map((c) => c.name),
    ];
  }
  const names = new Set(own.map((c) => c.name));
  const waiting = (turn.companionOrder ?? []).filter(
    (n) => names.has(n) && !(turn.companionsActed ?? []).includes(n),
  );
  if (!waiting.length) return '';
  return waiting.length === 1
    ? `Companion with an AI of their own, not yet acted: ${waiting[0]}.`
    : `Companions with an AI of their own, not yet acted, to go one at a time in this order: ${waiting.join(', ')}.`;
});

export const COMPANION_TOOLS: ConnectorTool[] = [
  own({
    name: 'companion_view',
    description:
      'For a companion with an AI of its own, during a turn: who the character is, what it has seen and heard, ' +
      'and what the others are doing this turn. Holds nothing the character could not know.',
    schema: z.object({ character: z.string().trim().min(1).max(80).describe('The companion’s name') }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    during: ['turn'],
    async run(input, call) {
      const t = await openTable(call);
      const { c, turn } = await ownAiCompanion(t, input.character);
      const [campaign, story, scene, party, entities] = await Promise.all([
        loadCampaign(t.id),
        publicStory(t.id, turn.id),
        pgStore.scene(t.id),
        pgStore.characters(t.id),
        pgStore.entities(t.id),
      ]);
      const prompt = companionPrompt({
        campaign: infoOf(t.id, campaign),
        character: c,
        story,
        scene,
        party,
        known: knownEntries(entities),
        turn: turn.input,
      });
      return [
        prompt.system,
        prompt.storySoFar,
        prompt.text,
        `Decide what ${c.name} does, then call companion_act once with it, or with PASS.`,
      ]
        .filter(Boolean)
        .join('\n\n');
    },
  }),

  own({
    name: 'companion_act',
    description:
      'Record what a companion with an AI of its own does this turn, written in the third person like a ' +
      'player describing their character, in one to three sentences, or PASS. Once per companion per turn.',
    schema: z.object({
      character: z.string().trim().min(1).max(80).describe('The companion’s name'),
      action: z.string().trim().min(1).max(600).describe('What they attempt or say, or PASS'),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    during: ['turn'],
    async run(input, call) {
      const t = await openTable(call);
      const { c } = await ownAiCompanion(t, input.character);
      const text = companionAction(input.action);
      if (!(await t.room.companionActed(c.name, text)))
        throw new ToolError(`${c.name} has already acted this turn.`);
      return text ? 'Recorded.' : 'Passed.';
    },
  }),
];

addTools(...COMPANION_TOOLS);
