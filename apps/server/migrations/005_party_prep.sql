-- The party (several characters, each run by players, the GM or its own AI),
-- the prep phase before play, campaign documents, the GM's notebook and the
-- character-builder chats.

ALTER TABLE campaigns
  ADD COLUMN phase      text NOT NULL DEFAULT 'prep' CHECK (phase IN ('prep', 'active')),
  ADD COLUMN started_at timestamptz,
  -- Set once the GM has planned the campaign and written its opening scene.
  ADD COLUMN opened_at  timestamptz,
  -- The GM's compiled record (notebook, facts, summaries, document list). It
  -- is rebuilt only now and then so the prompt prefix stays cacheable.
  ADD COLUMN brief      text NOT NULL DEFAULT '',
  ADD COLUMN brief_at   timestamptz;

-- Campaigns that already exist are in play.
UPDATE campaigns SET phase = 'active', started_at = created_at, opened_at = created_at;

-- What each player hopes the story will (and will not) contain.
ALTER TABLE campaign_members ADD COLUMN wishes text NOT NULL DEFAULT '';

ALTER TABLE characters
  ADD COLUMN kind       text NOT NULL DEFAULT 'pc' CHECK (kind IN ('pc', 'npc')),
  ADD COLUMN controller text NOT NULL DEFAULT 'player' CHECK (controller IN ('player', 'gm', 'agent')),
  ADD COLUMN persona    text NOT NULL DEFAULT '',
  ADD COLUMN created_by uuid REFERENCES users(id) ON DELETE SET NULL;

-- Who speaks for a player-run character. Rows go away with the membership.
CREATE TABLE character_players (
  character_id uuid NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  campaign_id  uuid NOT NULL,
  user_id      uuid NOT NULL,
  PRIMARY KEY (character_id, user_id),
  FOREIGN KEY (campaign_id, user_id) REFERENCES campaign_members (campaign_id, user_id) ON DELETE CASCADE
);
CREATE INDEX character_players_user_idx ON character_players (campaign_id, user_id);

INSERT INTO character_players (character_id, campaign_id, user_id)
SELECT c.id, c.campaign_id, c.user_id
  FROM characters c
  JOIN campaign_members m ON m.campaign_id = c.campaign_id AND m.user_id = c.user_id;
UPDATE characters SET created_by = user_id;
-- Dropping the column also drops the one-character-per-player constraint.
ALTER TABLE characters DROP COLUMN user_id;

-- Campaign documents share the rules pipeline. A NULL campaign_id is a
-- library rulebook; anything else belongs to exactly one campaign.
ALTER TABLE documents
  ADD COLUMN campaign_id uuid REFERENCES campaigns(id) ON DELETE CASCADE,
  ADD COLUMN audience    text NOT NULL DEFAULT 'table' CHECK (audience IN ('table', 'gm')),
  -- NULL until the cataloguer (or the uploader) has classified it.
  ADD COLUMN kind        text CHECK (kind IN ('rules', 'setting', 'adventure', 'character', 'handout', 'other')),
  ADD COLUMN summary     text NOT NULL DEFAULT '';
CREATE INDEX documents_campaign_idx ON documents (campaign_id) WHERE campaign_id IS NOT NULL;

ALTER TABLE chunks ADD COLUMN campaign_id uuid REFERENCES campaigns(id) ON DELETE CASCADE;
CREATE INDEX chunks_campaign_idx ON chunks (campaign_id) WHERE campaign_id IS NOT NULL;

-- The GM's private notebook: living pages it rewrites as the story moves.
CREATE TABLE gm_notes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  title       text NOT NULL,
  content     text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX gm_notes_title_idx ON gm_notes (campaign_id, lower(title));

-- Old sessions are merged into arc summaries so the list stays short.
ALTER TABLE summaries DROP CONSTRAINT summaries_kind_check;
ALTER TABLE summaries ADD CONSTRAINT summaries_kind_check CHECK (kind IN ('chunk', 'session', 'arc'));

-- Lets the GM search everything that was ever said at the table.
CREATE INDEX messages_fts_idx ON messages USING gin (to_tsvector('english', content))
  WHERE kind IN ('action', 'dm');

-- One private chat per player and character with the character-building guide.
CREATE TABLE builder_threads (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id  uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  character_id uuid REFERENCES characters(id) ON DELETE SET NULL,
  -- For a character that does not exist yet: who will run it.
  intent       jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX builder_threads_owner_idx ON builder_threads (campaign_id, user_id);

CREATE TABLE builder_messages (
  id         bigserial PRIMARY KEY,
  thread_id  uuid NOT NULL REFERENCES builder_threads(id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('user', 'assistant')),
  content    text NOT NULL,
  meta       jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX builder_messages_thread_idx ON builder_messages (thread_id, id);
