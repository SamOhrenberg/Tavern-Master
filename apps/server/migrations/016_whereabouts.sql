-- Where a party member is when the party has split up, kept by the GM with
-- set_whereabouts. Empty means "with the party, in the current scene". A
-- companion with an AI of its own is shown only what happens where it is.
ALTER TABLE characters ADD COLUMN whereabouts text NOT NULL DEFAULT '';
