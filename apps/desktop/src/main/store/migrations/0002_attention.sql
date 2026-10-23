CREATE TABLE `attention` (
	`id` text PRIMARY KEY NOT NULL,
	`chat_id` text NOT NULL,
	`kind` text NOT NULL,
	`ref_id` text,
	`data_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`resolved_at` integer
);
--> statement-breakpoint
CREATE INDEX `attention_open` ON `attention` (`resolved_at`,`created_at`);