/** The oldest system git Atomic accepts; workflow worktree commands need `rev-parse --end-of-options` (Git 2.30). */
export const GIT_MINIMUM_VERSION = "2.30.0";

const GIT_PROVISION_ERROR_NAME = "GitProvisionError";
const GIT_UNAVAILABLE_ERROR_NAME = "GitUnavailableError";
const GIT_PROVISION_TIMEOUT_ERROR_NAME = "GitProvisionTimeoutError";
const GIT_PROVISION_CONFIG_ERROR_NAME = "GitProvisionConfigError";
const MAX_CAUSE_DEPTH = 8;
const RETRYABLE_HTTP_STATUSES: ReadonlySet<number> = new Set([408, 425, 429, 500, 502, 503, 504]);

export type GitUnavailableCode =
	| "unsupported-platform"
	| "offline"
	| "not-installed"
	| "checksum-mismatch"
	| "download-failed"
	| "install-failed";
export type GitProvisionTimeoutCode = "provision-timeout";
export type GitProvisionConfigCode = "invalid-option";
export type GitProvisionErrorCode = GitUnavailableCode | GitProvisionTimeoutCode | GitProvisionConfigCode;

export const GIT_UNAVAILABLE_CODES: ReadonlySet<string> = new Set<GitUnavailableCode>([
	"unsupported-platform",
	"offline",
	"not-installed",
	"checksum-mismatch",
	"download-failed",
	"install-failed",
]);

/** Why automatic provisioning cannot serve this machine. */
export type GitUnsupportedPlatformReason = "platform" | "architecture" | "musl" | "glibc-too-old";
/** An installation or cached-release validation step that failed. */
export type GitInstallPhase = "stage" | "extract" | "verify" | "promote";
/** The provisioning step that was running when a time limit expired. */
export type GitProvisionPhase = "lock" | "download" | "extract" | "verify";

/** A git found on PATH that Atomic could not use. */
export type GitRejectedSystemGit = {
	readonly path: string;
	readonly problem: "below-minimum" | "probe-failed";
	readonly version?: string;
};

type GitUnavailableCaseFields =
	| {
			readonly code: "unsupported-platform";
			readonly reason: GitUnsupportedPlatformReason;
			readonly libc?: string;
	  }
	| { readonly code: "offline"; readonly offlineVariable: string }
	| { readonly code: "not-installed"; readonly installDir: string }
	| {
			readonly code: "checksum-mismatch";
			readonly asset: string;
			readonly url: string;
			readonly expectedSha256: string;
			readonly actualSha256: string;
	  }
	| { readonly code: "download-failed"; readonly asset: string; readonly url: string; readonly httpStatus?: number }
	| {
			readonly code: "install-failed";
			readonly phase: GitInstallPhase;
			readonly asset: string;
			readonly installDir: string;
			readonly detail?: string;
	  };

/**
 * The facts behind a {@link GitUnavailableError}, discriminated by `code`. `platform` and `arch` are Node's values.
 * `installCommand` is the command that installs git on the machine that raised the error, when its distribution is
 * known; it is stored, never recomputed, so a rehydrated error keeps the original machine's command.
 */
export type GitUnavailableFields = GitUnavailableCaseFields & {
	readonly platform: string;
	readonly arch: string;
	readonly installCommand?: string;
	readonly systemGit?: GitRejectedSystemGit;
};

export type GitProvisionTimeoutFields = {
	readonly phase: GitProvisionPhase;
	readonly timeoutMs: number;
	readonly elapsedMs: number;
	readonly installCommand?: string;
};

export type GitProvisionConfigFields = {
	readonly source: "sdk";
	readonly field: string;
	readonly expected: string;
};

export type GitProvisionJsonValue =
	| string
	| number
	| boolean
	| null
	| readonly GitProvisionJsonValue[]
	| { readonly [key: string]: GitProvisionJsonValue | undefined };
export type GitProvisionFields = { readonly [key: string]: GitProvisionJsonValue | undefined };

/** A non-git cause, reduced to what survives a process boundary. */
export interface SerializedErrorCause {
	readonly name: string;
	readonly message: string;
	readonly code?: string | number;
	readonly cause?: SerializedGitProvisionError | SerializedErrorCause;
}

/** The wire form of a git provisioning error; {@link rehydrateGitProvisionError} restores its class. */
export interface SerializedGitProvisionError {
	readonly name: string;
	readonly code: string;
	readonly message: string;
	readonly hint: string;
	readonly retryable: boolean;
	readonly fields: GitProvisionFields;
	readonly cause?: SerializedGitProvisionError | SerializedErrorCause;
}

interface GitProvisionErrorInit {
	readonly name?: string;
	readonly code: string;
	readonly message: string;
	readonly hint: string;
	readonly retryable: boolean;
	readonly fields: GitProvisionFields;
}

function composeMessage(failure: string, subject: string, code: string, hint: string): string {
	return `${failure}: ${subject} (${code}). ${hint}`;
}

/** Base of every git provisioning and resolution failure. */
export class GitProvisionError extends Error {
	override readonly name: string = GIT_PROVISION_ERROR_NAME;
	readonly code: string;
	readonly hint: string;
	readonly retryable: boolean;
	readonly fields: GitProvisionFields;
	/** A cleanup failure that followed this error; it never replaces it. */
	declare readonly cleanupCause?: Error;

	constructor(init: GitProvisionErrorInit, options?: ErrorOptions) {
		super(init.message, options);
		if (init.name !== undefined) this.name = init.name;
		this.code = init.code;
		this.hint = init.hint;
		this.retryable = init.retryable;
		this.fields = init.fields;
	}

	toJSON(): SerializedGitProvisionError {
		return serializeGitProvisionError(this, 1);
	}
}

function serializeGitProvisionError(error: GitProvisionError, depth: number): SerializedGitProvisionError {
	const cause = serializeCause(error.cause, depth);
	return {
		name: error.name,
		code: error.code,
		message: error.message,
		hint: error.hint,
		retryable: error.retryable,
		fields: error.fields,
		...(cause === undefined ? {} : { cause }),
	};
}

function systemGitClause(systemGit: GitRejectedSystemGit | undefined): string {
	if (systemGit === undefined) return "";
	return systemGit.problem === "below-minimum"
		? `; ${systemGit.path} is git ${systemGit.version}, older than ${GIT_MINIMUM_VERSION}`
		: `; ${systemGit.path} did not report a usable git version`;
}

function installYourself(installCommand: string | undefined): string {
	return installCommand === undefined
		? `install git ${GIT_MINIMUM_VERSION} or newer with your system package manager (https://git-scm.com/downloads)`
		: `install git ${GIT_MINIMUM_VERSION} or newer with \`${installCommand}\``;
}

function unavailableSubject(fields: GitUnavailableFields): string {
	switch (fields.code) {
		case "unsupported-platform":
			return `automatic provisioning does not support ${fields.platform}/${fields.arch}${fields.libc === undefined ? "" : ` with ${fields.libc}`}${systemGitClause(fields.systemGit)}`;
		case "offline":
			return `${fields.offlineVariable} is set, so no portable git is downloaded${systemGitClause(fields.systemGit)}`;
		case "not-installed":
			return `no git ${GIT_MINIMUM_VERSION} or newer is on PATH${systemGitClause(fields.systemGit)}, and no portable git is installed in ${fields.installDir}`;
		case "checksum-mismatch":
			return `${fields.asset} has SHA-256 ${fields.actualSha256}, expected ${fields.expectedSha256}; nothing was installed`;
		case "download-failed":
			return `${fields.asset} could not be downloaded${fields.httpStatus === undefined ? "" : ` (HTTP ${fields.httpStatus})`}`;
		case "install-failed": {
			const verb = { stage: "staged", extract: "extracted", verify: "verified", promote: "installed" }[fields.phase];
			return `${fields.asset} could not be ${verb} into ${fields.installDir}${fields.detail === undefined ? "" : `: ${fields.detail}`}`;
		}
	}
}

function capitalize(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1);
}

function unavailableHint(fields: GitUnavailableFields): string {
	switch (fields.code) {
		case "unsupported-platform":
			return `${capitalize(installYourself(fields.installCommand))}.`;
		case "offline":
			return `Unset ${fields.offlineVariable} so Atomic can download a portable git, or ${installYourself(fields.installCommand)}.`;
		case "not-installed":
			return `Call resolveGit() to download a portable git (interactive Atomic does this at startup), or ${installYourself(fields.installCommand)}.`;
		case "checksum-mismatch":
			return `Check for a proxy or firewall that alters downloads from github.com, or ${installYourself(fields.installCommand)}.`;
		case "download-failed":
			return `Check that github.com is reachable from this machine and try again, or ${installYourself(fields.installCommand)}.`;
		case "install-failed":
			return fields.phase === "verify"
				? `Check cached files and read/execute access in ${fields.installDir}; if this system cannot run the portable build, ${installYourself(fields.installCommand)}.`
				: `Check free disk space and write access to ${fields.installDir} and try again, or ${installYourself(fields.installCommand)}.`;
	}
}

function unavailableRetryable(fields: GitUnavailableFields): boolean {
	if (fields.code !== "download-failed") return false;
	return fields.httpStatus === undefined || RETRYABLE_HTTP_STATUSES.has(fields.httpStatus);
}

/** No usable git: none on PATH, and Atomic cannot or did not provision one. Nothing is installed when this is thrown. */
export class GitUnavailableError extends GitProvisionError {
	override readonly name = GIT_UNAVAILABLE_ERROR_NAME;
	declare readonly code: GitUnavailableCode;
	declare readonly fields: GitUnavailableFields;
	/** The Node platform git was resolved for, for example `linux`. */
	readonly platform: string;

	constructor(fields: GitUnavailableFields, options?: ErrorOptions) {
		const hint = unavailableHint(fields);
		super(
			{
				code: fields.code,
				message: composeMessage("Git is unavailable", unavailableSubject(fields), fields.code, hint),
				hint,
				retryable: unavailableRetryable(fields),
				fields,
			},
			options,
		);
		this.platform = fields.platform;
	}
}

/** A provisioning step exceeded its time limit. Retrying may succeed on a faster connection. */
export class GitProvisionTimeoutError extends GitProvisionError {
	override readonly name = GIT_PROVISION_TIMEOUT_ERROR_NAME;
	declare readonly code: GitProvisionTimeoutCode;
	declare readonly fields: GitProvisionTimeoutFields;
	declare readonly retryable: true;

	constructor(fields: GitProvisionTimeoutFields, options?: ErrorOptions) {
		const hint = `Check the network connection to github.com and try again, or ${installYourself(fields.installCommand)}.`;
		super(
			{
				code: "provision-timeout",
				message: composeMessage(
					"Git provisioning timed out",
					`${fields.phase} did not finish within ${fields.timeoutMs}ms (stopped after ${fields.elapsedMs}ms)`,
					"provision-timeout",
					hint,
				),
				hint,
				retryable: true,
				fields,
			},
			options,
		);
	}
}

/** A `resolveGit()` option had the wrong type; rejected before any probe or download. */
export class GitProvisionConfigError extends GitProvisionError {
	override readonly name = GIT_PROVISION_CONFIG_ERROR_NAME;
	declare readonly code: GitProvisionConfigCode;
	declare readonly fields: GitProvisionConfigFields;

	constructor(fields: GitProvisionConfigFields) {
		const hint = `Pass ${fields.expected} or omit ${fields.field}.`;
		super({
			code: "invalid-option",
			message: composeMessage(
				"Invalid git resolution option",
				`${fields.field} from ${fields.source} must be ${fields.expected}`,
				"invalid-option",
				hint,
			),
			hint,
			retryable: false,
			fields,
		});
	}
}

type ErrorLike = { readonly name?: string; readonly code?: string | number; readonly message?: string };

function hasNameAndCode(value: unknown, name: string, codes: ReadonlySet<string> | undefined): boolean {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as ErrorLike;
	if (candidate.name !== name || typeof candidate.code !== "string") return false;
	return codes === undefined || codes.has(candidate.code);
}

const KNOWN_NAMES = [
	GIT_PROVISION_ERROR_NAME,
	GIT_UNAVAILABLE_ERROR_NAME,
	GIT_PROVISION_TIMEOUT_ERROR_NAME,
	GIT_PROVISION_CONFIG_ERROR_NAME,
] as const;

export function isGitProvisionError(value: unknown): value is GitProvisionError {
	return value instanceof GitProvisionError || KNOWN_NAMES.some((name) => hasNameAndCode(value, name, undefined));
}

export function isGitUnavailableError(value: unknown): value is GitUnavailableError {
	return (
		value instanceof GitUnavailableError || hasNameAndCode(value, GIT_UNAVAILABLE_ERROR_NAME, GIT_UNAVAILABLE_CODES)
	);
}

export function isGitProvisionTimeoutError(value: unknown): value is GitProvisionTimeoutError {
	return (
		value instanceof GitProvisionTimeoutError ||
		hasNameAndCode(value, GIT_PROVISION_TIMEOUT_ERROR_NAME, new Set(["provision-timeout"]))
	);
}

export function isGitProvisionConfigError(value: unknown): value is GitProvisionConfigError {
	return (
		value instanceof GitProvisionConfigError ||
		hasNameAndCode(value, GIT_PROVISION_CONFIG_ERROR_NAME, new Set(["invalid-option"]))
	);
}

/** The first git provisioning error in `error`'s cause chain, searched to a bounded depth. */
export function findGitProvisionError(error: unknown): GitProvisionError | undefined {
	let current = error;
	for (let depth = 0; depth < MAX_CAUSE_DEPTH && typeof current === "object" && current !== null; depth++) {
		if (isGitProvisionError(current)) return current;
		current = (current as { readonly cause?: unknown }).cause;
	}
	return undefined;
}

/** Whether anything in `error`'s cause chain is a git provisioning error a caller may retry. */
export function isRetryableGitProvisionError(error: unknown): boolean {
	let current = error;
	for (let depth = 0; depth < MAX_CAUSE_DEPTH && typeof current === "object" && current !== null; depth++) {
		if (isGitProvisionError(current) && current.retryable === true) return true;
		current = (current as { readonly cause?: unknown }).cause;
	}
	return false;
}

/** Keep `primary` and attach the cleanup failure that followed it. */
export function attachGitCleanupFailure(primary: unknown, cleanupFailure: unknown): void {
	if (typeof primary !== "object" || primary === null || "cleanupCause" in primary) return;
	Object.defineProperty(primary, "cleanupCause", {
		value: cleanupFailure instanceof Error ? cleanupFailure : new Error(String(cleanupFailure)),
		enumerable: false,
	});
}

function serializeCause(
	cause: unknown,
	parentDepth: number,
): SerializedGitProvisionError | SerializedErrorCause | undefined {
	const depth = parentDepth + 1;
	if (depth > MAX_CAUSE_DEPTH || typeof cause !== "object" || cause === null) return undefined;
	if (cause instanceof GitProvisionError) return serializeGitProvisionError(cause, depth);
	const candidate = cause as ErrorLike & { readonly cause?: unknown };
	const nested = serializeCause(candidate.cause, depth);
	return {
		name: typeof candidate.name === "string" ? candidate.name : "Error",
		message: typeof candidate.message === "string" ? candidate.message : String(cause),
		...(typeof candidate.code === "string" || typeof candidate.code === "number" ? { code: candidate.code } : {}),
		...(nested === undefined ? {} : { cause: nested }),
	};
}

function isSerializedGitProvisionError(
	value: SerializedGitProvisionError | SerializedErrorCause,
): value is SerializedGitProvisionError {
	return typeof (value as SerializedGitProvisionError).fields === "object";
}

function rehydrateCause(cause: SerializedGitProvisionError | SerializedErrorCause | undefined): Error | undefined {
	if (cause === undefined) return undefined;
	if (isSerializedGitProvisionError(cause)) return rehydrateGitProvisionError(cause);
	const nested = rehydrateCause(cause.cause);
	const error = new Error(cause.message, nested === undefined ? undefined : { cause: nested });
	error.name = cause.name;
	if (cause.code !== undefined) Object.defineProperty(error, "code", { value: cause.code, enumerable: true });
	return error;
}

/**
 * Restore a serialized git provisioning error as its own class, with its cause chain. An unknown name (from a newer
 * sender) becomes a {@link GitProvisionError} that keeps the original name, code, message, and hint.
 */
export function rehydrateGitProvisionError(payload: SerializedGitProvisionError): GitProvisionError {
	const cause = rehydrateCause(payload.cause);
	const options = cause === undefined ? undefined : { cause };
	if (payload.name === GIT_UNAVAILABLE_ERROR_NAME && GIT_UNAVAILABLE_CODES.has(payload.code))
		return new GitUnavailableError(payload.fields as GitUnavailableFields, options);
	if (payload.name === GIT_PROVISION_TIMEOUT_ERROR_NAME && payload.code === "provision-timeout")
		return new GitProvisionTimeoutError(payload.fields as GitProvisionTimeoutFields, options);
	if (payload.name === GIT_PROVISION_CONFIG_ERROR_NAME && payload.code === "invalid-option")
		return new GitProvisionConfigError(payload.fields as GitProvisionConfigFields);
	return new GitProvisionError(
		{
			name: payload.name,
			code: payload.code,
			message: payload.message,
			hint: payload.hint,
			retryable: payload.retryable,
			fields: payload.fields,
		},
		options,
	);
}
