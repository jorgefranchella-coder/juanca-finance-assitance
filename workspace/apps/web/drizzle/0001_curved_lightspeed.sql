CREATE TABLE `review_decisions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`import_record_id` integer NOT NULL,
	`user_id` text NOT NULL,
	`decision` text NOT NULL,
	`note` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`import_record_id`) REFERENCES `import_records`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_review_decisions_user_record` ON `review_decisions` (`user_id`,`import_record_id`);