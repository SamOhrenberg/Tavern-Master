import type { CampaignMember } from '@tavern/protocol';
import { IconCheck } from '../icons';
import { Avatar } from '../ui';

/** "Ann", "Ann and Bob", "Ann, Bob and Cy". */
export function nameList(names: string[]): string {
  return names.length <= 1
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** Everyone but the host (other owners too), who readies up before the host begins or resumes. */
export function playersOf(members: CampaignMember[], hostId: string) {
  const players = members.filter((m) => m.id !== hostId);
  return { players, waitingOn: players.filter((m) => !m.ready) };
}

/** Who is ready, as a titled list. Nothing when the host plays alone. */
export function ReadyList({
  members,
  hostId,
  meId,
  title,
}: {
  members: CampaignMember[];
  hostId: string;
  meId: string;
  title: string;
}) {
  const { players, waitingOn } = playersOf(members, hostId);
  if (players.length === 0) return null;
  return (
    <section>
      <div className="section-title">
        <span>{title}</span>
        <span>
          {players.length - waitingOn.length}/{players.length}
        </span>
      </div>
      <div className="list ready-list">
        {players.map((m) => (
          <div key={m.id}>
            <Avatar name={m.displayName} seed={m.id} small />
            <span className="grow truncate">
              {m.id === meId ? 'You' : m.displayName}
              {m.characterName && <span className="muted"> · {m.characterName}</span>}
            </span>
            {m.ready ? (
              <span className="pill jade">
                <IconCheck /> Ready
              </span>
            ) : (
              <span className="pill">Not yet</span>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
