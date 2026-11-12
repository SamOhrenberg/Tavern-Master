-- Campaign encyclopedia: broaden the kinds a tracked entity can take, and give
-- each one the fields a browsable codex needs. Secrets stay server-side until
-- revealed; the article/aliases/summary hold only what players may know.
ALTER TABLE entities
  DROP CONSTRAINT entities_kind_check,
  ADD  CONSTRAINT entities_kind_check
       CHECK (kind IN ('npc', 'location', 'quest', 'item', 'faction', 'event', 'term')),
  ADD COLUMN aliases               jsonb   NOT NULL DEFAULT '[]'::jsonb,  -- other names the DM may use
  ADD COLUMN article               text    NOT NULL DEFAULT '',            -- player-visible longer entry
  ADD COLUMN article_secret        text,                                   -- DM-only extension, revealed with `secret`
  ADD COLUMN first_seen_message_id bigint,                                 -- when players first met it
  ADD COLUMN in_codex              boolean NOT NULL DEFAULT true;          -- hide pure bookkeeping entities

-- Case-insensitive lookup of a name for inline linking and codex search.
CREATE INDEX entities_name_lower ON entities (campaign_id, lower(name));
