-- A picture of a person or creature on the NPCs tab, chosen by the campaign's
-- owners. The file lives in the uploads directory under this random storage
-- name, as character pictures do.
--
-- Kept beside entities rather than in them: a story rewind deletes and
-- re-inserts every entity row from a snapshot, and a picture is the owners'
-- choice, not something play changes, so it must come through a rewind
-- untouched. For the same reason there is no foreign key to entities; the
-- code removes a picture with its entry.
CREATE TABLE npc_portraits (
  entity_id   uuid PRIMARY KEY,
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  portrait    text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX npc_portraits_campaign ON npc_portraits (campaign_id);
