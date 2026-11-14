import { describe, expect, it } from 'vitest';
import type { CampaignInfo } from '../src/agent/context.js';
import { TOOLS } from '../src/agent/tools.js';
import { DmDesk, type DeskTurn } from '../src/connector/desk.js';
import { connectorGuide, projectInstructions } from '../src/connector/instructions.js';
import { dmModeOf } from '../src/connector/mode.js';
import { CONNECTOR_TOOLS } from '../src/connector/tools.js';

/** Timers the test fires by hand. */
function manualTimers() {
  const pending = new Map<number, () => void>();
  let next = 0;
  return {
    setTimer: (fn: () => void) => {
      const id = next++;
      pending.set(id, fn);
      return { cancel: () => pending.delete(id) };
    },
    fireAll: () => {
      for (const [id, fn] of [...pending]) {
        pending.delete(id);
        fn();
      }
    },
    count: () => pending.size,
  };
}

const turn = (n = 1): DeskTurn => ({
  id: `t${n}`,
  number: n,
  sessionId: 's1',
  input: { number: n, actions: [], passed: [] },
  ctx: {
    campaignId: 'c',
    systemId: 's',
    turnId: `t${n}`,
    actors: [],
    citations: [],
    rolls: [],
    stateChanged: false,
  },
  claimed: false,
});

describe('DM desk', () => {
  it('holds a turn until it is narrated', async () => {
    const timers = manualTimers();
    const desk = new DmDesk({ setTimer: timers.setTimer });
    const outcome = desk.handOff(turn(), 60_000);
    expect(desk.turn?.number).toBe(1);
    expect(desk.claim()?.claimed).toBe(true);
    expect(desk.complete()).toBe(true);
    await expect(outcome).resolves.toBe(true);
    expect(desk.turn).toBeNull();
    // The timeout was cancelled with it.
    expect(timers.count()).toBe(0);
  });

  it('gives a turn back to the table when nobody narrates it in time', async () => {
    const timers = manualTimers();
    const desk = new DmDesk({ setTimer: timers.setTimer });
    const outcome = desk.handOff(turn(), 60_000);
    timers.fireAll();
    await expect(outcome).resolves.toBe(false);
    expect(desk.turn).toBeNull();
    expect(desk.complete()).toBe(false);
  });

  it('can be dropped, for instance when the owner switches back to the built-in DM', async () => {
    const desk = new DmDesk({ setTimer: manualTimers().setTimer });
    const outcome = desk.handOff(turn(), 60_000);
    expect(desk.drop()).toBe(true);
    await expect(outcome).resolves.toBe(false);
  });

  it('refuses a second turn while one is waiting', () => {
    const desk = new DmDesk({ setTimer: manualTimers().setTimer });
    void desk.handOff(turn(1), 60_000);
    expect(() => desk.handOff(turn(2), 60_000)).toThrow();
  });

  it('wakes a waiting client as soon as a turn is handed over', async () => {
    const timers = manualTimers();
    const desk = new DmDesk({ setTimer: timers.setTimer });
    const waiting = desk.waitForTurn(30_000);
    void desk.handOff(turn(3), 60_000);
    await expect(waiting).resolves.toMatchObject({ number: 3 });
  });

  it('returns a waiting turn at once, and nothing when the wait runs out or is cancelled', async () => {
    const timers = manualTimers();
    const desk = new DmDesk({ setTimer: timers.setTimer });

    const timedOut = desk.waitForTurn(30_000);
    timers.fireAll();
    await expect(timedOut).resolves.toBeNull();

    const abort = new AbortController();
    const cancelled = desk.waitForTurn(30_000, abort.signal);
    abort.abort();
    await expect(cancelled).resolves.toBeNull();

    void desk.handOff(turn(4), 60_000);
    await expect(desk.waitForTurn(30_000)).resolves.toMatchObject({ number: 4 });
  });
});

describe('connector tools', () => {
  it('offers the session tools and every one of the GM’s own tools, each once', () => {
    const names = CONNECTOR_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of [
      'list_campaigns',
      'open_campaign',
      'take_turn',
      'narrate',
      'review_chronicle',
      'save_chronicle',
    ])
      expect(names).toContain(name);
    for (const t of TOOLS) expect(names).toContain(t.name);
    expect(names).toContain('edit_sheet');
  });

  it('describes every input as a JSON object schema', () => {
    for (const t of CONNECTOR_TOOLS) {
      expect(t.inputSchema.type, t.name).toBe('object');
      expect(t.inputSchema).not.toHaveProperty('$schema');
      expect(t.description.length, t.name).toBeGreaterThan(20);
    }
  });

  it('marks lookups read-only and changes to the table as not', () => {
    const hint = (name: string) => CONNECTOR_TOOLS.find((t) => t.name === name)!.annotations.readOnlyHint;
    expect(hint('lookup_rules')).toBe(true);
    expect(hint('get_state')).toBe(true);
    expect(hint('narrate')).toBe(false);
    expect(hint('update_character')).toBe(false);
  });
});

describe('connector instructions', () => {
  const info: CampaignInfo = {
    id: 'c',
    name: 'The Sunken Bell',
    premise: 'A drowned town rings at low tide.',
    tone: 'eerie',
    systemName: 'SRD 5.1',
  };

  it('extends the built-in DM guide with how the chat table works', () => {
    const guide = connectorGuide(info);
    expect(guide).toContain('Dungeon Master for "The Sunken Bell"');
    expect(guide).toContain('A drowned town rings at low tide.');
    expect(guide).toContain('## Running this table from a chat');
    expect(guide).toContain('take_turn');
  });

  it('gives the project a short, stable instruction that starts every chat with open_campaign', () => {
    const text = projectInstructions('The Sunken Bell');
    expect(text).toContain('open_campaign with "The Sunken Bell"');
    expect(text.length).toBeLessThan(1500);
  });

  it('treats anything but an explicit choice as the built-in DM', () => {
    expect(dmModeOf({ dm: 'claude' })).toBe('claude');
    expect(dmModeOf({ dm: 'server' })).toBe('server');
    expect(dmModeOf({})).toBe('server');
    expect(dmModeOf(null)).toBe('server');
    expect(dmModeOf({ dm: 'something else' })).toBe('server');
  });
});
