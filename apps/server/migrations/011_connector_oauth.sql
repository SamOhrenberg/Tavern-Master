-- Clients that registered themselves to sign in (RFC 7591). Public clients only: no secrets.
CREATE TABLE oauth_clients (
  id            text PRIMARY KEY,                 -- 'tmo_' + 24 random bytes, base64url
  name          text NOT NULL,
  redirect_uris jsonb NOT NULL,                   -- array of strings, 1 to 5
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz
);

-- A sign-in in progress: stored at /oauth/authorize, answered on the approval screen.
CREATE TABLE oauth_requests (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id      text NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  redirect_uri   text NOT NULL,
  state          text,
  code_challenge text NOT NULL,
  resource       text NOT NULL,                   -- BASE_URL/mcp or BASE_URL/mcp/c/<campaign id>
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL             -- 10 minutes
);

-- One-time authorization codes. Only the hash is stored.
CREATE TABLE oauth_codes (
  code_hash      bytea PRIMARY KEY,
  client_id      text NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri   text NOT NULL,
  code_challenge text NOT NULL,
  resource       text NOT NULL,
  expires_at     timestamptz NOT NULL,            -- 5 minutes
  used_at        timestamptz,
  token_id       uuid REFERENCES connector_tokens(id) ON DELETE SET NULL
);

-- A connection made by signing in is a connector token that expires and can be refreshed.
ALTER TABLE connector_tokens
  ADD COLUMN client_id          text REFERENCES oauth_clients(id) ON DELETE CASCADE,
  ADD COLUMN resource           text,             -- NULL for hand-made tokens: valid on any connector address
  ADD COLUMN expires_at         timestamptz,      -- NULL for hand-made tokens: no expiry
  ADD COLUMN refresh_hash       bytea UNIQUE,
  ADD COLUMN prev_refresh_hash  bytea,            -- the refresh token just rotated out, to detect replay
  ADD COLUMN refresh_expires_at timestamptz;
CREATE INDEX connector_tokens_prev_refresh_idx ON connector_tokens (prev_refresh_hash)
  WHERE prev_refresh_hash IS NOT NULL;
