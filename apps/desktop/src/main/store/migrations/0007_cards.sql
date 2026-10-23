CREATE TABLE `card_data` (
	`card_id` text NOT NULL,
	`key` text NOT NULL,
	`value_json` text NOT NULL,
	PRIMARY KEY(`card_id`, `key`)
);
--> statement-breakpoint
CREATE TABLE `cards` (
	`id` text PRIMARY KEY NOT NULL,
	`node_id` text NOT NULL,
	`title` text NOT NULL,
	`network_json` text DEFAULT '[]' NOT NULL,
	`refresh_hash` text,
	`gate` text,
	`created_at` integer NOT NULL
);
