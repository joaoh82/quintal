-- Split "office settings" into the two different things it always was.
--
-- The deployment has a name, shown to somebody who has not signed in. An office
-- has a chat radius, a walk-up radius and a reply window, which describe how
-- its room behaves. These shared one row because rooms were keyed by map alone,
-- so every workspace shared one room and there was nowhere to hang a per-office
-- radius. Rooms are per-office now, so these separate.
--
-- Order matters: the values are copied out before the old table is rebuilt.

CREATE TABLE `instance_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint

-- Keep the name this deployment already had.
INSERT INTO `instance_settings` (`id`, `name`, `updated_at`)
SELECT 'global', `name`, `updated_at` FROM `office_settings` WHERE `id` = 'global';
--> statement-breakpoint

-- Every office starts from what the whole instance was using, so nobody's room
-- changes behaviour under them. Defaults are only for offices made later.
CREATE TABLE `__new_office_settings` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`chat_radius_tiles` integer DEFAULT 12 NOT NULL,
	`walk_up_radius_tiles` integer DEFAULT 3 NOT NULL,
	`reply_window_seconds` integer DEFAULT 90 NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint

INSERT INTO `__new_office_settings`
  (`workspace_id`, `chat_radius_tiles`, `walk_up_radius_tiles`, `reply_window_seconds`, `updated_at`)
SELECT
  w.`id`,
  COALESCE(o.`chat_radius_tiles`, 12),
  COALESCE(o.`walk_up_radius_tiles`, 3),
  COALESCE(o.`reply_window_seconds`, 90),
  COALESCE(o.`updated_at`, unixepoch() * 1000)
FROM `workspaces` w
LEFT JOIN `office_settings` o ON o.`id` = 'global';
--> statement-breakpoint

DROP TABLE `office_settings`;
--> statement-breakpoint
ALTER TABLE `__new_office_settings` RENAME TO `office_settings`;
