import { dirname, isAbsolute, join, resolve } from "node:path";
import { Value } from "typebox/value";
import { ENV_SESSION_DIR, getAgentDir } from "../config.js";
import { resolvePath } from "../utils/paths.ts";
import { SettingsManager } from "./settings-manager.ts";
import { SessionStorageSelectionSchema } from "./settings-schema.ts";
import type { Settings } from "./settings-types.ts";
import { StorageConfigError } from "./storage/errors.js";
import { StorageProvider, type StorageSelection } from "./storage/provider.js";
import { selectStorage } from "./storage/selection.js";
import { JsonlSessionStore } from "./storage/session/jsonl-session-store.js";
import { LegacySessionStore } from "./storage/session/legacy-session-store.js";
import type { SessionStore } from "./storage/session/types.js";

export interface SessionStorageOptions {
	readonly agentDir?: string;
	readonly settings?: Settings;
	readonly sessionStore?: SessionStore | StorageSelection;
	readonly noSession?: boolean;
	readonly sessionDir?: string;
	readonly sessionStorePath?: string;
	readonly sessionPrefix?: string;
}

const provider = new StorageProvider();
const sources = new WeakMap<StorageSelection, { source: "settings" | "cli" | "env"; field: string }>();
type EngineSessionStorage = Extract<StorageSelection, { kind: "sqlite" }>;
const engineSelections = new WeakMap<SessionStore, EngineSessionStorage | null>();
const isolatedCliMemoryStores = new WeakSet<SessionStore>();
export const ENGINE_SESSION_STORAGE_FLAG = "--internal-session-storage";

export function getEngineSessionStorage(store: SessionStore): EngineSessionStorage | undefined {
	return engineSelections.get(store) ?? undefined;
}

export function canIsolateSessionStore(store: SessionStore): boolean {
	return (
		isolatedCliMemoryStores.has(store) ||
		getEngineSessionStorage(store) !== undefined ||
		(store instanceof JsonlSessionStore && !engineSelections.has(store))
	);
}

export function takeEngineSessionStorageArg(args: readonly string[]): {
	args: string[];
	sessionStorage?: EngineSessionStorage;
} {
	const remaining: string[] = [];
	let sessionStorage: EngineSessionStorage | undefined;
	for (let index = 0; index < args.length; index++) {
		if (args[index] !== ENGINE_SESSION_STORAGE_FLAG) {
			remaining.push(args[index]!);
			continue;
		}
		let parsed: EngineSessionStorage;
		try {
			parsed = JSON.parse(args[++index]!) as EngineSessionStorage;
		} catch {
			throw new StorageConfigError("cli", ENGINE_SESSION_STORAGE_FLAG, "invalid-selection");
		}
		if (parsed?.kind !== "sqlite" || typeof parsed.path !== "string") {
			throw new StorageConfigError("cli", ENGINE_SESSION_STORAGE_FLAG, "invalid-selection");
		}
		sessionStorage = parsed;
	}
	return { args: remaining, ...(sessionStorage === undefined ? {} : { sessionStorage }) };
}

function resolveStoragePath(path: string, base: string, source: "cli" | "env" | "settings", field: string): string {
	try {
		return resolvePath(path, base);
	} catch {
		throw new StorageConfigError(source, field, "invalid-path");
	}
}

export function selectSessionStorage(
	cwd: string,
	options: SessionStorageOptions = {},
): SessionStore | StorageSelection {
	if (options.sessionStore !== undefined) {
		const value = options.sessionStore;
		if (value !== null && typeof value === "object" && "load" in value) {
			if (
				[
					value.create,
					value.append,
					value.replace,
					value.load,
					value.readHeader,
					value.delete,
					value.list,
					value.findMostRecent,
					value.close,
				].some((hook) => typeof hook !== "function") ||
				!value.descriptor ||
				typeof value.descriptor.adapter !== "string" ||
				typeof value.descriptor.location !== "string"
			)
				throw new StorageConfigError("sdk", "sessionStore", "invalid-session-store");
			return value;
		}
		return value;
	}
	if (options.sessionStorePath !== undefined) {
		const selection = {
			kind: "sqlite",
			path: resolveStoragePath(options.sessionStorePath, cwd, "cli", "--session-store"),
			...(options.sessionPrefix === undefined ? {} : { prefix: options.sessionPrefix }),
		} as const;
		sources.set(selection, { source: "cli", field: "--session-store" });
		return selection;
	}
	if (options.noSession) return { kind: "memory" };
	const directory = options.sessionDir !== undefined ? options.sessionDir : process.env[ENV_SESSION_DIR];
	if (options.sessionDir !== undefined || (directory !== undefined && directory.length > 0)) {
		const source = options.sessionDir !== undefined ? "cli" : "env";
		const field = source === "cli" ? "--session-dir" : ENV_SESSION_DIR;
		if (typeof directory !== "string") throw new StorageConfigError(source, field, "invalid-dir");
		const selection = { kind: "jsonl", dir: resolveStoragePath(directory, cwd, source, field) } as const;
		sources.set(selection, { source, field });
		return selection;
	}
	const agentDir = options.agentDir ?? getAgentDir();
	const defaultPath = join(dirname(agentDir), "workflows", "journal.sqlite");
	const settings = options.settings ?? SettingsManager.create(cwd, agentDir).getSettings();
	if (
		settings.sessions !== undefined &&
		(settings.sessions === null || typeof settings.sessions !== "object" || Array.isArray(settings.sessions))
	) {
		throw new StorageConfigError("settings", "sessions", "selection-object-required");
	}
	const value = settings.sessions?.storage !== undefined ? settings.sessions.storage : settings.storage;
	if (value === undefined) return { kind: "sqlite", path: defaultPath };
	const field = settings.sessions?.storage !== undefined ? "sessions.storage" : "storage";
	if (!Value.Check(SessionStorageSelectionSchema, value) || (field === "storage" && "dir" in value)) {
		throw new StorageConfigError("settings", field, "invalid-selection");
	}
	let selection: StorageSelection;
	if ("dir" in value)
		selection = { kind: "jsonl", dir: resolveStoragePath(value.dir, dirname(agentDir), "settings", field) };
	else {
		selection = selectStorage(
			value,
			"settings",
			field,
			field === "storage" ? join(dirname(agentDir), "storage.sqlite") : defaultPath,
		);
		if (selection.kind === "sqlite" && !isAbsolute(selection.path)) {
			selection = { ...selection, path: resolveStoragePath(selection.path, dirname(agentDir), "settings", field) };
		}
	}
	sources.set(selection, { source: "settings", field });
	return selection;
}

/**
 * The shared default database, selected directly or handed to the engine child. Sessions saved
 * before it became the default stay readable from the agent directory's JSONL files.
 */
function isDefaultDatabase(
	selection: StorageSelection,
	agentDir: string,
): selection is Extract<StorageSelection, { kind: "sqlite" }> {
	return (
		selection.kind === "sqlite" &&
		!selection.prefix &&
		selection.path !== "" &&
		selection.path !== ":memory:" &&
		resolve(selection.path) === resolve(join(dirname(agentDir), "workflows", "journal.sqlite"))
	);
}

export async function resolveSessionStore(cwd: string, options: SessionStorageOptions = {}): Promise<SessionStore> {
	const selection = selectSessionStorage(cwd, options);
	if (selection !== null && typeof selection === "object" && "load" in selection) return selection;
	const agentDir = options.agentDir ?? getAgentDir();
	try {
		const opened = await provider.openSessionStore(selection, { agentDir, domain: "sessions" });
		const store = isDefaultDatabase(selection, agentDir)
			? new LegacySessionStore(opened, {
					legacyDirectory: join(agentDir, "sessions"),
					databasePath: resolve(selection.path),
				})
			: opened;
		if (selection.kind === "sqlite" && selection.path !== "" && selection.path !== ":memory:") {
			engineSelections.set(store, {
				kind: "sqlite",
				path: resolve(selection.path),
				...(selection.prefix === undefined ? {} : { prefix: selection.prefix }),
			});
		} else if (selection.kind !== "jsonl") engineSelections.set(store, null);
		if (selection.kind === "memory" && options.noSession && options.sessionStore === undefined) {
			isolatedCliMemoryStores.add(store);
		}
		return store;
	} catch (error) {
		if (error instanceof StorageConfigError) {
			const origin = sources.get(selection);
			throw new StorageConfigError(origin?.source ?? "sdk", origin?.field ?? "sessionStore", error.reason);
		}
		throw error;
	}
}
