CREATE TABLE `canvases` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`viewport_json` text
);
--> statement-breakpoint
CREATE TABLE `chats` (
	`id` text PRIMARY KEY NOT NULL,
	`node_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`model` text,
	`reasoning` text,
	`permission_mode` text DEFAULT 'auto-edit' NOT NULL,
	`cwd` text NOT NULL,
	`worktree_id` text,
	`native_session_id` text,
	`title` text NOT NULL,
	`title_locked` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'idle' NOT NULL,
	`created_at` integer NOT NULL,
	`last_activity_at` integer NOT NULL,
	FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `events` (
	`chat_id` text NOT NULL,
	`seq` integer NOT NULL,
	`ts` integer NOT NULL,
	`turn_id` text,
	`type` text NOT NULL,
	`payload_json` text NOT NULL,
	PRIMARY KEY(`chat_id`, `seq`)
);
--> statement-breakpoint
CREATE TABLE `nodes` (
	`id` text PRIMARY KEY NOT NULL,
	`canvas_id` text NOT NULL,
	`project_id` text,
	`type` text NOT NULL,
	`x` real NOT NULL,
	`y` real NOT NULL,
	`w` real NOT NULL,
	`h` real NOT NULL,
	`z` integer DEFAULT 0 NOT NULL,
	`data_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`canvas_id`) REFERENCES `canvases`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `nodes_canvas` ON `nodes` (`canvas_id`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value_json` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `turns` (
	`id` text PRIMARY KEY NOT NULL,
	`chat_id` text NOT NULL,
	`seq` integer NOT NULL,
	`user_text` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`status` text DEFAULT 'running' NOT NULL,
	`checkpoint_before` text,
	`checkpoint_after` text,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `turns_chat` ON `turns` (`chat_id`,`seq`);