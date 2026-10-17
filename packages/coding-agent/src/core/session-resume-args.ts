import { resolve } from "node:path";
import { selectSessionStorage } from "./session-storage.js";
import type { SessionStore } from "./storage/session/types.js";

/** Pin a SQLite conversation when the invoking project would select another store. */
export function sqliteSessionResumeArgs(store: SessionStore, cwd: string): string[] {
	const { adapter, location, prefix = "" } = store.descriptor;
	if (adapter !== "node-sqlite" || location === "" || location === ":memory:") return [];
	const path = resolve(location);
	const selected = selectSessionStorage(cwd);
	if (
		!("load" in selected) &&
		selected.kind === "sqlite" &&
		resolve(selected.path) === path &&
		(selected.prefix ?? "") === prefix
	)
		return [];
	return ["--session-store", path, ...(prefix === "" ? [] : ["--session-prefix", prefix])];
}
