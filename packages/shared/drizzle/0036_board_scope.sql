-- The board scope is on by default, so every agent created so far gets it:
-- a note an agent writes is read by everybody, and handing one over obeys
-- the same owner rule a person's hand-over does. An owner takes it away in
-- Settings → Agents, as with any scope.
UPDATE `agents`
SET `scopes` = json_insert(`scopes`, '$[#]', 'board')
WHERE json_valid(`scopes`)
  AND json_type(`scopes`) = 'array'
  AND NOT EXISTS (SELECT 1 FROM json_each(`agents`.`scopes`) WHERE `json_each`.`value` = 'board');
