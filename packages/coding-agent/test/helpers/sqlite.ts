import { createRequire } from "node:module";

/**
 * A `bun:sqlite`-shaped fixture handle backed by `node:sqlite`.
 *
 * These suites were written against `bun:sqlite`, whose `Database` exposes
 * `run(sql, ...params)` directly. `node:sqlite` splits that into `exec()` for
 * parameterless statements and `prepare().run()` for bound ones, and refuses to
 * bind the booleans `bun:sqlite` stores as integer 1/0. Absorbing both here
 * keeps every existing call site and assertion unchanged, so these suites still
 * prove what they proved when they ran only under Bun.
 *
 * Mirrors `src/core/tools/resource-selectors.ts`: `node:sqlite` only, which
 * Node ≥ 24.20.0 and Bun ≥ 1.4.2 (this repository's floor) both ship. The
 * `bun:sqlite` fallback was removed with the earlier 1.4.0 floor.
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

export class TestSqliteDatabase implements FixtureDatabase {
	private readonly node: NodeSqliteDatabase;

	constructor(path: string) {
		const requireModule = createRequire(import.meta.url);
		const { DatabaseSync } = requireModule("node:sqlite") as {
			DatabaseSync: new (path: string) => NodeSqliteDatabase;
		};
		this.node = new DatabaseSync(path);
	}

	run(sql: string, ...params: unknown[]): void {
		if (params.length === 0) {
			this.node.exec(sql);
			return;
		}
		this.node.prepare(sql).run(...bindValues(params));
	}

	query(sql: string): FixtureStatement {
		const statement = this.node.prepare(sql);
		return {
			all: (...params: unknown[]) => statement.all(...bindValues(params)),
			get: (...params: unknown[]) => statement.get(...bindValues(params)),
			run: (...params: unknown[]) => statement.run(...bindValues(params)),
		};
	}

	close(): void {
		this.node.close();
	}
}

/** The `{ Database }` shape the existing fixture call sites destructure. */
export function sqlite(): { Database: typeof TestSqliteDatabase } {
	return { Database: TestSqliteDatabase };
}
