export type WorkspaceErrorFieldValue =
	| string
	| number
	| boolean
	| null
	| readonly WorkspaceErrorFieldValue[]
	| { readonly [key: string]: WorkspaceErrorFieldValue };
export type WorkspaceErrorFields = { readonly [key: string]: WorkspaceErrorFieldValue };

export type WorkspaceConfigErrorCode = "invalid-setting";
export type GitUnavailableErrorCode = "not-installed" | "unsupported-platform" | "offline" | "checksum-mismatch";
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
	| "invalid-snapshot";
export type WorkspaceDriftErrorCode = "tree-drift";
export type WorkspaceErrorCode =
	| WorkspaceConfigErrorCode
	| WorkspaceGitErrorCode
	| WorkspaceSnapshotErrorCode
	| WorkspaceRestoreErrorCode
	| WorkspaceDriftErrorCode;

export type WorkspaceErrorName =
	| "WorkspaceError"
	| "WorkspaceConfigError"
	| "WorkspaceGitError"
	| "WorkspaceSnapshotError"
	| "WorkspaceRestoreError"
	| "WorkspaceDriftError";

const MAX_CAUSE_DEPTH = 8;
const MAX_SERIALIZED_CAUSE_DEPTH = 4;

/**
 * Base of every worktree snapshot, restore and drift failure. Branch on `code` or the class, never on `message`.
 * `fields` holds the same JSON-safe facts as the typed properties, for logs and process boundaries.
 */
export class WorkspaceError extends Error {
	override readonly name: WorkspaceErrorName = "WorkspaceError";
	readonly code: WorkspaceErrorCode;
	/** What failed, without the code and the hint: the first part of `message`. */
	readonly summary: string;
	readonly hint: string;
	readonly retryable: boolean = false;
	readonly fields: WorkspaceErrorFields;
	declare readonly cleanupCause?: Error;

	constructor(code: WorkspaceErrorCode, summary: string, hint: string, fields: WorkspaceErrorFields, cause?: Error) {
		super(`${summary} (${code}). ${hint}`, cause === undefined ? undefined : { cause });
		this.code = code;
		this.summary = summary;
		this.hint = hint;
		this.fields = Object.freeze({ ...fields });
		Object.assign(this, fields);
	}
}

export type WorkspaceConfigSource = "sdk" | "cli" | "env" | "settings";

/** A snapshot setting or SDK option has the wrong type or range. Thrown before any Git command runs. */
export class WorkspaceConfigError extends WorkspaceError {
	override readonly name = "WorkspaceConfigError" as const;
	declare readonly code: WorkspaceConfigErrorCode;
	declare readonly source: WorkspaceConfigSource;
	declare readonly field: string;
	declare readonly expected: string;

	constructor(source: WorkspaceConfigSource, field: string, expected: string) {
		super(
			"invalid-setting",
			`Invalid worktree snapshot setting: ${field} from ${source}`,
			`Set ${field} to ${expected}.`,
			{ source, field, expected },
		);
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

const GIT_UNAVAILABLE_SUMMARIES: Record<GitUnavailableErrorCode, string> = {
	"not-installed": "could not be started",
	"unsupported-platform": "cannot be provisioned on this platform",
	offline: "could not be downloaded while offline",
	"checksum-mismatch": "failed its checksum after download",
};

/**
 * Git cannot be provided, so worktree snapshots cannot be read or restored. Capture degrades with this as its reason;
 * restore and verification throw it before any other work. Code-compatible with the class that Git provisioning
 * (#4322) exports, which replaces this definition.
 */
export class GitUnavailableError extends Error {
	override readonly name = "GitUnavailableError" as const;
	readonly code: GitUnavailableErrorCode;
	readonly platform: NodeJS.Platform;
	readonly executable: string;
	readonly hint: string;
	readonly retryable = false;
	readonly fields: WorkspaceErrorFields;

	constructor(code: GitUnavailableErrorCode, executable: string, options?: { cause?: Error }) {
		const alternative = process.platform === "linux" ? " (or your distribution's package manager)" : "";
		const hint = `Install Git with \`${gitInstallCommand()}\`${alternative} or put it on PATH, then retry.`;
		super(
			`Git is unavailable: ${executable} ${GIT_UNAVAILABLE_SUMMARIES[code]}, and worktree snapshots need it to read and rebuild repository state (${code}). ${hint}`,
			options?.cause === undefined ? undefined : { cause: options.cause },
		);
		this.code = code;
		this.platform = process.platform;
		this.executable = executable;
		this.hint = hint;
		this.fields = Object.freeze({ platform: this.platform, executable });
	}
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
		super(
			"git-failed",
			`Git ${fields.operation} failed in ${fields.cwd}${fields.detail ? `: ${fields.detail}` : ""}`,
			"Check that the repository is readable, its disk has free space, and no other Git process holds its lock, then retry.",
			fields,
			cause,
		);
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
		super(code, summary, hint, { subject }, cause);
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

/** Why a snapshot or binding record was refused before any Git or filesystem work. */
export type InvalidSnapshotReason = "unsafe-remote" | "invalid-object-id" | "invalid-snapshot-id" | "invalid-blob-hash";

const INVALID_SNAPSHOT_EXPECTATIONS: Record<InvalidSnapshotReason, string> = {
	"unsafe-remote": "a remote URL Atomic can safely fetch from",
	"invalid-object-id": "a Git object id",
	"invalid-snapshot-id": "a snapshot id",
	"invalid-blob-hash": "a SHA-256 blob hash",
};
function restoreMessage(
	code: WorkspaceRestoreErrorCode,
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

/** A restore failed before returning a verified worktree. Nothing is left at the target. */
export class WorkspaceRestoreError extends WorkspaceError implements WorkspaceRestoreErrorFields {
	override readonly name = "WorkspaceRestoreError" as const;
	declare readonly code: WorkspaceRestoreErrorCode;
	declare readonly snapshotId: string | null;
	declare readonly head?: string;
	declare readonly tree?: string;
	declare readonly blob?: string;
	declare readonly role?: "patch" | "bundle";
	declare readonly deltaIndex?: number;
	declare readonly expectedTree?: string;
	declare readonly actualTree?: string | null;
	declare readonly commits?: readonly string[];
	declare readonly paths?: readonly string[];
	declare readonly reason?: WorkspaceRestoreErrorFields["reason"];
	declare readonly remotes?: readonly string[];
	declare readonly target?: string;
	declare readonly detail?: string;
	declare readonly field?: string;

	constructor(code: WorkspaceRestoreErrorCode, fields: WorkspaceRestoreErrorFields, cause?: Error) {
		const [summary, hint] = restoreMessage(code, fields);
		super(code, summary, hint, compactFields(fields), cause);
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
		super(
			"tree-drift",
			`Worktree drifted from its recorded snapshot: ${fields.root} has tree ${fields.actualTree ?? "none"} at ${fields.actualHead ?? "no HEAD"}, expected ${fields.expectedTree} at ${fields.expectedHead}${
				failure ? `, and the automatic restore failed: ${failure.summary}` : ""
			}`,
			failure?.hint ?? "Restore the recorded snapshot into a new worktree, or undo the changes, then resume.",
			compactFields(failure ? { ...fields, restoreCode: failure.code } : fields),
			cause,
		);
	}
}

function compactFields(fields: object): WorkspaceErrorFields {
	return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as WorkspaceErrorFields;
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
	],
	WorkspaceDriftError: ["tree-drift"],
};
const ALL_CODES = new Set(Object.values(CODES).flat());

function structurallyIs(value: unknown, name: WorkspaceErrorName): boolean {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as { readonly name?: unknown; readonly code?: unknown };
	if (typeof candidate.code !== "string") return false;
	if (name === "WorkspaceError") {
		return (
			typeof candidate.name === "string" &&
			Object.hasOwn(CODES, candidate.name) &&
			ALL_CODES.has(candidate.code as WorkspaceErrorCode)
		);
	}
	return candidate.name === name && CODES[name].includes(candidate.code as WorkspaceErrorCode);
}

export function isWorkspaceError(value: unknown): value is WorkspaceError {
	return value instanceof WorkspaceError || structurallyIs(value, "WorkspaceError");
}
export function isWorkspaceConfigError(value: unknown): value is WorkspaceConfigError {
	return value instanceof WorkspaceConfigError || structurallyIs(value, "WorkspaceConfigError");
}
const GIT_UNAVAILABLE_CODES: ReadonlySet<string> = new Set<GitUnavailableErrorCode>(
	Object.keys(GIT_UNAVAILABLE_SUMMARIES) as GitUnavailableErrorCode[],
);

export function isGitUnavailableError(value: unknown): value is GitUnavailableError {
	if (value instanceof GitUnavailableError) return true;
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as { readonly name?: unknown; readonly code?: unknown };
	return (
		candidate.name === "GitUnavailableError" &&
		typeof candidate.code === "string" &&
		GIT_UNAVAILABLE_CODES.has(candidate.code)
	);
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

/** The first error in `error`'s cause chain that `guard` accepts, searching at most eight levels deep. */
export function findWorkspaceError<T extends WorkspaceError>(
	error: unknown,
	guard: (value: unknown) => value is T = isWorkspaceError as (value: unknown) => value is T,
): T | undefined {
	let current = error;
	for (let depth = 0; depth < MAX_CAUSE_DEPTH && current !== undefined && current !== null; depth++) {
		if (guard(current)) return current;
		current = typeof current === "object" ? (current as { readonly cause?: unknown }).cause : undefined;
	}
	return undefined;
}

export interface SerializedWorkspaceError {
	readonly name: string;
	readonly code?: string;
	readonly message: string;
	readonly hint?: string;
	readonly fields?: WorkspaceErrorFields;
	readonly cause?: SerializedWorkspaceError;
}

/** A JSON form of `error` and up to four levels of its causes, for crossing worker and IPC boundaries. */
export function serializeWorkspaceError(error: Error, depth = 0): SerializedWorkspaceError {
	const cause = depth + 1 < MAX_SERIALIZED_CAUSE_DEPTH && error.cause instanceof Error ? error.cause : undefined;
	const workspace = isWorkspaceError(error) || isGitUnavailableError(error) ? error : undefined;
	return {
		name: error.name,
		...(workspace ? { code: workspace.code, hint: workspace.hint, fields: workspace.fields } : {}),
		message: error.message,
		...(cause ? { cause: serializeWorkspaceError(cause, depth + 1) } : {}),
	};
}

type Rehydrator = (fields: WorkspaceErrorFields, code: string, cause?: Error) => Error;
const REHYDRATORS: Partial<Record<WorkspaceErrorName | "GitUnavailableError", Rehydrator>> = {
	WorkspaceConfigError: (fields) =>
		new WorkspaceConfigError(fields.source as WorkspaceConfigSource, String(fields.field), String(fields.expected)),
	GitUnavailableError: (fields, code, cause) =>
		new GitUnavailableError(
			code as GitUnavailableErrorCode,
			String(fields.executable),
			cause ? { cause } : undefined,
		),
	WorkspaceGitError: (fields, _code, cause) =>
		new WorkspaceGitError(
			fields as { operation: string; cwd: string; exitCode: number | null; detail: string },
			cause,
		),
	WorkspaceSnapshotError: (fields, code, cause) =>
		new WorkspaceSnapshotError(code as WorkspaceSnapshotErrorCode, String(fields.subject), cause),
	WorkspaceRestoreError: (fields, code, cause) =>
		new WorkspaceRestoreError(
			code as WorkspaceRestoreErrorCode,
			fields as unknown as WorkspaceRestoreErrorFields,
			cause,
		),
	WorkspaceDriftError: (fields, _code, cause) =>
		new WorkspaceDriftError(fields as unknown as WorkspaceDriftErrorFields, cause),
};

/**
 * Rebuilds an error from {@link serializeWorkspaceError}. Known names become their class with every field intact;
 * other workspace errors become a {@link WorkspaceError} keeping their name and code; anything else a plain Error.
 */
export function rehydrateWorkspaceError(value: SerializedWorkspaceError): Error {
	const cause = value.cause ? rehydrateWorkspaceError(value.cause) : undefined;
	const rehydrate = REHYDRATORS[value.name as WorkspaceErrorName | "GitUnavailableError"];
	const known =
		value.name === "GitUnavailableError"
			? isGitUnavailableError(value)
			: Object.hasOwn(CODES, value.name) &&
				CODES[value.name as WorkspaceErrorName].includes(value.code as WorkspaceErrorCode);
	if (rehydrate && value.fields && known) return rehydrate(value.fields, value.code as string, cause);
	if (value.code !== undefined) {
		const error = Object.create(WorkspaceError.prototype) as WorkspaceError;
		Object.defineProperties(error, {
			name: { value: value.name, enumerable: false },
			message: { value: value.message, enumerable: false },
			code: { value: value.code, enumerable: true },
			hint: { value: value.hint ?? "", enumerable: true },
			retryable: { value: false, enumerable: true },
			fields: { value: Object.freeze({ ...(value.fields ?? {}) }), enumerable: true },
			...(cause ? { cause: { value: cause, enumerable: false } } : {}),
		});
		return error;
	}
	const error = new Error(value.message, cause ? { cause } : undefined);
	error.name = value.name;
	return error;
}
