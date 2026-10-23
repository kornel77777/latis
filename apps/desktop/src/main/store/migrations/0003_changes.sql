CREATE TABLE `checkpoints` (
	`id` text PRIMARY KEY NOT NULL,
	`chat_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`repo` text NOT NULL,
	`before` text NOT NULL,
	`after` text,
	`files_json` text DEFAULT '[]' NOT NULL,
	`undone_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `checkpoints_chat` ON `checkpoints` (`chat_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`chat_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`summary` text NOT NULL,
	`files_json` text NOT NULL,
	`decisions_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`reviewed_at` integer
);
--> statement-breakpoint
CREATE INDEX `reviews_open` ON `reviews` (`reviewed_at`,`created_at`);--> statement-breakpoint
CREATE TABLE `worktrees` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`path` text NOT NULL,
	`branch` text NOT NULL,
	`base_ref` text NOT NULL,
	`base_commit` text NOT NULL,
	`created_at` integer NOT NULL,
	`merged_at` integer,
	`removed_at` integer
);
