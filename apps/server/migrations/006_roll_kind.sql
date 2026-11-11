-- Make the intent of a roll explicit: attack (to hit), damage, check, etc.
-- Older rows and unspecified rolls default to 'other'.
ALTER TABLE dice_rolls
  ADD COLUMN kind text NOT NULL DEFAULT 'other'
      CHECK (kind IN ('attack','damage','check','save','initiative','other'));
