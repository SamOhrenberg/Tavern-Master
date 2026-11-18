-- A roll the DM asks for is shown to the player only once the narration that
-- asked for it has been posted, so the dice never arrive before the story
-- that calls for them. Requests made before this change were already shown.
ALTER TABLE roll_requests ADD COLUMN shown boolean NOT NULL DEFAULT true;
