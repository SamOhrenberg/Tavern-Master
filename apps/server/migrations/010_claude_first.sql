-- Work waiting for a Dungeon Master outside the server (the Claude app):
-- everything except gathered turns, which stay on the in-memory desk because
-- they belong to a live room.
CREATE TABLE dm_work (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id  uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('guide', 'sheet', 'catalogue', 'chronicle')),
  -- What it is about. One open item per subject.
  --   guide:     builder_threads.id
  --   sheet:     a fresh uuid
  --   catalogue: documents.id
  --   chronicle: 'chunk' | 'session:<play_sessions.id>' | 'arc' | 'notes'
  subject_id   text NOT NULL,
  requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  payload      jsonb NOT NULL DEFAULT '{}',
  status       text NOT NULL DEFAULT 'waiting'
               CHECK (status IN ('waiting', 'claimed', 'done', 'failed', 'cancelled')),
  result       jsonb,
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  claimed_at   timestamptz,
  finished_at  timestamptz
);
CREATE UNIQUE INDEX dm_work_open_idx ON dm_work (campaign_id, kind, subject_id)
  WHERE status IN ('waiting', 'claimed');
CREATE INDEX dm_work_queue_idx ON dm_work (campaign_id, created_at)
  WHERE status IN ('waiting', 'claimed');
CREATE INDEX dm_work_requester_idx ON dm_work (campaign_id, requested_by, kind);

-- The last time an outside DM called any tool for this campaign.
ALTER TABLE campaigns ADD COLUMN dm_seen_at timestamptz;
