ALTER TABLE `artifacts` ADD `confidenceLevel` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `problems` ADD `requiredConfidence` integer DEFAULT 2 NOT NULL;