-- Ready check in the lobby: every player (everyone but the host) marks
-- themselves ready, and the campaign cannot begin until they all have.
ALTER TABLE campaign_members ADD COLUMN ready_at timestamptz;
