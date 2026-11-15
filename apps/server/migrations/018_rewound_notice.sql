-- Telling Claude the story was rewound. An outside DM keeps its own
-- conversation, which still holds the scenes a rewind deleted, so the next
-- thing it is handed says what happened. rewound_note is that message,
-- rewound_at when it was written, and rewind_told_at when it was delivered
-- (it is delivered once).
ALTER TABLE campaigns ADD COLUMN rewound_at timestamptz;
ALTER TABLE campaigns ADD COLUMN rewound_note text NOT NULL DEFAULT '';
ALTER TABLE campaigns ADD COLUMN rewind_told_at timestamptz;

-- A session a rewind reopened counts as just picked up, so its old messages
-- do not make it look abandoned (a session untouched for hours is wrapped up).
ALTER TABLE play_sessions ADD COLUMN resumed_at timestamptz;
