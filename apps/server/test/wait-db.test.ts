import type { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setConfigForTests, testConfig } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { closeDb, q, q1 } from '../src/db/pool.js';
import { createCharacter } from '../src/party.js';
import { openRoom } from '../src/realtime/room.js';

const fakeSocket = () =>
  ({ readyState: 1, OPEN: 1, send: () => undefined, close: () => undefined }) as unknown as WebSocket;
const settle = () => new Promise((r) => setTimeout(r, 150));

// "Until everyone is ready" means every player, not just whoever has the app open.
describe.skipIf(!process.env.TEST_DATABASE_URL)('waiting for the whole table (database)', () => {
  const tag = `wt${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let system = '';
  let camp = '';
  let host = '';
  let wife = '';
  let hostChar = '';
  let wifeChar = '';
  const hostSocket = fakeSocket();
  const hostRef = () => ({ id: host, username: `host-${tag}`, displayName: 'Host' });

  const user = async (name: string) =>
    (await q1<{ id: string }>(
      `INSERT INTO users (username, display_name, password_hash) VALUES ($1, $2, 'x') RETURNING id`,
      [`${name}-${tag}`, name],
    ))!.id;

  beforeAll(async () => {
    setConfigForTests(testConfig({ DATABASE_URL: process.env.TEST_DATABASE_URL! }));
    await migrate();
    system = (await q1<{ id: string }>(`INSERT INTO game_systems (slug, name) VALUES ($1, $2) RETURNING id`, [
      `sys-${tag}`,
      `sys-${tag}`,
    ]))!.id;
    host = await user('Host');
    wife = await user('Lloyd');
    // Run by Claude, so a closed turn waits on the desk instead of calling a model.
    camp = (await q1<{ id: string }>(
      `INSERT INTO campaigns (system_id, owner_id, name, settings, phase, started_at, opened_at)
       VALUES ($1, $2, $3, '{"dm":"claude","gatherWindowSeconds":0}', 'active', now(), now()) RETURNING id`,
      [system, host, `Wait ${tag}`],
    ))!.id;
    await q(
      `INSERT INTO campaign_members (campaign_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'player')`,
      [camp, host, wife],
    );
    hostChar = await createCharacter(
      camp,
      { userId: host, role: 'owner' },
      { name: 'Marcus', maxHp: 10, sheet: {} },
    );
    wifeChar = await createCharacter(
      camp,
      { userId: wife, role: 'player' },
      { name: 'Lloyd', maxHp: 10, sheet: {} },
    );
  });

  afterAll(async () => {
    (await openRoom(camp)).releaseDesk();
    await settle();
    await q('DELETE FROM campaigns WHERE id = $1', [camp]);
    await q(`DELETE FROM users WHERE username LIKE $1`, [`%-${tag}`]);
    await q('DELETE FROM game_systems WHERE id = $1', [system]);
    await closeDb();
  });

  it('waits for a player who is away, and leaving does not end the turn', async () => {
    const room = await openRoom(camp);
    await room.join(hostSocket, hostRef());
    await room.action(hostRef(), 'Marcus looks around.');
    room.done(hostRef());
    let turn = room.turnState();
    expect(turn.status).toBe('collecting');
    // Lloyd's player is not here, and the table still waits on Lloyd.
    expect(turn.expected).toEqual(expect.arrayContaining([hostChar, wifeChar]));
    expect(turn.done).toEqual([hostChar]);

    room.leave(hostSocket);
    await settle();
    expect(room.turnState().status).toBe('collecting');

    // The owner can still send it on.
    room.force();
    await settle();
    turn = room.turnState();
    expect(turn.status).toBe('resolving');
  });

  it('with a gather window, it goes back to waiting only on who is here', async () => {
    const room = await openRoom(camp);
    room.releaseDesk();
    await settle();
    room.setGatherWindow(60_000);
    await room.join(hostSocket, hostRef());
    await settle();
    await room.action(hostRef(), 'Marcus waits.');
    room.done(hostRef());
    await settle();
    expect(room.turnState().status).toBe('resolving');
  });
});
