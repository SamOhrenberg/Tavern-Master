import type { Character, Entity, GameState } from '@tavern/protocol';
import { api } from '../api';
import { useAction } from '../app';
import { IconChevron, IconClose, IconPlus } from '../icons';
import { Avatar, Sheet } from '../ui';
import { isNpc } from './npcs';

/** How many faces of each group the strip shows before "+N". */
const FACES = 4;

/** Who is in the scene now: the party members with it, and the people and creatures the DM says are there. */
export function sceneCast(state: GameState) {
  return {
    party: state.characters.filter((c) => !c.whereabouts),
    away: state.characters.filter((c) => c.whereabouts),
    others: state.entities.filter((e) => isNpc(e) && e.inScene),
  };
}

function Faces({ people, party }: { people: (Character | Entity)[]; party?: boolean }) {
  const shown = people.slice(0, FACES);
  const more = people.length - shown.length;
  return (
    <span className={`faces${party ? ' party' : ''}`}>
      {shown.map((p) => (
        <Avatar key={p.id} name={p.name} seed={p.id} src={p.portrait} small />
      ))}
      {more > 0 && <span className="faces-more">+{more}</span>}
    </span>
  );
}

/**
 * The faces of everyone in the scene, above the story: the party, then the
 * people and creatures with them. A tap opens the scene. Nothing shows until
 * the DM has set a scene or someone else is there.
 */
export function SceneStrip({ state, onOpen }: { state: GameState; onOpen: () => void }) {
  const { party, others } = sceneCast(state);
  if (!others.length && !state.scene) return null;
  const label = others.length ? others.map((e) => e.name).join(', ') : state.scene;
  return (
    <button type="button" className="scene-strip" onClick={onOpen} aria-label={`In this scene: ${label}`}>
      {party.length > 0 && <Faces people={party} party />}
      {party.length > 0 && others.length > 0 && <i className="scene-dot" aria-hidden="true" />}
      {others.length > 0 && <Faces people={others} />}
      <span className="grow truncate scene-strip-text">{label}</span>
      <IconChevron className="chev" />
    </button>
  );
}

/**
 * The scene in full: where the party is, who is with them, and who is off
 * elsewhere. Tapping someone opens what the party knows of them. Owners can
 * put people in the scene or take them out, for when the DM forgot.
 */
export function SceneSheet({
  campaignId,
  state,
  owner,
  onEntry,
  onParty,
  onClose,
}: {
  campaignId: string;
  state: GameState;
  owner: boolean;
  onEntry: (e: Entity) => void;
  onParty: () => void;
  onClose: () => void;
}) {
  const [busy, run] = useAction();
  const { party, away, others } = sceneCast(state);
  const absent = owner ? state.entities.filter((e) => isNpc(e) && !e.inScene) : [];
  const place = (e: Entity, inScene: boolean) =>
    run(() => api(`/campaigns/${campaignId}/entities/${e.id}/scene`, { method: 'PUT', body: { inScene } }));

  return (
    <Sheet title="In this scene" onClose={onClose}>
      <div className="stack scene-sheet">
        {state.scene && <p className="story-lede scene-text">{state.scene}</p>}

        {party.length > 0 && (
          <section>
            <div className="section-title">
              <span>Party</span>
              <span>{party.length}</span>
            </div>
            <div className="entities">
              {party.map((c) => (
                <button key={c.id} type="button" className="entity scene-row" onClick={onParty}>
                  <Avatar name={c.name} seed={c.id} src={c.portrait} />
                  <b className="grow truncate">{c.name}</b>
                  {c.kind === 'npc' && <span className="pill arcane">Companion</span>}
                  <IconChevron className="chev" />
                </button>
              ))}
            </div>
          </section>
        )}

        <section>
          <div className="section-title">
            <span>Others</span>
            <span>{others.length}</span>
          </div>
          {others.length === 0 ? (
            <p className="small muted">Nobody else is here.</p>
          ) : (
            <div className="entities">
              {others.map((e) => (
                <div key={e.id} className="scene-other">
                  <button type="button" className="entity scene-row grow" onClick={() => onEntry(e)}>
                    <Avatar name={e.name} seed={e.id} src={e.portrait} />
                    <span className="grow scene-row-text">
                      <b className="truncate">{e.name}</b>
                      {(e.status || e.summary) && (
                        <span className="small muted truncate">{e.status || e.summary}</span>
                      )}
                    </span>
                    <IconChevron className="chev" />
                  </button>
                  {owner && (
                    <button
                      type="button"
                      className="icon-btn"
                      disabled={busy}
                      onClick={() => void place(e, false)}
                      aria-label={`${e.name} has left the scene`}
                    >
                      <IconClose />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>

        {away.length > 0 && (
          <section>
            <div className="section-title">
              <span>Elsewhere</span>
              <span>{away.length}</span>
            </div>
            <div className="entities">
              {away.map((c) => (
                <button key={c.id} type="button" className="entity scene-row away" onClick={onParty}>
                  <Avatar name={c.name} seed={c.id} src={c.portrait} />
                  <span className="grow scene-row-text">
                    <b className="truncate">{c.name}</b>
                    <span className="small muted truncate">{c.whereabouts}</span>
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}

        {absent.length > 0 && (
          <section>
            <div className="section-title">
              <span>Also here?</span>
            </div>
            <p className="small muted">
              For when the DM forgot someone. Players see the faces above the story.
            </p>
            <div className="scene-add">
              {absent.map((e) => (
                <button
                  key={e.id}
                  type="button"
                  className="btn sm"
                  disabled={busy}
                  onClick={() => void place(e, true)}
                >
                  <IconPlus /> {e.name}
                </button>
              ))}
            </div>
          </section>
        )}
      </div>
    </Sheet>
  );
}
