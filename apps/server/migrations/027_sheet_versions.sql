-- Versions of a system's character sheet. Each published sheet is kept, so a
-- campaign stays on the version it was made with until its host moves it on.
-- game_systems.sheet_template stays the latest version; sheet_version says
-- which number that is. renames carries a field's values to its new name
-- (old key -> new key) when a version replaces one field with another.
CREATE TABLE sheet_versions (
  system_id  uuid NOT NULL REFERENCES game_systems(id) ON DELETE CASCADE,
  version    int NOT NULL CHECK (version >= 1),
  schema     jsonb NOT NULL,
  renames    jsonb NOT NULL DEFAULT '{}',
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (system_id, version)
);

ALTER TABLE game_systems ADD COLUMN sheet_version int NOT NULL DEFAULT 1;
ALTER TABLE campaigns ADD COLUMN sheet_version int NOT NULL DEFAULT 1;

-- Every system's sheet as it is today is its first version, and every campaign is on it.
INSERT INTO sheet_versions (system_id, version, schema)
SELECT id, 1, sheet_template FROM game_systems;
