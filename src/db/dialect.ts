import Database from 'bun:sqlite';
import { Kysely, SqliteAdapter, SqliteQueryCompiler, CompiledQuery, SqliteIntrospector } from 'kysely';
import type { Driver, DatabaseConnection, Dialect } from 'kysely';

class BunSqliteConnection implements DatabaseConnection {
	private readonly _db: Database;

	constructor(db: Database) {
		this._db = db;
	}

	public executeQuery<O>({ sql, parameters }: CompiledQuery) {
		const stmt = this._db.prepare<O, any>(sql, parameters);

		if (stmt.columnNames.length > 0) {
			return Promise.resolve({
				rows: stmt.all(),
			});
		}

		const results = stmt.run();

		return Promise.resolve({
			insertId: BigInt(results.lastInsertRowid),
			numAffectedRows: BigInt(results.changes),
			rows: [],
		});
	}

	public async *streamQuery() {
		throw new Error('Streaming is not implemented in this dialect');
	}
}

class ConnectionMutex {
	private _promise?: Promise<void>;
	private _resolve?: () => void;

	async lock() {
		while (this._promise) {
			await this._promise;
		}

		this._promise = new Promise(resolve => {
			this._resolve = resolve;
		});
	}

	unlock() {
		const resolve = this._resolve;

		this._promise = undefined;
		this._resolve = undefined;

		resolve?.();
	}
}

class BunSqliteDriver implements Driver {
	private readonly _db: Database;
	private readonly _connection: DatabaseConnection;
	private readonly _connectionMutex = new ConnectionMutex();

	constructor(db: Database) {
		this._db = db;
		this._connection = new BunSqliteConnection(this._db);
	}

	async init() { }

	async acquireConnection() {
		await this._connectionMutex.lock();

		return this._connection;
	}

	async beginTransaction(connection: DatabaseConnection) {
		await connection.executeQuery(CompiledQuery.raw('begin'));
	}

	async commitTransaction(connection: DatabaseConnection) {
		await connection.executeQuery(CompiledQuery.raw('commit'));
	}

	async rollbackTransaction(connection: DatabaseConnection) {
		await connection.executeQuery(CompiledQuery.raw('rollback'));
	}

	async releaseConnection() {
		this._connectionMutex.unlock();
	}

	async destroy() {
		this._db.close();
	}
}

class BunSqliteDialect implements Dialect {
	private readonly _db: Database;

	constructor(path: string) {
		this._db = new Database(path);
	}

	createDriver(): Driver {
		return new BunSqliteDriver(this._db);
	}

	createQueryCompiler() {
		return new SqliteQueryCompiler();
	}

	createAdapter() {
		return new SqliteAdapter();
	}

	createIntrospector(db: Kysely<any>) {
		return new SqliteIntrospector(db);
	}
}

export { BunSqliteDialect };
