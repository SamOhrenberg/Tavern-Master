-- The workshop: a conversation the admins have with the AI about a game
-- system before anyone plays it. From it come proposed changes to the sheet
-- (kept in sheet_draft for review), and the system's GM guide: how to run the
-- game, topic by topic, and rulings every table on the system follows.
CREATE TABLE system_workshop_messages (
  id         bigserial PRIMARY KEY,
  system_id  uuid NOT NULL REFERENCES game_systems(id) ON DELETE CASCADE,
  -- Who spoke, for an admin's message; NULL for the AI.
  user_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  role       text NOT NULL CHECK (role IN ('user', 'assistant')),
  content    text NOT NULL,
  meta       jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX system_workshop_messages_idx ON system_workshop_messages (system_id, id);

ALTER TABLE game_systems
  ADD COLUMN gm_guide jsonb NOT NULL DEFAULT '{"version": 1, "topics": [], "rulings": []}';
