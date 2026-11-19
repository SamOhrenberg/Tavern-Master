-- The NPCs tab: people and creatures the party has met, each with a stat block
-- the DM keeps and the campaign's owners can edit.
--   creature: a kind for monsters and mobs ("Dumpster Roach"), beside npc.
--   sheet:    the stat block, as [{label, value, hidden}]. A hidden line is a
--             spoiler (exact hit points, a power not yet seen, a true motive)
--             that players are not sent until the DM reveals it.
--   hidden:   the whole entry is planned and the party has not met it yet.
--             Players are not sent it at all; naming it in narration shows it.
ALTER TABLE entities
  DROP CONSTRAINT entities_kind_check,
  ADD  CONSTRAINT entities_kind_check
       CHECK (kind IN ('npc', 'creature', 'location', 'quest', 'item', 'faction', 'event', 'term')),
  ADD COLUMN sheet  jsonb   NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN hidden boolean NOT NULL DEFAULT false;

-- Story rewinds restore entities from whole-row snapshots; give the rows in
-- snapshots taken before this migration the new columns, or restoring one
-- would put NULL into them.
UPDATE state_snapshots s
   SET state = jsonb_set(s.state, '{entities}', (
         SELECT coalesce(jsonb_agg(
                  e || jsonb_build_object('sheet', coalesce(e -> 'sheet', '[]'::jsonb),
                                          'hidden', coalesce(e -> 'hidden', 'false'::jsonb))), '[]'::jsonb)
           FROM jsonb_array_elements(s.state -> 'entities') e))
 WHERE jsonb_typeof(s.state -> 'entities') = 'array';
