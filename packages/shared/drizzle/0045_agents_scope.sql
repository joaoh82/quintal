ALTER TABLE `agents` ADD `created_by_agent_id` text REFERENCES agents(id) ON DELETE set null;
--> statement-breakpoint
-- The agents scope is on by default, so every agent created so far gets it,
-- as with commands and routines: an agent makes and changes its owner's
-- agents, as its owner, and gives only scopes it holds, never this one. What
-- it makes is marked as its. An owner takes it away in Settings → Agents, as
-- with any scope.
UPDATE `agents`
SET `scopes` = json_insert(`scopes`, '$[#]', 'agents')
WHERE json_valid(`scopes`)
  AND json_type(`scopes`) = 'array'
  AND NOT EXISTS (SELECT 1 FROM json_each(`agents`.`scopes`) WHERE `json_each`.`value` = 'agents');
