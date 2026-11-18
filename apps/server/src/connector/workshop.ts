import type { WorkshopMessage } from '@tavern/protocol';
import { z } from 'zod';
import type { TurnContext } from '../agent/store.js';
import { pgStore } from '../agent/store.js';
import { dispatchTool, type ToolSpec } from '../agent/tools.js';
import {
  loadSystem,
  postReply,
  questionPosted,
  stateBlock,
  unanswered,
  workshopAnswerer,
  workshopInstructions,
  workshopMessages,
  workshopTools,
  type WorkshopSystem,
} from '../agent/workshop.js';
import { config } from '../config.js';
import { q, q1 } from '../db/pool.js';
import {
  jsonSchema,
  own,
  ToolError,
  unescapeQuotes,
  type ConnectorCall,
  type ConnectorTool,
} from './toolkit.js';
import { addTools } from './tools.js';

/**
 * The workshop from Claude: an admin shapes a game system (its character
 * sheet, its GM guide and rulings) talking to Claude in claude.ai, or has
 * Claude answer the workshop chat in the app. The tools are the built-in
 * workshop's own, so both make the same changes in the same way.
 */

const systemArg = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .describe('The game system: its name or id, as list_systems shows it');

/** The system a workshop call is about, for an admin or that system's owner, on the account-wide address only. */
async function adminSystem(call: ConnectorCall, ref: unknown): Promise<WorkshopSystem> {
  if (call.pinned)
    throw new ToolError(
      'The workshop is not available on a connection for one campaign. Use the account-wide one.',
    );
  const user = await q1<{ role: string; totp: boolean }>(
    'SELECT role, totp_enabled_at IS NOT NULL AS totp FROM users WHERE id = $1',
    [call.user.userId],
  );
  const admin = user?.role === 'admin';
  if (admin && config().ADMIN_REQUIRE_TOTP && !user.totp)
    throw new ToolError('Admins must turn on two-factor sign-in in the app before using the workshop.');
  // An admin reaches every system; a player only the systems an admin made them an owner of.
  const all = await q<{ id: string; name: string; slug: string }>(
    admin
      ? 'SELECT id, name, slug FROM game_systems ORDER BY name'
      : `SELECT s.id, s.name, s.slug FROM game_systems s
           JOIN game_system_owners o ON o.system_id = s.id AND o.user_id = $1 ORDER BY s.name`,
    admin ? [] : [call.user.userId],
  );
  if (!admin && !all.length)
    throw new ToolError('Only the server’s admins, and the owners of a game system, can use the workshop.');
  const want = String(ref ?? '').trim();
  if (!want) throw new ToolError('Say which system: call list_systems to see them.');
  const low = want.toLowerCase();
  const hit =
    all.find((s) => s.id === want || s.slug === low) ??
    all.find((s) => s.name.toLowerCase() === low) ??
    all.find((s) => s.name.toLowerCase().startsWith(low));
  if (!hit)
    throw new ToolError(
      `There is no system called "${want}". Systems: ${all.map((s) => s.name).join(', ')}.`,
    );
  return (await loadSystem(hit.id))!;
}

const CLAUDE_PART = `## Working from Claude
You reach this workshop through the Tavern Master connector, and every workshop tool takes the system's name.
- Talking with an admin here in Claude: work with them directly through the workshop tools. The app shows the results: sheet changes wait in the draft for an admin to review under Character sheet, and the guide and rulings apply at once.
- Answering the workshop in the app, when the admin here asks you to: call workshop_wait. It returns the admins' messages waiting for an answer, each with its number. Do what they ask with the tools, then answer with workshop_reply, written for a phone, giving the number of the last message you answer. Call workshop_wait again, until the admin here says stop or it returns nothing for a while.
- <workshop_state> shows the sheet, the draft, the guide and the rulings as they stand now.`;

const quote = (m: WorkshopMessage) =>
  m.role === 'user' ? `${m.author?.displayName ?? 'An admin'}: ${m.content}` : `You: ${m.content}`;

const answeredBy = async (sys: WorkshopSystem, userId: string) =>
  (await workshopAnswerer(sys, userId)).answeredBy;

/** The last message workshop_wait handed out, per system: what a reply answers when it names none. */
const delivered = new Map<string, number>();

/** How long workshop_wait sleeps between looks at the database, should a message arrive another way. */
const RECHECK_MS = 30_000;

/** The built-in workshop's tools, made to take the system by name and to check the caller may shape it. */
function wrap(spec: ToolSpec, readOnly: boolean): ConnectorTool {
  const inner = jsonSchema(spec.schema) as { properties?: Record<string, unknown>; required?: string[] };
  return {
    name: `workshop_${spec.name}`,
    description: spec.description,
    inputSchema: {
      ...inner,
      type: 'object',
      properties: { system: jsonSchema(systemArg), ...(inner.properties ?? {}) },
      required: ['system', ...(inner.required ?? [])],
    },
    annotations: { readOnlyHint: readOnly, destructiveHint: false, openWorldHint: false },
    during: ['any'],
    async call(input, call) {
      const raw = (unescapeQuotes(input ?? {}) ?? {}) as Record<string, unknown>;
      try {
        const sys = await adminSystem(call, raw.system);
        const { system: _system, ...rest } = raw;
        // The workshop belongs to no campaign: its tools reach only this system.
        const ctx: TurnContext = {
          campaignId: '',
          systemId: sys.id,
          turnId: null,
          actors: [],
          citations: [],
          rolls: [],
          stateChanged: false,
        };
        const out = await dispatchTool(spec.name, rest, ctx, pgStore, undefined, workshopTools(sys.id));
        return { text: out.content, isError: out.isError };
      } catch (err) {
        if (err instanceof ToolError) return { text: err.message, isError: true };
        throw err;
      }
    },
  };
}

const READ_ONLY = new Set(['lookup_rules', 'read_sheet']);

export const WORKSHOP_TOOLS: ConnectorTool[] = [
  own({
    name: 'open_workshop',
    description:
      'For the server’s admins: open the workshop for a game system, to shape it before anyone plays it (what its ' +
      'character sheet holds, how its GM runs it, rulings every table follows). Returns your instructions, the ' +
      'system as it stands and the conversation so far. Call it first.',
    schema: z.object({ system: systemArg }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    during: ['any'],
    async run({ system }, call) {
      const sys = await adminSystem(call, system);
      const [state, messages, waiting, who] = await Promise.all([
        stateBlock(sys),
        workshopMessages(sys.id),
        unanswered(sys.id),
        answeredBy(sys, call.user.userId),
      ]);
      const recent = messages.slice(-12).map(quote).join('\n\n');
      return [
        workshopInstructions(sys),
        CLAUDE_PART,
        state,
        recent
          ? `## The workshop chat in the app (latest)\n${recent}`
          : 'Nobody has written in the app’s workshop yet.',
        who === 'claude'
          ? waiting.length
            ? `${waiting.length} message${waiting.length === 1 ? ' is' : 's are'} waiting for your answer in the app. Call workshop_wait to read and answer them.`
            : 'You answer the workshop in the app. Nothing is waiting.'
          : 'In the app, the built-in AI answers the workshop. An admin can switch it to Claude there.',
      ].join('\n\n');
    },
  }),

  own({
    name: 'workshop_wait',
    description:
      'Wait for an admin’s message in the app’s workshop, and return those waiting for an answer. Answer them ' +
      'with workshop_reply, then call this again.',
    schema: z.object({
      system: systemArg,
      wait_seconds: z
        .number()
        .int()
        .min(0)
        .max(600)
        .optional()
        .describe('How long to wait. Defaults to the most allowed.'),
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    during: ['any'],
    async run({ system, wait_seconds }, call) {
      const sys = await adminSystem(call, system);
      if ((await answeredBy(sys, call.user.userId)) !== 'claude')
        throw new ToolError(
          'The built-in AI answers this workshop in the app. An admin switches it to Claude in the workshop there.',
        );
      const max = config().CONNECTOR_MAX_WAIT_SECONDS;
      const until = Date.now() + Math.min(wait_seconds ?? max, max) * 1000;
      for (;;) {
        const waiting = await unanswered(sys.id);
        if (waiting.length) {
          const last = waiting[waiting.length - 1]!.id;
          delivered.set(sys.id, last);
          const fresh = (await loadSystem(sys.id))!;
          return [
            await stateBlock(fresh),
            `## Waiting for your answer\n${waiting.map((m) => `[#${m.id}] ${quote(m)}`).join('\n\n')}`,
            `Do what they ask with the workshop tools, then answer with workshop_reply, through: ${last}.`,
          ].join('\n\n');
        }
        const left = until - Date.now();
        if (left <= 0 || call.signal.aborted) return 'Nothing is waiting in the workshop.';
        await questionPosted(sys.id, Math.min(left, RECHECK_MS), call.signal);
      }
    },
  }),

  own({
    name: 'workshop_reply',
    description:
      'Answer in the app’s workshop chat. The admins read it on their phones: short paragraphs, plain prose.',
    schema: z.object({
      system: systemArg,
      text: z.string().trim().min(1).max(8000),
      through: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('The number of the last message this answers, as workshop_wait shows it'),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    during: ['any'],
    async run({ system, text, through }, call) {
      const sys = await adminSystem(call, system);
      // Admins can write while Claude works: an answer covers only what Claude has read.
      const upTo = through ?? delivered.get(sys.id) ?? (await unanswered(sys.id)).at(-1)?.id;
      await postReply(sys.id, text, upTo);
      const more = (await unanswered(sys.id)).length;
      return more
        ? `Posted in the workshop. ${more} newer message${more === 1 ? ' is' : 's are'} waiting: call workshop_wait to read ${more === 1 ? 'it' : 'them'}.`
        : 'Posted in the workshop. Call workshop_wait for the next message.';
    },
  }),

  ...workshopTools('').map((t) => wrap(t, READ_ONLY.has(t.name))),
];

addTools(...WORKSHOP_TOOLS);
