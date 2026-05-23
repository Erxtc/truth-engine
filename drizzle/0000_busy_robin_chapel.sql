CREATE TABLE `agent_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`artifactId` text,
	`agentRole` text NOT NULL,
	`inputContext` text,
	`response` text,
	`cost` real,
	`timestamp` integer DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	FOREIGN KEY (`artifactId`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`workspacePath` text,
	`type` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`problemId` text NOT NULL,
	`parentId` text,
	`depth` integer DEFAULT 0 NOT NULL,
	`score` real DEFAULT 0 NOT NULL,
	`title` text,
	`hypothesisText` text,
	`formalStatement` text,
	`sourceCode` text,
	`payload` text,
	`latestExecutionId` text,
	`provenance` text,
	`createdAt` integer DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updatedAt` integer DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	FOREIGN KEY (`problemId`) REFERENCES `problems`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `executions` (
	`id` text PRIMARY KEY NOT NULL,
	`artifactId` text NOT NULL,
	`executionType` text NOT NULL,
	`passed` integer NOT NULL,
	`metrics` text,
	`errorLog` text,
	`testResults` text,
	`runtimeMs` integer,
	`createdAt` integer DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	FOREIGN KEY (`artifactId`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `problems` (
	`id` text PRIMARY KEY NOT NULL,
	`domain` text NOT NULL,
	`description` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`stepPlan` text,
	`currentStep` integer DEFAULT 0 NOT NULL,
	`createdAt` integer DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updatedAt` integer DEFAULT (CURRENT_TIMESTAMP) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `relations` (
	`id` text PRIMARY KEY NOT NULL,
	`sourceId` text NOT NULL,
	`targetId` text NOT NULL,
	`relationType` text NOT NULL,
	`properties` text,
	`createdAt` integer DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	FOREIGN KEY (`sourceId`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`targetId`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE cascade
);
