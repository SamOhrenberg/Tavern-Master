-- Structured game state, long-term memory and token accounting.
CREATE TABLE entities (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id     uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('npc', 'location', 'quest', 'item', 'faction')),
  name            text NOT NULL,
  summary         text NOT NULL DEFAULT '',
  status          text NOT NULL DEFAULT '',
  data            jsonb NOT NULL DEFAULT '{}',
  secret          text,
  secret_revealed boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX entities_name_idx ON entities (campaign_id, kind, lower(name));

CREATE TABLE flags (
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  key         text NOT NULL,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (campaign_id, key)
);

CREATE TABLE state_events (
  id          bigserial PRIMARY KEY,
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  turn_id     uuid REFERENCES turns(id) ON DELETE SET NULL,
  actor       text NOT NULL,
  tool        text NOT NULL,
  target_type text,
  target_id   text,
  summary     text NOT NULL,
  diff        jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX state_events_campaign_idx ON state_events (campaign_id, id DESC);

CREATE TABLE dice_rolls (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id    uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  turn_id        uuid REFERENCES turns(id) ON DELETE SET NULL,
  expression     text NOT NULL,
  detail         jsonb NOT NULL,
  total          int NOT NULL,
  reason         text NOT NULL DEFAULT '',
  character_name text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX dice_rolls_campaign_idx ON dice_rolls (campaign_id, created_at DESC);

CREATE TABLE summaries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id     uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  session_id      uuid REFERENCES play_sessions(id) ON DELETE SET NULL,
  kind            text NOT NULL CHECK (kind IN ('chunk', 'session')),
  content         text NOT NULL,
  from_message_id bigint,
  to_message_id   bigint,
  token_count     int NOT NULL DEFAULT 0,
  superseded_at   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX summaries_campaign_idx ON summaries (campaign_id, created_at);

CREATE TABLE memories (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id   uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  kind          text NOT NULL DEFAULT 'fact' CHECK (kind IN ('fact', 'thread', 'promise')),
  content       text NOT NULL,
  importance    int NOT NULL DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
  source        text NOT NULL DEFAULT 'dm' CHECK (source IN ('dm', 'summary')),
  superseded_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX memories_campaign_idx ON memories (campaign_id) WHERE superseded_at IS NULL;

CREATE TABLE usage_events (
  id                 bigserial PRIMARY KEY,
  at                 timestamptz NOT NULL DEFAULT now(),
  user_id            uuid REFERENCES users(id) ON DELETE SET NULL,
  campaign_id        uuid REFERENCES campaigns(id) ON DELETE SET NULL,
  task               text NOT NULL,
  provider           text NOT NULL,
  model              text NOT NULL,
  key_source         text NOT NULL DEFAULT 'instance' CHECK (key_source IN ('instance', 'byo')),
  input_tokens       int NOT NULL DEFAULT 0,
  output_tokens      int NOT NULL DEFAULT 0,
  cache_read_tokens  int NOT NULL DEFAULT 0,
  cache_write_tokens int NOT NULL DEFAULT 0,
  cost_micro_usd     bigint NOT NULL DEFAULT 0
);
CREATE INDEX usage_user_idx ON usage_events (user_id, at);
CREATE INDEX usage_campaign_idx ON usage_events (campaign_id, at);
