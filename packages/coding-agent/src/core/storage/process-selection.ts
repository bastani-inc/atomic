import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import { ENV_SESSION_DIR } from "../../config.js";
import { resolvePath } from "../../utils/paths.ts";
import { SessionStorageSelectionSchema, StorageSelectionSchema } from "../settings-schema.ts";
import { StorageConfigError, StoragePrefixError } from "./errors.js";
import { validateStoragePrefix } from "./prefix.js";
import type { StorageSelection } from "./provider.js";
import { selectStorage } from "./selection.js";
import { environmentTeamProfile, TEAM_PROFILE_ENV } from "./team-profile.js";

export const STORAGE_ENV = "ATOMIC_STORAGE";
export const SESSIONS_STORAGE_ENV = "ATOMIC_SESSIONS_STORAGE";
export const WORKFLOWS_JOURNAL_ENV = "ATOMIC_WORKFLOWS_JOURNAL";
export const WORKFLOW_JOURNAL_PATH_ENV = "ATOMIC_WORKFLOW_JOURNAL_PATH";

export type StorageDomain = "sessions" | "journal";
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

function choose(
	value: DomainSelection,
	source: "cli" | "env",
	field: string,
	agentDir: string,
	defaultPath: string,
): ProcessStorageChoice {
	const resolve = (path: string): string => {
		try {
			return resolvePath(path, dirname(agentDir));
		} catch {
			throw new StorageConfigError(source, field, "invalid-path");
		}
	};
	if ("dir" in value) return { selection: { kind: "jsonl", dir: resolve(value.dir) }, source, field };
	try {
		validateStoragePrefix(value.prefix);
	} catch (error) {
		if (error instanceof StoragePrefixError) throw new StorageConfigError(source, field, "invalid-prefix");
		throw error;
	}
	const selection = selectStorage(value, source, field, defaultPath);
	return {
		selection:
			selection.kind === "sqlite" && !isAbsolute(selection.path)
				? { ...selection, path: resolve(selection.path) }
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
	const domainDefault = join(dirname(agentDir), "workflows", "journal.sqlite");
	const read = (
		field: string,
		schema: typeof SessionStorageSelectionSchema | typeof StorageSelectionSchema,
		defaultPath: string,
	): ProcessStorageChoice | undefined => {
		const text = environmentValue(field);
		if (text === undefined) return undefined;
		return choose(parseSelection(text, schema, "env", field), "env", field, agentDir, defaultPath);
	};
	const sharedDefault = join(dirname(agentDir), "storage.sqlite");
	const team = environmentTeamProfile();
	return {
		sessions: read(SESSIONS_STORAGE_ENV, SessionStorageSelectionSchema, domainDefault),
		journal: read(WORKFLOWS_JOURNAL_ENV, StorageSelectionSchema, domainDefault),
		shared: read(STORAGE_ENV, StorageSelectionSchema, sharedDefault),
		team: team === undefined ? undefined : choose(team, "env", TEAM_PROFILE_ENV, agentDir, sharedDefault),
	};
}

/** Check every set storage variable, whether or not any selection uses it. */
export function validateProcessStorage(agentDir: string): void {
	environmentChoices(agentDir);
}

/**
 * The process-level storage selection for one domain: `--storage`/`--storage-file`, then the domain
 * variable or its legacy path variable, then `ATOMIC_STORAGE`, then the `ATOMIC_PROFILE=ci` team database.
 * `undefined` leaves the choice to settings.
 * Every set storage variable is validated, whichever one applies.
 */
export function selectProcessStorage(
	domain: StorageDomain,
	agentDir: string,
	cwd = process.cwd(),
): ProcessStorageChoice | undefined {
	const legacyField = domain === "sessions" ? ENV_SESSION_DIR : WORKFLOW_JOURNAL_PATH_ENV;
	const legacy = environmentValue(legacyField);
	const environment = environmentChoices(agentDir);
	const cli = registry[CLI_SELECTION];
	if (cli !== undefined) {
		if (legacy !== undefined) {
			throw new StorageConfigError("cli", `${cli.field}, ${legacyField}`, "conflicting-overrides");
		}
		return choose(cli.value, "cli", cli.field, agentDir, join(dirname(agentDir), "storage.sqlite"));
	}
	const domainField = domain === "sessions" ? SESSIONS_STORAGE_ENV : WORKFLOWS_JOURNAL_ENV;
	const domainChoice = domain === "sessions" ? environment.sessions : environment.journal;
	if (domainChoice !== undefined) {
		if (legacy !== undefined) {
			throw new StorageConfigError("env", `${domainField}, ${legacyField}`, "conflicting-overrides");
		}
		return domainChoice;
	}
	if (legacy !== undefined) {
		if (domain === "journal")
			return { selection: { kind: "sqlite", path: legacy }, source: "env", field: legacyField };
		try {
			return { selection: { kind: "jsonl", dir: resolvePath(legacy, cwd) }, source: "env", field: legacyField };
		} catch {
			throw new StorageConfigError("env", legacyField, "invalid-path");
		}
	}
	return environment.shared ?? environment.team;
}

/** Whether the launching process selected this domain's storage, without validating the selection. */
export function hasProcessStorageSelection(domain: StorageDomain): boolean {
	return (
		registry[CLI_SELECTION] !== undefined ||
		(domain === "sessions"
			? [SESSIONS_STORAGE_ENV, ENV_SESSION_DIR, STORAGE_ENV, TEAM_PROFILE_ENV]
			: [WORKFLOWS_JOURNAL_ENV, WORKFLOW_JOURNAL_PATH_ENV, STORAGE_ENV, TEAM_PROFILE_ENV]
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

/**
 * `process.env` with `ATOMIC_STORAGE` set to {@link processSharedStorageSelection}, as the Intercom broker this
 * process starts receives it: the environment to compare a running broker's storage against.
 */
export function processStorageEnvironment(): NodeJS.ProcessEnv {
	return { ...process.env, [STORAGE_ENV]: processSharedStorageSelection() ?? "" };
}
