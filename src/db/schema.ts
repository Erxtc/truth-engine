import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const artifactTypes = ["hypothesis", "lemma", "project", "proof", "code_module", "experiment", "simulation_result", "failure_report", "insight", "constraint"] as const;
export const artifactStatuses = ["active", 'lemma', "dead", "superseded"] as const;
export const relationTypes = ["depends_on", "contradicts", "verifies", "refines", "subsumes", "cites", "generalizes", "specializes"] as const;
export const executionTypes = ["code_run", "project", "proof_check", "simulation", "benchmark"] as const;
export const problemStatuses = ["open", "partially_solved", "solved"] as const;
export const agentRoles = ["proposer", "critic", "judge", "executor", "formalizer", "synthesist", "curator"] as const;

export const problems = sqliteTable("problems", {
	id: text("id").primaryKey().notNull(),
	domain: text("domain").notNull(),
	description: text("description").notNull(),
	status: text("status", { enum: problemStatuses }).default("open").notNull(),
	createdAt: integer("createdAt", { mode: "timestamp" }).notNull().default(sql`(CURRENT_TIMESTAMP)`),
	updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull().default(sql`(CURRENT_TIMESTAMP)`),
});

export const artifacts = sqliteTable("artifacts", {
	id: text("id").primaryKey().notNull(),
	workspacePath: text("workspacePath"),
	type: text("type", { enum: artifactTypes }).notNull(),
	status: text("status", { enum: artifactStatuses }).default("active").notNull(),
	problemId: text("problemId")
		.notNull()
		.references(() => problems.id, { onDelete: "cascade" }),
	parentId: text("parentId"),
	depth: integer("depth").notNull().default(0),
	score: real("score").default(0).notNull(),

	title: text("title"),
	hypothesisText: text("hypothesisText"),
	formalStatement: text("formalStatement"),
	sourceCode: text("sourceCode"),
	payload: text("payload", { mode: "json" }),

	latestExecutionId: text("latestExecutionId"),
	provenance: text("provenance", { mode: "json" }),

	createdAt: integer("createdAt", { mode: "timestamp" }).notNull().default(sql`(CURRENT_TIMESTAMP)`),
	updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull().default(sql`(CURRENT_TIMESTAMP)`),
});

export const relations = sqliteTable("relations", {
	id: text("id").primaryKey().notNull(),
	sourceId: text("sourceId")
		.notNull()
		.references(() => artifacts.id, { onDelete: "cascade" }),
	targetId: text("targetId")
		.notNull()
		.references(() => artifacts.id, { onDelete: "cascade" }),
	relationType: text("relationType", { enum: relationTypes }).notNull(),
	properties: text("properties", { mode: "json" }),
	createdAt: integer("createdAt", { mode: "timestamp" }).notNull().default(sql`(CURRENT_TIMESTAMP)`),
});

export const executions = sqliteTable("executions", {
	id: text("id").primaryKey().notNull(),
	artifactId: text("artifactId")
		.notNull()
		.references(() => artifacts.id, { onDelete: "cascade" }),
	executionType: text("executionType").notNull(),
	passed: integer("passed", { mode: "boolean" }).notNull(),
	metrics: text("metrics", { mode: "json" }),
	errorLog: text("errorLog"),
	testResults: text("testResults", { mode: "json" }),
	runtimeMs: integer("runtimeMs"),
	createdAt: integer("createdAt", { mode: "timestamp" }).notNull().default(sql`(CURRENT_TIMESTAMP)`),
});

export const agentLogs = sqliteTable("agent_logs", {
	id: text("id").primaryKey().notNull(),
	artifactId: text("artifactId").references(() => artifacts.id),
	agentRole: text("agentRole", { enum: agentRoles }).notNull(),
	inputContext: text("inputContext"),
	response: text("response", { mode: "json" }),
	cost: real("cost"),
	timestamp: integer("timestamp", { mode: "timestamp" }).notNull().default(sql`(CURRENT_TIMESTAMP)`),
});

export type Problem = typeof problems.$inferSelect;
export type Artifact = typeof artifacts.$inferSelect;
export type Relation = typeof relations.$inferSelect;
export type Execution = typeof executions.$inferSelect;
export type AgentLog = typeof agentLogs.$inferSelect;