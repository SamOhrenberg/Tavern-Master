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
  /** How long to wait for the rest of the table after the first action. 0 waits until everyone is ready. */
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
 * A turn opens with the first action. A seat may send several messages; it
 * is finished once its player says they are done (or passes without acting).
 * The turn closes, and goes to the DM as one batch, as soon as every seat the
 * room says to wait on is done or passed, or when the gather window runs out,
 * or when the owner forces it. With a window, the room lists only seats whose
 * player is here; with none, every player's (see Room.syncSeats). Actions
 * that arrive while the DM is still resolving are held for the next turn.
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
  /** Seats that acted and said they are done. */
  private done = new Set<string>();
  private queued: CollectedAction[] = [];
  /** Companions deciding whether to answer something said this turn. The turn waits for them. */
  private listening = 0;
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
      this.done = new Set();
      // With no window the turn waits for every present seat, or the owner's Go now.
      if (this.windowMs > 0) {
        this.deadline = this.now() + this.windowMs;
        this.timer = this.setTimer(() => this.close('timeout'), this.windowMs);
      } else {
        this.deadline = null;
      }
    }
    this.actions.push(action);
    // Writing again reopens a seat that had said it was done.
    this.passed.delete(action.seat);
    this.done.delete(action.seat);
    this.closeIfReady();
    return opened ? 'opened' : 'added';
  }

  /**
   * A seat is finished with this turn: done if it acted, passed if it did not.
   * Only meaningful while collecting.
   */
  finish(seat: string): boolean {
    if (this.phase !== 'collecting') return false;
    const into = this.hasActed(seat) ? this.done : this.passed;
    if (into.has(seat)) return false;
    into.add(seat);
    this.closeIfReady();
    return true;
  }

  /**
   * A seat takes back its done or pass, to answer something said after it
   * finished. The turn waits on it again. Only meaningful while collecting:
   * once every seat is done the turn has gone to the DM.
   */
  reopen(seat: string): boolean {
    if (this.phase !== 'collecting') return false;
    const was = this.done.delete(seat);
    return this.passed.delete(seat) || was;
  }

  /**
   * Everyone the turn waits on who said they were done or passed is waited on
   * again, as when something new was said that they may want to answer.
   * Seats the turn never waits on (a line spoken for a companion, a
   * companion's own answer) stay finished. Returns whether anything changed.
   */
  reopenAll(): boolean {
    if (this.phase !== 'collecting') return false;
    let changed = false;
    for (const seat of this.present) {
      if (this.done.delete(seat)) changed = true;
      if (this.passed.delete(seat)) changed = true;
    }
    return changed;
  }

  /**
   * Keep the turn open while the companions decide whether to answer what was
   * just said, even if every seat says it is done meanwhile. Each call must be
   * matched by stopListening. The gather window and the owner's Go now still
   * close the turn.
   */
  listen(): boolean {
    if (this.phase !== 'collecting') return false;
    this.listening++;
    return true;
  }

  /** The companions have answered or let it pass. The turn closes now if everyone is done. */
  stopListening(): void {
    if (this.listening === 0) return;
    this.listening--;
    this.closeIfReady();
  }

  /** What has been gathered so far this turn, in the order it was said. */
  gathered(): readonly CollectedAction[] {
    return this.phase === 'collecting' ? [...this.actions] : [];
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
    this.listening = 0;
    this.actions = [];
    this.passed = new Set();
    this.done = new Set();
    this.phase = 'idle';
    this.deadline = null;
    return held;
  }

  /** Drop a turn that is still being gathered, as when the story is rewound past it. */
  reset(): void {
    this.timer?.cancel();
    this.timer = undefined;
    this.queued = [];
    this.listening = 0;
    this.actions = [];
    this.passed = new Set();
    this.done = new Set();
    this.phase = 'idle';
    this.deadline = null;
  }

  /**
   * Change the text of an action not yet sent to the DM. 'resolving' when it
   * is in the turn the DM is resolving right now, 'none' when it is not held.
   */
  editAction(messageId: number, text: string): 'ok' | 'resolving' | 'none' {
    const held = this.queued.find((a) => a.messageId === messageId);
    if (held) {
      held.text = text;
      return 'ok';
    }
    const gathered = this.actions.find((a) => a.messageId === messageId);
    if (!gathered) return 'none';
    if (this.phase === 'resolving') return 'resolving';
    gathered.text = text;
    return 'ok';
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
      done: this.phase === 'idle' ? [] : [...this.done],
      passed: this.phase === 'idle' ? [] : [...this.passed],
      listening: this.phase === 'collecting' && this.listening > 0,
    };
  }

  private closeIfReady(): void {
    if (this.phase !== 'collecting' || this.actions.length === 0 || this.listening > 0) return;
    for (const seat of this.present) {
      if (!this.done.has(seat) && !this.passed.has(seat)) return;
    }
    this.close('all_ready');
  }

  private close(reason: ClosedTurn['reason']): void {
    if (this.phase !== 'collecting') return;
    this.timer?.cancel();
    this.timer = undefined;
    this.phase = 'resolving';
    this.deadline = null;
    this.listening = 0;
    this.onClose({ actions: this.actions, passed: [...this.passed], reason });
  }
}
