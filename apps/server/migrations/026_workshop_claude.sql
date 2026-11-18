-- Who answers a system's workshop in the app: the built-in AI, or an admin's
-- Claude through the connector (open_workshop, workshop_wait, workshop_reply).
ALTER TABLE game_systems
  ADD COLUMN workshop_ai text NOT NULL DEFAULT 'server' CHECK (workshop_ai IN ('server', 'claude'));
