import type { Block, ChatProvider, ChatRequest, Message, StreamEvent } from './types.js';

const unescapeXml = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

interface MockAction {
  name: string;
  text: string;
}

function userText(m: Message): string {
  return m.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n');
}

/** Actions of the turn being resolved: the last user message that carries a <turn> element. */
function currentActions(messages: Message[]): MockAction[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== 'user') continue;
    const text = userText(m);
    const turn = text.lastIndexOf('<turn');
    if (turn < 0) continue;
    const out: MockAction[] = [];
    const re = /<action player="([^"]*)"(?: character="([^"]*)")?>([\s\S]*?)<\/action>/g;
    for (const match of text.slice(turn).matchAll(re)) {
      out.push({
        name: unescapeXml(match[2] || match[1] || 'Someone'),
        text: unescapeXml(match[3] ?? '').trim(),
      });
    }
    return out;
  }
  return [];
}

function outcome(total: number): string {
  if (total >= 20) return 'a flawless success that will be retold at the tavern';
  if (total >= 15) return 'a clean success';
  if (total >= 10) return 'it works, though not without a wobble';
  if (total >= 5) return 'it falls short, and the situation tightens';
  return 'it goes badly wrong';
}

const estimate = (s: string) => Math.ceil(s.length / 4);
const title = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());

/** The last thing the person typed, without any tagged block the server put in front of it. */
function lastSaid(messages: Message[]): string {
  const last = [...messages].reverse().find((m) => m.role === 'user');
  return last
    ? userText(last)
        .replace(/<sheet>[\s\S]*?<\/sheet>/g, '')
        .trim()
    : '';
}

/** A character name out of free text: "Name: X" or "called X" if present, else the first words. */
function nameIn(text: string): string {
  const labelled = /(?:\bname\s*[:=]\s*|\b(?:called|named)\s+)([A-Za-z][\w' -]{1,40})/i.exec(text);
  const raw = labelled?.[1] ?? text.replace(/[^\w' -]+/g, ' ');
  const all = raw.trim().split(/\s+/);
  // After a label the name runs for as long as the words are capitalised ("Bram Stoutheart who owes…").
  const end = labelled ? all.findIndex((w, i) => i > 0 && !/^[A-Z]/.test(w)) : 2;
  const words = all.slice(0, end < 0 ? 3 : Math.min(end, 3));
  return title(words.join(' ')).slice(0, 40) || 'Wanderer';
}

/**
 * A scripted stand-in for a real model: no network, no key, deterministic
 * shape. It exercises the same paths a real model does (look up a rule, roll
 * for each acting player, narrate with attribution and a citation; plan an
 * opening; play a companion; build or read a character sheet), which makes
 * it useful for tests, CI and trying the app before adding an API key.
 */
export function mockProvider(): ChatProvider {
  return {
    name: 'mock',
    async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
      const inputTokens =
        estimate(JSON.stringify(req.messages)) + estimate(req.system.map((s) => s.text).join(''));
      const finish = (content: Block[], stop: 'end' | 'tool_use'): StreamEvent => ({
        type: 'done',
        stop,
        content,
        model: req.model,
        usage: {
          inputTokens,
          outputTokens: estimate(JSON.stringify(content)),
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      });
      const say = async function* (text: string): AsyncIterable<StreamEvent> {
        for (const piece of text.match(/\S+\s*/g) ?? []) yield { type: 'text', text: piece };
        yield finish([{ type: 'text', text }], 'end');
      };

      const last = req.messages[req.messages.length - 1];
      const results = last?.role === 'user' ? last.content.filter((b) => b.type === 'tool_result') : [];
      const said = lastSaid(req.messages);

      switch (req.task) {
        case 'companion': {
          const self = /You play one character[^:]*: ([^,]+),/.exec(req.system[0]?.text ?? '')?.[1] ?? 'I';
          yield* say(`I stay close to the others and keep watch, ready to back them up. (${self})`);
          return;
        }
        case 'catalogue': {
          yield* say(
            JSON.stringify({
              kind: 'setting',
              summary:
                'Background material uploaded for this campaign. Consult it for names, places and history.',
            }),
          );
          return;
        }
        case 'sheet': {
          // Here the upload itself is the <sheet> block, so read all of it.
          const sheet = last ? userText(last) : '';
          const hp = /\b(?:max(?:imum)?\s*)?(?:hp|hit points)\s*[:=]?\s*(\d{1,4})/i.exec(sheet);
          yield finish(
            [
              {
                type: 'tool_use',
                id: 'mock_sheet',
                name: 'record_character',
                input: {
                  name: nameIn(sheet.replace(/<\/?sheet>|Record this character\./g, ' ')),
                  max_hp: hp ? Number(hp[1]) : 10,
                  fields: [{ field: 'level', value: 1 }],
                  persona: 'Read from an uploaded sheet by the scripted model.',
                },
              },
            ],
            'tool_use',
          );
          return;
        }
        case 'builder': {
          if (results.length === 0 && said.length > 2) {
            yield finish(
              [
                {
                  type: 'tool_use',
                  id: 'mock_save',
                  name: 'save_character',
                  input: {
                    name: nameIn(said),
                    max_hp: 12,
                    fields: [{ field: 'level', value: 1 }],
                    persona: said.slice(0, 300),
                  },
                },
                {
                  type: 'tool_use',
                  id: 'mock_stat',
                  name: 'roll_dice',
                  input: { expression: '4d6kh3', reason: 'An ability score', kind: 'other' },
                },
              ],
              'tool_use',
            );
            return;
          }
          yield* say(
            results.length
              ? 'I have put that on the sheet and rolled a first ability score for you. **What do they do for a living**, and what are they running from?'
              : 'Tell me who you would like to play: a name, a mood, anything at all.',
          );
          return;
        }
        case 'opening': {
          if (results.length === 0) {
            yield finish(
              [
                {
                  type: 'tool_use',
                  id: 'mock_plan',
                  name: 'write_note',
                  input: {
                    title: 'Story plan',
                    content:
                      'Central conflict: something stirs under the old road. Arc one: the missing caravan. Arc two: who paid for the silence.',
                  },
                },
                {
                  type: 'tool_use',
                  id: 'mock_scene',
                  name: 'set_scene',
                  input: {
                    description: 'A roadside inn at dusk, rain coming in, a stranger watching the door.',
                  },
                },
              ],
              'tool_use',
            );
            return;
          }
          const names = [...(userText(req.messages[0]!).matchAll(/<character name="([^"]*)"/g) ?? [])].map(
            (m) => unescapeXml(m[1] ?? ''),
          );
          const who = names.length ? `**${names.join('**, **')}**` : 'You';
          yield* say(
            `Rain drums on the shutters of the roadside inn. ${who} share a table by the fire, strangers no longer after three days on the same muddy road.\n\nAcross the room a hooded traveller has not touched their drink, and has not stopped watching the door. What do you do?`,
          );
          return;
        }
        case 'lore': {
          // Sample the material once, then record a small distilled voice.
          if (results.length === 0) {
            yield finish(
              [
                {
                  type: 'tool_use',
                  id: 'mock_setting_search',
                  name: 'search_setting',
                  input: { query: 'voice vocabulary tone' },
                },
              ],
              'tool_use',
            );
            return;
          }
          yield finish(
            [
              {
                type: 'tool_use',
                id: 'mock_save_lore',
                name: 'save_lore',
                input: {
                  version: 1,
                  voice: 'Wry, breathless and knowing, like a late-night broadcast narrating your doom.',
                  pacing: 'Short beats crash forward, punctuated by sudden System announcements.',
                  glossary: [
                    { term: 'the Crawl', meaning: 'The televised dungeon the survivors descend.', sounds_like: 'the Crawl' },
                  ],
                  presentation: ['System messages delivered in boxed announcements'],
                  touchstones: ['the System', 'the Syndicate'],
                  cautions: ['Do not pre-empt who is really behind the Showrunners.'],
                },
              },
            ],
            'tool_use',
          );
          return;
        }
        default:
          break;
      }

      // Utility calls (no tools) are summaries.
      if (!req.tools?.length) {
        yield* say(
          JSON.stringify({
            summary: 'The party pressed on; their recent deeds are recorded in the chronicle.',
            memories: [],
          }),
        );
        return;
      }

      const actions = currentActions(req.messages);

      if (results.length === 0 && actions.length > 0) {
        const calls: Block[] = [
          {
            type: 'tool_use',
            id: 'mock_rules',
            name: 'lookup_rules',
            input: {
              query: actions
                .map((a) => a.text)
                .join(' ')
                .slice(0, 280),
            },
          },
          ...actions.map((a, i): Block => ({
            type: 'tool_use',
            id: `mock_roll_${i}`,
            name: 'roll_dice',
            input: { expression: '1d20', reason: a.text.slice(0, 80), character: a.name, kind: 'check' },
          })),
        ];
        yield finish(calls, 'tool_use');
        return;
      }

      const totals: number[] = [];
      let cite = '';
      for (const r of results) {
        if (r.type !== 'tool_result') continue;
        if (r.toolUseId === 'mock_rules') {
          if (r.content.includes('[R1]')) cite = ' The ruling follows the book [R1].';
        } else {
          const m = /=\s*(-?\d+)\s*$/m.exec(r.content);
          totals.push(m ? Number(m[1]) : 10);
        }
      }
      const paragraphs = actions.length
        ? actions.map((a, i) => {
            const total = totals[i] ?? 10;
            const deed = a.text.replace(/[.!?\s]+$/, '');
            return `**${a.name}** commits: "${deed}". The die comes up **${total}** — ${outcome(total)}.`;
          })
        : ['The moment stretches. Nobody moves, and the world carries on around the party.'];
      yield* say(`${paragraphs.join('\n\n')}\n\n${cite.trim()} What do you do next?`.trim());
    },
  };
}
