import type { ChatMessage } from '@tavern/protocol';
import { useState } from 'react';
import { api } from '../api';
import { useAction } from '../app';
import { ConfirmButton, Field, Sheet } from '../ui';

/**
 * What can be done with one message: edit it (the host any narration or
 * action, a player their own actions), and for the host, take the story back
 * to a narration. Rewinding deletes everything after it and puts the game
 * state back as it stood there.
 */
export function MessageMenu({
  campaignId,
  message: m,
  owner,
  onClose,
}: {
  campaignId: string;
  message: ChatMessage;
  owner: boolean;
  onClose: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(m.content);
  const [busy, run] = useAction();
  const narration = m.kind === 'dm';
  const title = narration
    ? 'The Dungeon Master’s scene'
    : `${m.characterName ?? m.user?.displayName ?? 'Someone'}’s action`;

  const save = () =>
    run(async () => {
      await api(`/campaigns/${campaignId}/messages/${m.id}`, { method: 'PATCH', body: { content: text } });
      onClose();
    }, 'Edited');

  const rewind = () =>
    run(async () => {
      await api(`/campaigns/${campaignId}/rewind`, { body: { messageId: m.id } });
      onClose();
    }, 'The story is back at this scene');

  return (
    <Sheet title={title} onClose={onClose} tall={editing}>
      {editing ? (
        <div className="stack">
          <Field
            label="Text"
            hint={
              narration
                ? 'Names in [[double brackets]] link to the codex. The DM reads the new text from its next turn on.'
                : 'If the DM has not resolved this turn yet, it gets the new text.'
            }
          >
            <textarea
              className="textarea"
              rows={narration ? 12 : 4}
              value={text}
              maxLength={12000}
              onChange={(e) => setText(e.target.value)}
            />
          </Field>
          <button
            type="button"
            className="btn primary block"
            disabled={busy || !text.trim() || text.trim() === m.content}
            onClick={() => void save()}
          >
            Save
          </button>
          <button type="button" className="btn block" onClick={() => setEditing(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="stack">
          <button type="button" className="btn block" onClick={() => setEditing(true)}>
            Edit the text
          </button>
          {owner && narration && (
            <>
              <ConfirmButton
                className="btn danger block"
                confirmLabel="Tap again to rewind"
                disabled={busy}
                onConfirm={() => void rewind()}
              >
                Rewind the story to here
              </ConfirmButton>
              <p className="small muted">
                Everything after this scene is deleted: actions, narration and dice. The game goes back to how
                it stood here, including hit points, items, the codex and the DM&apos;s notes. This cannot be
                undone.
              </p>
            </>
          )}
        </div>
      )}
    </Sheet>
  );
}
