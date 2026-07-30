import { createRequire } from "node:module";

/**
 * A `bun:sqlite`-shaped fixture handle backed by whichever builtin exists.
 *
 * These suites were written against `bun:sqlite`, whose `Database` exposes
 * `run(sql, ...params)` directly. `node:sqlite` splits that into `exec()` for
 * parameterless statements and `prepare().run()` for bound ones, and refuses to
 * bind the booleans `bun:sqlite` stores as integer 1/0. Absorbing both here
 * keeps every existing call site and assertion unchanged, so these suites still
 * prove what they proved when they ran only under Bun.
 *
 * Mirrors the preference order in `src/core/tools/resource-selectors.ts`:
 * `node:sqlite` first, `bun:sqlite` as the fallback for Bun releases that
 * predate oven-sh/bun#32498.
 */

interface FixtureRow {
	[column: string]: unknown;
}
interface FixtureStatement {
	all(...params: unknown[]): FixtureRow[];
	get(...params: unknown[]): FixtureRow | undefined;
	run(...params: unknown[]): unknown;
}
interface FixtureDatabase {
	run(sql: string, ...params: unknown[]): void;
	query(sql: string): FixtureStatement;
	close(): void;
}

function bindValues(params: readonly unknown[]): unknown[] {
	return params.map((param) => (typeof param === "boolean" ? (param ? 1 : 0) : param));
}

interface NodeSqliteDatabase {
	exec(sql: string): void;
	prepare(sql: string): FixtureStatement;
	close(): void;
}
interface BunSqliteDatabase {
	run(sql: string, ...params: unknown[]): void;
	query(sql: string): FixtureStatement;
	close(): void;
}

export class TestSqliteDatabase implements FixtureDatabase {
	private readonly node?: NodeSqliteDatabase;
	private readonly bun?: BunSqliteDatabase;

	constructor(path: string) {
		const requireModule = createRequire(import.meta.url);
		try {
			const { DatabaseSync } = requireModule("node:sqlite") as {
				DatabaseSync: new (path: string) => NodeSqliteDatabase;
			};
			this.node = new DatabaseSync(path);
		} catch {
			const { Database } = requireModule("bun:sqlite") as { Database: new (path: string) => BunSqliteDatabase };
			this.bun = new Database(path);
		}
	}

	run(sql: string, ...params: unknown[]): void {
		if (this.bun) {
			this.bun.run(sql, ...params);
			return;
		}
		const node = this.node as NodeSqliteDatabase;
		if (params.length === 0) {
			node.exec(sql);
			return;
		}
		node.prepare(sql).run(...bindValues(params));
	}

	query(sql: string): FixtureStatement {
		if (this.bun) return this.bun.query(sql);
		const statement = (this.node as NodeSqliteDatabase).prepare(sql);
		return {
			all: (...params: unknown[]) => statement.all(...bindValues(params)),
			get: (...params: unknown[]) => statement.get(...bindValues(params)),
			run: (...params: unknown[]) => statement.run(...bindValues(params)),
		};
	}

	close(): void {
		(this.node ?? this.bun)?.close();
	}
}

/** The `{ Database }` shape the existing fixture call sites destructure. */
export function sqlite(): { Database: typeof TestSqliteDatabase } {
	return { Database: TestSqliteDatabase };
}
