import { beforeAll, describe, expect, it } from 'vitest';
import { systemPrompt } from '../src/agent/context.js';
import { setConfigForTests, testConfig } from '../src/config.js';
import type { OutsideAi } from '../src/llm/outside.js';
import { maskDraft, polishRequest, polishWith, unmask } from '../src/llm/polish.js';

beforeAll(() => setConfigForTests(testConfig()));

const gemini: OutsideAi = {
  name: 'Gemini',
  provider: 'gemini',
  model: 'gemini-2.5-pro',
  baseUrl: null,
  apiKey: 'g-key',
};

/** A Gemini that answers with whatever `write` makes of the request it was sent. */
function fakeGemini(write: (request: string) => string) {
  const seen: { system: string; request: string }[] = [];
  const impl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const request = body.contents[0].parts[0].text as string;
    seen.push({ system: body.systemInstruction.parts[0].text, request });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: write(request) }] } }] }));
  }) as unknown as typeof fetch;
  return { impl, seen };
}

const masked = (request: string) => /<narration>\n([\s\S]*)\n<\/narration>/.exec(request)![1]!;

const said = ['Thorn steps forward. "We come in peace, mostly." He keeps a hand on his axe.'];
const draft =
  'Thorn steps up to the gate and says, "We come in peace, mostly." The guard squints at [[Captain Vey]] ' +
  'and grunts, "Peace costs extra." [R2] Behind him, ▮▮▮. What do you do?';

describe('polishing narration', () => {
  it('locks player dialogue, codex links, citations and redactions behind markers', () => {
    const { masked: m, kept } = maskDraft(draft, said);
    // The quote marks go with the line, so the other AI cannot re-punctuate it either.
    expect(kept).toEqual(['"We come in peace, mostly."', '[[Captain Vey]]', '[R2]', '▮▮▮']);
    expect(m).not.toContain('We come in peace');
    expect(m).toContain('says, ⟦1⟧ The guard');
    // An NPC's line is the DM's own writing and is free to be reworded.
    expect(m).toContain('"Peace costs extra."');
  });

  it('protects a quoted line the DM took from a player’s action even when it is not word for word', () => {
    const { kept } = maskDraft('She hisses, "get down!" The arrows fly.', [
      'Mara: "Get down!" I dive behind the cart.',
    ]);
    expect(kept).toEqual(['"get down!"']);
  });

  it('puts protected text back, and refuses a reply that lost, repeated or invented a marker', () => {
    const kept = ['A', 'B'];
    expect(unmask('x ⟦1⟧ y ⟦2⟧ z', kept, 11)).toBe('x A y B z');
    expect(unmask('x ⟦1⟧ y', kept, 7)).toBeNull();
    expect(unmask('x ⟦1⟧ ⟦1⟧ ⟦2⟧', kept, 10)).toBeNull();
    expect(unmask('x ⟦1⟧ ⟦2⟧ ⟦3⟧', kept, 10)).toBeNull();
    // Far longer or shorter than the draft is not a polish, it is a rewrite.
    expect(unmask('⟦1⟧⟦2⟧', kept, 100)).toBeNull();
  });

  it('asks only for style, and tells it about the markers and the tone', () => {
    const req = polishRequest('Some ⟦1⟧ text', 1, 'grim and wry');
    expect(req).toContain('Add no new events');
    expect(req).toContain('Keep every marker exactly once');
    expect(req).toContain('grim and wry');
    expect(polishRequest('No markers here', 0, '')).not.toContain('Markers like');
  });

  it('sends the masked draft and posts the polished text with the players’ words exactly as written', async () => {
    const g = fakeGemini((req) =>
      masked(req).replace('The guard squints at', 'The grizzled guard narrows his eyes at'),
    );
    const out = await polishWith(gemini, draft, said, 'tense', g.impl);
    expect(out.polished).toBe(true);
    expect(out.text).toContain('"We come in peace, mostly."');
    expect(out.text).toContain('The grizzled guard narrows his eyes at [[Captain Vey]]');
    expect(out.text).toContain('[R2]');
    expect(g.seen[0]!.request).not.toContain('We come in peace');
    expect(g.seen[0]!.system).toContain('prose editor');
  });

  it('falls back to the draft when the other AI tampers with the players’ words or fails', async () => {
    const tampered = fakeGemini(
      () => 'Thorn says, "We come in peace." Then everyone dances. What do you do?',
    );
    expect(await polishWith(gemini, draft, said, '', tampered.impl)).toEqual({
      text: draft,
      polished: false,
    });

    const down = (async () => new Response('{}', { status: 503 })) as unknown as typeof fetch;
    expect(await polishWith(gemini, draft, said, '', down)).toEqual({ text: draft, polished: false });
  });

  it('tells the DM its narration is polished and to quote players exactly', () => {
    const base = { id: 'c', name: 'Bell', premise: '', tone: '', systemName: 'SRD' };
    expect(systemPrompt(base)).not.toContain('Your narration is polished');
    const polished = systemPrompt({ ...base, polishWith: 'Gemini' });
    expect(polished).toContain('Your narration is polished');
    expect(polished).toContain("quote the player's words exactly");
  });
});
