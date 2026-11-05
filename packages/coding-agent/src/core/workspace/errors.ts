/**
 * The workspace error family: worktree snapshot capture, restore and drift (#4245), snapshot blob collection (#4355),
 * and workspace bindings (#3109). One base, `WorkspaceError`, one code union, `WorkspaceErrorCode`, one guard, cause
 * walk and wire form for all of them.
 *
 * Every error carries a stable `code`, JSON-safe `fields` (also set as properties of the error), a `hint`, a `summary`
 * of what failed and an explicit `retryable` flag. Messages are built from them: `<summary> (<code>). <hint>`.
 */
import {
	type GitUnavailableCode,
	GitUnavailableError,
	type GitUnavailableFields,
	isGitUnavailableError,
} from "../../utils/git-errors.ts";

export { type GitUnavailableCode, GitUnavailableError, type GitUnavailableFields, isGitUnavailableError };
export type GitUnavailableErrorCode = GitUnavailableCode;

export type WorkspaceErrorFieldValue =
	| string
	| number
	| boolean
	| null
	| readonly WorkspaceErrorFieldValue[]
	| { readonly [key: string]: WorkspaceErrorFieldValue | undefined };
export type WorkspaceErrorFields = { readonly [key: string]: WorkspaceErrorFieldValue | undefined };

export type WorkspaceConfigErrorCode = "invalid-setting";
export type WorkspaceGitErrorCode = "git-failed";
export type WorkspaceSnapshotErrorCode =
	| "not-a-repository"
	| "unborn-head"
	| "blob-store-unsupported"
	| "unreadable-path";
export type WorkspaceRestoreErrorCode =
	| "snapshot-not-found"
	| "blob-missing"
	| "blob-corrupt"
	| "commits-unavailable"
	| "delta-failed"
	| "tree-mismatch"
	| "unsafe-target"
	| "unwritable-path"
	| "invalid-snapshot"
	| "restore-failed";
export type WorkspaceDriftErrorCode = "tree-drift";
export type WorkspaceCollectionErrorCode = "collection-failed";
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
	| "writer-conflict"
	| "incomplete-worktree";
export type WorkspacePublicationErrorCode = "publication-failed";
export type WorkspaceTimeoutErrorCode = "timeout";
export type WorkspaceSandboxErrorCode = "write-denied";
export type WorkspaceErrorCode =
	| WorkspaceConfigErrorCode
	| WorkspaceGitErrorCode
	| WorkspaceSnapshotErrorCode
	| WorkspaceRestoreErrorCode
	| WorkspaceDriftErrorCode
	| WorkspaceCollectionErrorCode
	| WorkspaceBindingErrorCode
	| WorkspacePublicationErrorCode
	| WorkspaceTimeoutErrorCode
	| WorkspaceSandboxErrorCode;

export type WorkspaceErrorName =
	| "WorkspaceError"
	| "WorkspaceConfigError"
	| "WorkspaceGitError"
	| "WorkspaceSnapshotError"
	| "WorkspaceRestoreError"
	| "WorkspaceDriftError"
	| "WorkspaceCollectionError"
	| "WorkspaceBindingError"
	| "WorkspacePublicationError"
	| "WorkspaceTimeoutError"
	| "WorkspaceSandboxError";

export type WorkspaceBindingErrorReason =
	| "not-a-worktree"
	| "not-a-worktree-root"
	| "different-repository"
	| "different-branch"
	| "detached-head"
	| "not-a-repository"
	| "not-a-repository-root"
	| "history-rewritten"
	| "remote-changed"
	| "branch-diverged"
	| "interrupted-add"
	| "orphaned-directory"
	| "repair-failed"
	| "addition-in-progress"
	| "outdated";
export type WorkspaceConfigErrorReason = "missing" | "invalid-type" | "invalid-value";
/** Why a recorded workspace binding could not be restored (`restore-failed`). */
export type WorkspaceRestoreErrorReason = "repository-missing" | "branch-missing" | "commits-unavailable";
export type WorkspacePublicationErrorReason =
	| "no-remote"
	| "push-failed"
	| "gh-unavailable"
	| "gh-unauthenticated"
	| "gh-failed";

/** Step that was running when a workspace operation failed or timed out: a git step, or waiting for the repository lock. */
export type WorkspaceGitPhase =
	| "probe"
	| "clone"
	| "fetch"
	| "worktree-add"
	| "validate"
	| "snapshot"
	| "change-set"
	| "push"
	| "lease"
	| "repository-lock";

const MAX_CAUSE_DEPTH = 8;
/** Properties of the error itself, which a field of the same name never replaces. */
const RESERVED_PROPERTIES: ReadonlySet<string> = new Set([
	"name",
	"message",
	"stack",
	"cause",
	"cleanupCause",
	"code",
	"summary",
	"hint",
	"fields",
	"retryable",
]);

export interface WorkspaceErrorInit {
	/** Set only for the family base, such as an error of a class this version does not know; subclasses set their own. */
	readonly name?: string;
	readonly code: WorkspaceErrorCode;
	/** What failed, without the code and the hint: the first part of the message. */
	readonly summary: string;
	readonly hint: string;
	readonly fields: WorkspaceErrorFields;
	readonly retryable?: boolean;
	/** The sub-case of `code`, when the class has them. */
	readonly reason?: string;
	readonly cause?: unknown;
	/** A cleanup step that failed after this error; the error itself stays the primary failure. */
	readonly cleanupCause?: unknown;
}

/**
 * Base of every workspace binding, worktree snapshot, restore, drift and collection failure. Branch on `code` or the
 * class, never on `message`. `fields` holds the same JSON-safe facts as the typed properties, for logs and process
 * boundaries.
 */
export class WorkspaceError extends Error {
	override readonly name: string;
	readonly code: WorkspaceErrorCode;
	/** What failed, without the code and the hint: the first part of `message`. */
	readonly summary: string;
	readonly hint: string;
	readonly retryable: boolean;
	readonly fields: WorkspaceErrorFields;
	declare readonly reason?: string;
	/** A cleanup step that failed after this error; the error itself stays the primary failure. */
	declare readonly cleanupCause?: unknown;

	constructor(init: WorkspaceErrorInit) {
		super(
			`${init.summary} (${init.code}). ${init.hint}`,
			init.cause === undefined ? undefined : { cause: init.cause },
		);
		this.name = init.name ?? "WorkspaceError";
		this.code = init.code;
		this.summary = init.summary;
		this.hint = init.hint;
		this.retryable = init.retryable ?? false;
		this.fields = Object.freeze({ ...init.fields });
		for (const [key, value] of Object.entries(init.fields))
			if (!RESERVED_PROPERTIES.has(key)) Object.defineProperty(this, key, { value, enumerable: true });
		if (init.reason !== undefined) Object.defineProperty(this, "reason", { value: init.reason, enumerable: true });
		attachCleanupCause(this, init.cleanupCause);
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

export type WorkspaceConfigSource = "sdk" | "cli" | "env" | "settings";

/** A workspace option (#3109): how it is wrong, and the value received. */
export interface WorkspaceConfigErrorInit {
	readonly source: WorkspaceConfigSource;
	readonly field: string;
	readonly reason: WorkspaceConfigErrorReason;
	readonly expected: string;
	readonly received: string;
}

function configInit(
	sourceOrInit: WorkspaceConfigSource | WorkspaceConfigErrorInit,
	field: string | undefined,
	expected: string | undefined,
): WorkspaceErrorInit {
	if (typeof sourceOrInit === "string")
		return {
			code: "invalid-setting",
			summary: `Invalid worktree snapshot setting: ${field} from ${sourceOrInit}`,
			hint: `Set ${field} to ${expected}.`,
			fields: { source: sourceOrInit, field, expected },
		};
	const init = sourceOrInit;
	return {
		code: "invalid-setting",
		reason: init.reason,
		summary: `Invalid workspace option: ${init.field} from ${init.source} is ${init.reason === "missing" ? "missing" : `${init.received}, expected ${init.expected}`}`,
		hint: `Set ${init.field} to ${init.expected}.`,
		fields: { source: init.source, field: init.field, expected: init.expected, received: init.received },
	};
}

/**
 * A workspace option, a worktree snapshot setting or an SDK option has the wrong type or range. Thrown before any Git
 * or filesystem work. A workspace option also says how it is wrong (`reason`) and what it `received`.
 */
export class WorkspaceConfigError extends WorkspaceError {
	override readonly name = "WorkspaceConfigError" as const;
	declare readonly code: WorkspaceConfigErrorCode;
	declare readonly reason?: WorkspaceConfigErrorReason;
	declare readonly source: WorkspaceConfigSource;
	declare readonly field: string;
	declare readonly expected: string;
	declare readonly received?: string;

	/** A workspace option. */
	constructor(init: WorkspaceConfigErrorInit);
	/** A worktree snapshot setting or SDK option. */
	constructor(source: WorkspaceConfigSource, field: string, expected: string);
	constructor(sourceOrInit: WorkspaceConfigSource | WorkspaceConfigErrorInit, field?: string, expected?: string) {
		super(configInit(sourceOrInit, field, expected));
	}
}

const GIT_INSTALL_COMMANDS: Readonly<Partial<Record<NodeJS.Platform, string>>> = {
	darwin: "xcode-select --install",
	win32: "winget install --id Git.Git -e",
	linux: "sudo apt-get install git",
};

/** The command that installs Git on `platform`. */
export function gitInstallCommand(platform: NodeJS.Platform = process.platform): string {
	return GIT_INSTALL_COMMANDS[platform] ?? "install Git from https://git-scm.com/downloads";
}

function compactFields(fields: object): WorkspaceErrorFields {
	return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as WorkspaceErrorFields;
}

/** A Git command failed. `detail` is the first line of its error output with any URL credentials removed. */
export class WorkspaceGitError extends WorkspaceError {
	override readonly name = "WorkspaceGitError" as const;
	declare readonly code: WorkspaceGitErrorCode;
	declare readonly operation: string;
	declare readonly cwd: string;
	declare readonly exitCode: number | null;
	declare readonly detail: string;

	constructor(fields: { operation: string; cwd: string; exitCode: number | null; detail: string }, cause?: Error) {
		super({
			code: "git-failed",
			summary: `Git ${fields.operation} failed in ${fields.cwd}${fields.detail ? `: ${fields.detail}` : ""}`,
			hint: "Check that the repository is readable, its disk has free space, and no other Git process holds its lock, then retry.",
			fields,
			cause,
		});
	}
}

const SNAPSHOT_SUMMARIES: Record<WorkspaceSnapshotErrorCode, (subject: string) => readonly [string, string]> = {
	"not-a-repository": (subject) => [
		`Worktree snapshot unavailable: ${subject} is not inside a Git repository`,
		"Work inside a Git checkout to record snapshots.",
	],
	"unborn-head": (subject) => [
		`Worktree snapshot unavailable: ${subject} has no commits yet`,
		"Create a first commit to record snapshots.",
	],
	"blob-store-unsupported": (subject) => [
		`Worktree snapshot unavailable: ${subject} storage cannot hold snapshot blobs`,
		subject === "workflow journal"
			? 'Select a SQLite workflow journal, for example `"workflows": { "journal": { "path": "workflows/journal.sqlite" } }` in settings.json, to record snapshots.'
			: 'Select a SQLite session store, for example `--session-store <path>` or `"sessions": { "storage": { "path": "sessions.sqlite" } }` in settings.json, to record snapshots.',
	],
	"unreadable-path": (subject) => [
		`Worktree snapshot unavailable: ${subject} cannot be read`,
		`Make ${subject} readable by the current user (for example \`chmod u+rwX\` on it and its parent directories), replace a symbolic link that loops or points nowhere, or list the path in .gitignore or .atomic/snapshot-ignore, then retry.`,
	],
};

/** A snapshot cannot be recorded for a directory or a store. Capture reports it once as the degrade reason. */
export class WorkspaceSnapshotError extends WorkspaceError {
	override readonly name = "WorkspaceSnapshotError" as const;
	declare readonly code: WorkspaceSnapshotErrorCode;
	declare readonly subject: string;

	constructor(code: WorkspaceSnapshotErrorCode, subject: string, cause?: Error) {
		const [summary, hint] = SNAPSHOT_SUMMARIES[code](subject);
		super({ code, summary, hint, fields: { subject }, cause });
	}
}

/**
 * `error` as an `unreadable-path` snapshot error when it is a filesystem failure on `path`, so it carries a code and
 * a hint and degrades capture instead of failing the caller; any other error is returned unchanged.
 */
export function unreadablePathError(path: string, error: unknown): unknown {
	if (!(error instanceof Error) || typeof (error as NodeJS.ErrnoException).syscall !== "string") return error;
	return new WorkspaceSnapshotError("unreadable-path", path, error);
}

export interface WorkspaceRestoreErrorFields {
	readonly snapshotId: string | null;
	readonly head?: string;
	readonly tree?: string;
	readonly blob?: string;
	readonly role?: "patch" | "bundle";
	readonly deltaIndex?: number;
	readonly expectedTree?: string;
	readonly actualTree?: string | null;
	readonly commits?: readonly string[];
	readonly paths?: readonly string[];
	readonly reason?:
		| "denied-history"
		| "bundle-over-cap"
		| "not-fetched"
		| "not-empty"
		| "not-restored"
		| InvalidSnapshotReason;
	readonly remotes?: readonly string[];
	readonly target?: string;
	readonly detail?: string;
	/** For `invalid-snapshot`: the record field that failed, such as `remotes[0]` or `chain[2].tree`. */
	readonly field?: string;
}

/** A recorded workspace binding that could not be restored on resume (#3109): why, and its facts. */
export interface WorkspaceRestoreErrorInit {
	readonly reason: WorkspaceRestoreErrorReason;
	readonly fields: WorkspaceErrorFields;
	readonly cause?: unknown;
	readonly cleanupCause?: unknown;
}

/** Why a snapshot or binding record was refused before any Git or filesystem work. */
export type InvalidSnapshotReason = "unsafe-remote" | "invalid-object-id" | "invalid-snapshot-id" | "invalid-blob-hash";

const INVALID_SNAPSHOT_EXPECTATIONS: Record<InvalidSnapshotReason, string> = {
	"unsafe-remote": "a remote URL Atomic can safely fetch from",
	"invalid-object-id": "a Git object id",
	"invalid-snapshot-id": "a snapshot id",
	"invalid-blob-hash": "a SHA-256 blob hash",
};

function snapshotRestoreMessage(
	code: Exclude<WorkspaceRestoreErrorCode, "restore-failed">,
	fields: WorkspaceRestoreErrorFields,
): readonly [string, string] {
	const snapshot = fields.snapshotId ?? "binding";
	switch (code) {
		case "snapshot-not-found":
			return fields.tree === undefined
				? [
						`Cannot restore snapshot ${snapshot}: the session refers to it but holds no record of it`,
						"Resume on the machine that recorded it, or import (`atomic --import <file>`) a session saved with `/export <file>.jsonl`, which carries its snapshots.",
					]
				: [
						`Cannot restore workspace: no retained snapshot or warm object store has tree ${fields.tree}`,
						"Pass the recorded snapshot, or restore on a host that already materialized this tree.",
					];
		case "blob-missing":
			return [
				`Cannot restore snapshot ${snapshot}: ${fields.role ?? "snapshot"} blob ${fields.blob} is missing from storage`,
				"Use the storage the snapshot was recorded in, or import (`atomic --import <file>`) a session saved with `/export <file>.jsonl`, which carries its blobs.",
			];
		case "blob-corrupt":
			return [
				`Cannot restore snapshot ${snapshot}: ${fields.role ?? "snapshot"} blob ${fields.blob} does not match its hash`,
				"The stored snapshot is damaged; restore an earlier snapshot or re-import the session.",
			];
		case "commits-unavailable": {
			const remotes = fields.remotes?.length ? fields.remotes.join(", ") : "no recorded remote";
			if (fields.reason === "not-fetched") {
				return [
					`Cannot restore snapshot ${snapshot}: commit ${fields.head} could not be fetched from ${remotes}`,
					fields.remotes?.length
						? `Check access with \`git ls-remote ${fields.remotes[0]}\` and that ${fields.head} is pushed, then retry.`
						: `Push ${fields.head} to a remote and record it, then retry.`,
				];
			}
			const push = `Push commit ${fields.head} (with its history) to a recorded remote`;
			const deniedPaths = fields.paths?.length ? ` ${fields.paths.join(", ")}` : "";
			return [
				`Cannot restore snapshot ${snapshot}: commit ${fields.head} is not on ${remotes} and its unpushed history ${
					fields.reason === "denied-history"
						? `touches denied paths${deniedPaths}`
						: "exceeded the snapshot size cap"
				}`,
				fields.reason === "denied-history"
					? `${push}, then retry.${fields.commits?.length ? ` Commits ${fields.commits.join(", ")} add or change denied paths${deniedPaths}, so pushing publishes those files.` : ""}`
					: `${push}, or raise snapshots.maxSnapshotBytes and record a new snapshot, then retry.`,
			];
		}
		case "delta-failed":
			return [
				`Cannot restore snapshot ${snapshot}: delta ${fields.deltaIndex} (patch ${fields.blob ?? "none"}) did not produce tree ${fields.expectedTree}`,
				"The patch chain does not apply to its base; restore an earlier snapshot.",
			];
		case "tree-mismatch":
			return [
				`Restored worktree does not match snapshot ${snapshot}: ${fields.target} has tree ${fields.actualTree}, expected ${fields.expectedTree}`,
				"Check the repository's .gitattributes filters, then retry the restore into a new directory.",
			];
		case "unsafe-target":
			return fields.reason === "not-restored"
				? [
						`Cannot remove ${fields.target}: it is not a worktree that a snapshot restore created`,
						"Remove only paths returned by restoreWorktreeSnapshot, with the same storeDir.",
					]
				: [
						`Cannot restore into ${fields.target}: it is not an empty directory`,
						"Choose a new or empty directory, or omit `into` to restore under Atomic home.",
					];
		case "unwritable-path":
			return [
				`Cannot write ${fields.target}${fields.snapshotId === null ? "" : ` while restoring snapshot ${fields.snapshotId}`}`,
				`Free space on the volume that holds ${fields.target}, or make it and its parent directory writable by the current user (for example \`chmod u+rwX\`), then retry.`,
			];
		case "invalid-snapshot":
			return [
				`Invalid snapshot record${fields.snapshotId === null ? "" : ` ${fields.snapshotId}`}: ${fields.field} is not ${INVALID_SNAPSHOT_EXPECTATIONS[fields.reason as InvalidSnapshotReason]}`,
				"The record is malformed or was not written by Atomic. Restore only sessions and runs from storage you trust, or export the session again on the machine that recorded it.",
			];
	}
}

function text(fields: WorkspaceErrorFields, key: string): string {
	return String(fields[key]);
}

function bindingRestoreMessage(
	reason: WorkspaceRestoreErrorReason,
	fields: WorkspaceErrorFields,
): readonly [string, string] {
	switch (reason) {
		case "repository-missing":
			return [
				`Workspace restore failed: repository ${text(fields, "repository")} is gone`,
				`Restore the repository at ${text(fields, "repository")}, or start a new run.`,
			];
		case "branch-missing":
			return [
				`Workspace restore failed: branch ${text(fields, "branch")} for ${text(fields, "worktree")} is gone`,
				`Recreate branch ${text(fields, "branch")} or push it to the remote, then resume.`,
			];
		case "commits-unavailable": {
			const commits = (fields.missingCommits as readonly string[]).join(", ");
			return [
				`Workspace restore failed: ${commits}, which completed steps recorded on ${text(fields, "branch")}, are neither in ${text(fields, "repository")} nor on its remote`,
				`Push ${text(fields, "branch")} from the machine that made those commits (git -C <its worktree> push origin ${text(fields, "branch")}), then resume; resuming without them would skip their work.`,
			];
		}
	}
}

function restoreInit(
	codeOrInit: Exclude<WorkspaceRestoreErrorCode, "restore-failed"> | WorkspaceRestoreErrorInit,
	fields: WorkspaceRestoreErrorFields | undefined,
	cause: Error | undefined,
): WorkspaceErrorInit {
	if (typeof codeOrInit === "string") {
		const restored = fields as WorkspaceRestoreErrorFields;
		const [summary, hint] = snapshotRestoreMessage(codeOrInit, restored);
		return { code: codeOrInit, summary, hint, fields: compactFields(restored), cause };
	}
	const [summary, hint] = bindingRestoreMessage(codeOrInit.reason, codeOrInit.fields);
	return {
		code: "restore-failed",
		reason: codeOrInit.reason,
		summary,
		hint,
		fields: codeOrInit.fields,
		cause: codeOrInit.cause,
		cleanupCause: codeOrInit.cleanupCause,
	};
}

/**
 * A restore failed before returning a verified worktree: a worktree snapshot that could not be restored (nothing is
 * left at the target), or a recorded workspace binding that could not be restored on resume (`restore-failed`).
 */
export class WorkspaceRestoreError extends WorkspaceError {
	override readonly name = "WorkspaceRestoreError" as const;
	declare readonly code: WorkspaceRestoreErrorCode;
	declare readonly reason?: WorkspaceRestoreErrorFields["reason"] | WorkspaceRestoreErrorReason;
	declare readonly snapshotId?: string | null;
	declare readonly head?: string;
	declare readonly tree?: string;
	declare readonly blob?: string;
	declare readonly role?: "patch" | "bundle";
	declare readonly deltaIndex?: number;
	declare readonly expectedTree?: string;
	declare readonly actualTree?: string | null;
	declare readonly commits?: readonly string[];
	declare readonly paths?: readonly string[];
	declare readonly remotes?: readonly string[];
	declare readonly target?: string;
	declare readonly detail?: string;
	declare readonly field?: string;

	/** A recorded workspace binding (#3109). */
	constructor(init: WorkspaceRestoreErrorInit);
	/** A worktree snapshot (#4245). */
	constructor(
		code: Exclude<WorkspaceRestoreErrorCode, "restore-failed">,
		fields: WorkspaceRestoreErrorFields,
		cause?: Error,
	);
	constructor(
		codeOrInit: Exclude<WorkspaceRestoreErrorCode, "restore-failed"> | WorkspaceRestoreErrorInit,
		fields?: WorkspaceRestoreErrorFields,
		cause?: Error,
	) {
		super(restoreInit(codeOrInit, fields, cause));
	}
}

/**
 * `error` as an `unwritable-path` restore error when it is a filesystem failure writing `target`, so it carries a code
 * and a hint; any other error is returned unchanged.
 */
export function unwritablePathError(target: string, snapshotId: string | null, error: unknown): unknown {
	if (!(error instanceof Error) || typeof (error as NodeJS.ErrnoException).syscall !== "string") return error;
	return new WorkspaceRestoreError("unwritable-path", { snapshotId, target }, error);
}

export interface WorkspaceDriftErrorFields {
	readonly root: string;
	readonly expectedHead: string;
	readonly actualHead: string | null;
	readonly expectedTree: string;
	readonly actualTree: string | null;
	readonly snapshotId: string | null;
	/** `restore-failed` when an automatic restore was attempted and failed; the failure is the error's `cause`. */
	readonly reason?: "restore-failed";
	/** The `code` of the typed restore failure, when `reason` is `restore-failed`. */
	readonly restoreCode?: string;
}

/** The code, summary and remediation of a typed restore failure, which a drift error shows in place of its own. */
function restoreFailure(cause: Error | undefined): { code: string; summary: string; hint: string } | undefined {
	if (isGitUnavailableError(cause))
		return { code: cause.code, summary: `Git is unavailable (${cause.code})`, hint: cause.hint };
	const typed = findWorkspaceError(cause);
	if (typed === undefined || typeof typed.summary !== "string") return undefined;
	return { code: typed.code, summary: typed.summary, hint: typed.hint };
}

/**
 * A worktree no longer matches the snapshot work would resume from. Nothing ran against it. When an automatic restore
 * was attempted (`reason: "restore-failed"`), the message and hint carry the typed restore failure's summary and fix.
 */
export class WorkspaceDriftError extends WorkspaceError implements WorkspaceDriftErrorFields {
	override readonly name = "WorkspaceDriftError" as const;
	declare readonly code: WorkspaceDriftErrorCode;
	declare readonly root: string;
	declare readonly expectedHead: string;
	declare readonly actualHead: string | null;
	declare readonly expectedTree: string;
	declare readonly actualTree: string | null;
	declare readonly snapshotId: string | null;
	declare readonly reason?: "restore-failed";
	declare readonly restoreCode?: string;

	constructor(fields: WorkspaceDriftErrorFields, cause?: Error) {
		const failure = fields.reason === "restore-failed" ? restoreFailure(cause) : undefined;
		super({
			code: "tree-drift",
			summary: `Worktree drifted from its recorded snapshot: ${fields.root} has tree ${fields.actualTree ?? "none"} at ${fields.actualHead ?? "no HEAD"}, expected ${fields.expectedTree} at ${fields.expectedHead}${
				failure ? `, and the automatic restore failed: ${failure.summary}` : ""
			}`,
			hint: failure?.hint ?? "Restore the recorded snapshot into a new worktree, or undo the changes, then resume.",
			fields: compactFields(failure ? { ...fields, restoreCode: failure.code } : fields),
			cause,
		});
	}
}

/**
 * The step a failed snapshot blob collection was in: taking its claim, indexing references written before the index
 * existed, deleting blobs, or recording its outcome.
 */
export type SnapshotCollectionPhase = "claim" | "index" | "sweep" | "record";

export interface WorkspaceCollectionErrorFields {
	/** The blob table being collected, such as `snapshot_blobs`. */
	readonly table: string;
	readonly phase: SnapshotCollectionPhase;
	/** Blobs the collection deleted before it failed. */
	readonly deleted: number;
}

const COLLECTION_PHASES: Record<SnapshotCollectionPhase, string> = {
	claim: "claiming",
	index: "indexing existing snapshot references of",
	sweep: "deleting unreferenced blobs from",
	record: "recording its outcome for",
};

/**
 * Collecting unreferenced snapshot blobs failed; the storage failure is the `cause`. No blob a retained snapshot
 * references was deleted, and running the collection again is safe, so it is retryable.
 */
export class WorkspaceCollectionError extends WorkspaceError implements WorkspaceCollectionErrorFields {
	override readonly name = "WorkspaceCollectionError" as const;
	declare readonly code: WorkspaceCollectionErrorCode;
	declare readonly retryable: true;
	declare readonly table: string;
	declare readonly phase: SnapshotCollectionPhase;
	declare readonly deleted: number;

	constructor(fields: WorkspaceCollectionErrorFields, cause?: Error) {
		super({
			code: "collection-failed",
			summary: `Snapshot blob collection failed while ${COLLECTION_PHASES[fields.phase]} ${fields.table}`,
			hint: "No blob a retained snapshot needs was deleted. Check that the database is writable, has free space and is not locked by a stopped process; collection retries after snapshots.collectIntervalSeconds, or call collectSnapshotGarbage to retry now.",
			fields: { table: fields.table, phase: fields.phase, deleted: fields.deleted },
			retryable: true,
			cause,
		});
	}
}

/** Git's own last words, which name the actual problem, when the failure recorded any. */
function gitOutput(fields: WorkspaceErrorFields): string {
	const detail = fields.detail;
	return typeof detail === "string" && detail !== "" ? `: ${detail}` : "";
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
			if (reason === "outdated")
				return {
					what: "Git is too old",
					subject: `${text(fields, "gitPath")} is git ${text(fields, "version")}, and workspaces need git ${text(fields, "minimumVersion")} or later to lock worktrees while adding them`,
					hint: `Install a newer git (${text(fields, "installCommand")}) and make sure it is first on PATH.`,
				};
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
			if (reason === "branch-diverged")
				return {
					what: "Workspace branch diverged from its remote",
					subject: `${text(fields, "branch")} in ${text(fields, "repository")} is at ${text(fields, "actual")}, and origin/${text(fields, "branch")} at ${text(fields, "expected")} has commits it lacks`,
					hint: `Push or rebase the local commits onto origin/${text(fields, "branch")}, or take the remote's history with git -C ${text(fields, "repository")} branch --force ${text(fields, "branch")} origin/${text(fields, "branch")}, then retry.`,
				};
			return {
				what: "Workspace changed unexpectedly",
				subject:
					reason === "remote-changed"
						? `${text(fields, "worktree")} no longer has the recorded remote ${text(fields, "expected")}`
						: `${text(fields, "branch")} in ${text(fields, "worktree")} no longer contains the recorded commit ${text(fields, "expected")}`,
				hint: "Restore the recorded repository state, or start a new run instead of resuming.",
			};
		case "incomplete-worktree":
			if (reason === "addition-in-progress")
				return {
					what: "Workspace worktree is still being added",
					subject:
						fields.adderPid === null
							? `${text(fields, "worktree")} may still be checking out: ${text(fields, "adminDir")} holds an index lock, and no record names the git adding it`
							: `git (pid ${text(fields, "adderPid")} on ${text(fields, "adderHost")}) is still adding ${text(fields, "worktree")}`,
					hint:
						fields.adderPid === null
							? `Wait for that checkout to finish, then bind again. If no git is running, remove the worktree with git -C ${text(fields, "repository")} worktree remove --force --force ${text(fields, "worktree")}.`
							: `Wait for it to finish, or stop it with kill -TERM -${text(fields, "adderPid")} (Windows: taskkill /T /PID ${text(fields, "adderPid")}), then bind again.`,
				};
			return {
				what: "Workspace worktree is incomplete",
				subject:
					reason === "orphaned-directory"
						? `${text(fields, "worktree")} points at ${text(fields, "adminDir")}, which ${text(fields, "repository")} no longer has`
						: reason === "repair-failed"
							? `${text(fields, "worktree")} was left by an interrupted checkout and could not be removed`
							: `${text(fields, "worktree")} was left by an interrupted checkout (${text(fields, "adminDir")} is locked: ${text(fields, "marker")})`,
				hint: `Remove it with git -C ${text(fields, "repository")} worktree remove --force --force ${text(fields, "worktree")} and git -C ${text(fields, "repository")} worktree prune, or delete the directory if git no longer lists it, then bind again.`,
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
			summary: `${described.what}: ${described.subject}`,
			hint: described.hint,
			fields: init.fields,
			retryable:
				RETRYABLE_BINDING_CODES.has(init.code) ||
				init.reason === "addition-in-progress" ||
				(init.code === "git-failed" && RETRYABLE_GIT_PHASES.has(String(init.fields.phase))) ||
				(init.code === "filesystem-failed" && RETRYABLE_ERRNOS.has(String(init.fields.errno))),
			cause: init.cause,
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
		super({
			code: "publication-failed",
			reason: init.reason,
			summary: `Pull request publication failed: ${text(init.fields, "branch")} of ${text(init.fields, "repo")} (${init.reason})`,
			hint: PUBLICATION_HINTS[init.reason],
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
	/** The git command that ran, or for `repository-lock` the lock file waited for. */
	readonly command: string;
	/** For `repository-lock`: the process holding the lock, when known. */
	readonly holderPid?: number | null;
	readonly cause?: unknown;
}

function describeTimeout(init: WorkspaceTimeoutErrorInit): Described {
	const limit = `limit ${init.timeoutMs}ms`;
	if (init.phase === "repository-lock") {
		const holder = init.holderPid == null ? "another process" : `process ${init.holderPid}`;
		return {
			what: "Workspace repository lock wait timed out",
			subject: `${holder} held ${init.command} for ${init.elapsedMs}ms, ${limit}`,
			hint: `Wait for ${holder} to finish its fetch or worktree change, or stop it if it is stuck, then retry.`,
		};
	}
	return {
		what: "Workspace git command timed out",
		subject: `${init.command} ran ${init.elapsedMs}ms during ${init.phase}, ${limit}`,
		hint:
			init.phase === "worktree-add"
				? "Check free disk space and the repository's checkout size, then retry; the interrupted worktree is repaired on the next bind."
				: "Check network access to the remote, then retry.",
	};
}

/** A git step of a workspace operation exceeded its time limit. */
export class WorkspaceTimeoutError extends WorkspaceError {
	override readonly name = "WorkspaceTimeoutError" as const;
	declare readonly code: WorkspaceTimeoutErrorCode;
	declare readonly phase: WorkspaceGitPhase;
	declare readonly timeoutMs: number;
	declare readonly elapsedMs: number;

	constructor(init: WorkspaceTimeoutErrorInit) {
		const { what, subject, hint } = describeTimeout(init);
		super({
			code: "timeout",
			summary: `${what}: ${subject}`,
			hint,
			fields: {
				phase: init.phase,
				timeoutMs: init.timeoutMs,
				elapsedMs: init.elapsedMs,
				command: init.command,
				...(init.holderPid === undefined ? {} : { holderPid: init.holderPid }),
			},
			cause: init.cause,
			retryable: true,
		});
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
		super({
			code: "write-denied",
			summary: `Write denied in a read-only workspace: ${init.tool} cannot change ${init.worktree}`,
			hint: "This stage is a read-only reviewer; report the change instead of making it.",
			fields: { tool: init.tool, worktree: init.worktree, sandbox: "read-only" },
		});
	}
}

const CODES: Readonly<Record<WorkspaceErrorName, readonly WorkspaceErrorCode[]>> = {
	WorkspaceError: [],
	WorkspaceConfigError: ["invalid-setting"],
	WorkspaceGitError: ["git-failed"],
	WorkspaceSnapshotError: ["not-a-repository", "unborn-head", "blob-store-unsupported", "unreadable-path"],
	WorkspaceRestoreError: [
		"snapshot-not-found",
		"blob-missing",
		"blob-corrupt",
		"commits-unavailable",
		"delta-failed",
		"tree-mismatch",
		"unsafe-target",
		"unwritable-path",
		"invalid-snapshot",
		"restore-failed",
	],
	WorkspaceDriftError: ["tree-drift"],
	WorkspaceCollectionError: ["collection-failed"],
	WorkspaceBindingError: [
		"wrong-repository",
		"wrong-branch",
		"conflicting-worktree-input",
		"invalid-repository",
		"unknown-base",
		"cwd-outside-worktree",
		"git-unavailable",
		"git-failed",
		"filesystem-failed",
		"drift",
		"writer-conflict",
		"incomplete-worktree",
	],
	WorkspacePublicationError: ["publication-failed"],
	WorkspaceTimeoutError: ["timeout"],
	WorkspaceSandboxError: ["write-denied"],
};
const ALL_CODES = new Set(Object.values(CODES).flat());

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

function structurallyIs(value: unknown, name: WorkspaceErrorName): boolean {
	const candidateName = dataProperty(value, "name");
	const code = dataProperty(value, "code");
	if (typeof code !== "string") return false;
	if (name === "WorkspaceError")
		return (
			typeof candidateName === "string" &&
			Object.hasOwn(CODES, candidateName) &&
			ALL_CODES.has(code as WorkspaceErrorCode)
		);
	return candidateName === name && CODES[name].includes(code as WorkspaceErrorCode);
}

export function isWorkspaceError(value: unknown): value is WorkspaceError {
	return value instanceof WorkspaceError || structurallyIs(value, "WorkspaceError");
}
export function isWorkspaceConfigError(value: unknown): value is WorkspaceConfigError {
	return value instanceof WorkspaceConfigError || structurallyIs(value, "WorkspaceConfigError");
}
export function isWorkspaceGitError(value: unknown): value is WorkspaceGitError {
	return value instanceof WorkspaceGitError || structurallyIs(value, "WorkspaceGitError");
}
export function isWorkspaceSnapshotError(value: unknown): value is WorkspaceSnapshotError {
	return value instanceof WorkspaceSnapshotError || structurallyIs(value, "WorkspaceSnapshotError");
}
export function isWorkspaceRestoreError(value: unknown): value is WorkspaceRestoreError {
	return value instanceof WorkspaceRestoreError || structurallyIs(value, "WorkspaceRestoreError");
}
export function isWorkspaceDriftError(value: unknown): value is WorkspaceDriftError {
	return value instanceof WorkspaceDriftError || structurallyIs(value, "WorkspaceDriftError");
}
export function isWorkspaceCollectionError(value: unknown): value is WorkspaceCollectionError {
	return value instanceof WorkspaceCollectionError || structurallyIs(value, "WorkspaceCollectionError");
}
export function isWorkspaceBindingError(value: unknown): value is WorkspaceBindingError {
	return value instanceof WorkspaceBindingError || structurallyIs(value, "WorkspaceBindingError");
}
export function isWorkspacePublicationError(value: unknown): value is WorkspacePublicationError {
	return value instanceof WorkspacePublicationError || structurallyIs(value, "WorkspacePublicationError");
}
export function isWorkspaceTimeoutError(value: unknown): value is WorkspaceTimeoutError {
	return value instanceof WorkspaceTimeoutError || structurallyIs(value, "WorkspaceTimeoutError");
}
export function isWorkspaceSandboxError(value: unknown): value is WorkspaceSandboxError {
	return value instanceof WorkspaceSandboxError || structurallyIs(value, "WorkspaceSandboxError");
}

/** The first error in `value`'s cause chain (itself included, at most eight links) that `guard` accepts. */
export function findWorkspaceError(value: unknown): WorkspaceError | undefined;
export function findWorkspaceError<T>(value: unknown, guard: (candidate: unknown) => candidate is T): T | undefined;
export function findWorkspaceError(value: unknown, guard: (candidate: unknown) => boolean = isWorkspaceError): unknown {
	let current: unknown = value;
	for (let depth = 0; depth < MAX_CAUSE_DEPTH && current !== undefined && current !== null; depth++) {
		if (guard(current)) return current;
		current = dataProperty(current, "cause");
	}
	return undefined;
}

/** Whether `value` or a cause up to eight levels deep is a workspace error that is safe to retry. */
export function isRetryableWorkspaceError(value: unknown): boolean {
	return (
		findWorkspaceError(
			value,
			(candidate): candidate is WorkspaceError =>
				isWorkspaceError(candidate) && dataProperty(candidate, "retryable") === true,
		) !== undefined
	);
}

/** Wire form of an error and up to seven of its causes, for crossing worker and IPC boundaries. */
export interface SerializedWorkspaceError {
	readonly name: string;
	readonly message: string;
	readonly code?: string;
	readonly hint?: string;
	readonly fields?: WorkspaceErrorFields;
	readonly retryable?: boolean;
	/** The sub-case of `code`, when it is not already one of the `fields`. */
	readonly reason?: string;
	readonly cause?: SerializedWorkspaceError;
	/** A cleanup that also failed, recorded beside the failure rather than replacing it. */
	readonly cleanupCause?: SerializedWorkspaceError;
}

function serialize(value: unknown, depth: number): SerializedWorkspaceError | undefined {
	if (value === undefined || value === null || depth >= MAX_CAUSE_DEPTH) return undefined;
	if (typeof value !== "object") return { name: "Error", message: String(value) };
	const error = value as Partial<WorkspaceError>;
	const typed = isWorkspaceError(value) || isGitUnavailableError(value);
	const reason = typed && typeof error.reason === "string" && error.fields?.reason !== error.reason;
	const cause = serialize(error.cause, depth + 1);
	const cleanupCause = serialize(error.cleanupCause, depth + 1);
	return {
		name: typeof error.name === "string" ? error.name : "Error",
		...(typed
			? { code: error.code, hint: error.hint, fields: error.fields, retryable: error.retryable === true }
			: {}),
		...(reason ? { reason: error.reason } : {}),
		message: typeof error.message === "string" ? error.message : String(value),
		...(cause ? { cause } : {}),
		...(cleanupCause ? { cleanupCause } : {}),
	};
}

/**
 * A JSON form of `error` and up to seven of its causes, as deep as {@link findWorkspaceError} searches, for crossing
 * worker and IPC boundaries.
 */
export function serializeWorkspaceError(error: Error): SerializedWorkspaceError {
	return serialize(error, 0) as SerializedWorkspaceError;
}

type Rehydrator = (value: SerializedWorkspaceError, fields: WorkspaceErrorFields, cause?: Error) => Error;
const REHYDRATORS: Partial<Record<WorkspaceErrorName | "GitUnavailableError", Rehydrator>> = {
	WorkspaceConfigError: (value, fields) =>
		value.reason === undefined
			? new WorkspaceConfigError(
					fields.source as WorkspaceConfigSource,
					String(fields.field),
					String(fields.expected),
				)
			: new WorkspaceConfigError({
					source: fields.source as WorkspaceConfigSource,
					field: String(fields.field),
					reason: value.reason as WorkspaceConfigErrorReason,
					expected: String(fields.expected),
					received: String(fields.received),
				}),
	GitUnavailableError: (value, fields, cause) =>
		new GitUnavailableError(
			compactFields({ ...fields, code: value.code }) as unknown as GitUnavailableFields,
			cause ? { cause } : undefined,
		),
	WorkspaceGitError: (_value, fields, cause) =>
		new WorkspaceGitError(
			fields as { operation: string; cwd: string; exitCode: number | null; detail: string },
			cause,
		),
	WorkspaceSnapshotError: (value, fields, cause) =>
		new WorkspaceSnapshotError(value.code as WorkspaceSnapshotErrorCode, String(fields.subject), cause),
	WorkspaceRestoreError: (value, fields, cause) =>
		value.code === "restore-failed"
			? new WorkspaceRestoreError({ reason: value.reason as WorkspaceRestoreErrorReason, fields, cause })
			: new WorkspaceRestoreError(
					value.code as Exclude<WorkspaceRestoreErrorCode, "restore-failed">,
					fields as unknown as WorkspaceRestoreErrorFields,
					cause,
				),
	WorkspaceDriftError: (_value, fields, cause) =>
		new WorkspaceDriftError(fields as unknown as WorkspaceDriftErrorFields, cause),
	WorkspaceCollectionError: (_value, fields, cause) =>
		new WorkspaceCollectionError(fields as unknown as WorkspaceCollectionErrorFields, cause),
	WorkspaceBindingError: (value, fields, cause) =>
		new WorkspaceBindingError({
			code: value.code as WorkspaceBindingErrorCode,
			reason: value.reason as WorkspaceBindingErrorReason | undefined,
			fields,
			cause,
		}),
	WorkspacePublicationError: (value, fields, cause) =>
		new WorkspacePublicationError({ reason: value.reason as WorkspacePublicationErrorReason, fields, cause }),
	WorkspaceTimeoutError: (_value, fields, cause) =>
		new WorkspaceTimeoutError({
			phase: fields.phase as WorkspaceGitPhase,
			timeoutMs: Number(fields.timeoutMs),
			elapsedMs: Number(fields.elapsedMs),
			command: String(fields.command),
			holderPid: fields.holderPid as number | null | undefined,
			cause,
		}),
	WorkspaceSandboxError: (_value, fields) =>
		new WorkspaceSandboxError({ tool: String(fields.tool), worktree: String(fields.worktree) }),
};

function rebuild(value: SerializedWorkspaceError, cause: Error | undefined): Error {
	const rehydrate = Object.hasOwn(REHYDRATORS, value.name)
		? REHYDRATORS[value.name as WorkspaceErrorName | "GitUnavailableError"]
		: undefined;
	const known =
		value.name === "GitUnavailableError"
			? isGitUnavailableError(value)
			: Object.hasOwn(CODES, value.name) &&
				CODES[value.name as WorkspaceErrorName].includes(value.code as WorkspaceErrorCode);
	if (rehydrate && value.fields && known) return rehydrate(value, value.fields, cause);
	if (value.code !== undefined) {
		const error = new WorkspaceError({
			code: value.code as WorkspaceErrorCode,
			summary: value.message,
			hint: value.hint ?? "",
			fields: value.fields ?? {},
			retryable: value.retryable === true,
			reason: value.reason,
			cause,
		});
		Object.defineProperty(error, "name", {
			value: value.name,
			enumerable: false,
			writable: true,
			configurable: true,
		});
		// The wire form has no summary, and a class this version does not know may shape its message differently.
		delete (error as { summary?: string }).summary;
		return error;
	}
	const error = new Error(value.message, cause ? { cause } : undefined);
	error.name = value.name;
	return error;
}

/**
 * Rebuilds an error from {@link serializeWorkspaceError}. Known names become their class with every field intact;
 * other workspace errors become a {@link WorkspaceError} keeping their name and code; anything else a plain Error.
 * The sender's message wins, so a sender on another version renders the same text.
 */
export function rehydrateWorkspaceError(value: SerializedWorkspaceError): Error {
	const cause = value.cause ? rehydrateWorkspaceError(value.cause) : undefined;
	const error = rebuild(value, cause);
	Object.defineProperty(error, "message", { value: value.message, writable: true, configurable: true });
	return attachCleanupCause(
		error,
		value.cleanupCause ? rehydrateWorkspaceError(value.cleanupCause) : undefined,
	) as Error;
}
