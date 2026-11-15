-- Rewinding play. Before every turn is resolved (and before the opening
-- scene) the game state is saved here, so the host can take the story back to
-- any narration and the world goes back with it: characters' vitals,
-- inventory, sheets and whereabouts, the codex, flags, the scene, the GM's
-- notebook, memories and the chronicle.
--
-- after_message_id is the newest message when the state was saved: the state
-- "just after message M" is the earliest snapshot with after_message_id >= M.
-- Rows are copied whole (to_jsonb), so a later migration that adds a NOT NULL
-- column without a default to one of those tables must also clear this table.
CREATE TABLE state_snapshots (
  id               bigserial PRIMARY KEY,
  campaign_id      uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  after_message_id bigint NOT NULL,
  turn_id          uuid,
  state            jsonb NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX state_snapshots_campaign_idx ON state_snapshots (campaign_id, after_message_id);

-- Messages the host or their author changed after they were posted.
ALTER TABLE messages ADD COLUMN edited_at timestamptz;

-- Between sessions: set when the host ends a session. The table sees the
-- recap, every player readies up, and the host resumes.
ALTER TABLE campaigns ADD COLUMN resting_since timestamptz;
