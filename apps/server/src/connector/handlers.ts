import type { Table, ToolImage } from './toolkit.js';
import type { WorkItem, WorkKind } from './work.js';

/** What Claude is handed for one request. */
export interface WorkView {
  text: string;
  images?: ToolImage[];
}

/**
 * How one kind of request is prepared, shown to Claude and dropped. Each kind
 * registers its handler from the module that holds its tools.
 */
export interface WorkHandler {
  /**
   * Runs once, when the item is first claimed: work out what it covers and
   * store that in its payload. Returns the item as updated, or null when
   * there is nothing to do any more and the item should be dropped.
   */
  prepare?(item: WorkItem, t: Table): Promise<WorkItem | null>;
  render(item: WorkItem, t: Table): Promise<WorkView>;
  /** A line for the list of open requests. */
  label(item: WorkItem): string;
  /** Claude dropped it with skip_work: tell whoever asked. */
  skipped?(item: WorkItem, reason: string, t: Table): Promise<void>;
}

const handlers = new Map<WorkKind, WorkHandler>();

export function registerWork(kind: WorkKind, handler: WorkHandler): void {
  handlers.set(kind, handler);
}

export function handlerFor(kind: WorkKind): WorkHandler {
  return (
    handlers.get(kind) ?? {
      label: () => `${kind} request`,
      render: async (item) => ({
        text: `Request ${item.id} (${kind}) cannot be handled by this server. Drop it with skip_work.`,
      }),
    }
  );
}
