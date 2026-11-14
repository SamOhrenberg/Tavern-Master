-- Connector tokens: let an outside MCP client (the Claude app, through a
-- custom connector) act as the Dungeon Master for campaigns its user owns.
-- Like sessions, only a hash of the token is stored; the token itself is
-- shown once when it is made.
--
-- `campaign_id` is the campaign the client last opened with open_campaign.
-- Every other connector tool acts on it, so no tool takes a campaign argument
-- that the model could point somewhere else.
CREATE TABLE connector_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   bytea NOT NULL UNIQUE,
  label        text NOT NULL,
  campaign_id  uuid REFERENCES campaigns(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);
CREATE INDEX connector_tokens_user_idx ON connector_tokens (user_id) WHERE revoked_at IS NULL;
