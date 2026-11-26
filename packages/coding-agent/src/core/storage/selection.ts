import { readFileSync } from "node:fs";
import type { SqliteDatabase } from "./database.js";
import {
	StorageConfigError,
	StoragePrefixError,
	TeamProfileConfigError,
	type TeamProfileConfigErrorCode,
} from "./errors.js";
import type { StorageSteps } from "./file-identity.js";
import { isLibsqlUrl, LIBSQL_REMOVED_HINT, REMOVED_LIBSQL_ADAPTER } from "./libsql-removed.js";
import { validateStoragePrefix } from "./prefix.js";
import type { AdapterOptions, SecretRef, StorageSelection } from "./provider.js";
import type { TeamProfile, TeamProfileOptions } from "./team.js";

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

const PENDING_DEFAULT_PATH = "\0";

function takesDefaultPath(
	value: StorageInputSelection,
	selection: StorageSelection,
): selection is Extract<StorageSelection, { kind: "sqlite" }> {
	return (
		selection.kind === "sqlite" &&
		selection.path === PENDING_DEFAULT_PATH &&
		(value as { readonly path?: unknown }).path !== PENDING_DEFAULT_PATH
	);
}

export function selectStorage(
	value: StorageInputSelection,
	source: "sdk" | "settings" | "env" | "cli",
	field: string,
	defaultPath: string | (() => string),
): StorageSelection {
	if (typeof defaultPath === "string") return selectStorageAt(value, source, field, defaultPath);
	const selection = selectStorageAt(value, source, field, PENDING_DEFAULT_PATH);
	return takesDefaultPath(value, selection) ? { ...selection, path: defaultPath() } : selection;
}

function selectStorageAt(
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
		if (value.adapter === REMOVED_LIBSQL_ADAPTER)
			throw new StorageConfigError(source, field, "libsql-removed", LIBSQL_REMOVED_HINT);
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

export async function selectStorageAsync(
	value: StorageInputSelection,
	source: "sdk" | "settings" | "env" | "cli",
	field: string,
	defaultPath: () => Promise<string>,
): Promise<StorageSelection> {
	const selection = selectStorageAt(value, source, field, PENDING_DEFAULT_PATH);
	return takesDefaultPath(value, selection) ? { ...selection, path: await defaultPath() } : selection;
}

export function* selectStorageSteps(
	value: StorageInputSelection,
	source: "sdk" | "settings" | "env" | "cli",
	field: string,
	defaultPath: string | (() => StorageSteps<string>),
): StorageSteps<StorageSelection> {
	if (typeof defaultPath === "string") return selectStorageAt(value, source, field, defaultPath);
	const selection = selectStorageAt(value, source, field, PENDING_DEFAULT_PATH);
	return takesDefaultPath(value, selection) ? { ...selection, path: yield* defaultPath() } : selection;
}

/** A token file `atomic storage join` created in the agent directory has this filename prefix. */
export const STORAGE_TOKEN_FILE = "storage-token";

/** The `sessions.storage` value that pins sessions to the local default store, named explicitly. */
export const LOCAL_SESSIONS_STORAGE = { path: "workflows/journal.sqlite" } as const;

export type TeamInputSource = "sdk" | "cli" | "env";

interface TeamInputFields {
	readonly url: string;
	readonly token: string;
	readonly tokenFile: string;
	readonly prefix: string;
}

const FIELDS: Readonly<Record<TeamInputSource, TeamInputFields>> = {
	sdk: { url: "url", token: "token", tokenFile: "tokenFile", prefix: "prefix" },
	cli: { url: "<url>", token: "--token-file", tokenFile: "--token-file", prefix: "--prefix" },
	env: { url: "url", token: "token", tokenFile: "tokenFile", prefix: "prefix" },
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

/** The first-party PostgreSQL adapter package that `atomic storage join postgres://…` and `--db postgres://…` select. */
export const POSTGRES_ADAPTER_PACKAGE = "@bastani/atomic-storage-postgres";

/** The platform credential a Postgres selection's `auth` option names, instead of a password. */
export type PostgresAuth = "azure-entra" | "aws-iam" | "gcp-iam";

/** What `--auth` takes, and the `auth` option each value selects; the option values themselves are accepted too. */
export const POSTGRES_AUTH_FLAGS: Readonly<Record<string, PostgresAuth>> = {
	azure: "azure-entra",
	aws: "aws-iam",
	gcp: "gcp-iam",
};

/** Whether a database URL names a PostgreSQL server. */
export function isPostgresUrl(url: string): boolean {
	return /^postgres(?:ql)?:\/\//.test(url);
}

/** The flags that pass a Postgres credential, as refusals name them. */
const POSTGRES_CREDENTIAL_FLAGS = ["--password-file", "--token-file", "--auth"] as const;

/**
 * Check a `postgres://` or `postgresql://` URL: it names a host and holds no password, in its userinfo or as a
 * `password` parameter. A user name is part of the address and stays.
 */
function checkPostgresUrl(url: string, source: TeamInputSource): string {
	const field = FIELDS[source].url;
	const parsed = URL.canParse(url) ? new URL(url) : undefined;
	if (parsed === undefined || parsed.hostname === "") {
		throw invalid(
			"unsupported-url",
			source,
			field,
			"Use a postgres://user@host[:port]/database URL, for example postgres://atomic@db.example.com:5432/atomic.",
		);
	}
	if (parsed.password !== "" || parsed.searchParams.has("password")) {
		throw invalid(
			"credential-in-url",
			source,
			field,
			"The URL carries a password. Remove it and pass it with --password-file or --token-file instead (or use --auth), so it never reaches settings or output.",
		);
	}
	return url;
}

/** The shared database a command line names: its URL and where its credential comes from. */
export interface SharedDatabaseArguments {
	readonly url: string;
	/** A password or token file another process keeps fresh, referenced in place. */
	readonly tokenFile?: string;
	/** Postgres only: a password file. */
	readonly passwordFile?: string;
	/** Postgres only: the platform credential, as the `--auth` value. */
	readonly auth?: string;
}

/** {@link SharedDatabaseArguments} after the checks, with `auth` resolved to the adapter's option value. */
export interface CheckedSharedDatabase {
	readonly url: string;
	readonly tokenFile?: string;
	readonly passwordFile?: string;
	readonly auth?: PostgresAuth;
}

/**
 * Check the database URL and credential flags of `atomic storage join` and `--db`: a `postgres://` or
 * `postgresql://` URL that takes exactly one of `--password-file`, `--token-file` and `--auth`. A URL of the removed
 * libSQL adapter is refused with how to move off it.
 */
export function checkSharedDatabaseArguments(input: SharedDatabaseArguments): CheckedSharedDatabase {
	const { url, tokenFile, passwordFile, auth } = input;
	if (isPostgresUrl(url)) {
		checkPostgresUrl(url, "cli");
		const sources = [passwordFile, tokenFile, auth].filter((value) => value !== undefined);
		if (sources.length > 1) throw conflictingTeamToken("cli", POSTGRES_CREDENTIAL_FLAGS);
		if (sources.length === 0)
			throw invalid(
				"missing-token",
				"cli",
				"--password-file",
				"Pass the database password with --password-file or --token-file, or a platform credential with --auth azure|aws|gcp.",
			);
		if (passwordFile !== undefined) return { url, passwordFile };
		if (tokenFile !== undefined) return { url, tokenFile };
		const mode = Object.hasOwn(POSTGRES_AUTH_FLAGS, auth!)
			? POSTGRES_AUTH_FLAGS[auth!]
			: Object.values(POSTGRES_AUTH_FLAGS).find((value) => value === auth);
		if (mode === undefined)
			throw invalid("unsupported-auth", "cli", "--auth", "Use --auth azure, --auth aws or --auth gcp.");
		return { url, auth: mode };
	}
	throw invalid(
		isLibsqlUrl(url) ? "libsql-removed" : "unsupported-url",
		"cli",
		FIELDS.cli.url,
		isLibsqlUrl(url)
			? `Atomic opens shared databases on PostgreSQL only: use a postgres:// or postgresql:// URL. ${LIBSQL_REMOVED_HINT}`
			: "Use a postgres:// or postgresql:// URL, for example postgres://atomic@db.example.com:5432/atomic.",
	);
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

/**
 * Read a token file and remove surrounding whitespace, or with `as-connections-read` only one final line ending, as
 * a file a selection references is read for every connection; an unreadable or empty file is an invalid input.
 */
export function readTeamTokenFile(
	path: string,
	source: TeamInputSource,
	field: string = FIELDS[source].tokenFile,
	read: "trimmed" | "as-connections-read" = "trimmed",
): string {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		throw unreadableTokenFile(path, source, field, error as Error);
	}
	return teamTokenOf(text, path, source, field, read);
}

function unreadableTokenFile(
	path: string,
	source: TeamInputSource,
	field: string,
	cause: Error,
): TeamProfileConfigError {
	return invalid("unreadable-token-file", source, field, `Check that ${path} exists and is readable.`, {
		path,
		cause,
	});
}

function teamTokenOf(
	text: string,
	path: string,
	source: TeamInputSource,
	field: string,
	read: "trimmed" | "as-connections-read",
): string {
	// A file referenced in place is read again by every new connection, which drops only one final line ending.
	const token =
		read === "trimmed"
			? text.trim()
			: text.endsWith("\r\n")
				? text.slice(0, -2)
				: text.endsWith("\n")
					? text.slice(0, -1)
					: text;
	if (token.length === 0) {
		throw invalid(
			"empty-token",
			source,
			field,
			field === "--password-file"
				? `The password file ${path} is empty: write the database password into it.`
				: `The token file ${path} is empty: write the database password or token into it.`,
			{ path },
		);
	}
	return token;
}

/** More than one token source. */
export function conflictingTeamToken(source: TeamInputSource, fields: readonly string[]): TeamProfileConfigError {
	return invalid("conflicting-token", source, fields.join(", "), `Pass only one of ${fields.join(", ")}.`);
}

// `getTeamProfile` loads the settings and storage machinery on first use, so importing the storage module stays
// cheap for storage adapters and hosts that never read the layout.

/**
 * The layout in effect for this process and working directory (`individual`, `team`, `ci` or `custom`), from the
 * storage each domain selects. Reads only; an invalid selection rejects with its `StorageConfigError`.
 */
export async function getTeamProfile(options: TeamProfileOptions = {}): Promise<TeamProfile> {
	return (await import("./team.js")).selectTeamProfile(options);
}
