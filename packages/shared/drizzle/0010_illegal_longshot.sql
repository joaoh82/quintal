ALTER TABLE `users` ADD `instance_admin` integer DEFAULT false NOT NULL;
--> statement-breakpoint
-- Existing instances keep exactly who they had.
--
-- Until now this was worked out on every check as "the earliest account", so
-- writing that same answer down changes nothing today and stops it moving
-- tomorrow. On an instance where the first sign-in was not the person running
-- it — a stale test identity, say — that is the wrong answer preserved
-- faithfully, and `pnpm admin` is how it gets corrected.
UPDATE `users` SET `instance_admin` = 1
WHERE `id` = (SELECT `id` FROM `users` ORDER BY `created_at`, `id` LIMIT 1);
