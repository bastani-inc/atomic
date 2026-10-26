import { setTimeout as delay } from "node:timers/promises";
import { TestSqliteDatabase } from "../../packages/coding-agent/test/helpers/sqlite.js";

/** Creates the gate a gated pooled child waits on in `journalPath` (#4022). */
export function createReaskGate(journalPath: string): void {
	const database = new TestSqliteDatabase(journalPath);
	try {
		database.run("CREATE TABLE test_reask_gate(starts INTEGER, released INTEGER); INSERT INTO test_reask_gate VALUES (0, 0)");
	} finally {
		database.close();
	}
}

function gateRow(journalPath: string): { readonly starts: number; readonly released: number } {
	const database = new TestSqliteDatabase(journalPath);
	try {
		const row = database.query("SELECT starts, released FROM test_reask_gate").get() as
			| { readonly starts: number; readonly released: number }
			| undefined;
		return row ?? { starts: 0, released: 0 };
	} finally {
		database.close();
	}
}

/** How many times a gated child has started; the second start is the replacement attempt. */
export function reaskGateStarts(journalPath: string): number {
	return gateRow(journalPath).starts;
}

/** Lets the replacement attempt go on to ask again. */
export function releaseReaskGate(journalPath: string): void {
	const database = new TestSqliteDatabase(journalPath);
	try {
		database.run("UPDATE test_reask_gate SET released = 1");
	} finally {
		database.close();
	}
}

/**
 * Counts this start of the child; a replacement attempt (any start after the first) waits here
 * until the test releases it, so the test can answer in the window before the replacement asks.
 * Returns whether this is a replacement attempt.
 */
export async function passReaskGate(journalPath: string): Promise<boolean> {
	const database = new TestSqliteDatabase(journalPath);
	try {
		database.run("UPDATE test_reask_gate SET starts = starts + 1");
	} finally {
		database.close();
	}
	const replacement = gateRow(journalPath).starts > 1;
	while (replacement && gateRow(journalPath).released === 0) await delay(25);
	return replacement;
}
