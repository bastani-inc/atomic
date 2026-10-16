import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { makeTempDirectory, removeTempDirectory } from "./runtime.js";

export function makeLibsqlDirectory(): string {
	const root = process.env.ATOMIC_TEST_LIBSQL_ROOT;
	return root === undefined ? makeTempDirectory("atomic-libsql-") : mkdtempSync(join(root, "atomic-libsql-"));
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
	await collectReleasedLibsqlStatements();
	removeTempDirectory(directory);
}
