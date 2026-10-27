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

/**
 * A scripted stand-in for a real model: no network, no key, deterministic
 * shape. It exercises the same loop a real DM does (look up a rule, roll for
 * each acting player, then narrate with attribution and a citation), which
 * makes it useful for tests, CI and trying the app before adding an API key.
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

      // Utility calls (no tools) are summaries.
      if (!req.tools?.length) {
        const text = JSON.stringify({
          summary: 'The party pressed on; their recent deeds are recorded in the chronicle.',
          memories: [],
        });
        yield { type: 'text', text };
        yield finish([{ type: 'text', text }], 'end');
        return;
      }

      const last = req.messages[req.messages.length - 1];
      const results = last?.role === 'user' ? last.content.filter((b) => b.type === 'tool_result') : [];
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
            input: { expression: '1d20', reason: a.text.slice(0, 80), character: a.name },
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
      const text = `${paragraphs.join('\n\n')}\n\n${cite.trim()} What do you do next?`.trim();

      for (const piece of text.match(/\S+\s*/g) ?? []) {
        yield { type: 'text', text: piece };
      }
      yield finish([{ type: 'text', text }], 'end');
    },
  };
}
