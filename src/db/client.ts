import { Kysely, sql } from "kysely";
import { BunSqliteDialect } from "./dialect";
import type { DB } from "./types";

export const db = new Kysely<DB>({
	dialect: new BunSqliteDialect("./db.sqlite"),
});


// TODO: Test updates:
async function trackUpdates(tableName: string) {
	await sql`
		CREATE TRIGGER IF NOT EXISTS ${sql.raw(`update_${tableName}_updatedAt`)}
		AFTER UPDATE ON ${sql.raw(tableName)}
		FOR EACH ROW
		WHEN NEW.updatedAt IS NOT OLD.updatedAt
		BEGIN
			UPDATE ${sql.raw(tableName)}
			SET updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ','now')
			WHERE rowid = NEW.rowid;
		END;
	`.execute(db);
}

async function tableHasUpdatedAt(tableName: string) {
	const res = await sql`
    PRAGMA table_info(${sql.raw(tableName)})
  `.execute(db);

	return res.rows.some((c: any) => c.name === "updatedAt");
}

async function getTables(): Promise<string[]> {
	const res = await sql`
    SELECT name FROM sqlite_master
    WHERE type='table'
    AND name NOT LIKE 'sqlite_%'
  `.execute(db);

	return res.rows.map((r: any) => r.name);
}

export async function setupUpdateTriggers() {
	const tables = await getTables();

	for (const table of tables) {
		const hasUpdatedAt = await tableHasUpdatedAt(table);

		if (!hasUpdatedAt) continue;

		await trackUpdates(table);
	}
}

await sql`PRAGMA journal_mode = WAL;`.execute(db);
await sql`PRAGMA busy_timeout = 5000;`.execute(db);
await setupUpdateTriggers();