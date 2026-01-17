-- Fix corrupted player names in convocation_poules by joining with players table
UPDATE convocation_poules cp
SET player_name = COALESCE(
  (SELECT CONCAT(p.last_name, ' ', p.first_name) 
   FROM players p 
   WHERE REPLACE(p.licence, ' ', '') = REPLACE(cp.licence, ' ', '')),
  cp.player_name
)
WHERE cp.player_name = 'undefined undefined' OR cp.player_name IS NULL OR cp.player_name = '';
