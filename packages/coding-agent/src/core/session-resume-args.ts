import { resolve } from "node:path";
import type { SessionStore } from "./storage/session/types.js";

/** Pin the open SQLite store without re-reading settings or guessing startup trust. */
export function sqliteSessionResumeArgs(store: SessionStore): string[] {
	const { adapter, location, prefix = "" } = store.descriptor;
	if (adapter !== "node-sqlite" || location === "" || location === ":memory:") return [];
	return ["--session-store", resolve(location), ...(prefix === "" ? [] : ["--session-prefix", prefix])];
}
