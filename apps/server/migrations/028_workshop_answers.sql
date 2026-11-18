-- Which admin messages an answer covers. Claude answers the workshop through
-- the connector and admins can write while it works, so an answer covers the
-- messages up to the last one Claude read, not every message before it.
-- NULL means every message before the answer (the built-in AI's answers).
ALTER TABLE system_workshop_messages ADD COLUMN answers_through bigint;
