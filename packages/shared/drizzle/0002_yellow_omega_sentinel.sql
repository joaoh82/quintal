CREATE TABLE `office_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`chat_radius_tiles` integer DEFAULT 12 NOT NULL,
	`walk_up_radius_tiles` integer DEFAULT 3 NOT NULL,
	`reply_window_seconds` integer DEFAULT 90 NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
