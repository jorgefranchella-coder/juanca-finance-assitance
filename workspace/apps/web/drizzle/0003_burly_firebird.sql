CREATE TABLE `chat_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`attachment_name` text,
	`attachment_type` text,
	`object_key` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_chat_messages_user_created` ON `chat_messages` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `transaction_proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`user_id` text NOT NULL,
	`owner` text NOT NULL,
	`side` text NOT NULL,
	`instrument_code` text NOT NULL,
	`quantity` real NOT NULL,
	`unit_price` real NOT NULL,
	`currency` text NOT NULL,
	`trade_date` text NOT NULL,
	`fees_minor` integer DEFAULT 0 NOT NULL,
	`source` text NOT NULL,
	`confidence` real NOT NULL,
	`evidence` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`applied_import_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `chat_messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_transaction_proposals_user_status` ON `transaction_proposals` (`user_id`,`status`,`created_at`);