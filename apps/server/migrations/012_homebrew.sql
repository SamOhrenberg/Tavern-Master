-- Homebrew systems: a table that plays one can talk rules over with its GM
-- at a shared rules desk, and the decisions it reaches are kept as rulings
-- that the GM follows from then on.
ALTER TABLE game_systems ADD COLUMN homebrew boolean NOT NULL DEFAULT false;

-- The rules desk: one out-of-character conversation per campaign, shared by
-- everyone at the table. user_id is the player who spoke (NULL for the GM).
CREATE TABLE rules_messages (
  id          bigserial PRIMARY KEY,
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  role        text NOT NULL CHECK (role IN ('user', 'assistant')),
  content     text NOT NULL,
  meta        jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rules_messages_campaign_idx ON rules_messages (campaign_id, id);

-- What the table and its GM settled on. Followed on every turn until retired.
--   rule:       a house rule or a change to how the system's rules work
--   direction:  how the table wants the campaign to play out
--   correction: a call the GM got wrong, and how the story stands now
CREATE TABLE rulings (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id  uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('rule', 'direction', 'correction')),
  content      text NOT NULL,
  requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  retired_at   timestamptz,
  retired_by   uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX rulings_campaign_idx ON rulings (campaign_id, created_at) WHERE retired_at IS NULL;

-- Claude answers the rules desk in a Claude campaign. subject_id is the campaign id.
ALTER TABLE dm_work DROP CONSTRAINT dm_work_kind_check;
ALTER TABLE dm_work ADD CONSTRAINT dm_work_kind_check
  CHECK (kind IN ('guide', 'sheet', 'catalogue', 'chronicle', 'rules'));
