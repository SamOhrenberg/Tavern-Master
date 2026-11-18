-- A picture of each character, chosen by whoever may edit its sheet. The file
-- lives in the uploads directory under this random storage name; NULL means
-- the character has none and the app draws its initial instead.
ALTER TABLE characters ADD COLUMN portrait text;
