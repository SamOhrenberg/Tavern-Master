import { describe, expect, it } from 'vitest';
import type { CampaignInfo } from '../src/agent/context.js';
import { TOOLS } from '../src/agent/tools.js';
import { crc32 } from 'node:zlib';
import { DmDesk, type DeskTurn } from '../src/connector/desk.js';
import { kitFiles, slugOf } from '../src/connector/kit.js';
import { connectorGuide, projectInstructions } from '../src/connector/instructions.js';
import { dmModeOf } from '../src/connector/mode.js';
import { presenceOf, type PresenceFacts } from '../src/connector/presence.js';
import '../src/connector/register.js';
import { gateAllows } from '../src/connector/toolkit.js';
import { connectorTools } from '../src/connector/tools.js';
import { zipStore } from '../src/connector/zip.js';

const CONNECTOR_TOOLS = connectorTools();

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

describe('presence of an outside DM', () => {
  const now = Date.parse('2026-11-14T20:00:00Z');
  const base: PresenceFacts = {
    mode: 'claude',
    polls: 0,
    lastCallAt: 0,
    claimed: false,
    seenAt: null,
    waiting: 0,
    now,
    listenMs: 75_000,
  };

  it('is always listening for the built-in DM', () => {
    expect(presenceOf({ ...base, mode: 'server', waiting: 3 })).toEqual({
      mode: 'server',
      state: 'listening',
      lastSeenAt: null,
      waiting: 0,
    });
  });

  it('tells never, away, listening and working apart', () => {
    expect(presenceOf(base).state).toBe('never');
    const seen = new Date(now - 3_600_000);
    expect(presenceOf({ ...base, seenAt: seen })).toMatchObject({
      state: 'away',
      lastSeenAt: seen.toISOString(),
    });
    // A poll open counts as listening however long ago the last call began.
    expect(presenceOf({ ...base, seenAt: seen, polls: 1, lastCallAt: now - 600_000 }).state).toBe(
      'listening',
    );
    expect(presenceOf({ ...base, lastCallAt: now - 30_000 }).state).toBe('listening');
    expect(presenceOf({ ...base, lastCallAt: now - 80_000 }).state).toBe('away');
    expect(presenceOf({ ...base, polls: 1, claimed: true, waiting: 2 })).toMatchObject({
      state: 'working',
      waiting: 2,
    });
  });
});

describe('DM desk', () => {
  it('wakes a waiter without a turn when poked', async () => {
    const timers = manualTimers();
    const desk = new DmDesk({ setTimer: timers.setTimer });
    const waiting = desk.waitForTurn(60_000);
    desk.poke();
    await expect(waiting).resolves.toBeNull();
    expect(timers.count()).toBe(0);
  });

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
      'wait_for_work',
      'host_action',
      'close_turn',
      'narrate',
      'skip_work',
    ])
      expect(names).toContain(name);
    expect(names).not.toContain('take_turn');
    expect(names).not.toContain('review_chronicle');
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

  it('lets each tool run only while Claude holds the right thing', () => {
    const during = (name: string) => CONNECTOR_TOOLS.find((t) => t.name === name)!.during;
    // Nothing held: the GM tools and narration, not request tools.
    expect(gateAllows(during('narrate'), null, false)).toBe(true);
    expect(gateAllows(during('update_character'), null, false)).toBe(true);
    // A claimed turn counts as free.
    expect(gateAllows(during('narrate'), null, true)).toBe(true);
    // A guide request: dice and rules, nothing that changes the world or speaks to the table.
    expect(gateAllows(during('roll_dice'), 'guide', false)).toBe(true);
    expect(gateAllows(during('lookup_rules'), 'guide', false)).toBe(true);
    expect(gateAllows(during('search_documents'), 'guide', false)).toBe(true);
    expect(gateAllows(during('update_character'), 'guide', false)).toBe(false);
    expect(gateAllows(during('write_note'), 'guide', false)).toBe(false);
    expect(gateAllows(during('narrate'), 'guide', false)).toBe(false);
    expect(gateAllows(during('roll_dice'), 'sheet', false)).toBe(false);
    // Always allowed, whatever is held.
    for (const kind of ['guide', 'sheet', 'catalogue', 'chronicle'] as const) {
      expect(gateAllows(during('wait_for_work'), kind, false)).toBe(true);
      expect(gateAllows(during('skip_work'), kind, false)).toBe(true);
      expect(gateAllows(during('open_campaign'), kind, true)).toBe(true);
    }
    // Turn-only tools.
    expect(gateAllows(['turn'], null, false)).toBe(false);
    expect(gateAllows(['turn'], null, true)).toBe(true);
    expect(gateAllows(['turn'], 'guide', true)).toBe(false);
    expect(gateAllows(['sheet'], 'sheet', false)).toBe(true);
    expect(gateAllows(['sheet'], null, false)).toBe(false);
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

  it('extends the built-in DM guide with how Claude runs every AI at the table', () => {
    const guide = connectorGuide(info);
    expect(guide).toContain('Dungeon Master for "The Sunken Bell"');
    expect(guide).toContain('A drowned town rings at low tide.');
    expect(guide).toContain('## Running this table from Claude');
    expect(guide).toContain('wait_for_work');
    expect(guide).not.toContain('take_turn');
    // Both ways of playing an own-AI companion: a blind subagent, or Claude itself.
    expect(guide).toContain('start it once for each, in parallel');
    expect(guide).toContain('If you cannot start subagents');
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

describe('the campaign folder', () => {
  /** Read a zip's central directory back: name, size and CRC of every entry. */
  function readZip(buf: Buffer) {
    const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    const count = buf.readUInt16LE(end + 10);
    let at = buf.readUInt32LE(end + 16);
    const entries: { name: string; size: number; crc: number; data: Buffer }[] = [];
    for (let i = 0; i < count; i++) {
      expect(buf.readUInt32LE(at)).toBe(0x02014b50);
      const crc = buf.readUInt32LE(at + 16);
      const size = buf.readUInt32LE(at + 24);
      const nameLen = buf.readUInt16LE(at + 28);
      const local = buf.readUInt32LE(at + 42);
      const name = buf.toString('utf8', at + 46, at + 46 + nameLen);
      expect(buf.readUInt32LE(local)).toBe(0x04034b50);
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      entries.push({ name, size, crc, data: buf.subarray(start, start + size) });
      at += 46 + nameLen;
    }
    return entries;
  }

  it('zips files that read back with the right names, sizes and checksums', () => {
    const files = [
      { path: 'a/one.txt', data: Buffer.from('hello') },
      { path: 'a/ünïcode.md', data: Buffer.from('# Ü\n') },
      { path: 'a/empty', data: Buffer.alloc(0) },
    ];
    const entries = readZip(zipStore(files));
    expect(entries.map((e) => e.name)).toEqual(files.map((f) => f.path));
    for (const [i, e] of entries.entries()) {
      expect(e.size).toBe(files[i]!.data.length);
      expect(e.crc).toBe(crc32(files[i]!.data));
      expect(e.data.equals(files[i]!.data)).toBe(true);
    }
    // The same files always make the same bytes.
    expect(zipStore(files).equals(zipStore(files))).toBe(true);
  });

  it('holds the folder setup for one campaign, with no secret in it', () => {
    const files = kitFiles(
      { id: '7f1e0d55-1b9a-4b1e-9a2f-1c2d3e4f5a6b', name: 'The Sunken Bell!' },
      'https://tavern.example',
    );
    const byName = new Map(files.map((f) => [f.path, f.data.toString('utf8')]));
    expect([...byName.keys()].sort()).toEqual(
      [
        '.claude/agents/companion.md',
        '.claude/settings.json',
        '.claude/skills/dm/SKILL.md',
        '.mcp.json',
        'CLAUDE.md',
        'README.md',
      ].map((p) => `the-sunken-bell/${p}`),
    );
    const mcp = JSON.parse(byName.get('the-sunken-bell/.mcp.json')!);
    expect(mcp).toEqual({
      mcpServers: {
        'tavern-master': {
          type: 'http',
          url: 'https://tavern.example/mcp/c/7f1e0d55-1b9a-4b1e-9a2f-1c2d3e4f5a6b',
        },
      },
    });
    for (const text of byName.values()) expect(text).not.toMatch(/tm[car]_[A-Za-z0-9_-]{20}/);
    expect(byName.get('the-sunken-bell/.claude/agents/companion.md')).toContain(
      'tools: mcp__tavern-master__companion_view, mcp__tavern-master__companion_act',
    );
    // /loop starts the skill the way Claude would, so Claude must be allowed to.
    expect(byName.get('the-sunken-bell/.claude/skills/dm/SKILL.md')).not.toContain(
      'disable-model-invocation',
    );
    expect(slugOf('  ')).toBe('campaign');
    expect(slugOf('A'.repeat(60)).length).toBe(40);
  });
});
