-- The routines scope is on by default, so every agent created so far gets
-- it: an agent keeps routines on itself and its owner's other agents, as its
-- owner, and what it makes is marked as its. An owner takes it away in
-- Settings → Agents, as with any scope.
UPDATE `agents`
SET `scopes` = json_insert(`scopes`, '$[#]', 'routines')
WHERE json_valid(`scopes`)
  AND json_type(`scopes`) = 'array'
  AND NOT EXISTS (SELECT 1 FROM json_each(`agents`.`scopes`) WHERE `json_each`.`value` = 'routines');
