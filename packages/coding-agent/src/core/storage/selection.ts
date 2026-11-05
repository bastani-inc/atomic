import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { SqliteDatabase } from "./database.js";
import {
	StorageConfigError,
	StoragePrefixError,
	TeamProfileConfigError,
	type TeamProfileConfigErrorCode,
} from "./errors.js";
import { validateStoragePrefix } from "./prefix.js";
import type { AdapterOptions, SecretRef, StorageSelection } from "./provider.js";
import type {
	JoinTeamOptions,
	LeaveTeamOptions,
	TeamJoinResult,
	TeamLeaveResult,
	TeamProfile,
	TeamProfileOptions,
} from "./team.js";

/** A secret held only in this process's memory: it is never written to settings, environments or files. */
export interface InMemorySecretRef {
	readonly value: string;
}

/** What every serialization of an in-memory secret shows instead of the secret. */
export const REDACTED_SECRET = "[redacted]";

const redacted = (): { readonly value: string } => ({ value: REDACTED_SECRET });

/**
 * An `{ value }` secret reference whose value the storage provider can read, but which `JSON.stringify` and
 * `util.inspect` (console output) show as `[redacted]` and which spreading does not copy.
 */
export function inMemorySecret(value: string): InMemorySecretRef {
	const secret = {};
	Object.defineProperties(secret, {
		value: { value, enumerable: false },
		toJSON: { value: redacted, enumerable: false },
		[Symbol.for("nodejs.util.inspect.custom")]: { value: redacted, enumerable: false },
	});
	return secret as InMemorySecretRef;
}

/** The same references, with every `{ value }` secret in the form that serializes as `[redacted]`. */
function redactInMemorySecrets(secrets: Readonly<Record<string, SecretRef>>): Readonly<Record<string, SecretRef>> {
	return Object.fromEntries(
		Object.entries(secrets).map(([name, ref]) => [
			name,
			"value" in ref && !Object.hasOwn(ref, "toJSON") ? inMemorySecret(ref.value) : ref,
		]),
	);
}

export interface StorageSettingsSelection {
	readonly path?: string;
	readonly memory?: boolean;
	readonly adapter?: string;
	readonly options?: AdapterOptions;
	readonly secrets?: Readonly<Record<string, SecretRef>>;
	readonly prefix?: string;
}
export type StorageInputSelection =
	| StorageSettingsSelection
	| { readonly database: SqliteDatabase; readonly prefix?: string };

/**
 * Whether a journal selection names no store of its own (`{}`, or an empty `path`), so it means the default journal:
 * the local journal store. A `prefix` alone still selects tables in the legacy single file, as it always did.
 */
export function selectsDefaultJournalStore(value: StorageInputSelection | undefined): boolean {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const keys = Object.entries(value)
		.filter(([key, entry]) => entry !== undefined && !(key === "memory" && entry === false))
		.map(([key]) => key);
	const path = (value as { readonly path?: string }).path;
	return keys.every((key) => key === "path") && (path === undefined || path === "");
}

export function selectStorage(
	value: StorageInputSelection,
	source: "sdk" | "settings" | "env" | "cli",
	field: string,
	defaultPath: string,
): StorageSelection {
	const invalid = (reason: string): never => {
		throw new StorageConfigError(source, field, reason);
	};
	if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid("selection-object-required");
	if ("dir" in value) return invalid("adapter-domain-unsupported");
	if ("prefix" in value && value.prefix !== undefined && typeof value.prefix !== "string")
		return invalid("invalid-prefix");
	if (source === "sdk") {
		const forms = ["path", "memory", "adapter", "database"].filter((key) => key in value);
		if (forms.length === 0) return invalid("selection-required");
		if (forms.length > 1) return invalid("multiple-selection-forms");
		if ("path" in value && typeof value.path !== "string") return invalid("invalid-path");
		if ("memory" in value && value.memory !== true) return invalid("invalid-memory");
		if ("adapter" in value && (typeof value.adapter !== "string" || value.adapter.length === 0))
			return invalid("invalid-adapter");
	}
	if ("database" in value) {
		if (["path", "memory", "adapter"].some((key) => key in value)) return invalid("multiple-selection-forms");
		const db = value.database;
		if (
			db === null ||
			typeof db !== "object" ||
			[db.exec, db.run, db.get, db.all, db.transaction, db.close].some((hook) => typeof hook !== "function") ||
			!db.descriptor ||
			typeof db.descriptor.adapter !== "string" ||
			typeof db.descriptor.location !== "string"
		)
			return invalid("async-database-required");
		return { kind: "database", database: db, ...(value.prefix === undefined ? {} : { prefix: value.prefix }) };
	}
	if (value.path !== undefined && typeof value.path !== "string") return invalid("invalid-path");
	if (value.memory !== undefined && typeof value.memory !== "boolean") return invalid("invalid-memory");
	if (value.adapter !== undefined) {
		if (typeof value.adapter !== "string" || value.adapter.length === 0) return invalid("invalid-adapter");
		if ("path" in value || "memory" in value) return invalid("multiple-selection-forms");
		if (value.options !== undefined) {
			if (value.options === null || typeof value.options !== "object" || Array.isArray(value.options))
				return invalid("invalid-options");
			for (const option of Object.values(value.options)) {
				if (
					option !== null &&
					!["string", "number", "bigint", "boolean"].includes(typeof option) &&
					!(option instanceof Uint8Array)
				)
					return invalid("invalid-options");
			}
		}
		if (value.secrets !== undefined) {
			if (value.secrets === null || typeof value.secrets !== "object" || Array.isArray(value.secrets))
				return invalid("invalid-secrets");
			for (const ref of Object.values(value.secrets)) {
				if (ref === null || typeof ref !== "object" || Array.isArray(ref)) return invalid("invalid-secret-ref");
				const forms = ["env", "file", "value"].filter((key) => key in ref);
				if (forms.length !== 1) return invalid("invalid-secret-ref");
				if ("value" in ref) {
					if (source !== "sdk") return invalid("in-memory-secret-unsupported");
					if (typeof ref.value !== "string") return invalid("invalid-secret-ref");
				} else if ("env" in ref ? typeof ref.env !== "string" : typeof ref.file !== "string")
					return invalid("invalid-secret-ref");
			}
		}
		return {
			kind: "adapter",
			module: value.adapter,
			...(value.options === undefined ? {} : { options: value.options }),
			...(value.secrets === undefined ? {} : { secrets: redactInMemorySecrets(value.secrets) }),
			...(value.prefix === undefined ? {} : { prefix: value.prefix }),
		};
	}
	if (value.options !== undefined || value.secrets !== undefined) return invalid("adapter-required");
	if (value.path && value.memory === true) return invalid("path-and-memory");
	if (value.memory === true) return { kind: "memory" };
	return {
		kind: "sqlite",
		path: source === "sdk" && value.path !== undefined ? value.path : value.path || defaultPath,
		...(value.prefix === undefined ? {} : { prefix: value.prefix }),
	};
}

/** The first-party libSQL / Turso adapter package that team setup and `atomic storage join` select. */
export const LIBSQL_ADAPTER_PACKAGE = "@bastani/atomic-storage-libsql";
/** Filename prefix for private token files created by `atomic storage join` and `atomic team join` in the agent directory. */
export const STORAGE_TOKEN_FILE = "storage-token";

/** The `sessions.storage` value `team join` writes: the local default store, named explicitly. */
export const LOCAL_SESSIONS_STORAGE = { path: "workflows/journal.sqlite" } as const;

/** The command that joins this machine to the team's shared storage; error hints across Atomic name it. */
export const SHARED_STORAGE_JOIN_HINT = "atomic team join <url> --token-file <path>";

export const TEAM_PROFILE_ENV = "ATOMIC_PROFILE";
export const TEAM_URL_ENV = "ATOMIC_TEAM_URL";
export const TEAM_TOKEN_ENV = "ATOMIC_TEAM_TOKEN";
export const TEAM_TOKEN_FILE_ENV = "ATOMIC_TEAM_TOKEN_FILE";
export const TEAM_PREFIX_ENV = "ATOMIC_TEAM_PREFIX";
/** The variables `ATOMIC_PROFILE=ci` reads; setting any of them without the profile is an error. */
export const TEAM_VARIABLES: readonly string[] = [TEAM_URL_ENV, TEAM_TOKEN_ENV, TEAM_TOKEN_FILE_ENV, TEAM_PREFIX_ENV];

/** A team database selection in the settings form: usable as `createAgentSession({ storage })` and `RunOpts.journal`. */
export interface TeamStorageSelection {
	readonly adapter: string;
	readonly options: Readonly<Record<string, string>>;
	readonly secrets?: Readonly<Record<string, SecretRef>>;
	readonly prefix?: string;
}

export interface TeamProfileSelectionOptions {
	readonly profile: "ci";
	/** `libsql://`, `https://`, `wss://` or absolute `file:` URL, without a credential. */
	readonly url: string;
	/** The database token, held as an in-memory `{ value }` secret that is never serialized or written. */
	readonly token?: string;
	/** A file holding the database token; relative paths resolve against the working directory. */
	readonly tokenFile?: string;
	/** An environment variable holding the database token, read when the store opens. */
	readonly tokenEnv?: string;
	readonly prefix?: string;
}

export type TeamInputSource = "sdk" | "cli" | "env";

interface TeamInputFields {
	readonly profile: string;
	readonly url: string;
	readonly token: string;
	readonly tokenFile: string;
	readonly prefix: string;
}

const FIELDS: Readonly<Record<TeamInputSource, TeamInputFields>> = {
	sdk: { profile: "profile", url: "url", token: "token", tokenFile: "tokenFile", prefix: "prefix" },
	cli: { profile: "profile", url: "<url>", token: "--token-file", tokenFile: "--token-file", prefix: "--prefix" },
	env: {
		profile: TEAM_PROFILE_ENV,
		url: TEAM_URL_ENV,
		token: TEAM_TOKEN_ENV,
		tokenFile: TEAM_TOKEN_FILE_ENV,
		prefix: TEAM_PREFIX_ENV,
	},
};

function invalid(
	code: TeamProfileConfigErrorCode,
	source: TeamInputSource,
	field: string,
	hint: string,
	extra: { readonly path?: string; readonly missing?: readonly string[]; readonly cause?: Error } = {},
): TeamProfileConfigError {
	return new TeamProfileConfigError(code, { source, field, hint, ...extra });
}

/** Whether a database URL holds the token itself: userinfo, or the `authToken` query parameter libSQL URLs accept. */
function carriesCredential(url: string): boolean {
	if (!URL.canParse(url)) return false;
	const { username, password, searchParams } = new URL(url);
	return username !== "" || password !== "" || searchParams.has("authToken");
}

/** Whether a team database URL needs no token: a local `file:` database. */
export function isFileUrl(url: string): boolean {
	return url.startsWith("file:");
}

/** Check a team database URL: a supported scheme, an absolute `file:` URL, and no credential in it. */
export function checkTeamUrl(url: string | undefined, source: TeamInputSource): string {
	const field = FIELDS[source].url;
	if (url === undefined || url.length === 0) {
		throw invalid("missing-url", source, field, "Pass the team database URL, for example libsql://<db>.turso.io.");
	}
	if (!/^(libsql|https?|wss?):\/\/[^/]/.test(url) && !isFileUrl(url)) {
		throw invalid("unsupported-url", source, field, "Use a libsql://, https://, wss://, or absolute file: URL.");
	}
	if (isFileUrl(url) && !url.startsWith("file:/")) {
		throw invalid(
			"relative-file-url",
			source,
			field,
			"Use an absolute file: URL (for example file:///path/to/shared.sqlite), so every working directory uses the same database.",
		);
	}
	if (carriesCredential(url)) {
		throw invalid(
			"credential-in-url",
			source,
			field,
			`The URL carries a credential (user name, password, or authToken). Remove it and pass the token with ${FIELDS[source].token === FIELDS[source].tokenFile ? FIELDS[source].tokenFile : `${FIELDS[source].token} or ${FIELDS[source].tokenFile}`} instead, so it never reaches settings or output.`,
		);
	}
	return url;
}

/** Check a table prefix with the same rules as every storage prefix. */
export function checkTeamPrefix(prefix: string | undefined, source: TeamInputSource): string | undefined {
	if (prefix === undefined) return undefined;
	try {
		validateStoragePrefix(prefix);
	} catch (error) {
		if (!(error instanceof StoragePrefixError)) throw error;
		throw invalid(
			"invalid-prefix",
			source,
			FIELDS[source].prefix,
			error.reason === "reserved"
				? "Choose a prefix that does not start with sqlite_."
				: "Use letters, digits and underscores, not starting with a digit, for example team_.",
			{ cause: error },
		);
	}
	return prefix;
}

/** Read a token file and remove surrounding whitespace; an unreadable or empty file is an invalid input. */
export function readTeamTokenFile(path: string, source: TeamInputSource): string {
	const field = FIELDS[source].tokenFile;
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		throw invalid("unreadable-token-file", source, field, `Check that ${path} exists and is readable.`, {
			path,
			cause: error as Error,
		});
	}
	const token = text.trim();
	if (token.length === 0) {
		throw invalid(
			"empty-token",
			source,
			field,
			`The token file ${path} is empty: write the token into it, for example with turso db tokens create <db>.`,
			{ path },
		);
	}
	return token;
}

/** A missing token for a URL that needs one. */
export function missingTeamToken(url: string, source: Exclude<TeamInputSource, "env">): TeamProfileConfigError {
	const scheme = url.split(":")[0];
	return invalid(
		"missing-token",
		source,
		FIELDS[source].token,
		source === "cli"
			? `--token-file is required for ${scheme}: URLs; only absolute file: URLs need no token.`
			: `Pass the database token for ${scheme}: URLs; only absolute file: URLs need no token.`,
	);
}

/** More than one token source. */
export function conflictingTeamToken(source: TeamInputSource, fields: readonly string[]): TeamProfileConfigError {
	return invalid("conflicting-token", source, fields.join(", "), `Pass only one of ${fields.join(", ")}.`);
}

/** A whitespace-only literal token, or an empty variable name. */
export function emptyTeamToken(source: TeamInputSource, field: string = FIELDS[source].token): TeamProfileConfigError {
	return invalid("empty-token", source, field, `${field} is empty: pass the database token.`);
}

function checkProfile(profile: string, source: TeamInputSource): "ci" {
	if (profile === "ci") return profile;
	throw invalid(
		"unknown-profile",
		source,
		FIELDS[source].profile,
		source === "env" ? `Set ${TEAM_PROFILE_ENV} to ci, or unset it.` : 'Pass profile: "ci".',
	);
}

/**
 * The CI profile as a team database selection, without reading or writing settings: sessions, workflow runs and
 * Intercom can all use it. A literal `token` becomes an in-memory `{ value }` secret that serializes as
 * `[redacted]` and that only SDK callers can pass; `tokenFile` (absolute path) and `tokenEnv` are references read
 * when the store opens. Inputs are checked first; nothing else happens.
 */
export function teamProfileSelection(options: TeamProfileSelectionOptions): TeamStorageSelection {
	checkProfile(options.profile, "sdk");
	const url = checkTeamUrl(options.url, "sdk");
	const sources = (["token", "tokenFile", "tokenEnv"] as const).filter((name) => options[name] !== undefined);
	if (sources.length > 1) throw conflictingTeamToken("sdk", ["token", "tokenFile", "tokenEnv"]);
	const prefix = checkTeamPrefix(options.prefix, "sdk");
	let authToken: SecretRef | undefined;
	if (options.token !== undefined) {
		if (options.token.trim().length === 0) throw emptyTeamToken("sdk");
		authToken = inMemorySecret(options.token);
	} else if (options.tokenFile !== undefined) {
		const path = resolve(options.tokenFile);
		readTeamTokenFile(path, "sdk");
		authToken = { file: path };
	} else if (options.tokenEnv !== undefined) {
		if (options.tokenEnv.length === 0) throw emptyTeamToken("sdk", "tokenEnv");
		if (!process.env[options.tokenEnv]) {
			throw invalid(
				"missing-token",
				"sdk",
				"tokenEnv",
				`Set ${options.tokenEnv} to the database token: the selection reads the token from it when the store opens.`,
			);
		}
		authToken = { env: options.tokenEnv };
	} else if (!isFileUrl(url)) {
		throw missingTeamToken(url, "sdk");
	}
	return {
		adapter: LIBSQL_ADAPTER_PACKAGE,
		options: { url },
		...(authToken === undefined ? {} : { secrets: { authToken } }),
		...(prefix === undefined ? {} : { prefix }),
	};
}

function environmentValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
	const value = env[name];
	return value === undefined || value.length === 0 ? undefined : value;
}

/**
 * The selection `ATOMIC_PROFILE=ci` makes from `ATOMIC_TEAM_URL` and `ATOMIC_TEAM_TOKEN` or `ATOMIC_TEAM_TOKEN_FILE`
 * (plus an optional `ATOMIC_TEAM_PREFIX`), or `undefined` without a profile. The token is referenced, never copied:
 * `{ env: "ATOMIC_TEAM_TOKEN" }` or the token file's absolute path, so the selection can be handed to child processes.
 * Invalid input throws {@link TeamProfileConfigError} with `source: "env"`: a team variable without the profile, or
 * the profile without its URL or token, is `incomplete-profile` naming every missing variable at once.
 */
export function environmentTeamProfile(env: NodeJS.ProcessEnv = process.env): TeamStorageSelection | undefined {
	const profile = environmentValue(env, TEAM_PROFILE_ENV);
	const url = environmentValue(env, TEAM_URL_ENV);
	const token = environmentValue(env, TEAM_TOKEN_ENV);
	const tokenFile = environmentValue(env, TEAM_TOKEN_FILE_ENV);
	const prefix = environmentValue(env, TEAM_PREFIX_ENV);
	if (profile === undefined) {
		const set = TEAM_VARIABLES.filter((name) => environmentValue(env, name) !== undefined);
		if (set.length === 0) return undefined;
		throw invalid(
			"incomplete-profile",
			"env",
			TEAM_PROFILE_ENV,
			`${set.join(", ")} ${set.length === 1 ? "is" : "are"} set but ${TEAM_PROFILE_ENV} is not: set ${TEAM_PROFILE_ENV}=ci to use the team database in this process, or unset ${set.length === 1 ? "it" : "them"} (to join this machine to the team database instead, run ${SHARED_STORAGE_JOIN_HINT}).`,
			{ missing: [TEAM_PROFILE_ENV] },
		);
	}
	checkProfile(profile, "env");
	const missing = [
		...(url === undefined ? [TEAM_URL_ENV] : []),
		...(token === undefined && tokenFile === undefined && (url === undefined || !isFileUrl(url))
			? [`${TEAM_TOKEN_ENV} or ${TEAM_TOKEN_FILE_ENV}`]
			: []),
	];
	if (missing.length > 0) {
		throw invalid(
			"incomplete-profile",
			"env",
			missing.join(", "),
			`${TEAM_PROFILE_ENV}=ci needs the team database URL and its token: set ${missing.join(" and ")} (only an absolute file: URL needs no token).`,
			{ missing },
		);
	}
	const checkedUrl = checkTeamUrl(url, "env");
	if (token !== undefined && tokenFile !== undefined) {
		throw conflictingTeamToken("env", [TEAM_TOKEN_ENV, TEAM_TOKEN_FILE_ENV]);
	}
	const checkedPrefix = checkTeamPrefix(prefix, "env");
	let secrets: Readonly<Record<string, SecretRef>> | undefined;
	if (token !== undefined) {
		if (token.trim().length === 0) throw emptyTeamToken("env");
		secrets = { authToken: { env: TEAM_TOKEN_ENV } };
	} else if (tokenFile !== undefined) {
		if (!isAbsolute(tokenFile)) {
			throw invalid(
				"relative-token-file",
				"env",
				TEAM_TOKEN_FILE_ENV,
				`Set ${TEAM_TOKEN_FILE_ENV} to an absolute path, for example under $RUNNER_TEMP: the processes Atomic starts would resolve a relative path against their own working directory.`,
			);
		}
		const path = resolve(tokenFile);
		readTeamTokenFile(path, "env");
		secrets = { authToken: { file: path } };
	}
	return {
		adapter: LIBSQL_ADAPTER_PACKAGE,
		options: { url: checkedUrl },
		...(secrets === undefined ? {} : { secrets }),
		...(checkedPrefix === undefined ? {} : { prefix: checkedPrefix }),
	};
}

// The team setup SDK loads the settings and storage machinery on first use, so importing the storage module stays
// cheap for storage adapters and hosts that never set up a team.

/**
 * Use a team database for workflow runs and Intercom while sessions stay private: checks every input and the
 * connection first, then sets the global `storage` setting to the team database and `sessions.storage` to the local
 * default store in one settings write, and restarts the Intercom broker so it routes through the team database.
 * Rejects with `TeamProfileConfigError` for an invalid input and `TeamProfileError` otherwise; on any rejection
 * nothing was changed. A failed broker restart is reported in `broker`, not thrown.
 */
export async function joinTeam(options: JoinTeamOptions): Promise<TeamJoinResult> {
	return (await import("./team.js")).joinTeam(options);
}

/**
 * Restore the individual layout: remove the global `storage` setting and the `sessions.storage` pin when they hold
 * exactly what `joinTeam` writes, leave every other value in place, delete the removed selection's token file unless
 * another setting references it, and restart the Intercom broker when `storage` was removed. Running it again
 * changes nothing.
 */
export async function leaveTeam(options: LeaveTeamOptions = {}): Promise<TeamLeaveResult> {
	return (await import("./team.js")).leaveTeam(options);
}

/**
 * The layout in effect for this process and working directory (`individual`, `team`, `ci` or `custom`), from the
 * storage each domain selects. Reads only; an invalid selection rejects with its `StorageConfigError`.
 */
export async function getTeamProfile(options: TeamProfileOptions = {}): Promise<TeamProfile> {
	return (await import("./team.js")).selectTeamProfile(options);
}
