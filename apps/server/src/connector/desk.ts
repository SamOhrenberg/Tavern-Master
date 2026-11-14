import type { TurnInput } from '../agent/context.js';
import type { TurnContext } from '../agent/store.js';

/** A gathered turn waiting for, or being resolved by, a Dungeon Master outside the server. */
export interface DeskTurn {
  id: string;
  number: number;
  sessionId: string;
  input: TurnInput;
  /** Shared by every tool call made for this turn, so citations and rolls collect in one place. */
  ctx: TurnContext;
  claimed: boolean;
}

type Timer = (fn: () => void, ms: number) => { cancel(): void };
const realTimer: Timer = (fn, ms) => {
  const t = setTimeout(fn, ms);
  return { cancel: () => clearTimeout(t) };
};

/**
 * Where a closed turn waits when the DM is an outside client (the Claude app
 * through the connector) instead of the server's own model.
 *
 * The room hands a turn over and waits for the outcome. The connector picks it
 * up with `waitForTurn` and `claim`, runs its tools against the turn's
 * context, and settles it with `complete`. A turn nobody narrates within the
 * timeout is given up on, so a table is never stuck behind a DM who left.
 *
 * This class has no I/O; the room and the connector wire it up.
 */
export class DmDesk {
  private current: { turn: DeskTurn; settle: (ok: boolean) => void } | null = null;
  private waiters = new Set<() => void>();
  private readonly setTimer: Timer;

  constructor(opts: { setTimer?: Timer } = {}) {
    this.setTimer = opts.setTimer ?? realTimer;
  }

  get turn(): DeskTurn | null {
    return this.current?.turn ?? null;
  }

  /** Offer a turn. Resolves true once it is narrated, false if it times out or is dropped. */
  handOff(turn: DeskTurn, timeoutMs: number): Promise<boolean> {
    if (this.current) throw new Error('a turn is already waiting for the DM');
    return new Promise<boolean>((resolve) => {
      const timer = this.setTimer(() => this.settle(false), timeoutMs);
      this.current = {
        turn,
        settle: (ok) => {
          timer.cancel();
          resolve(ok);
        },
      };
      for (const wake of [...this.waiters]) wake();
    });
  }

  /** Take the waiting turn to resolve it. Claiming twice returns the same turn. */
  claim(): DeskTurn | null {
    const turn = this.turn;
    if (turn) turn.claimed = true;
    return turn;
  }

  /** Wake everyone waiting without handing out a turn: other work for the DM arrived. */
  poke(): void {
    for (const wake of [...this.waiters]) wake();
  }

  /** The turn was narrated. */
  complete(): boolean {
    return this.settle(true);
  }

  /** Give up on the waiting turn. */
  drop(): boolean {
    return this.settle(false);
  }

  /**
   * Wait up to `ms` for a turn to be offered, or for `poke`. Returns at once
   * if a turn is already waiting, and returns null on timeout, on a poke, or
   * when `signal` aborts.
   */
  waitForTurn(ms: number, signal?: AbortSignal): Promise<DeskTurn | null> {
    if (this.turn) return Promise.resolve(this.turn);
    if (signal?.aborted || ms <= 0) return Promise.resolve(null);
    return new Promise((resolve) => {
      const finish = () => {
        timer.cancel();
        this.waiters.delete(finish);
        signal?.removeEventListener('abort', finish);
        resolve(this.turn);
      };
      const timer = this.setTimer(finish, ms);
      this.waiters.add(finish);
      signal?.addEventListener('abort', finish, { once: true });
    });
  }

  private settle(ok: boolean): boolean {
    const current = this.current;
    if (!current) return false;
    this.current = null;
    current.settle(ok);
    return true;
  }
}
