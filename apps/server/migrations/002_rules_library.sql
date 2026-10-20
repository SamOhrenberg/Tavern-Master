-- Game systems, uploaded rule documents, retrieval chunks, background jobs.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE game_systems (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug           citext NOT NULL UNIQUE,
  name           text NOT NULL,
  description    text NOT NULL DEFAULT '',
  sheet_template jsonb NOT NULL DEFAULT '{"abilities": [], "fields": []}',
  created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE documents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  system_id       uuid NOT NULL REFERENCES game_systems(id) ON DELETE CASCADE,
  title           text NOT NULL,
  original_name   text NOT NULL,
  storage_name    text NOT NULL UNIQUE,
  mime            text NOT NULL,
  size_bytes      bigint NOT NULL,
  sha256          text NOT NULL,
  status          text NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued', 'parsing', 'embedding', 'ready', 'failed')),
  error           text,
  page_count      int,
  chunk_count     int NOT NULL DEFAULT 0,
  embedding_model text,
  uploaded_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  processed_at    timestamptz
);
CREATE INDEX documents_system_idx ON documents (system_id);

CREATE TABLE chunks (
  id              bigserial PRIMARY KEY,
  document_id     uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  system_id       uuid NOT NULL REFERENCES game_systems(id) ON DELETE CASCADE,
  ordinal         int NOT NULL,
  heading         text NOT NULL DEFAULT '',
  page_start      int,
  page_end        int,
  content         text NOT NULL,
  token_count     int NOT NULL DEFAULT 0,
  tsv             tsvector GENERATED ALWAYS AS (
                    setweight(to_tsvector('english', heading), 'A') ||
                    setweight(to_tsvector('english', content), 'B')
                  ) STORED,
  -- Dimension is left open so systems can use different embedding models.
  -- Retrieval is an exact scan filtered by system; no ANN index at this scale.
  embedding       vector,
  embedding_model text
);
CREATE INDEX chunks_system_idx ON chunks (system_id, embedding_model);
CREATE INDEX chunks_document_idx ON chunks (document_id);
CREATE INDEX chunks_tsv_idx ON chunks USING gin (tsv);

CREATE TABLE jobs (
  id           bigserial PRIMARY KEY,
  kind         text NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}',
  status       text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  run_at       timestamptz NOT NULL DEFAULT now(),
  attempts     int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 3,
  locked_at    timestamptz,
  locked_by    text,
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz
);
CREATE INDEX jobs_queue_idx ON jobs (run_at) WHERE status = 'queued';
