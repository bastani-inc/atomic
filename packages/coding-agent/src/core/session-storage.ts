import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { Value } from "@bastani/atomic-ai/utils/typebox/value";
import { getAgentDir, getProjectConfigPaths } from "../config.js";
import { resolvePath } from "../utils/paths.ts";
import { stripBom } from "../utils/text.ts";
import { SettingsManager } from "./settings-manager.ts";
import { deepMergeSettings } from "./settings-merge.js";
import { SessionStorageSelectionSchema } from "./settings-schema.ts";
import type { Settings } from "./settings-types.ts";
import { StorageConfigError } from "./storage/errors.js";
import {
	defaultSessionDatabasePathAsync,
	defaultSessionDatabasePathSteps,
	defaultSharedStoragePathSteps,
	runStorageSteps,
	runStorageStepsSync,
	type StorageHomeSettings,
	type StorageSteps,
	storagePathBaseDirSteps,
	storageSettingsSteps,
} from "./storage/file-identity.js";
import { selectProcessStorageSteps } from "./storage/process-selection.js";
import { StorageProvider, type StorageSelection } from "./storage/provider.js";
import { selectStorageSteps } from "./storage/selection.js";
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

/** The settings keys that select a session store and the storage home its relative paths resolve from. */
const SESSION_STORAGE_SETTINGS = ["sessions", "storage", "workflows"] as const;

/** The parts of `settings` that select the session store, as stable text. */
function sessionStorageProjection(settings: Settings): string {
	const stable = (value: unknown): unknown =>
		typeof value === "object" && value !== null && !Array.isArray(value)
			? Object.fromEntries(
					Object.keys(value)
						.sort()
						.map((key) => [key, stable((value as Record<string, unknown>)[key])]),
				)
			: Array.isArray(value)
				? value.map(stable)
				: value;
	const workflows = (settings as StorageHomeSettings).workflows;
	return JSON.stringify(
		stable({
			sessions: settings.sessions?.storage,
			storage: settings.storage,
			journal:
				typeof workflows === "object" && workflows !== null && !Array.isArray(workflows)
					? workflows.journal
					: undefined,
		}),
	);
}

/**
 * Whether the project settings layers (highest precedence first) can put a folder's sessions in another store than
 * `global` alone: their storage-selecting values are merged over the global ones as settings merge, and compared as
 * written. Nothing is resolved, read or opened, so equal values are the only proof of the same store.
 */
export function sessionStorageSettingsDiffer(global: Settings, projectLayers: readonly Settings[]): boolean {
	const project = projectLayers.reduceRight<Settings>((merged, layer) => {
		const selecting: Record<string, unknown> = {};
		for (const key of SESSION_STORAGE_SETTINGS)
			if (Object.hasOwn(layer, key)) selecting[key] = (layer as Record<string, unknown>)[key];
		return deepMergeSettings(merged, selecting as Settings);
	}, {});
	return sessionStorageProjection(deepMergeSettings(global, project)) !== sessionStorageProjection(global);
}

/**
 * Whether a project's own settings files can put its sessions in another store than the global settings, read as
 * plain JSON without applying them (#5693). A file that cannot be read or parsed counts as different: only the
 * folder's decision may tell what it would choose.
 */
export function projectSettingsChooseSessionStorage(cwd: string, globalSettings: Settings): boolean {
	const layers: Settings[] = [];
	for (const path of getProjectConfigPaths(cwd, "settings.json")) {
		let text: string;
		try {
			text = readFileSync(path, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			return true;
		}
		try {
			const parsed: unknown = JSON.parse(stripBom(text));
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return true;
			layers.push(parsed as Settings);
		} catch {
			return true;
		}
	}
	return sessionStorageSettingsDiffer(globalSettings, layers);
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
	const agentDir = options.agentDir ?? getAgentDir();
	return runStorageStepsSync(
		selectSessionStorageSteps(cwd, options, agentDir),
		() => options.settings ?? SettingsManager.create(cwd, agentDir).getSettings(),
	);
}

export function selectSessionStorageWithSettings(
	cwd: string,
	options: SessionStorageOptions & { readonly settings: Settings },
): SessionStore | StorageSelection {
	return runStorageStepsSync(
		selectSessionStorageSteps(cwd, options, options.agentDir ?? getAgentDir()),
		() => options.settings,
	);
}

export function selectSessionStorageWithSettingsAsync(
	cwd: string,
	options: SessionStorageOptions & { readonly settings: Settings },
): Promise<SessionStore | StorageSelection> {
	return runStorageSteps(
		selectSessionStorageSteps(cwd, options, options.agentDir ?? getAgentDir()),
		async () => options.settings,
	);
}

function* selectSessionStorageSteps(
	cwd: string,
	options: SessionStorageOptions,
	agentDir: string,
): StorageSteps<SessionStore | StorageSelection> {
	return (
		(yield* selectSessionStorageBeforeSettingsSteps(cwd, options, agentDir)) ??
		(yield* selectSessionStorageFromSettingsSteps(yield* storageSettingsSteps<Settings>(), agentDir))
	);
}

function* selectSessionStorageBeforeSettingsSteps(
	cwd: string,
	options: SessionStorageOptions,
	agentDir: string,
): StorageSteps<SessionStore | StorageSelection | undefined> {
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
	if (options.sessionDir !== undefined) {
		if (typeof options.sessionDir !== "string") throw new StorageConfigError("cli", "--session-dir", "invalid-dir");
		const selection = {
			kind: "jsonl",
			dir: resolveStoragePath(options.sessionDir, cwd, "cli", "--session-dir"),
		} as const;
		sources.set(selection, { source: "cli", field: "--session-dir" });
		return selection;
	}
	const processChoice = yield* selectProcessStorageSteps("sessions", agentDir, cwd);
	if (processChoice !== undefined) {
		sources.set(processChoice.selection, { source: processChoice.source, field: processChoice.field });
		return processChoice.selection;
	}
	return undefined;
}

function* selectSessionStorageFromSettingsSteps(settings: Settings, agentDir: string): StorageSteps<StorageSelection> {
	if (
		settings.sessions !== undefined &&
		(settings.sessions === null || typeof settings.sessions !== "object" || Array.isArray(settings.sessions))
	) {
		throw new StorageConfigError("settings", "sessions", "selection-object-required");
	}
	const value = settings.sessions?.storage !== undefined ? settings.sessions.storage : settings.storage;
	if (value === undefined) return { kind: "sqlite", path: yield* defaultSessionDatabasePathSteps(agentDir, settings) };
	const field = settings.sessions?.storage !== undefined ? "sessions.storage" : "storage";
	const selection = yield* selectSessionSettingSteps(value, field, agentDir, settings);
	sources.set(selection, { source: "settings", field });
	return selection;
}

/**
 * The selection a settings value for sessions names: a `{ dir }` JSONL directory or a storage selection, with relative
 * paths resolved against the Atomic home. `field` is the setting it came from, `sessions.storage` or `storage`; a value
 * that is not a valid selection for it throws {@link StorageConfigError}.
 */
export function selectSessionSetting(
	value: NonNullable<NonNullable<Settings["sessions"]>["storage"]>,
	field: "sessions.storage" | "storage",
	agentDir: string,
	settings?: StorageHomeSettings,
): StorageSelection {
	return runStorageStepsSync(selectSessionSettingSteps(value, field, agentDir, settings));
}

function* selectSessionSettingSteps(
	value: NonNullable<NonNullable<Settings["sessions"]>["storage"]>,
	field: "sessions.storage" | "storage",
	agentDir: string,
	settings?: StorageHomeSettings,
): StorageSteps<StorageSelection> {
	if (!Value.Check(SessionStorageSelectionSchema, value) || (field === "storage" && "dir" in value)) {
		throw new StorageConfigError("settings", field, "invalid-selection");
	}
	const effectiveSettings: StorageHomeSettings =
		settings ?? (field === "storage" ? { storage: value } : { sessions: { storage: value } });
	if ("dir" in value)
		return {
			kind: "jsonl",
			dir: resolveStoragePath(
				value.dir,
				yield* storagePathBaseDirSteps(value.dir, agentDir, effectiveSettings),
				"settings",
				field,
			),
		};
	const selection = yield* selectStorageSteps(value, "settings", field, () =>
		field === "storage"
			? defaultSharedStoragePathSteps(agentDir, effectiveSettings)
			: defaultSessionDatabasePathSteps(agentDir, effectiveSettings),
	);
	if (selection.kind === "sqlite" && !isAbsolute(selection.path)) {
		return {
			...selection,
			path: resolveStoragePath(
				selection.path,
				yield* storagePathBaseDirSteps(selection.path, agentDir, effectiveSettings),
				"settings",
				field,
			),
		};
	}
	return selection;
}

/**
 * The shared default database, selected directly or handed to the engine child. Sessions saved
 * before it became the default stay readable from the agent directory's JSONL files.
 */
async function isDefaultDatabase(selection: StorageSelection, agentDir: string): Promise<boolean> {
	return (
		selection.kind === "sqlite" &&
		!selection.prefix &&
		selection.path !== "" &&
		selection.path !== ":memory:" &&
		resolve(selection.path) === resolve(await defaultSessionDatabasePathAsync(agentDir))
	);
}

export async function resolveSessionStore(cwd: string, options: SessionStorageOptions = {}): Promise<SessionStore> {
	const agentDir = options.agentDir ?? getAgentDir();
	const settings = options.settings ?? (await SettingsManager.createAsync(cwd, agentDir)).getSettings();
	const select = () => selectSessionStorageWithSettingsAsync(cwd, { ...options, settings });
	let selection = await select();
	if (selection !== null && typeof selection === "object" && "load" in selection) return selection;
	if (
		(selection.kind === "sqlite" || selection.kind === "jsonl") &&
		options.sessionStore === undefined &&
		options.sessionStorePath === undefined &&
		options.sessionDir === undefined
	) {
		await mkdir(agentDir, { recursive: true });
		selection = (await select()) as StorageSelection;
	}
	// Released sessions' history that a killed process left in this agent directory goes, once per process (#4502).
	void import("./storage/session/released-history-files.js").then(
		({ sweepReleasedHistoryOnce }) => sweepReleasedHistoryOnce(agentDir),
		() => undefined,
	);
	try {
		const opened = await provider.openSessionStore(selection, { agentDir, domain: "sessions" });
		const store =
			selection.kind === "sqlite" && (await isDefaultDatabase(selection, agentDir))
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
