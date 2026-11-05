import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { StoragePrefixError } from "./errors.js";
import { validateStoragePrefix } from "./prefix.js";
import type { SecretRef } from "./provider.js";
import { inMemorySecret } from "./secret.js";
import { TeamProfileConfigError, type TeamProfileConfigErrorCode } from "./team-errors.js";

/** The first-party libSQL / Turso adapter package that team setup and `atomic storage join` select. */
export const LIBSQL_ADAPTER_PACKAGE = "@bastani/atomic-storage-libsql";
/** Filename prefix for private token files created by `atomic storage join` and `atomic team join` in the agent directory. */
export const STORAGE_TOKEN_FILE = "storage-token";

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
export function environmentTeamProfile(
	env: NodeJS.ProcessEnv = process.env,
	cwd: string = process.cwd(),
): TeamStorageSelection | undefined {
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
		const path = resolve(cwd, tokenFile);
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
