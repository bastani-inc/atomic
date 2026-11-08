import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { JsonWireValue } from "./framing.js";
import { BROKER_STORAGE_ENV } from "./paths.js";

/**
 * The raw shared `storage` selection, read without the host package so the broker stays self-contained: the
 * selection the launching process handed this broker in `ATOMIC_STORAGE` (its `--storage`, `--storage-file` or own
 * `ATOMIC_STORAGE`), otherwise the top-level `storage` value of the agent directory's settings. Relative paths in
 * either resolve against the agent directory's parent, as for sessions and the journal. `undefined` leaves
 * multi-node routing off: no selection, a per-process selection that is not a JSON object (the launching process
 * validated it; settings are never consulted instead), and the selections the storage layer reads as in-memory
 * (`memory: true` without a path, or `path: ":memory:"`), which no other broker can share. `path: ""` is not one of
 * them: it selects the default storage file.
 */
export function readSharedStorageSetting(
	agentDir: string,
	env: NodeJS.ProcessEnv = process.env,
): Record<string, JsonWireValue> | undefined {
	const processSelection = env[BROKER_STORAGE_ENV];
	let parsed: JsonWireValue | undefined;
	try {
		parsed =
			processSelection === undefined || processSelection.length === 0
				? (JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as { storage?: JsonWireValue }).storage
				: JSON.parse(processSelection);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
	const selection = parsed;
	if (selection.adapter === undefined) {
		if (selection.memory === true && !selection.path) return undefined;
		if (selection.path === ":memory:") return undefined;
	}
	return selection;
}

/** Where `readSharedStorageSetting` takes the selection from in this environment. */
export function sharedStorageSettingSource(env: NodeJS.ProcessEnv = process.env): "env" | "settings" {
	const processSelection = env[BROKER_STORAGE_ENV];
	return processSelection === undefined || processSelection.length === 0 ? "settings" : "env";
}

function sortedKeys(_key: string, value: JsonWireValue): JsonWireValue {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
	return Object.fromEntries(Object.entries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)));
}

/** Identifies a shared selection independently of key order, without revealing it: two brokers agree when it matches. */
export function sharedStorageDigest(setting: Readonly<Record<string, JsonWireValue>>): string {
	return createHash("sha256").update(JSON.stringify(setting, sortedKeys)).digest("hex");
}

/** The adapter (`sqlite` for a `path` selection) and table prefix a shared selection names, for logs and status. */
export function describeSharedStorage(setting: Readonly<Record<string, JsonWireValue>>): { adapter: string; prefix?: string } {
	const adapter = typeof setting.adapter === "string" ? setting.adapter : "sqlite";
	return typeof setting.prefix === "string" && setting.prefix.length > 0 ? { adapter, prefix: setting.prefix } : { adapter };
}
