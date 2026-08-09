DROP INDEX `users_email_unique`;--> statement-breakpoint
DROP INDEX "accounts_user_id_idx";--> statement-breakpoint
DROP INDEX "agent_events_agent_created_idx";--> statement-breakpoint
DROP INDEX "agent_events_kind_idx";--> statement-breakpoint
DROP INDEX "agent_hosts_workspace_label";--> statement-breakpoint
DROP INDEX "agents_api_key_hash_unique";--> statement-breakpoint
DROP INDEX "agents_workspace_id_idx";--> statement-breakpoint
DROP INDEX "agents_owner_user_id_idx";--> statement-breakpoint
DROP INDEX "host_tokens_token_hash_unique";--> statement-breakpoint
DROP INDEX "invite_links_token_hash_unique";--> statement-breakpoint
DROP INDEX "invite_links_workspace_id_idx";--> statement-breakpoint
DROP INDEX "memberships_workspace_user_unique";--> statement-breakpoint
DROP INDEX "memberships_user_id_idx";--> statement-breakpoint
DROP INDEX "sessions_token_unique";--> statement-breakpoint
DROP INDEX "sessions_user_id_idx";--> statement-breakpoint
DROP INDEX "users_pubkey_unique";--> statement-breakpoint
DROP INDEX "verifications_identifier_idx";--> statement-breakpoint
DROP INDEX "workspaces_slug_unique";--> statement-breakpoint
ALTER TABLE `users` ALTER COLUMN "pubkey" TO "pubkey" text NOT NULL;--> statement-breakpoint
CREATE INDEX `accounts_user_id_idx` ON `accounts` (`user_id`);--> statement-breakpoint
CREATE INDEX `agent_events_agent_created_idx` ON `agent_events` (`agent_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `agent_events_kind_idx` ON `agent_events` (`kind`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_hosts_workspace_label` ON `agent_hosts` (`workspace_id`,`label`);--> statement-breakpoint
CREATE UNIQUE INDEX `agents_api_key_hash_unique` ON `agents` (`api_key_hash`);--> statement-breakpoint
CREATE INDEX `agents_workspace_id_idx` ON `agents` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `agents_owner_user_id_idx` ON `agents` (`owner_user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `host_tokens_token_hash_unique` ON `host_tokens` (`token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `invite_links_token_hash_unique` ON `invite_links` (`token_hash`);--> statement-breakpoint
CREATE INDEX `invite_links_workspace_id_idx` ON `invite_links` (`workspace_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `memberships_workspace_user_unique` ON `memberships` (`workspace_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `memberships_user_id_idx` ON `memberships` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_unique` ON `sessions` (`token`);--> statement-breakpoint
CREATE INDEX `sessions_user_id_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_pubkey_unique` ON `users` (`pubkey`);--> statement-breakpoint
CREATE INDEX `verifications_identifier_idx` ON `verifications` (`identifier`);--> statement-breakpoint
CREATE UNIQUE INDEX `workspaces_slug_unique` ON `workspaces` (`slug`);--> statement-breakpoint
ALTER TABLE `users` DROP COLUMN `email`;--> statement-breakpoint
ALTER TABLE `users` DROP COLUMN `email_verified`;