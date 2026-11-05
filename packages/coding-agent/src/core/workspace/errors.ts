/**
 * Typed errors for workspace bindings (#3109).
 *
 * Every error extends `WorkspaceError`, carries a stable `code`, JSON-safe `fields`, a `hint`, and an explicit
 * `retryable` flag. Messages are built from the fields: `<what failed>: <subject> (<code>). <what to do next>.`
 */

const MAX_CAUSE_DEPTH = 8;

export type WorkspaceErrorFieldValue = string | number | boolean | null | readonly string[];
export type WorkspaceErrorFields = Readonly<Record<string, WorkspaceErrorFieldValue>>;

export type WorkspaceBindingErrorCode =
	| "wrong-repository"
	| "wrong-branch"
	| "conflicting-worktree-input"
	| "invalid-repository"
	| "unknown-base"
	| "cwd-outside-worktree"
	| "git-unavailable"
	| "git-failed"
	| "filesystem-failed"
	| "drift"
	| "writer-conflict";

export type WorkspaceBindingErrorReason =
	| "not-a-worktree"
	| "not-a-worktree-root"
	| "different-repository"
	| "different-branch"
	| "detached-head"
	| "not-a-repository"
	| "not-a-repository-root"
	| "history-rewritten"
	| "remote-changed";

export type WorkspaceConfigErrorCode = "invalid-setting";
export type WorkspaceConfigSource = "sdk" | "cli" | "env" | "settings";
export type WorkspaceConfigErrorReason = "missing" | "invalid-type" | "invalid-value";

export type WorkspaceRestoreErrorCode = "restore-failed";
export type WorkspaceRestoreErrorReason = "repository-missing" | "branch-missing";

export type WorkspacePublicationErrorCode = "publication-failed";
export type WorkspacePublicationErrorReason =
	| "no-remote"
	| "push-failed"
	| "gh-unavailable"
	| "gh-unauthenticated"
	| "gh-failed";

export type WorkspaceTimeoutErrorCode = "timeout";
export type WorkspaceSandboxErrorCode = "write-denied";

export type WorkspaceErrorCode =
	| WorkspaceBindingErrorCode
	| WorkspaceConfigErrorCode
	| WorkspaceRestoreErrorCode
	| WorkspacePublicationErrorCode
	| WorkspaceTimeoutErrorCode
	| WorkspaceSandboxErrorCode;

/** Git step that was running when a workspace operation failed or timed out. */
export type WorkspaceGitPhase =
	| "probe"
	| "clone"
	| "fetch"
	| "worktree-add"
	| "validate"
	| "snapshot"
	| "change-set"
	| "push"
	| "lease";

interface WorkspaceErrorInit {
	/** Set only for the family base; each subclass declares its own literal name. */
	readonly name?: string;
	readonly code: string;
	readonly message: string;
	readonly hint: string;
	readonly fields: WorkspaceErrorFields;
	readonly retryable: boolean;
	readonly reason?: string;
	readonly cause?: unknown;
	readonly cleanupCause?: unknown;
}

/** Family base for every workspace error. Unknown serialized names rehydrate into this class. */
export class WorkspaceError extends Error {
	override readonly name: string;
	readonly code: string;
	readonly reason?: string;
	readonly hint: string;
	readonly fields: WorkspaceErrorFields;
	readonly retryable: boolean;
	/** A cleanup step that failed after this error; the error itself stays the primary failure. */
	readonly cleanupCause?: unknown;

	constructor(init: WorkspaceErrorInit) {
		super(init.message, { cause: init.cause });
		this.name = init.name ?? "WorkspaceError";
		this.code = init.code;
		this.reason = init.reason;
		this.hint = init.hint;
		this.fields = Object.freeze({ ...init.fields });
		this.retryable = init.retryable;
		this.cleanupCause = init.cleanupCause;
	}
}

/**
 * Keep `primary` as the failure and record a cleanup failure on it as `cleanupCause`. A primary that is not an `Error`
 * cannot carry the field and is returned unchanged; the cleanup failure is then reported only through `primary`.
 */
export function attachCleanupCause(primary: unknown, cleanupCause: unknown): unknown {
	if (cleanupCause !== undefined && primary instanceof Error)
		Object.defineProperty(primary, "cleanupCause", { value: cleanupCause, enumerable: true, configurable: true });
	return primary;
}

function message(what: string, subject: string, code: string, hint: string): string {
	return `${what}: ${subject} (${code}). ${hint}`;
}

/** Git's own last words, which name the actual problem, when the failure recorded any. */
function gitOutput(fields: WorkspaceErrorFields): string {
	const detail = fields.detail;
	return typeof detail === "string" && detail !== "" ? `: ${detail}` : "";
}

function text(fields: WorkspaceErrorFields, key: string): string {
	return String(fields[key]);
}

interface Described {
	readonly what: string;
	readonly subject: string;
	readonly hint: string;
}

const OUT_OF_SPACE_ERRNOS: ReadonlySet<string> = new Set(["ENOSPC", "EDQUOT"]);
const IN_THE_WAY_ERRNOS: ReadonlySet<string> = new Set(["EEXIST", "ENOTEMPTY"]);

function describeBinding(
	code: WorkspaceBindingErrorCode,
	reason: WorkspaceBindingErrorReason | undefined,
	fields: WorkspaceErrorFields,
): Described {
	switch (code) {
		case "wrong-repository":
			return {
				what: "Workspace worktree belongs to another repository",
				subject:
					reason === "not-a-worktree"
						? `${text(fields, "worktree")} is not a git worktree`
						: reason === "not-a-worktree-root"
							? `${text(fields, "worktree")} is inside the worktree ${text(fields, "actual")}, not its root`
							: `${text(fields, "worktree")} uses ${text(fields, "actual")}, expected ${text(fields, "expected")}`,
				hint: `Pass a worktree of ${text(fields, "repo")}, or use worktree: "auto".`,
			};
		case "wrong-branch":
			return {
				what: "Workspace worktree is on the wrong branch",
				subject: `${text(fields, "worktree")} is on ${text(fields, "actual")}, expected ${text(fields, "expected")}`,
				hint: `Check out ${text(fields, "expected")} in that worktree, or pass the branch it is on.`,
			};
		case "conflicting-worktree-input":
			return {
				what: "Workspace conflicts with a worktree input",
				subject: `${text(fields, "input")} is set together with workspace`,
				hint: `Remove ${text(fields, "input")}; the workspace already selects the worktree.`,
			};
		case "invalid-repository":
			return {
				what: "Workspace repository is not usable",
				subject:
					reason === "not-a-repository-root"
						? `${text(fields, "repo")} is inside the repository ${text(fields, "actual")}, not its root`
						: `${text(fields, "repo")} is not a git repository`,
				hint:
					reason === "not-a-repository-root"
						? `Pass the repository root ${text(fields, "actual")}.`
						: "Pass the absolute path of a git repository root, or a remote URL.",
			};
		case "unknown-base":
			return {
				what: "Workspace base does not resolve",
				subject: `${text(fields, "base")} is not a commit in ${text(fields, "repo")}`,
				hint: "Pass a base that exists in the repository, for example origin/main.",
			};
		case "cwd-outside-worktree":
			return {
				what: "Working directory escapes the workspace",
				subject: `${text(fields, "cwd")} is outside ${text(fields, "worktree")}`,
				hint: "Use a cwd inside the workspace worktree, or a relative path.",
			};
		case "git-unavailable":
			return {
				what: "Git is unavailable",
				subject: `${text(fields, "gitPath")} could not be started, and workspaces need git to bind repositories`,
				hint: `Install git (${text(fields, "installCommand")}) and make sure it is on PATH.`,
			};
		case "git-failed":
			return {
				what: "Workspace git command failed",
				subject: `${text(fields, "command")} exited with status ${text(fields, "status")} during ${text(fields, "phase")}${gitOutput(fields)}`,
				hint: "Check the repository, network access and credentials, then retry.",
			};
		case "filesystem-failed":
			return {
				what: "Workspace filesystem operation failed",
				subject: `${text(fields, "operation")} ${text(fields, "path")} failed with ${text(fields, "errno")}`,
				hint: OUT_OF_SPACE_ERRNOS.has(text(fields, "errno"))
					? `Free disk space on the volume that holds ${text(fields, "path")}, then retry.`
					: IN_THE_WAY_ERRNOS.has(text(fields, "errno"))
						? `Remove ${text(fields, "path")}, which is in the way, then retry.`
						: `Check that ${text(fields, "path")} is writable by this user, then retry.`,
			};
		case "drift":
			return {
				what: "Workspace changed unexpectedly",
				subject:
					reason === "remote-changed"
						? `${text(fields, "worktree")} no longer has the recorded remote ${text(fields, "expected")}`
						: `${text(fields, "branch")} in ${text(fields, "worktree")} no longer contains the recorded commit ${text(fields, "expected")}`,
				hint: "Restore the recorded repository state, or start a new run instead of resuming.",
			};
		case "writer-conflict":
			return {
				what: "Workspace already has a writer",
				subject: `${text(fields, "worktree")} is held by ${text(fields, "holder")} (pid ${text(fields, "holderPid")} on ${text(fields, "holderHost")})`,
				hint: `Wait for that writer to finish, use a read-only workspace, or remove ${text(fields, "lockFile")} if its process is gone.`,
			};
	}
}

const RETRYABLE_BINDING_CODES: ReadonlySet<WorkspaceBindingErrorCode> = new Set(["writer-conflict"]);
const RETRYABLE_GIT_PHASES: ReadonlySet<string> = new Set(["clone", "fetch", "push"]);
const RETRYABLE_ERRNOS: ReadonlySet<string> = new Set([...OUT_OF_SPACE_ERRNOS, "EAGAIN", "EBUSY", "EMFILE", "ENFILE"]);

export interface WorkspaceBindingErrorInit {
	readonly code: WorkspaceBindingErrorCode;
	readonly reason?: WorkspaceBindingErrorReason;
	readonly fields: WorkspaceErrorFields;
	readonly cause?: unknown;
}

/** A workspace could not be bound: wrong repository or branch, conflicting inputs, git failures or drift. */
export class WorkspaceBindingError extends WorkspaceError {
	override readonly name = "WorkspaceBindingError" as const;
	declare readonly code: WorkspaceBindingErrorCode;
	declare readonly reason?: WorkspaceBindingErrorReason;

	constructor(init: WorkspaceBindingErrorInit) {
		const described = describeBinding(init.code, init.reason, init.fields);
		super({
			code: init.code,
			reason: init.reason,
			message: message(described.what, described.subject, init.code, described.hint),
			hint: described.hint,
			fields: init.fields,
			retryable:
				RETRYABLE_BINDING_CODES.has(init.code) ||
				(init.code === "git-failed" && RETRYABLE_GIT_PHASES.has(String(init.fields.phase))) ||
				(init.code === "filesystem-failed" && RETRYABLE_ERRNOS.has(String(init.fields.errno))),
			cause: init.cause,
		});
	}
}

export interface WorkspaceConfigErrorInit {
	readonly source: WorkspaceConfigSource;
	readonly field: string;
	readonly reason: WorkspaceConfigErrorReason;
	readonly expected: string;
	readonly received: string;
}

/** A workspace option was missing or malformed. Thrown before any git or filesystem work. */
export class WorkspaceConfigError extends WorkspaceError {
	override readonly name = "WorkspaceConfigError" as const;
	declare readonly code: WorkspaceConfigErrorCode;
	declare readonly reason: WorkspaceConfigErrorReason;
	readonly source: WorkspaceConfigSource;
	readonly field: string;

	constructor(init: WorkspaceConfigErrorInit) {
		const hint = `Set ${init.field} to ${init.expected}.`;
		super({
			code: "invalid-setting",
			reason: init.reason,
			message: message(
				"Invalid workspace option",
				`${init.field} from ${init.source} is ${init.reason === "missing" ? "missing" : `${init.received}, expected ${init.expected}`}`,
				"invalid-setting",
				hint,
			),
			hint,
			fields: {
				source: init.source,
				field: init.field,
				expected: init.expected,
				received: init.received,
			},
			retryable: false,
		});
		this.source = init.source;
		this.field = init.field;
	}
}

export interface WorkspaceRestoreErrorInit {
	readonly reason: WorkspaceRestoreErrorReason;
	readonly fields: WorkspaceErrorFields;
	readonly cause?: unknown;
	readonly cleanupCause?: unknown;
}

/** A recorded binding could not be restored on resume. */
export class WorkspaceRestoreError extends WorkspaceError {
	override readonly name = "WorkspaceRestoreError" as const;
	declare readonly code: WorkspaceRestoreErrorCode;
	declare readonly reason: WorkspaceRestoreErrorReason;

	constructor(init: WorkspaceRestoreErrorInit) {
		const hint =
			init.reason === "repository-missing"
				? `Restore the repository at ${text(init.fields, "repository")}, or start a new run.`
				: `Recreate branch ${text(init.fields, "branch")} or push it to the remote, then resume.`;
		super({
			code: "restore-failed",
			reason: init.reason,
			message: message(
				"Workspace restore failed",
				init.reason === "repository-missing"
					? `repository ${text(init.fields, "repository")} is gone`
					: `branch ${text(init.fields, "branch")} for ${text(init.fields, "worktree")} is gone`,
				"restore-failed",
				hint,
			),
			hint,
			fields: init.fields,
			retryable: false,
			cause: init.cause,
			cleanupCause: init.cleanupCause,
		});
	}
}

export interface WorkspacePublicationErrorInit {
	readonly reason: WorkspacePublicationErrorReason;
	readonly fields: WorkspaceErrorFields;
	readonly cause?: unknown;
}

const PUBLICATION_HINTS: Readonly<Record<WorkspacePublicationErrorReason, string>> = {
	"no-remote": "Add an origin remote to the repository before publishing.",
	"push-failed": "Check push access to the remote, then retry.",
	"gh-unavailable": "Install the GitHub CLI (https://cli.github.com) and run gh auth login.",
	"gh-unauthenticated": "Run gh auth login, or set GH_TOKEN, then retry.",
	"gh-failed": "Check gh auth status and the repository on GitHub, then retry.",
};

/** `publishPullRequest` could not push the branch or open the pull request. */
export class WorkspacePublicationError extends WorkspaceError {
	override readonly name = "WorkspacePublicationError" as const;
	declare readonly code: WorkspacePublicationErrorCode;
	declare readonly reason: WorkspacePublicationErrorReason;

	constructor(init: WorkspacePublicationErrorInit) {
		const hint = PUBLICATION_HINTS[init.reason];
		super({
			code: "publication-failed",
			reason: init.reason,
			message: message(
				"Pull request publication failed",
				`${text(init.fields, "branch")} of ${text(init.fields, "repo")} (${init.reason})`,
				"publication-failed",
				hint,
			),
			hint,
			fields: init.fields,
			retryable: init.reason === "push-failed" || init.reason === "gh-failed",
			cause: init.cause,
		});
	}
}

export interface WorkspaceTimeoutErrorInit {
	readonly phase: WorkspaceGitPhase;
	readonly timeoutMs: number;
	readonly elapsedMs: number;
	readonly command: string;
}

/** A git step of a workspace operation exceeded its time limit. */
export class WorkspaceTimeoutError extends WorkspaceError {
	override readonly name = "WorkspaceTimeoutError" as const;
	declare readonly code: WorkspaceTimeoutErrorCode;
	readonly phase: WorkspaceGitPhase;
	readonly timeoutMs: number;
	readonly elapsedMs: number;

	constructor(init: WorkspaceTimeoutErrorInit) {
		const hint = "Check network access to the remote, then retry.";
		super({
			code: "timeout",
			message: message(
				"Workspace git command timed out",
				`${init.command} ran ${init.elapsedMs}ms during ${init.phase}, limit ${init.timeoutMs}ms`,
				"timeout",
				hint,
			),
			hint,
			fields: { phase: init.phase, timeoutMs: init.timeoutMs, elapsedMs: init.elapsedMs, command: init.command },
			retryable: true,
		});
		this.phase = init.phase;
		this.timeoutMs = init.timeoutMs;
		this.elapsedMs = init.elapsedMs;
	}
}

export interface WorkspaceSandboxErrorInit {
	readonly tool: string;
	readonly worktree: string;
}

/** A file-writing tool was called in a read-only workspace. Reported to the model as the tool's error result. */
export class WorkspaceSandboxError extends WorkspaceError {
	override readonly name = "WorkspaceSandboxError" as const;
	declare readonly code: WorkspaceSandboxErrorCode;

	constructor(init: WorkspaceSandboxErrorInit) {
		const hint = "This stage is a read-only reviewer; report the change instead of making it.";
		super({
			code: "write-denied",
			message: message(
				"Write denied in a read-only workspace",
				`${init.tool} cannot change ${init.worktree}`,
				"write-denied",
				hint,
			),
			hint,
			fields: { tool: init.tool, worktree: init.worktree, sandbox: "read-only" },
			retryable: false,
		});
	}
}

/** The command that installs git on `platform`. */
export function gitInstallCommand(platform: NodeJS.Platform = process.platform): string {
	if (platform === "darwin") return "xcode-select --install";
	if (platform === "win32") return "winget install --id Git.Git -e";
	return "sudo apt-get install git, sudo dnf install git or apk add git";
}

/** Why git is unavailable, in #4322's codes. A workspace only ever reports `not-installed` itself. */
export type GitUnavailableErrorCode = "not-installed" | "unsupported-platform" | "offline" | "checksum-mismatch";

/**
 * Git could not be started. Stand-in for #4322's `GitUnavailableError` (exported with `resolveGit()`), which replaces
 * this class when that change lands; the name, codes and `platform`/`hint` fields match it, so guards keep matching.
 */
export class GitUnavailableError extends Error {
	override readonly name = "GitUnavailableError" as const;
	readonly code: GitUnavailableErrorCode;
	readonly platform: NodeJS.Platform;
	readonly hint: string;
	readonly fields: WorkspaceErrorFields;
	readonly retryable = false;

	constructor(init: { readonly gitPath: string; readonly code?: GitUnavailableErrorCode; readonly cause?: unknown }) {
		const code = init.code ?? "not-installed";
		const installCommand = gitInstallCommand();
		const hint = `Install git (${installCommand}) and make sure it is on PATH.`;
		super(message("Git is unavailable", `${init.gitPath} could not be started`, code, hint), { cause: init.cause });
		this.code = code;
		this.platform = process.platform;
		this.hint = hint;
		this.fields = Object.freeze({ gitPath: init.gitPath, platform: process.platform, installCommand });
	}
}

const WORKSPACE_ERROR_NAMES: ReadonlySet<string> = new Set([
	"WorkspaceError",
	"WorkspaceBindingError",
	"WorkspaceConfigError",
	"WorkspaceRestoreError",
	"WorkspacePublicationError",
	"WorkspaceTimeoutError",
	"WorkspaceSandboxError",
]);

/**
 * A data property of `value` or its prototypes. Accessors are never invoked, so guards stay side-effect free and never
 * throw on hostile or half-built values.
 */
function dataProperty(value: unknown, key: string): unknown {
	for (let owner: unknown = value; typeof owner === "object" && owner !== null; owner = Object.getPrototypeOf(owner)) {
		const descriptor = Object.getOwnPropertyDescriptor(owner, key);
		if (descriptor !== undefined) return descriptor.value;
	}
	return undefined;
}

function named(value: unknown, name: string): boolean {
	return dataProperty(value, "name") === name && typeof dataProperty(value, "code") === "string";
}

export function isWorkspaceError(value: unknown): value is WorkspaceError {
	return (
		value instanceof WorkspaceError ||
		(WORKSPACE_ERROR_NAMES.has(dataProperty(value, "name") as string) &&
			typeof dataProperty(value, "code") === "string")
	);
}

export function isWorkspaceBindingError(value: unknown): value is WorkspaceBindingError {
	return value instanceof WorkspaceBindingError || named(value, "WorkspaceBindingError");
}

export function isWorkspaceConfigError(value: unknown): value is WorkspaceConfigError {
	return value instanceof WorkspaceConfigError || named(value, "WorkspaceConfigError");
}

export function isWorkspaceRestoreError(value: unknown): value is WorkspaceRestoreError {
	return value instanceof WorkspaceRestoreError || named(value, "WorkspaceRestoreError");
}

export function isWorkspacePublicationError(value: unknown): value is WorkspacePublicationError {
	return value instanceof WorkspacePublicationError || named(value, "WorkspacePublicationError");
}

export function isWorkspaceTimeoutError(value: unknown): value is WorkspaceTimeoutError {
	return value instanceof WorkspaceTimeoutError || named(value, "WorkspaceTimeoutError");
}

export function isWorkspaceSandboxError(value: unknown): value is WorkspaceSandboxError {
	return value instanceof WorkspaceSandboxError || named(value, "WorkspaceSandboxError");
}

export function isGitUnavailableError(value: unknown): value is GitUnavailableError {
	return value instanceof GitUnavailableError || named(value, "GitUnavailableError");
}

/** First error in `value`'s cause chain (itself included, at most eight links) that matches `guard`. */
export function findWorkspaceError(value: unknown): WorkspaceError | undefined;
export function findWorkspaceError<T>(value: unknown, guard: (candidate: unknown) => candidate is T): T | undefined;
export function findWorkspaceError(value: unknown, guard: (candidate: unknown) => boolean = isWorkspaceError): unknown {
	let current: unknown = value;
	for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
		if (guard(current)) return current;
		current = dataProperty(current, "cause");
	}
	return undefined;
}

/** Whether a workspace error marked retryable appears in `value`'s cause chain. */
export function isRetryableWorkspaceError(value: unknown): boolean {
	return (
		findWorkspaceError(value, (candidate): candidate is WorkspaceError => {
			return isWorkspaceError(candidate) && dataProperty(candidate, "retryable") === true;
		}) !== undefined
	);
}

export interface SerializedWorkspaceErrorCause {
	readonly name: string;
	readonly message: string;
	readonly code?: string;
	readonly hint?: string;
	readonly fields?: WorkspaceErrorFields;
	readonly retryable?: boolean;
	readonly reason?: string;
	readonly cause?: SerializedWorkspaceErrorCause;
}

/** Wire form of a workspace error, for crossing worker and IPC boundaries. */
export interface SerializedWorkspaceError extends SerializedWorkspaceErrorCause {
	readonly code: string;
	readonly hint: string;
	readonly fields: WorkspaceErrorFields;
	readonly retryable: boolean;
}

function serializeCause(value: unknown, depth: number): SerializedWorkspaceErrorCause | undefined {
	if (value === undefined || value === null || depth >= MAX_CAUSE_DEPTH) return undefined;
	const candidate = value as Partial<WorkspaceError>;
	// Undefined members disappear when the record is sent as JSON.
	return {
		name: candidate.name ?? "Error",
		message: candidate.message ?? String(value),
		code: candidate.code,
		hint: candidate.hint,
		fields: candidate.fields,
		retryable: candidate.retryable,
		reason: candidate.reason,
		cause: serializeCause(candidate.cause, depth + 1),
	};
}

export function serializeWorkspaceError(error: WorkspaceError): SerializedWorkspaceError {
	return serializeCause(error, 0) as SerializedWorkspaceError;
}

function rehydrateCause(record: SerializedWorkspaceErrorCause | undefined): unknown {
	if (record === undefined) return undefined;
	if (record.name === "GitUnavailableError") {
		const error = new GitUnavailableError({
			gitPath: String(record.fields?.gitPath ?? "git"),
			code: record.code as GitUnavailableErrorCode,
			cause: rehydrateCause(record.cause),
		});
		Object.defineProperty(error, "message", { value: record.message, writable: true, configurable: true });
		return error;
	}
	if (record.hint !== undefined) return rehydrateWorkspaceError(record as SerializedWorkspaceError);
	const error = new Error(record.message, { cause: rehydrateCause(record.cause) });
	error.name = record.name;
	return error;
}

function construct(record: SerializedWorkspaceError, cause: unknown): WorkspaceError {
	const fields = record.fields;
	switch (record.name) {
		case "WorkspaceBindingError":
			return new WorkspaceBindingError({
				code: record.code as WorkspaceBindingErrorCode,
				reason: record.reason as WorkspaceBindingErrorReason | undefined,
				fields,
				cause,
			});
		case "WorkspaceConfigError":
			return new WorkspaceConfigError({
				source: fields.source as WorkspaceConfigSource,
				field: text(fields, "field"),
				reason: record.reason as WorkspaceConfigErrorReason,
				expected: text(fields, "expected"),
				received: text(fields, "received"),
			});
		case "WorkspaceRestoreError":
			return new WorkspaceRestoreError({ reason: record.reason as WorkspaceRestoreErrorReason, fields, cause });
		case "WorkspacePublicationError":
			return new WorkspacePublicationError({
				reason: record.reason as WorkspacePublicationErrorReason,
				fields,
				cause,
			});
		case "WorkspaceTimeoutError":
			return new WorkspaceTimeoutError({
				phase: fields.phase as WorkspaceGitPhase,
				timeoutMs: Number(fields.timeoutMs),
				elapsedMs: Number(fields.elapsedMs),
				command: text(fields, "command"),
			});
		case "WorkspaceSandboxError":
			return new WorkspaceSandboxError({ tool: text(fields, "tool"), worktree: text(fields, "worktree") });
		default:
			return new WorkspaceError({
				name: record.name,
				code: record.code,
				reason: record.reason,
				message: record.message,
				hint: record.hint,
				fields,
				retryable: record.retryable,
				cause,
			});
	}
}

/** Rebuild the original class from its wire form. Unknown names become `WorkspaceError` with name and code kept. */
export function rehydrateWorkspaceError(record: SerializedWorkspaceError): WorkspaceError {
	const error = construct(record, rehydrateCause(record.cause));
	// The sender's message wins, so a sender on another version renders the same text.
	Object.defineProperty(error, "message", { value: record.message, writable: true, configurable: true });
	return error;
}
