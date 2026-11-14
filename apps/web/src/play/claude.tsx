import type { DmStatus } from '@tavern/protocol';
import { timeAgo } from '../ui';

/** Where Claude is, in a few words. */
export function dmLine(dm: DmStatus): string {
  switch (dm.state) {
    case 'listening':
      return 'Claude is at the table';
    case 'working':
      return 'Claude is working';
    case 'away':
      return `Claude is away · here ${timeAgo(dm.lastSeenAt)}`;
    case 'never':
      return 'Claude has not joined yet';
  }
}

/** A dot and a line saying whether Claude is at the table. */
export function DmChip({ dm }: { dm: DmStatus }) {
  return (
    <span className={`dm-chip ${dm.state}`} role="status">
      <i aria-hidden="true" />
      <span className="truncate">{dmLine(dm)}</span>
      {dm.waiting > 0 && dm.state !== 'working' && (
        <span className="dm-chip-count">{dm.waiting} waiting</span>
      )}
    </span>
  );
}

/** Claude is not at the table right now, so nothing will be answered until it is. */
export const dmAbsent = (dm: DmStatus | null | undefined): boolean =>
  !!dm && dm.mode === 'claude' && (dm.state === 'away' || dm.state === 'never');
