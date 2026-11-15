-- Other AIs the GM can ask for help: an admin adds one with its API key, and
-- in play the GM (built-in or Claude) can send it a request with ask_ai, for
-- whatever a game system's instructions say it does better. The key is
-- encrypted at rest and never leaves the server.
CREATE TABLE outside_ais (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  provider    text NOT NULL CHECK (provider IN ('gemini', 'openai')),
  model       text NOT NULL,
  -- Only for 'openai': any OpenAI-compatible endpoint. NULL means api.openai.com.
  base_url    text,
  api_key_enc text NOT NULL,
  key_hint    text NOT NULL,
  -- What the GM is told this AI is good for.
  note        text NOT NULL DEFAULT '',
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX outside_ais_name_idx ON outside_ais (lower(name));

-- Standing instructions an admin writes for the GM of every table that plays
-- this system, e.g. "ask Gemini to write achievement announcements".
ALTER TABLE game_systems ADD COLUMN gm_instructions text NOT NULL DEFAULT '';
