import { z } from 'zod';
import { savedLine } from '../agent/builder.js';
import { pgStore, type CharRow } from '../agent/store.js';
import { endCurrentSession, insertCampaign, startCampaign, updateCampaign } from '../campaign.js';
import { q, q1 } from '../db/pool.js';
import { HttpError } from '../errors.js';
import { enforceLimit, rateLimiters } from '../http/security.js';
import { applyDraft, type Control, type Viewer } from '../party.js';
import { config } from '../config.js';
import { setHostSave } from './guide.js';
import { setTokenCampaign } from './tokens.js';
import { campaignBrief } from './tools.js';
import { addTools } from './tools.js';
import { currentWork } from './work.js';
import { own, openTable, ToolError, type ConnectorTool, type Table } from './toolkit.js';

/**
 * Tools for setting a campaign up from Claude, talking with the host as their
 * co-DM: make a campaign, change it, build the party, begin, pause.
 */

/** Run something the app's routes also run; their refusals come back to Claude as tool errors. */
async function asTool<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof HttpError && err.status < 500) throw new ToolError(err.message);
    throw err;
  }
}

function findMember(chars: CharRow[], who: string): CharRow {
  const want = who.trim().toLowerCase();
  const hit =
    chars.find((c) => c.name.toLowerCase() === want) ??
    chars.find((c) => c.name.toLowerCase().startsWith(want));
  if (!hit)
    throw new ToolError(
      `No party member called "${who}". Party: ${chars.map((c) => c.name).join(', ') || 'none yet'}.`,
    );
  return hit;
}

// The host building with Claude in their own conversation: as the owner, for themselves or the table.
setHostSave(async (input, t) => {
  const { work_id: _w, character, played_by, companion, ...patch } = input;
  const owner: Viewer = { userId: t.ownerId, role: 'owner' };
  let characterId: string | null = null;
  let control: Control | undefined;
  if (character) {
    characterId = findMember(await pgStore.characters(t.id), character).id;
  } else {
    const kind = companion ? 'npc' : 'pc';
    const who = (played_by ?? 'me').trim().toLowerCase();
    if (who === 'me') control = { kind, controller: 'player', playerIds: [t.ownerId] };
    else if (who === 'dm' || who === 'claude') control = { kind, controller: 'gm', playerIds: [] };
    else {
      const member = await q1<{ id: string }>(
        `SELECT u.id FROM campaign_members m JOIN users u ON u.id = m.user_id
          WHERE m.campaign_id = $1 AND (lower(u.display_name) = $2 OR lower(u.username) = $2)`,
        [t.id, who],
      );
      if (!member)
        throw new ToolError(
          `Nobody called "${played_by}" is at this table. Use "me", "dm" or a player's name.`,
        );
      control = { kind, controller: 'player', playerIds: [member.id] };
    }
  }
  const out = await asTool(() => applyDraft(t.id, characterId, owner, patch, control));
  t.room.partyChanged();
  return savedLine(out);
});

const sheetsSchema = z
  .enum(['players', 'gm'])
  .describe('"players" keep their own sheets, or "gm": you update them');

function describeCharacter(c: CharRow, names: Map<string, string>): string {
  return JSON.stringify({
    name: c.name,
    kind: c.kind === 'npc' ? 'companion' : 'player character',
    played_by:
      c.controller === 'gm'
        ? 'you, the DM'
        : c.controller === 'agent'
          ? 'an AI of its own'
          : c.playerIds.map((id) => names.get(id) ?? 'a player').join(', ') || 'nobody yet',
    max_hp: c.maxHp,
    hp: c.hp,
    conditions: c.conditions,
    fields: c.sheet,
    inventory: c.inventory,
    persona: c.persona,
  });
}

export const SETUP_TOOLS: ConnectorTool[] = [
  own({
    name: 'list_systems',
    description: 'List the game systems (rulebooks) this server has, for create_campaign.',
    schema: z.object({}),
    annotations: { readOnlyHint: true, openWorldHint: false },
    during: ['any'],
    async run() {
      const rows = await q<{ name: string; description: string }>(
        'SELECT name, description FROM game_systems ORDER BY name',
      );
      if (!rows.length) return 'This server has no game systems yet. The admin adds them in the app.';
      return rows.map((r) => `- ${r.name}: ${r.description || 'no description'}`).join('\n');
    },
  }),

  own({
    name: 'create_campaign',
    description:
      'Start a new campaign that you run, owned by the host. It begins in the lobby, where the party is made. ' +
      'Returns the campaign opened, as open_campaign does, and a link the host can share in the app.',
    schema: z.object({
      name: z.string().trim().min(2).max(80),
      system: z
        .string()
        .trim()
        .min(1)
        .max(120)
        .describe('The game system, by name (from list_systems) or id'),
      premise: z
        .string()
        .trim()
        .max(2000)
        .default('')
        .describe('A few lines that set the world and the opening'),
      tone: z.string().trim().max(300).default(''),
      sheets: sheetsSchema.default('players'),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    during: ['any'],
    async run(input, call) {
      if (call.pinned)
        throw new ToolError('This connection is for one campaign. Make new ones from the app.');
      enforceLimit(rateLimiters().auth, `connector-create:${call.user.tokenId}`);
      const want = input.system.toLowerCase();
      const systems = await q<{ id: string; name: string }>(
        'SELECT id, name FROM game_systems ORDER BY name',
      );
      const system =
        systems.find((s) => s.id === input.system) ??
        systems.find((s) => s.name.toLowerCase() === want) ??
        systems.find((s) => s.name.toLowerCase().includes(want));
      if (!system)
        throw new ToolError(
          `No game system called "${input.system}". This server has: ${systems.map((s) => s.name).join(', ') || 'none'}.`,
        );
      const id = await insertCampaign({
        ownerId: call.user.userId,
        systemId: system.id,
        name: input.name,
        premise: input.premise,
        tone: input.tone,
        sheets: input.sheets,
        dm: 'claude',
      });
      await setTokenCampaign(call.user.tokenId, id);
      call.user.campaignId = id;
      const brief = await campaignBrief(await openTable(call));
      return `${brief}\n\nApp link: ${new URL(`/c/${id}`, config().baseUrl).toString()}`;
    },
  }),

  own({
    name: 'update_campaign',
    description:
      'Change the open campaign: its name, premise, tone, who keeps the sheets, or how long a turn gathers.',
    schema: z.object({
      name: z.string().trim().min(2).max(80).optional(),
      premise: z.string().trim().max(2000).optional(),
      tone: z.string().trim().max(300).optional(),
      sheets: sheetsSchema.optional(),
      gather_window_seconds: z.number().int().min(5).max(600).optional(),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    during: ['free'],
    async run(input, call) {
      const t = await openTable(call);
      const { gather_window_seconds, ...rest } = input;
      if (!Object.values(input).some((v) => v !== undefined)) throw new ToolError('Nothing to change.');
      await updateCampaign(t.id, { ...rest, gatherWindowSeconds: gather_window_seconds });
      t.room.broadcast({ type: 'state_changed' });
      return 'Updated.';
    },
  }),

  own({
    name: 'begin_adventure',
    description:
      'Take the campaign out of the lobby and begin play, as the host tapping Begin the adventure does. ' +
      'Every player has to have marked themselves ready in the app first; if someone has not, this says ' +
      'who. Returns the instructions for the opening scene.',
    schema: z.object({}),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    during: ['free'],
    async run(_input, call) {
      const t = await openTable(call);
      await asTool(() => startCampaign(t.id));
      return `The adventure has begun. Call wait_for_work for the opening scene.`;
    },
  }),

  own({
    name: 'end_session',
    description:
      'Close the session in progress, as the host does at the end of a night’s play. You are then asked to ' +
      'write that session’s chronicle. The table goes to the recap screen, and play resumes when every ' +
      'player is ready and the host starts the next session in the app.',
    schema: z.object({}),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    during: ['free'],
    async run(_input, call) {
      const t = await openTable(call);
      const n = await asTool(() => endCurrentSession(t.id));
      return `Session ${n} is closed. Its chronicle is waiting for you: call wait_for_work.`;
    },
  }),

  own({
    name: 'get_character',
    description:
      'Read one party member’s whole sheet: hit points, fields, inventory, persona and who plays them. In a ' +
      'guide request, only the character being built.',
    schema: z.object({ character: z.string().trim().min(1).max(80).describe('The character’s name') }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    during: ['free', 'guide'],
    async run(input, call) {
      const t = await openTable(call);
      const chars = await pgStore.characters(t.id);
      const c = findMember(chars, input.character);
      const held = await currentWork(t.id);
      if (held?.kind === 'guide') {
        const thread = await q1<{ character_id: string | null }>(
          'SELECT character_id FROM builder_threads WHERE id = $1',
          [held.subjectId],
        );
        if (thread?.character_id !== c.id)
          throw new ToolError('In a guide request you can read only the character being built.');
      }
      const people = await q<{ id: string; display_name: string }>(
        `SELECT u.id, u.display_name FROM campaign_members m JOIN users u ON u.id = m.user_id WHERE m.campaign_id = $1`,
        [t.id],
      );
      return describeCharacter(c, new Map(people.map((p) => [p.id, p.display_name])));
    },
  }),
];

addTools(...SETUP_TOOLS);

export type { Table };
