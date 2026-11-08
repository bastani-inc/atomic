import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { makeTempDirectory, removeTempDirectory } from "./runtime.js";

/**
 * Collect-and-remove attempts before a still-locked libSQL file fails the test. On Windows a native
 * connection can outlive one collection pass, and its open file blocks the unlink with EBUSY.
 */
const LIBSQL_REMOVE_ATTEMPTS = 10;
const LIBSQL_REMOVE_RETRY_MS = 100;

export function makeLibsqlDirectory(prefix = "atomic-libsql-"): string {
	const root = process.env.ATOMIC_TEST_LIBSQL_ROOT;
	return root === undefined ? makeTempDirectory(prefix) : mkdtempSync(join(root, prefix));
}

/** libsql 0.5.29 retains native connections until its discarded statements are collected. */
export async function collectReleasedLibsqlStatements(): Promise<void> {
	if (typeof Bun !== "undefined") {
		Bun.gc(true);
	} else {
		const { setFlagsFromString } = await import("node:v8");
		const { runInNewContext } = await import("node:vm");
		setFlagsFromString("--expose-gc");
		let collect: () => void;
		try {
			collect = runInNewContext("gc") as () => void;
		} finally {
			setFlagsFromString("--no-expose-gc");
		}
		collect();
	}
	// Native finalizers run after collection, before the next event-loop turn.
	await new Promise<void>((resolve) => setImmediate(resolve));
}

export async function removeLibsqlDirectory(directory: string): Promise<void> {
	// The Bun child's parent owns this root and removes it after the child exits, releasing all native handles.
	if (process.env.ATOMIC_TEST_LIBSQL_ROOT !== undefined) return;
	for (let attempt = 1; ; attempt++) {
		await collectReleasedLibsqlStatements();
		try {
			removeTempDirectory(directory);
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if ((code !== "EBUSY" && code !== "EPERM") || attempt >= LIBSQL_REMOVE_ATTEMPTS) throw error;
			await new Promise<void>((resolve) => setTimeout(resolve, LIBSQL_REMOVE_RETRY_MS));
		}
	}
}
