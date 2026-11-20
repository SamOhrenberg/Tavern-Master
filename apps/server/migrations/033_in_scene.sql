-- Who is in the current scene besides the party: the people and creatures
-- the DM says are there (set_scene's `present`), shown above the story. The
-- party's side is each character's whereabouts (empty: in the scene).
-- Kept on the entry, so a story rewind puts back who was there with it.
ALTER TABLE entities ADD COLUMN in_scene boolean NOT NULL DEFAULT false;

-- Story rewinds restore entities from whole-row snapshots; give the rows in
-- snapshots taken before this migration the new column, or restoring one
-- would put NULL into it.
UPDATE state_snapshots s
   SET state = jsonb_set(s.state, '{entities}', (
         SELECT coalesce(jsonb_agg(e || jsonb_build_object('in_scene', coalesce(e -> 'in_scene', 'false'::jsonb))),
                         '[]'::jsonb)
           FROM jsonb_array_elements(s.state -> 'entities') e))
 WHERE jsonb_typeof(s.state -> 'entities') = 'array';
