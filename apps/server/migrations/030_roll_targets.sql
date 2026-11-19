-- What a roll the DM asks a player to make has to reach, so the result can be
-- shown as a success or a failure. Null when the roll decides no pass or fail.
-- roll_under: success means rolling the target or lower (percentile chances).
ALTER TABLE roll_requests
  ADD COLUMN target integer,
  ADD COLUMN roll_under boolean NOT NULL DEFAULT false;
