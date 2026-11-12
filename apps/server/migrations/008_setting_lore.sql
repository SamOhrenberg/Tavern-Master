-- Setting packs: a game system's distilled "voice" — vocabulary, tone, pacing
-- and in-universe colour — read from the setting documents uploaded to it.
-- This is flavour the DM may lean on, never rules: lore is kept apart from the
-- rules corpus and is never retrieved as if it were mechanics.
--
-- Setting documents are the existing library documents with kind = 'setting'
-- (added in 005). Their prose stays searchable in `chunks`; this column holds
-- only the small distilled summary that rides in the prompt.
ALTER TABLE game_systems
  ADD COLUMN lore        jsonb,
  ADD COLUMN lore_status text NOT NULL DEFAULT 'none'
             CHECK (lore_status IN ('none', 'queued', 'reading', 'ready', 'failed')),
  ADD COLUMN lore_error  text,
  ADD COLUMN lore_at     timestamptz;
