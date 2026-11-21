import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { Static, TSchema } from "@bastani/atomic-schema/typebox";
import { Value } from "@bastani/atomic-schema/typebox/value";
import { ENV_SESSION_DIR } from "../../config.js";
import { resolvePath } from "../../utils/paths.ts";
import { SessionStorageSelectionSchema, StorageSelectionSchema } from "../settings-schema.ts";
import { StorageConfigError, StoragePrefixError } from "./errors.js";
import {
	defaultSessionDatabasePathSteps,
	defaultSharedStoragePathSteps,
	runStorageSteps,
	runStorageStepsSync,
	type StorageHomeSettings,
	type StorageSteps,
	storagePathBaseDirSteps,
	storageSettingsSteps,
} from "./file-identity.js";
import { validateStoragePrefix } from "./prefix.js";
import type { StorageSelection } from "./provider.js";
import {
	environmentTeamProfile,
	environmentTeamProfileAsync,
	environmentTeamProfileSelection,
	selectStorageSteps,
	TEAM_PROFILE_ENV,
} from "./selection.js";

export const STORAGE_ENV = "ATOMIC_STORAGE";
export const SESSIONS_STORAGE_ENV = "ATOMIC_SESSIONS_STORAGE";

/**
 * `sessions`: the session store, which has variables of its own. `shared`: the shared selection alone (`--storage`,
 * `ATOMIC_STORAGE`, `ATOMIC_PROFILE=ci`), as `atomic storage migrate` and the team layout read it.
 */
export type StorageDomain = "sessions" | "shared";
export type StorageFlag = "--storage" | "--storage-file";
export interface StorageFlagArgument {
	readonly flag: StorageFlag;
	readonly value: string;
}
/** A storage selection chosen by the launching process rather than by settings. */
export interface ProcessStorageChoice {
	readonly selection: StorageSelection;
	readonly source: "cli" | "env";
	readonly field: string;
}

type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };
type SharedSelection = Static<typeof StorageSelectionSchema>;
type DomainSelection = Static<typeof SessionStorageSelectionSchema>;

// Process-wide, and shared by every loaded copy of this module, but never inherited by child processes.
const CLI_SELECTION = Symbol.for("@bastani/atomic/storage/cli-selection");
const registry: typeof globalThis & {
	[CLI_SELECTION]?: { readonly field: StorageFlag; readonly value: SharedSelection };
} = globalThis;

function environmentValue(name: string): string | undefined {
	const value = process.env[name];
	return value === undefined || value.length === 0 ? undefined : value;
}

function parseSelection<T extends TSchema>(text: string, schema: T, source: "cli" | "env", field: string): Static<T> {
	let value: JsonValue;
	try {
		value = JSON.parse(text);
	} catch {
		throw new StorageConfigError(source, field, "invalid-json");
	}
	if (!Value.Check(schema, value)) throw new StorageConfigError(source, field, "invalid-selection");
	return value;
}

function chooseAt(value: DomainSelection, source: "cli" | "env", field: string, path: string): ProcessStorageChoice {
	const next = chooseSteps(value, source, field, path, path).next();
	if (!next.done) throw new Error(`Unexpected storage lookup while checking ${field}`);
	return next.value;
}

function* chooseSteps(
	value: DomainSelection,
	source: "cli" | "env",
	field: string,
	baseDir: string | ((path: string) => StorageSteps<string>),
	defaultPath: string | (() => StorageSteps<string>),
): StorageSteps<ProcessStorageChoice> {
	function* resolve(path: string): StorageSteps<string> {
		try {
			return resolvePath(path, typeof baseDir === "string" ? baseDir : yield* baseDir(path));
		} catch {
			throw new StorageConfigError(source, field, "invalid-path");
		}
	}
	if ("dir" in value) return { selection: { kind: "jsonl", dir: yield* resolve(value.dir) }, source, field };
	try {
		validateStoragePrefix(value.prefix);
	} catch (error) {
		if (error instanceof StoragePrefixError) throw new StorageConfigError(source, field, "invalid-prefix");
		throw error;
	}
	const selection = yield* selectStorageSteps(value, source, field, defaultPath);
	return {
		selection:
			selection.kind === "sqlite" && !isAbsolute(selection.path)
				? { ...selection, path: yield* resolve(selection.path) }
				: selection,
		source,
		field,
	};
}

/**
 * Record this process's `--storage` or `--storage-file` selection, or clear it with `undefined`.
 * A relative `--storage-file` path resolves against `cwd`.
 */
export function setCliStorageSelection(argument: StorageFlagArgument | undefined, cwd = process.cwd()): void {
	delete registry[CLI_SELECTION];
	if (argument === undefined) return;
	let text = argument.value;
	if (argument.flag === "--storage-file") {
		try {
			text = readFileSync(resolvePath(argument.value, cwd), "utf8");
		} catch {
			throw new StorageConfigError("cli", argument.flag, "unreadable-file");
		}
	}
	registry[CLI_SELECTION] = {
		field: argument.flag,
		value: parseSelection(text, StorageSelectionSchema, "cli", argument.flag),
	};
}

/** Every set storage variable, parsed and checked even when another selection outranks it. */
function environmentChoices(agentDir: string) {
	const read = (
		field: string,
		schema: typeof SessionStorageSelectionSchema | typeof StorageSelectionSchema,
	): ProcessStorageChoice | undefined => {
		const text = environmentValue(field);
		if (text === undefined) return undefined;
		const value = parseSelection(text, schema, "env", field);
		return chooseAt(value, "env", field, agentDir);
	};
	const team = environmentTeamProfileSelection();
	return {
		sessions: read(SESSIONS_STORAGE_ENV, SessionStorageSelectionSchema),
		shared: read(STORAGE_ENV, StorageSelectionSchema),
		team: team === undefined ? undefined : chooseAt(team, "env", TEAM_PROFILE_ENV, agentDir),
		teamValue: team,
	};
}

/** Check every set storage variable, whether or not any selection uses it. */
export function validateProcessStorage(agentDir: string): void {
	environmentChoices(agentDir);
	environmentTeamProfile();
}

export async function validateProcessStorageAsync(agentDir: string): Promise<void> {
	environmentChoices(agentDir);
	await environmentTeamProfileAsync();
}

/**
 * The process-level storage selection for one domain: `--storage`/`--storage-file`, then, for sessions, the domain
 * variable or its legacy path variable, then `ATOMIC_STORAGE`, then the `ATOMIC_PROFILE=ci` team database.
 * `undefined` leaves the choice to settings.
 * Every set storage variable is validated, whichever one applies.
 */
export function selectProcessStorage(
	domain: StorageDomain,
	agentDir: string,
	cwd = process.cwd(),
	settings?: StorageHomeSettings | (() => StorageHomeSettings | undefined),
): ProcessStorageChoice | undefined {
	return runStorageStepsSync(
		selectProcessStorageSteps(domain, agentDir, cwd),
		typeof settings === "function" ? settings : () => settings,
	);
}

export function selectProcessStorageAsync(
	domain: StorageDomain,
	agentDir: string,
	cwd = process.cwd(),
	settings?: StorageHomeSettings | (() => Promise<StorageHomeSettings | undefined>),
): Promise<ProcessStorageChoice | undefined> {
	return runStorageSteps(
		selectProcessStorageSteps(domain, agentDir, cwd),
		typeof settings === "function" ? settings : async () => settings,
	);
}

export function* selectProcessStorageSteps(
	domain: StorageDomain,
	agentDir: string,
	cwd: string,
): StorageSteps<ProcessStorageChoice | undefined> {
	const legacyField = ENV_SESSION_DIR;
	const legacy = domain === "sessions" ? environmentValue(legacyField) : undefined;
	const validated = environmentChoices(agentDir);
	const settings = storageSettingsSteps<StorageHomeSettings | undefined>;
	const baseDir = function* (path: string): StorageSteps<string> {
		return yield* storagePathBaseDirSteps(path, agentDir, yield* settings());
	};
	const domainDefault = function* (): StorageSteps<string> {
		return yield* defaultSessionDatabasePathSteps(agentDir, yield* settings());
	};
	const sharedDefault = function* (): StorageSteps<string> {
		return yield* defaultSharedStoragePathSteps(agentDir, yield* settings());
	};
	function* resolveEnv(
		field: string,
		schema: typeof SessionStorageSelectionSchema | typeof StorageSelectionSchema,
		defaultPath: () => StorageSteps<string>,
	): StorageSteps<ProcessStorageChoice | undefined> {
		const text = environmentValue(field);
		if (text === undefined) return undefined;
		const value = parseSelection(text, schema, "env", field);
		return yield* chooseSteps(value, "env", field, baseDir, defaultPath);
	}
	const cli = registry[CLI_SELECTION];
	if (cli !== undefined) {
		if (legacy !== undefined) {
			throw new StorageConfigError("cli", `${cli.field}, ${legacyField}`, "conflicting-overrides");
		}
		return yield* chooseSteps(cli.value, "cli", cli.field, baseDir, sharedDefault);
	}
	if (domain === "sessions" && validated.sessions !== undefined) {
		if (legacy !== undefined) {
			throw new StorageConfigError("env", `${SESSIONS_STORAGE_ENV}, ${legacyField}`, "conflicting-overrides");
		}
		return yield* resolveEnv(SESSIONS_STORAGE_ENV, SessionStorageSelectionSchema, domainDefault);
	}
	if (legacy !== undefined) {
		try {
			return { selection: { kind: "jsonl", dir: resolvePath(legacy, cwd) }, source: "env", field: legacyField };
		} catch {
			throw new StorageConfigError("env", legacyField, "invalid-path");
		}
	}
	if (validated.shared !== undefined) {
		return yield* resolveEnv(STORAGE_ENV, StorageSelectionSchema, sharedDefault);
	}
	const team = validated.teamValue;
	return team === undefined ? undefined : yield* chooseSteps(team, "env", TEAM_PROFILE_ENV, baseDir, sharedDefault);
}

/** Whether the launching process selected this domain's storage, without validating the selection. */
export function hasProcessStorageSelection(domain: StorageDomain): boolean {
	return (
		registry[CLI_SELECTION] !== undefined ||
		(domain === "sessions"
			? [SESSIONS_STORAGE_ENV, ENV_SESSION_DIR, STORAGE_ENV, TEAM_PROFILE_ENV]
			: [STORAGE_ENV, TEAM_PROFILE_ENV]
		).some((name) => environmentValue(name) !== undefined)
	);
}

/**
 * The shared `storage` selection this process was launched with, as the `ATOMIC_STORAGE` value a child process it
 * spawns should receive: `--storage`/`--storage-file`, then `ATOMIC_STORAGE`, then the `ATOMIC_PROFILE=ci` team
 * database, which references its token by variable or file and never copies it. `undefined` leaves the choice to
 * settings. An invalid team profile throws {@link TeamProfileConfigError}, as it does at startup.
 */
export function processSharedStorageSelection(): string | undefined {
	const cli = registry[CLI_SELECTION];
	if (cli !== undefined) return JSON.stringify(cli.value);
	const shared = environmentValue(STORAGE_ENV);
	if (shared !== undefined) return shared;
	const team = environmentTeamProfile();
	return team === undefined ? undefined : JSON.stringify(team);
}

export async function processSharedStorageSelectionAsync(): Promise<string | undefined> {
	const cli = registry[CLI_SELECTION];
	if (cli !== undefined) return JSON.stringify(cli.value);
	const shared = environmentValue(STORAGE_ENV);
	if (shared !== undefined) return shared;
	const team = await environmentTeamProfileAsync();
	return team === undefined ? undefined : JSON.stringify(team);
}

/**
 * `process.env` with `ATOMIC_STORAGE` set to {@link processSharedStorageSelection}, as the Intercom broker this
 * process starts receives it: the environment to compare a running broker's storage against.
 */
export function processStorageEnvironment(): NodeJS.ProcessEnv {
	return { ...process.env, [STORAGE_ENV]: processSharedStorageSelection() ?? "" };
}

export async function processStorageEnvironmentAsync(): Promise<NodeJS.ProcessEnv> {
	const selection = await processSharedStorageSelectionAsync();
	return { ...process.env, [STORAGE_ENV]: selection ?? "" };
}
