import { z } from 'zod';
import { companionAction, companionPrompt, knownEntries, publicStory } from '../agent/companion.js';
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

// A turn tells the DM which own-AI companions still have to act in it.
addTurnNote(async (t, turn) => {
  const waiting = (await pgStore.characters(t.id))
    .filter((c) => c.controller === 'agent' && !(turn.companionsActed ?? []).includes(c.name))
    .map((c) => c.name);
  return waiting.length ? `Companions with an AI of their own, not yet acted: ${waiting.join(', ')}.` : '';
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
      'Record what a companion with an AI of its own does this turn, in the first person, in one to three ' +
      'sentences, or PASS. Once per companion per turn.',
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
