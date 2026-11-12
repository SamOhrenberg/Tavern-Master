import type { TurnState } from '@tavern/protocol';

export interface CollectedAction {
  /**
   * The place in the turn this action fills: a player-run character, or a
   * player who has none. One player running two characters holds two seats.
   */
  seat: string;
  /** The person who typed it. */
  userId: string;
  text: string;
  /** Id of the stored chat message, when there is one. */
  messageId?: number;
}

export interface ClosedTurn {
  actions: CollectedAction[];
  /** Seats that sat the turn out. */
  passed: string[];
  reason: 'all_ready' | 'timeout' | 'forced';
}

export interface CollectorOptions {
  /** How long to wait for the rest of the table after the first action. */
  windowMs: number;
  onClose: (turn: ClosedTurn) => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => { cancel(): void };
}

const realTimer = (fn: () => void, ms: number) => {
  const t = setTimeout(fn, ms);
  return { cancel: () => clearTimeout(t) };
};

/**
 * Gathers one round of simultaneous actions ("ready or timeout").
 *
 * A turn opens with the first action. It closes, and goes to the DM as one
 * batch, as soon as every seat that is present has acted or passed, or when
 * the gather window runs out, or when the owner forces it. Nobody waits on a
 * seat whose player has left, and a solo player with one character never
 * waits at all. Actions that arrive while the DM is still resolving are held
 * for the next turn.
 *
 * This class has no I/O; the room wires it to the database and sockets.
 */
export class TurnCollector {
  phase: 'idle' | 'collecting' | 'resolving' = 'idle';
  deadline: number | null = null;
  windowMs: number;

  private present = new Set<string>();
  private actions: CollectedAction[] = [];
  private passed = new Set<string>();
  private queued: CollectedAction[] = [];
  private timer: { cancel(): void } | undefined;
  private readonly now: () => number;
  private readonly setTimer: NonNullable<CollectorOptions['setTimer']>;
  private readonly onClose: (turn: ClosedTurn) => void;

  constructor(opts: CollectorOptions) {
    this.windowMs = opts.windowMs;
    this.onClose = opts.onClose;
    this.now = opts.now ?? Date.now;
    this.setTimer = opts.setTimer ?? realTimer;
  }

  /** Update which seats are at the table. A seat emptying can complete the turn. */
  setPresent(seats: Iterable<string>): void {
    this.present = new Set(seats);
    this.closeIfReady();
  }

  /** Record an action. Returns where it went. */
  submit(action: CollectedAction): 'opened' | 'added' | 'queued' {
    if (this.phase === 'resolving') {
      this.queued.push(action);
      return 'queued';
    }
    const opened = this.phase === 'idle';
    if (opened) {
      this.phase = 'collecting';
      this.actions = [];
      this.passed = new Set();
      this.deadline = this.now() + this.windowMs;
      this.timer = this.setTimer(() => this.close('timeout'), this.windowMs);
    }
    this.actions.push(action);
    this.passed.delete(action.seat);
    this.closeIfReady();
    return opened ? 'opened' : 'added';
  }

  /** A present seat sits this turn out. Only meaningful while collecting. */
  pass(seat: string): boolean {
    if (this.phase !== 'collecting' || this.hasActed(seat)) return false;
    this.passed.add(seat);
    this.closeIfReady();
    return true;
  }

  /** Close now with whatever has been gathered. */
  force(): boolean {
    if (this.phase !== 'collecting') return false;
    this.close('forced');
    return true;
  }

  /**
   * Take the floor without a turn (the DM is writing the opening scene).
   * Actions sent meanwhile are held exactly as they are during a turn.
   */
  hold(): boolean {
    if (this.phase !== 'idle') return false;
    this.phase = 'resolving';
    return true;
  }

  /** The DM is done. Returns actions that arrived meanwhile so they can start the next turn. */
  resolved(): CollectedAction[] {
    const held = this.queued;
    this.queued = [];
    this.actions = [];
    this.passed = new Set();
    this.phase = 'idle';
    this.deadline = null;
    return held;
  }

  hasActed(seat: string): boolean {
    return this.actions.some((a) => a.seat === seat);
  }

  /** Everything except `seats`, which the room fills in from its own records. */
  snapshot(number: number | null): Omit<TurnState, 'seats'> {
    const acted = [...new Set(this.actions.map((a) => a.seat))];
    return {
      status: this.phase,
      number: this.phase === 'idle' ? null : number,
      deadline: this.phase === 'collecting' ? this.deadline : null,
      expected: this.phase === 'collecting' ? [...new Set([...this.present, ...acted])] : [],
      acted: this.phase === 'idle' ? [] : acted,
      passed: this.phase === 'idle' ? [] : [...this.passed],
    };
  }

  private closeIfReady(): void {
    if (this.phase !== 'collecting' || this.actions.length === 0) return;
    for (const seat of this.present) {
      if (!this.hasActed(seat) && !this.passed.has(seat)) return;
    }
    this.close('all_ready');
  }

  private close(reason: ClosedTurn['reason']): void {
    if (this.phase !== 'collecting') return;
    this.timer?.cancel();
    this.timer = undefined;
    this.phase = 'resolving';
    this.deadline = null;
    this.onClose({ actions: this.actions, passed: [...this.passed], reason });
  }
}
