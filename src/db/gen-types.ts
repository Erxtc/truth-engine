import fs from "fs";
import path from "path";
import { db } from "./client";
import { sql } from "kysely";

const TABLES = [
	"problems",
	"artifacts",
	"relations",
	"executions",
	"agent_logs",
] as const;

function sqliteToTsType(type: string | null): string {
	if (!type) return "string";

	const t = type.toLowerCase();

	if (t.includes("int")) return "number";
	if (t.includes("real") || t.includes("float") || t.includes("double")) return "number";
	if (t.includes("bool")) return "boolean";
	if (t.includes("json")) return "any";

	return "string";
}

let output = `/* AUTO-GENERATED FILE from src/db/gen-types.ts */\n\n`;

output += `export interface DB {\n`;

for (const tableName of TABLES) {
	const colsResult = await sql`
PRAGMA table_info(${sql.raw(`"${tableName}"`)})
`.execute(db);

	const cols = colsResult.rows as Array<{
		name: string;
		type: string;
		notnull: number;
	}>;

	output += `  ${tableName}: {\n`;

	for (const col of cols) {
		const tsType = sqliteToTsType(col.type);
		const optional = col.notnull ? "" : " | null";

		output += `    ${col.name}: ${tsType}${optional}\n`;
	}

	output += `  }\n`;
}

output += `}\n`;

fs.writeFileSync(path.join(__dirname, "./types.ts"), output);

console.log("✅ DB types generated from SQLite PRAGMA");