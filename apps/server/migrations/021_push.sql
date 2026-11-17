-- Push notifications (Web Push). Each browser or installed app that allowed
-- notifications leaves a subscription: an endpoint at its push service
-- (Apple, Google, Mozilla) and the keys to encrypt messages for it.
CREATE TABLE push_subscriptions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The sign-in on that device. A device that is signed out (logout, a
  -- revoked session, expiry) must stop showing the table on its lock screen.
  session_id   uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  endpoint     text NOT NULL UNIQUE,
  p256dh       text NOT NULL,
  auth         text NOT NULL,
  user_agent   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- Last time the app confirmed it still holds this subscription.
  seen_at      timestamptz NOT NULL DEFAULT now(),
  last_sent_at timestamptz,
  -- Consecutive failed deliveries; the subscription is dropped past a few.
  failures     int NOT NULL DEFAULT 0
);
CREATE INDEX push_subscriptions_user_idx ON push_subscriptions (user_id);
CREATE INDEX push_subscriptions_session_idx ON push_subscriptions (session_id);

-- Which kinds of notification each person wants. A missing key means on.
ALTER TABLE users ADD COLUMN notify_prefs jsonb NOT NULL DEFAULT '{}';

-- Silence one campaign without touching the others.
ALTER TABLE campaign_members ADD COLUMN notify_muted boolean NOT NULL DEFAULT false;

-- The server's own VAPID key pair, made on first use so nothing has to be
-- configured. Changing it would invalidate every subscription, so it is kept.
CREATE TABLE push_keys (
  id          int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  public_key  text NOT NULL,
  private_enc text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Quiet hours: {"start": "22:00", "end": "08:00", "timeZone": "Europe/Berlin"}, or null.
ALTER TABLE users ADD COLUMN notify_quiet jsonb;

-- Notifications held during someone's quiet hours, one per campaign (tag),
-- sent as a single summary when they end. The most important one is kept.
CREATE TABLE push_held (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tag        text NOT NULL,
  payload    jsonb NOT NULL,
  count      int NOT NULL DEFAULT 1,
  held_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, tag)
);
