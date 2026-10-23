CREATE TABLE `edges` (
	`id` text PRIMARY KEY NOT NULL,
	`flow_id` text NOT NULL,
	`source` text NOT NULL,
	`target` text NOT NULL,
	`mode` text DEFAULT 'every' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `edges_flow` ON `edges` (`flow_id`);--> statement-breakpoint
CREATE TABLE `flow_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`flow_id` text NOT NULL,
	`status` text NOT NULL,
	`trigger` text NOT NULL,
	`state_json` text NOT NULL,
	`log_json` text DEFAULT '[]' NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer
);
--> statement-breakpoint
CREATE INDEX `flow_runs_flow` ON `flow_runs` (`flow_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `flows` (
	`id` text PRIMARY KEY NOT NULL,
	`node_id` text NOT NULL,
	`name` text NOT NULL,
	`brief` text DEFAULT '' NOT NULL,
	`schedule_json` text,
	`next_run_at` integer,
	`loop_limit` integer DEFAULT 10 NOT NULL,
	`created_at` integer NOT NULL
);
