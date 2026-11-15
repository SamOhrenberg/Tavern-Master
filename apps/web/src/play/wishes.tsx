import { useEffect, useState } from 'react';
import { api } from '../api';
import { useAction } from '../app';
import { Field } from '../ui';

/**
 * What a player hopes the story holds, and anything they would rather avoid.
 * Only they and the DM read it. It can change at any time: in the lobby it
 * shapes the DM's plan, and once play has begun the DM hears about the change
 * on its next turn.
 */
export function WishesEditor({
  campaignId,
  saved,
  inPlay,
  onSaved,
}: {
  campaignId: string;
  /** The wishes as stored. */
  saved: string;
  inPlay: boolean;
  onSaved: () => Promise<unknown> | void;
}) {
  const [wishes, setWishes] = useState(saved);
  const [busy, run] = useAction();
  useEffect(() => setWishes(saved), [saved]);

  const save = () =>
    run(
      async () => {
        await api(`/campaigns/${campaignId}/wishes`, { method: 'PUT', body: { wishes } });
        await onSaved();
      },
      inPlay ? 'The DM will work it in from here' : 'The DM will keep it in mind',
    );

  return (
    <div className="stack">
      <Field
        label="Optional"
        hint={
          inPlay
            ? 'Add or change what you would love to see, or what you would rather avoid, at any time. Only you and the DM read this, and the DM picks it up on the next turn.'
            : 'Things you would love to see, and anything you would rather avoid. Only you and the DM read this. Leave it empty to be surprised.'
        }
      >
        <textarea
          className="textarea"
          rows={3}
          value={wishes}
          onChange={(e) => setWishes(e.target.value)}
          placeholder="A heist. A rival who keeps turning up. No spiders."
          maxLength={1200}
        />
      </Field>
      {wishes.trim() !== saved && (
        <button type="button" className="btn block" disabled={busy} onClick={() => void save()}>
          Save for the DM
        </button>
      )}
    </div>
  );
}
