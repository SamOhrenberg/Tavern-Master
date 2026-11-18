-- A sheet schema the AI drafted from a system's rulebooks, waiting for an
-- admin to review. Nothing in it reaches the sheets until the admin applies
-- some or all of its changes; then the draft is cleared.
ALTER TABLE game_systems
  ADD COLUMN sheet_draft        jsonb,
  -- What the drafter could not settle from the documents, for the admin to decide.
  ADD COLUMN sheet_draft_notes  jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN sheet_draft_status text NOT NULL DEFAULT 'none'
             CHECK (sheet_draft_status IN ('none', 'queued', 'drafting', 'ready', 'failed')),
  ADD COLUMN sheet_draft_error  text,
  ADD COLUMN sheet_draft_at     timestamptz;
