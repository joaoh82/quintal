CREATE TABLE `agent_activity` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL REFERENCES `workspaces`(`id`) ON DELETE cascade,
  `conversation_id` text NOT NULL REFERENCES `conversations`(`id`) ON DELETE cascade,
  `agent_id` text NOT NULL,
  `sequence` integer NOT NULL,
  `started_at` integer NOT NULL,
  `x` integer,
  `y` integer,
  `snapshot` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `agent_activity_conversation_idx` ON `agent_activity` (`workspace_id`, `conversation_id`, `started_at`);
