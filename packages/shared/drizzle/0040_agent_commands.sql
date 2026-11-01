ALTER TABLE `office_commands` ADD `written_by` text REFERENCES users(id);--> statement-breakpoint
ALTER TABLE `office_commands` ADD `written_by_agent_id` text REFERENCES agents(id);
--> statement-breakpoint
-- The commands scope is on by default, so every agent created so far gets
-- it: an agent writes a command as its owner, and what it writes is marked
-- as its. An owner takes it away in Settings → Agents, as with any scope.
UPDATE `agents`
SET `scopes` = json_insert(`scopes`, '$[#]', 'commands')
WHERE json_valid(`scopes`)
  AND json_type(`scopes`) = 'array'
  AND NOT EXISTS (SELECT 1 FROM json_each(`agents`.`scopes`) WHERE `json_each`.`value` = 'commands');
