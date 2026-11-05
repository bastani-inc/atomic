export type WorkspaceErrorFieldValue =
	| string
	| number
	| boolean
	| null
	| readonly WorkspaceErrorFieldValue[]
	| { readonly [key: string]: WorkspaceErrorFieldValue };
export type WorkspaceErrorFields = { readonly [key: string]: WorkspaceErrorFieldValue };

export type WorkspaceConfigErrorCode = "invalid-setting";
export type GitUnavailableErrorCode = "git-unavailable";
export type WorkspaceGitErrorCode = "git-failed";
export type WorkspaceSnapshotErrorCode = "not-a-repository" | "unborn-head" | "blob-store-unsupported";
export type WorkspaceRestoreErrorCode =
	| "snapshot-not-found"
	| "blob-missing"
	| "blob-corrupt"
	| "commits-unavailable"
	| "delta-failed"
	| "tree-mismatch"
	| "unsafe-target";
export type WorkspaceDriftErrorCode = "tree-drift";
export type WorkspaceErrorCode =
	| WorkspaceConfigErrorCode
	| GitUnavailableErrorCode
	| WorkspaceGitErrorCode
	| WorkspaceSnapshotErrorCode
	| WorkspaceRestoreErrorCode
	| WorkspaceDriftErrorCode;

export type WorkspaceErrorName =
	| "WorkspaceError"
	| "WorkspaceConfigError"
	| "GitUnavailableError"
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
	readonly hint: string;
	readonly retryable: boolean = false;
	readonly fields: WorkspaceErrorFields;
	declare readonly cleanupCause?: Error;

	constructor(code: WorkspaceErrorCode, summary: string, hint: string, fields: WorkspaceErrorFields, cause?: Error) {
		super(`${summary} (${code}). ${hint}`, cause === undefined ? undefined : { cause });
		this.code = code;
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
	linux: "sudo apt-get install git (or your distribution's package manager)",
};

/** The command that installs Git on `platform`. */
export function gitInstallCommand(platform: NodeJS.Platform = process.platform): string {
	return GIT_INSTALL_COMMANDS[platform] ?? "install Git from https://git-scm.com/downloads";
}

/**
 * Git could not be started, so worktree snapshots cannot be read or restored. Capture degrades with this as its
 * reason; restore and verification throw it before any other work.
 */
export class GitUnavailableError extends WorkspaceError {
	override readonly name = "GitUnavailableError" as const;
	declare readonly code: GitUnavailableErrorCode;
	declare readonly executable: string;
	declare readonly installCommand: string;

	constructor(executable: string, cause?: Error) {
		const installCommand = gitInstallCommand();
		super(
			"git-unavailable",
			`Git is unavailable: ${executable} could not be started, and worktree snapshots need it to read and rebuild repository state`,
			`Install Git with \`${installCommand}\` or put it on PATH, then retry.`,
			{ executable, installCommand },
			cause,
		);
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
			"Check that the repository is readable and not locked by another Git process, then retry.",
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
		"Use local SQLite, JSONL, memory, or a database-backed storage adapter to record snapshots.",
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
	readonly reason?: "denied-history" | "bundle-over-cap" | "not-fetched" | "not-empty";
	readonly remotes?: readonly string[];
	readonly target?: string;
	readonly detail?: string;
}

function restoreMessage(
	code: WorkspaceRestoreErrorCode,
	fields: WorkspaceRestoreErrorFields,
): readonly [string, string] {
	const snapshot = fields.snapshotId ?? "binding";
	switch (code) {
		case "snapshot-not-found":
			return [
				`Cannot restore workspace: no retained snapshot or warm object store has tree ${fields.tree}`,
				"Pass the recorded snapshot, or restore on a host that already materialized this tree.",
			];
		case "blob-missing":
			return [
				`Cannot restore snapshot ${snapshot}: ${fields.role} blob ${fields.blob} is missing from storage`,
				"Use the storage the snapshot was recorded in, or import a session file exported with `atomic --export <session> <file>`, which carries its blobs.",
			];
		case "blob-corrupt":
			return [
				`Cannot restore snapshot ${snapshot}: ${fields.role} blob ${fields.blob} does not match its hash`,
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
			return [
				`Cannot restore snapshot ${snapshot}: commit ${fields.head} is not on ${remotes} and its unpushed history ${
					fields.reason === "denied-history"
						? `touches denied paths ${fields.paths?.join(", ")}`
						: "exceeded the snapshot size cap"
				}`,
				`Push commits ${fields.commits?.join(", ")} to a recorded remote, then retry.`,
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
			return [
				`Cannot restore into ${fields.target}: it is not an empty directory`,
				"Choose a new or empty directory, or omit `into` to restore under Atomic home.",
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

	constructor(code: WorkspaceRestoreErrorCode, fields: WorkspaceRestoreErrorFields, cause?: Error) {
		const [summary, hint] = restoreMessage(code, fields);
		super(code, summary, hint, compactFields(fields), cause);
	}
}

export interface WorkspaceDriftErrorFields {
	readonly root: string;
	readonly expectedHead: string;
	readonly actualHead: string | null;
	readonly expectedTree: string;
	readonly actualTree: string | null;
	readonly snapshotId: string | null;
}

/** A worktree no longer matches the snapshot work would resume from. Nothing ran against it. */
export class WorkspaceDriftError extends WorkspaceError implements WorkspaceDriftErrorFields {
	override readonly name = "WorkspaceDriftError" as const;
	declare readonly code: WorkspaceDriftErrorCode;
	declare readonly root: string;
	declare readonly expectedHead: string;
	declare readonly actualHead: string | null;
	declare readonly expectedTree: string;
	declare readonly actualTree: string | null;
	declare readonly snapshotId: string | null;

	constructor(fields: WorkspaceDriftErrorFields, cause?: Error) {
		super(
			"tree-drift",
			`Worktree drifted from its recorded snapshot: ${fields.root} has tree ${fields.actualTree ?? "none"} at ${fields.actualHead ?? "no HEAD"}, expected ${fields.expectedTree} at ${fields.expectedHead}`,
			"Restore the recorded snapshot into a new worktree, or undo the changes, then resume.",
			compactFields(fields),
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
	GitUnavailableError: ["git-unavailable"],
	WorkspaceGitError: ["git-failed"],
	WorkspaceSnapshotError: ["not-a-repository", "unborn-head", "blob-store-unsupported"],
	WorkspaceRestoreError: [
		"snapshot-not-found",
		"blob-missing",
		"blob-corrupt",
		"commits-unavailable",
		"delta-failed",
		"tree-mismatch",
		"unsafe-target",
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
			candidate.name in CODES &&
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
export function isGitUnavailableError(value: unknown): value is GitUnavailableError {
	return value instanceof GitUnavailableError || structurallyIs(value, "GitUnavailableError");
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
	const workspace = isWorkspaceError(error) ? error : undefined;
	return {
		name: error.name,
		...(workspace ? { code: workspace.code, hint: workspace.hint, fields: workspace.fields } : {}),
		message: error.message,
		...(cause ? { cause: serializeWorkspaceError(cause, depth + 1) } : {}),
	};
}

type Rehydrator = (fields: WorkspaceErrorFields, code: string, cause?: Error) => WorkspaceError;
const REHYDRATORS: Partial<Record<WorkspaceErrorName, Rehydrator>> = {
	WorkspaceConfigError: (fields) =>
		new WorkspaceConfigError(fields.source as WorkspaceConfigSource, String(fields.field), String(fields.expected)),
	GitUnavailableError: (fields, _code, cause) => new GitUnavailableError(String(fields.executable), cause),
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
	const rehydrate = REHYDRATORS[value.name as WorkspaceErrorName];
	if (
		rehydrate &&
		value.fields &&
		CODES[value.name as WorkspaceErrorName].includes(value.code as WorkspaceErrorCode)
	) {
		return rehydrate(value.fields, value.code as string, cause);
	}
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
