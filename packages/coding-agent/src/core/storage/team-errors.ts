import { StorageConfigError, StorageError } from "./errors.js";

/** Why a team setup operation failed after its inputs were accepted. */
export type TeamProfileErrorCode =
	| "settings-unreadable"
	| "adapter-not-installed"
	| "connection-failed"
	| "token-write-failed"
	| "settings-write-failed"
	| "settings-locked"
	| "broker-restart-failed"
	| "token-delete-failed";

/** Which team input was rejected: an SDK option, a CLI argument, or an `ATOMIC_PROFILE` / `ATOMIC_TEAM_*` variable. */
export type TeamProfileConfigErrorCode =
	| "unknown-profile"
	| "incomplete-profile"
	| "missing-url"
	| "unsupported-url"
	| "relative-file-url"
	| "credential-in-url"
	| "missing-token"
	| "conflicting-token"
	| "unreadable-token-file"
	| "empty-token"
	| "invalid-prefix"
	| "unknown-command"
	| "unknown-option"
	| "missing-value"
	| "unexpected-argument";

export const TEAM_PROFILE_ERROR_CODES: ReadonlySet<TeamProfileErrorCode> = new Set<TeamProfileErrorCode>([
	"settings-unreadable",
	"adapter-not-installed",
	"connection-failed",
	"token-write-failed",
	"settings-write-failed",
	"settings-locked",
	"broker-restart-failed",
	"token-delete-failed",
]);

export const TEAM_PROFILE_CONFIG_ERROR_CODES: ReadonlySet<TeamProfileConfigErrorCode> =
	new Set<TeamProfileConfigErrorCode>([
		"unknown-profile",
		"incomplete-profile",
		"missing-url",
		"unsupported-url",
		"relative-file-url",
		"credential-in-url",
		"missing-token",
		"conflicting-token",
		"unreadable-token-file",
		"empty-token",
		"invalid-prefix",
		"unknown-command",
		"unknown-option",
		"missing-value",
		"unexpected-argument",
	]);

const USAGE_CODES: ReadonlySet<TeamProfileConfigErrorCode> = new Set<TeamProfileConfigErrorCode>([
	"unknown-command",
	"unknown-option",
	"missing-value",
	"unexpected-argument",
]);

const RETRYABLE_CODES: ReadonlySet<TeamProfileErrorCode> = new Set<TeamProfileErrorCode>([
	"connection-failed",
	"settings-locked",
	"broker-restart-failed",
]);

const SUMMARIES: Readonly<Record<TeamProfileErrorCode, string>> = {
	"settings-unreadable": "Cannot update the global settings",
	"adapter-not-installed": "The libSQL storage adapter is not installed",
	"connection-failed": "Could not connect to the team database",
	"token-write-failed": "Could not store the database token",
	"settings-write-failed": "Could not write the global settings",
	"settings-locked": "Another process is writing the global settings",
	"broker-restart-failed": "Could not restart the Intercom broker",
	"token-delete-failed": "Could not delete the token file",
};

/** The facts a {@link TeamProfileError} carries; every field is JSON-safe and holds no credential. */
export interface TeamProfileErrorFields {
	/** What the failure is about: the settings file, the adapter, the database URL, the token file or the agent directory. */
	readonly subject: string;
	readonly hint: string;
	/** A short, credential-free description of the cause. */
	readonly detail?: string;
	readonly cause?: Error;
}

/**
 * The family of team setup failures (`joinTeam`, `leaveTeam`, `getTeamProfile`, `atomic storage join`,
 * `atomic team`) after the inputs were accepted. Branch on `code`, never on the message.
 */
export class TeamProfileError extends StorageError {
	override readonly name = "TeamProfileError" as const;
	readonly code: TeamProfileErrorCode;
	readonly subject: string;
	readonly hint: string;
	readonly detail?: string;
	/** Whether the same call can succeed later without a change on the caller's side. */
	readonly retryable: boolean;

	constructor(code: TeamProfileErrorCode, fields: TeamProfileErrorFields) {
		super(
			`${SUMMARIES[code]}: ${fields.subject} (${code})${fields.detail === undefined ? "" : `: ${fields.detail}`}. ${fields.hint}`,
			fields.cause === undefined ? undefined : { cause: fields.cause },
		);
		this.code = code;
		this.subject = fields.subject;
		this.hint = fields.hint;
		if (fields.detail !== undefined) this.detail = fields.detail;
		this.retryable = RETRYABLE_CODES.has(code);
	}
}

export interface TeamProfileConfigErrorFields {
	readonly source: "sdk" | "cli" | "env";
	/** The option, argument or variable, for example `tokenFile`, `--token-file` or `ATOMIC_TEAM_URL`. */
	readonly field: string;
	readonly hint: string;
	/** The token file the input names, when the failure is about that file. */
	readonly path?: string;
	/** `incomplete-profile`: every variable that still has to be set, all reported at once. */
	readonly missing?: readonly string[];
	readonly cause?: Error;
}

/**
 * An invalid team input. It is a {@link StorageConfigError} whose `reason` equals `code`, so hosts that already
 * handle invalid `ATOMIC_STORAGE` values handle an invalid `ATOMIC_PROFILE=ci` setup the same way.
 */
export class TeamProfileConfigError extends StorageConfigError {
	override readonly name = "TeamProfileConfigError" as const;
	declare readonly source: "sdk" | "cli" | "env";
	readonly code: TeamProfileConfigErrorCode;
	readonly hint: string;
	readonly path?: string;
	readonly missing?: readonly string[];
	readonly retryable = false;

	constructor(code: TeamProfileConfigErrorCode, fields: TeamProfileConfigErrorFields) {
		super(fields.source, fields.field, code);
		this.message = `${USAGE_CODES.has(code) ? "Invalid team command" : "Invalid storage configuration"}: ${fields.field} (${code}). ${fields.hint}`;
		if (fields.cause !== undefined) {
			Object.defineProperty(this, "cause", { value: fields.cause, configurable: true, writable: true });
		}
		this.code = code;
		this.hint = fields.hint;
		if (fields.path !== undefined) this.path = fields.path;
		if (fields.missing !== undefined) this.missing = [...fields.missing];
	}
}

const MAX_CAUSE_DEPTH = 8;

function hasNameAndCode(value: unknown, name: string, codes: ReadonlySet<string>): boolean {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as { readonly name?: unknown; readonly code?: unknown };
	return candidate.name === name && typeof candidate.code === "string" && codes.has(candidate.code);
}

/** Whether `error` is a {@link TeamProfileError}, also across realms and processes (by `name` and `code`). */
export function isTeamProfileError(error: unknown): error is TeamProfileError {
	return error instanceof TeamProfileError || hasNameAndCode(error, "TeamProfileError", TEAM_PROFILE_ERROR_CODES);
}

/** Whether `error` is a {@link TeamProfileConfigError}, also across realms and processes (by `name` and `code`). */
export function isTeamProfileConfigError(error: unknown): error is TeamProfileConfigError {
	return (
		error instanceof TeamProfileConfigError ||
		hasNameAndCode(error, "TeamProfileConfigError", TEAM_PROFILE_CONFIG_ERROR_CODES)
	);
}

/** Whether `error` or one of its causes, up to eight levels deep, is a retryable {@link TeamProfileError}. */
export function isRetryableTeamProfileError(error: unknown): boolean {
	let current = error;
	for (let depth = 0; depth < MAX_CAUSE_DEPTH && current !== undefined && current !== null; depth++) {
		if (isTeamProfileError(current) && current.retryable) return true;
		current = current instanceof Error ? current.cause : undefined;
	}
	return false;
}
