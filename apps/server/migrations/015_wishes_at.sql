-- Players can change their wishes for the story after the campaign begins.
-- When they last did, so the GM hears about it without its brief being
-- compiled again.
ALTER TABLE campaign_members ADD COLUMN wishes_at timestamptz;
