import { DatabaseSync } from "node:sqlite";

/**
 * Now on the database clock, in milliseconds: the system clock SQLite reads, which the node-sqlite writers' queue
 * stamps and ages its tickets on. A test process's own `Date` can be seconds off it on Windows (#4387), so tests stamp
 * and age queue entries on this clock, never on `Date.now()`.
 */
export function databaseNow(): number {
	const clock = new DatabaseSync(":memory:");
	try {
		return Number(clock.prepare("SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER) AS now").get()!.now);
	} finally {
		clock.close();
	}
}

export interface FrozenDatabaseClock {
	/** Moves the frozen clock to `nowMs`. */
	set(nowMs: number): void;
	restore(): void;
}

/**
 * Makes every connection, the writers' queue's and `databaseNow`'s alike, read the database clock as `nowMs` until
 * `restore`, so a test controls ticket ages exactly and neither load nor a step of the system clock moves them. The
 * process clock (`Date`) is left alone: the writers' queue does not read it.
 */
export function freezeDatabaseClock(nowMs: number): FrozenDatabaseClock {
	let current = nowMs;
	const prepare = DatabaseSync.prototype.prepare;
	DatabaseSync.prototype.prepare = function (this: DatabaseSync, sql: string) {
		return prepare.call(this, sql.includes("unixepoch(") ? `SELECT ${current} AS now` : sql);
	} as typeof prepare;
	return {
		set: (next) => {
			current = next;
		},
		restore: () => {
			DatabaseSync.prototype.prepare = prepare;
		},
	};
}
