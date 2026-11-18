import { z } from 'zod';
import { pgStore, type Actor } from '../agent/store.js';
import { ToolError } from '../agent/tools.js';
import { q, q1 } from '../db/pool.js';
import { openRoom, type Room } from '../realtime/room.js';
import { dmModeOf } from './mode.js';
import type { ConnectorUser } from './tokens.js';
import type { WorkKind } from './work.js';

export { ToolError };

/** One tool call from the connector, with who is making it and on which address. */
export interface ConnectorCall {
  user: ConnectorUser;
  signal: AbortSignal;
  /** The campaign the address is pinned to, or null on the account-wide address. */
  campaignId: string | null;
  pinned: boolean;
}

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolImage {
  data: string;
  mimeType: string;
}

export interface ToolOutput {
  text: string;
  isError: boolean;
  images?: ToolImage[];
}

/**
 * When a tool may run, given what Claude holds right now:
 * - any:  always (opening a campaign, waiting for work, dropping a request);
 * - free: when no request is claimed (a claimed turn counts as free);
 * - turn: only while a turn is claimed;
 * - a work kind: only while a request of that kind is claimed.
 */
export type Gate = 'any' | 'free' | 'turn' | WorkKind;

export interface ConnectorTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: ToolAnnotations;
  during: Gate[];
  call(input: unknown, call: ConnectorCall): Promise<ToolOutput>;
}

/** Whether a tool may run while Claude holds `held` (a request kind, or null) and a turn is or is not claimed. */
export function gateAllows(during: Gate[], held: WorkKind | null, turnClaimed: boolean): boolean {
  if (during.includes('any')) return true;
  if (held) return during.includes(held);
  return during.includes('free') || (during.includes('turn') && turnClaimed);
}

export const jsonSchema = (schema: z.ZodType) => {
  const { $schema: _drop, ...rest } = z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>;
  return rest;
};

export interface Spec<S extends z.ZodType> {
  name: string;
  description: string;
  schema: S;
  annotations: ToolAnnotations;
  during: Gate[];
  run(input: z.infer<S>, call: ConnectorCall): Promise<string | { text: string; images?: ToolImage[] }>;
}

/**
 * Claude sometimes escapes the quotes inside a tool argument twice, so a name
 * like Priscilla "Priss" Vane arrives as Priscilla \"Priss\" Vane. Nothing a
 * table writes needs a backslash before a quote, so drop it everywhere.
 */
export function unescapeQuotes(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(/\\(["'])/g, '$1');
  if (Array.isArray(value)) return value.map(unescapeQuotes);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, unescapeQuotes(v)]));
  }
  return value;
}

/** A connector tool from a zod schema and a function. ToolErrors come back to Claude as tool errors. */
export function own<S extends z.ZodType>(spec: Spec<S>): ConnectorTool {
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: jsonSchema(spec.schema),
    annotations: spec.annotations,
    during: spec.during,
    async call(input, call) {
      const parsed = spec.schema.safeParse(unescapeQuotes(input ?? {}));
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((i) => `${i.path.join('.') || 'input'}: ${i.message}`)
          .join('; ');
        return { text: `Invalid arguments: ${issues}`, isError: true };
      }
      try {
        const out = await spec.run(parsed.data, call);
        return typeof out === 'string' ? { text: out, isError: false } : { ...out, isError: false };
      } catch (err) {
        if (err instanceof ToolError) return { text: err.message, isError: true };
        throw err;
      }
    },
  };
}

// ---------------------------------------------------------------- the open campaign

export interface Table {
  id: string;
  name: string;
  phase: 'prep' | 'active';
  status: string;
  opened: boolean;
  systemId: string;
  ownerId: string;
  gmSheets: boolean;
  room: Room;
}

/** The campaign a call acts on: the pinned one, else the one this connection last opened. */
export const campaignOf = (call: ConnectorCall): string | null => call.campaignId ?? call.user.campaignId;

/**
 * The campaign this call acts on, checked again on every call: still owned by
 * the token's user, not archived, and run by Claude. Marks the outside DM as
 * present at the table.
 */
export async function openTable(call: ConnectorCall): Promise<Table> {
  const id = campaignOf(call);
  if (!id) throw new ToolError('No campaign is open. Call list_campaigns, then open_campaign.');
  const row = await q1<{
    name: string;
    phase: 'prep' | 'active';
    status: string;
    opened: boolean;
    system_id: string;
    owner_id: string;
    settings: { dm?: unknown; sheets?: string };
    owns: boolean;
  }>(
    `SELECT c.name, c.phase, c.status, c.opened_at IS NOT NULL AS opened, c.system_id, c.owner_id, c.settings,
            c.owner_id = $2 AS owns
       FROM campaigns c WHERE c.id = $1`,
    [id, call.user.userId],
  );
  if (!row || !row.owns) throw new ToolError('That campaign is not one of yours. Open another one.');
  if (row.status !== 'active') throw new ToolError('That campaign is archived. Open another one.');
  if (dmModeOf(row.settings) !== 'claude') {
    throw new ToolError(
      `"${row.name}" is run by the built-in AI. To run it from here, the owner opens the campaign in the app, ` +
        'then Manage → Dungeon Master → Switch to Claude.',
    );
  }
  const room = await openRoom(id);
  room.touchDm();
  return {
    id,
    name: row.name,
    phase: row.phase,
    status: row.status,
    opened: row.opened,
    systemId: row.system_id,
    ownerId: row.owner_id,
    gmSheets: row.settings.sheets === 'gm',
    room,
  };
}

export function requirePlay(t: Table): void {
  if (t.phase !== 'active') {
    throw new ToolError(
      'The campaign is still in the lobby. You can prepare (notebook, codex entries, scene), but turns start ' +
        'once it begins: begin_adventure, or the owner taps Begin the adventure in the app.',
    );
  }
}

/** Everyone at the table, so the state snapshot does not mark absent players as away. */
export async function members(campaignId: string): Promise<Actor[]> {
  const [people, chars] = await Promise.all([
    q<{ id: string; display_name: string }>(
      `SELECT u.id, u.display_name FROM campaign_members m JOIN users u ON u.id = m.user_id WHERE m.campaign_id = $1`,
      [campaignId],
    ),
    pgStore.characters(campaignId),
  ]);
  return people.map((p) => ({
    userId: p.id,
    displayName: p.display_name,
    characterName: chars.find((c) => c.playerIds.includes(p.id))?.name ?? null,
  }));
}

export const memorySchema = z.object({
  kind: z.enum(['fact', 'thread', 'promise']).default('fact'),
  content: z.string().trim().min(3).max(400),
  importance: z.number().int().min(1).max(5).default(3),
});

export const workIdSchema = z.string().uuid().describe('The id of the request, from wait_for_work');
