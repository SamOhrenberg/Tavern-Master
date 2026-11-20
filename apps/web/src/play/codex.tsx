import type { Entity, EntityKind } from '@tavern/protocol';
import { IconSparkle } from '../icons';
import { Sheet } from '../ui';
import { NpcPortrait } from './npcs';

const KIND_LABEL: Record<EntityKind, string> = {
  npc: 'Person',
  creature: 'Creature',
  location: 'Place',
  quest: 'Quest',
  item: 'Item',
  faction: 'Faction',
  event: 'Event',
  term: 'Lore',
};

/** The scoped codex entry a reader opened from a narration link: only what the party may know. */
export function CodexSheet({ entity, onClose }: { entity: Entity; onClose: () => void }) {
  return (
    <Sheet title={entity.name} onClose={onClose}>
      <div className="codex-entry">
        {entity.portrait && (
          <div className="npc-hero">
            <NpcPortrait src={entity.portrait} name={entity.name} />
          </div>
        )}
        <div className="row wrap">
          <span className="pill">{KIND_LABEL[entity.kind]}</span>
          {entity.status && <span className="pill">{entity.status}</span>}
        </div>
        {entity.aliases.length > 0 && (
          <p className="small muted aliases">Also known as {entity.aliases.join(', ')}</p>
        )}
        {entity.summary && <p className="codex-summary">{entity.summary}</p>}
        {entity.sheet.length > 0 && (
          <dl className="kv card stat-block">
            {entity.sheet.map((l, i) => (
              <div key={i} className="kv-row">
                <dt>{l.label}</dt>
                <dd>{l.value}</dd>
              </div>
            ))}
          </dl>
        )}
        {entity.article && <p className="codex-article">{entity.article}</p>}
        {entity.articleSecret && (
          <p className="secret">
            <IconSparkle /> {entity.articleSecret}
          </p>
        )}
        {entity.secret && (
          <p className="secret">
            <IconSparkle /> {entity.secret}
          </p>
        )}
        {!entity.summary && !entity.article && !entity.sheet.length && (
          <p className="small muted">The story has not recorded more about this yet.</p>
        )}
      </div>
    </Sheet>
  );
}
