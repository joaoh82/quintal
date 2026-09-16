-- Preserve snapshots written before workspace-scoped activity keys.
UPDATE `agent_activity` SET `id` = `workspace_id` || ':' || `id`;
