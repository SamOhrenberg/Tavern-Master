-- Feedback from inside the app: bug reports, ideas and general comments.
-- Each becomes a GitHub issue on the repository the server is configured
-- with (GITHUB_FEEDBACK_REPO); its status and replies are read back from
-- there. Attached images stay on this server (see feedback_images) and the
-- issue links to them, so a screenshot of a private game is never published.
CREATE TABLE feedback (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('bug', 'idea', 'feedback')),
  title        text NOT NULL,
  body         text NOT NULL DEFAULT '',
  -- Where it was sent from: page, device, app version. Nothing the user typed.
  context      jsonb NOT NULL DEFAULT '{}',
  issue_number int,
  issue_url    text,
  -- Why it has not reached GitHub yet; it is tried again later.
  send_error   text,
  sent_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX feedback_user_idx ON feedback (user_id, created_at DESC);

CREATE TABLE feedback_images (
  feedback_id  uuid NOT NULL REFERENCES feedback(id) ON DELETE CASCADE,
  n            int NOT NULL,
  -- 'screenshot' of the page they were on, or a 'photo' from their device.
  source       text NOT NULL CHECK (source IN ('screenshot', 'photo')),
  storage_name text NOT NULL,
  mime         text NOT NULL,
  bytes        int NOT NULL,
  PRIMARY KEY (feedback_id, n)
);
