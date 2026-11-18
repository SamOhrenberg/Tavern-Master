-- Players an admin trusts with one game system. An owner of a system can do
-- everything an admin can to that system (rulebooks, sheet, workshop, GM
-- guide), but not to other systems or the rest of the server.
--
-- Campaigns need no change: campaign_members.role already allows several
-- owners. The creator (campaigns.owner_id) stays the host, whose AI and
-- Claude run the table.
CREATE TABLE game_system_owners (
  system_id  uuid NOT NULL REFERENCES game_systems(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  added_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (system_id, user_id)
);
CREATE INDEX game_system_owners_user_idx ON game_system_owners (user_id);
