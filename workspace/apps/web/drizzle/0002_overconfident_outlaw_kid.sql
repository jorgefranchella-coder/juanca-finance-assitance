CREATE TABLE `cost_basis` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`owner` text NOT NULL,
	`instrument_code` text NOT NULL,
	`currency` text NOT NULL,
	`quantity` real NOT NULL,
	`average_unit_cost` real NOT NULL,
	`as_of` text NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_cost_basis_identity` ON `cost_basis` (`user_id`,`owner`,`instrument_code`,`currency`);--> statement-breakpoint
CREATE TABLE `market_quotes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`market` text NOT NULL,
	`symbol` text NOT NULL,
	`currency` text NOT NULL,
	`price` real NOT NULL,
	`provider` text NOT NULL,
	`quoted_at` text NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_market_quotes_identity` ON `market_quotes` (`user_id`,`market`,`symbol`);