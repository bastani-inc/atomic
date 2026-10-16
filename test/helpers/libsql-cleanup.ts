import { removeTempDirectory } from "./runtime.js";

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
	await collectReleasedLibsqlStatements();
	removeTempDirectory(directory);
}
