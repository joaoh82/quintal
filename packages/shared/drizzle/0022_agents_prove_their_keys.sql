ALTER TABLE `agents` ADD `pubkey` text;--> statement-breakpoint
ALTER TABLE `agents` ADD `attestation` text;--> statement-breakpoint
CREATE UNIQUE INDEX `agents_pubkey_unique` ON `agents` (`pubkey`);--> statement-breakpoint
ALTER TABLE `agents` ALTER COLUMN "api_key_hash" TO "api_key_hash" text;
