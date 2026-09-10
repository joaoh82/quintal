ALTER TABLE `agents` ADD `max_sessions` integer;--> statement-breakpoint
ALTER TABLE `office_settings` ADD `agent_parallelism` integer DEFAULT 10 NOT NULL;