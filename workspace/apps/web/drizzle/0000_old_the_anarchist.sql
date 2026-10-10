CREATE TABLE `import_records` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`import_id` text NOT NULL,
	`record_kind` text NOT NULL,
	`source_sheet` text NOT NULL,
	`source_row` integer NOT NULL,
	`event_type` text,
	`requires_review` integer DEFAULT false NOT NULL,
	`payload` text NOT NULL,
	FOREIGN KEY (`import_id`) REFERENCES `imports`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_import_records_import` ON `import_records` (`import_id`);--> statement-breakpoint
CREATE TABLE `imports` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`owner` text NOT NULL,
	`file_type` text NOT NULL,
	`file_name` text NOT NULL,
	`sha256` text NOT NULL,
	`reference_date` text,
	`object_key` text NOT NULL,
	`record_count` integer NOT NULL,
	`market_value_cents` integer,
	`review_required` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'processed' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_imports_user_sha_type` ON `imports` (`user_id`,`sha256`,`file_type`);--> statement-breakpoint
CREATE INDEX `idx_imports_user_created` ON `imports` (`user_id`,`created_at`);