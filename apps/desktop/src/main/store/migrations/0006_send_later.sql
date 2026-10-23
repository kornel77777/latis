CREATE TABLE `scheduled` (
	`id` text PRIMARY KEY NOT NULL,
	`chat_id` text NOT NULL,
	`text` text NOT NULL,
	`fire_at` integer NOT NULL,
	`repeat_ms` integer,
	`on_reset` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `scheduled_fire` ON `scheduled` (`fire_at`);--> statement-breakpoint
ALTER TABLE `chats` ADD `continued_from` text;