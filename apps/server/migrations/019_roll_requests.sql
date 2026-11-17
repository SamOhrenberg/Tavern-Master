-- Rolls the DM asks a player to make. The DM calls request_roll for a
-- player-run character; only that character's players are shown the dice,
-- the server rolls the requested expression when they tap it, and the result
-- goes into the next turn as that character's action. A request is closed
-- when it is rolled, or dropped when the DM resolves a turn without it.
CREATE TABLE roll_requests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id  uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  character_id uuid NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  expression   text NOT NULL,
  reason       text NOT NULL DEFAULT '',
  kind         text NOT NULL DEFAULT 'check'
               CHECK (kind IN ('attack','damage','check','save','initiative','other')),
  -- The turn whose narration asked for it (null for the opening scene).
  turn_id      uuid REFERENCES turns(id) ON DELETE SET NULL,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','rolled','dropped')),
  roll_id      uuid REFERENCES dice_rolls(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  closed_at    timestamptz
);
CREATE INDEX roll_requests_pending_idx ON roll_requests (campaign_id) WHERE status = 'pending';
