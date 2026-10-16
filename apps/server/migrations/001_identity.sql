-- Identity, sessions, invites, friendships, audit log.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE users (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username           citext NOT NULL UNIQUE,
  email              citext UNIQUE,
  display_name       text NOT NULL,
  password_hash      text NOT NULL,
  role               text NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  totp_secret_enc    text,
  totp_enabled_at    timestamptz,
  recovery_codes     jsonb NOT NULL DEFAULT '[]',
  failed_logins      int NOT NULL DEFAULT 0,
  locked_until       timestamptz,
  daily_token_budget bigint,
  created_at         timestamptz NOT NULL DEFAULT now(),
  last_login_at      timestamptz
);

CREATE TABLE sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   bytea NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  ip           text,
  user_agent   text
);
CREATE INDEX sessions_user_idx ON sessions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE invites (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash  bytea NOT NULL UNIQUE,
  code_hint  text NOT NULL,
  role       text NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  note       text NOT NULL DEFAULT '',
  max_uses   int NOT NULL DEFAULT 1 CHECK (max_uses > 0),
  uses       int NOT NULL DEFAULT 0,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE friendships (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  addressee_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  responded_at timestamptz,
  CHECK (requester_id <> addressee_id)
);
-- one row per unordered pair
CREATE UNIQUE INDEX friendships_pair_idx
  ON friendships (least(requester_id, addressee_id), greatest(requester_id, addressee_id));
CREATE INDEX friendships_addressee_idx ON friendships (addressee_id);

CREATE TABLE user_api_keys (
  user_id         uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  provider        text NOT NULL CHECK (provider IN ('anthropic', 'openai', 'openrouter')),
  key_enc         text NOT NULL,
  key_hint        text NOT NULL,
  model_narration text,
  model_utility   text,
  enabled         boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  actor_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  action      text NOT NULL,
  target_type text,
  target_id   text,
  ip          text,
  meta        jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX audit_log_at_idx ON audit_log (at DESC);
