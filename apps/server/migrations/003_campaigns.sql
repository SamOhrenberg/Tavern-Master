-- Campaigns, membership, characters, sessions, turns and chat.
CREATE TABLE campaigns (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  system_id          uuid NOT NULL REFERENCES game_systems(id) ON DELETE RESTRICT,
  owner_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name               text NOT NULL,
  premise            text NOT NULL DEFAULT '',
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  settings           jsonb NOT NULL DEFAULT '{}',
  scene              text NOT NULL DEFAULT '',
  daily_token_budget bigint,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE campaign_members (
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        text NOT NULL DEFAULT 'player' CHECK (role IN ('owner', 'player')),
  joined_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (campaign_id, user_id)
);
CREATE INDEX campaign_members_user_idx ON campaign_members (user_id);

CREATE TABLE campaign_invites (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id  uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  inviter_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invitee_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  responded_at timestamptz,
  UNIQUE (campaign_id, invitee_id)
);
CREATE INDEX campaign_invites_invitee_idx ON campaign_invites (invitee_id) WHERE status = 'pending';

CREATE TABLE characters (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id   uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          text NOT NULL,
  sheet         jsonb NOT NULL DEFAULT '{}',
  hp            int NOT NULL DEFAULT 10,
  max_hp        int NOT NULL DEFAULT 10 CHECK (max_hp > 0),
  temp_hp       int NOT NULL DEFAULT 0 CHECK (temp_hp >= 0),
  conditions    jsonb NOT NULL DEFAULT '[]',
  inventory     jsonb NOT NULL DEFAULT '[]',
  private_notes text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, user_id),
  CHECK (hp >= 0 AND hp <= max_hp)
);

CREATE TABLE play_sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  number      int NOT NULL,
  started_at  timestamptz NOT NULL DEFAULT now(),
  ended_at    timestamptz,
  UNIQUE (campaign_id, number)
);

CREATE TABLE turns (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id  uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  session_id   uuid NOT NULL REFERENCES play_sessions(id) ON DELETE CASCADE,
  number       int NOT NULL,
  status       text NOT NULL DEFAULT 'collecting'
               CHECK (status IN ('collecting', 'resolving', 'done', 'failed')),
  opened_at    timestamptz NOT NULL DEFAULT now(),
  closed_at    timestamptz,
  close_reason text,
  UNIQUE (campaign_id, number)
);

CREATE TABLE messages (
  id             bigserial PRIMARY KEY,
  campaign_id    uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  session_id     uuid REFERENCES play_sessions(id) ON DELETE SET NULL,
  turn_id        uuid REFERENCES turns(id) ON DELETE SET NULL,
  kind           text NOT NULL CHECK (kind IN ('action', 'ooc', 'dm', 'system')),
  user_id        uuid REFERENCES users(id) ON DELETE SET NULL,
  character_name text,
  content        text NOT NULL,
  meta           jsonb NOT NULL DEFAULT '{}',
  summary_id     uuid,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_campaign_idx ON messages (campaign_id, id);
CREATE INDEX messages_unsummarised_idx ON messages (campaign_id, id) WHERE summary_id IS NULL;
