CREATE TABLE `mcp_servers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`transport` text NOT NULL,
	`command` text,
	`args_json` text DEFAULT '[]' NOT NULL,
	`url` text,
	`secret` blob,
	`shared` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `chats` ADD `role` text;--> statement-breakpoint
ALTER TABLE `chats` ADD `workspace_tools` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `chats` ADD `spawned_by` text;--> statement-breakpoint
ALTER TABLE `chats` ADD `connections_json` text DEFAULT '[]' NOT NULL;