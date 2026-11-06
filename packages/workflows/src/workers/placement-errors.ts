/**
 * Errors of shared worker placement (#4310): roots whose pooled children run on worker hosts that open the same shared
 * journal. One family, {@link WorkerPlacementError}; each concrete error has a stable `code`, JSON-safe fields and a
 * `hint`, and crosses process boundaries through {@link serializeWorkerPlacementError} and
 * {@link rehydrateWorkerPlacementError}.
 */

import { SHARED_STORAGE_JOIN_HINT } from "@bastani/atomic/storage";
import type { WorkspaceBinding } from "./workspace-binding.js";

/** Where a configuration value came from. */
export type WorkerPlacementConfigSource = "sdk" | "settings" | "env";

export type WorkerPlacementConfigErrorCode =
	| "invalid-option"
	| "requires-local-workers"
	| "unsupported-option"
	| "changed-on-resume";
export type SharedPoolSetupErrorCode =
	| "shared-journal-required"
	| "storage-adapter-unavailable"
	| "journal-secret-unavailable"
	| "git-unavailable"
	| "process-containment-unavailable"
	| "pool-on-another-host";
/** The operation a shared pool's setup was checked for. */
export type SharedPoolOperation = "shared-placement" | "worker-host" | "resume" | "local-pool";
export type WorkspaceRestoreUnavailableReason = "no-restore-port" | "no-capable-host";
export type StaleStageLeaseReason = "attempt-replaced" | "stage-lease-replaced";

export type WorkerPlacementErrorCode =
	| WorkerPlacementConfigErrorCode
	| SharedPoolSetupErrorCode
	| "workspace-restore-unavailable"
	| "stale-stage-lease";

type JsonField = string | number | boolean | null | readonly JsonField[] | { readonly [key: string]: JsonField };

/** A placement error as it crosses a worker, coordinator or root process boundary. */
export interface SerializedWorkerPlacementError {
	readonly name: string;
	readonly code: string;
	readonly message: string;
	readonly hint?: string;
	readonly retryable: boolean;
	readonly fields: Readonly<Record<string, JsonField>>;
	readonly cause?: SerializedWorkerPlacementError | { readonly name: string; readonly message: string };
}

const MAX_CAUSE_DEPTH = 8;

/** The base of every shared worker placement error. Catch it to handle the whole family. */
export class WorkerPlacementError extends Error {
	override readonly name: string = "WorkerPlacementError";
	readonly code: string;
	readonly hint: string | undefined;
	readonly retryable: boolean;
	constructor(
		code: string,
		message: string,
		options: { readonly hint?: string; readonly retryable?: boolean; readonly cause?: unknown } = {},
	) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.code = code;
		this.hint = options.hint;
		this.retryable = options.retryable ?? false;
	}
	/** The error's own JSON-safe fields, beyond name, code, message, hint and retryable. */
	fields(): Readonly<Record<string, JsonField>> {
		return {};
	}
}

/** A redacted remote URL: credentials in its user info are never kept. */
function redactRemote(remote: string): string {
	try {
		const url = new URL(remote);
		if (url.username === "" && url.password === "") return remote;
		url.username = "";
		url.password = "";
		return url.toString();
	} catch {
		// Not a URL (an scp-like `git@host:path` remote): its user part names an account, never a secret.
		return remote;
	}
}

/** A binding's identity as an error carries it: the matched fields, with remote URLs stripped of credentials. */
export interface WorkspaceBindingIdentity {
	readonly remotes: readonly string[];
	readonly head: string;
	readonly tree: string;
	readonly envHash: string;
}

export function workspaceBindingIdentity(binding: WorkspaceBinding): WorkspaceBindingIdentity {
	return {
		remotes: binding.remotes.map(redactRemote),
		head: binding.head,
		tree: binding.tree,
		envHash: binding.envHash,
	};
}

const CONFIG_HINTS: Readonly<Record<WorkerPlacementConfigErrorCode, string>> = {
	"invalid-option": "Fix the value and run again.",
	"requires-local-workers":
		"Set localWorkers with the worker definitions the root pools, or remove workers.placement.",
	"unsupported-option": "Remove the option, or run the root without shared placement.",
	"changed-on-resume": "Resume the root with the workers settings it started with, or start a new run.",
};

/** A shared placement or worker host option that is invalid, checked before anything starts. */
export class WorkerPlacementConfigError extends WorkerPlacementError {
	override readonly name = "WorkerPlacementConfigError" as const;
	declare readonly code: WorkerPlacementConfigErrorCode;
	readonly source: WorkerPlacementConfigSource;
	readonly field: string;
	readonly detail: string | undefined;
	constructor(
		source: WorkerPlacementConfigSource,
		field: string,
		code: WorkerPlacementConfigErrorCode,
		detail?: string,
		options: { readonly cause?: unknown } = {},
	) {
		const hint = CONFIG_HINTS[code];
		super(
			code,
			`Invalid worker placement configuration: ${field} from ${source} (${code})${detail === undefined ? "" : `: ${detail}`}. ${hint}`,
			{ hint, ...options },
		);
		this.source = source;
		this.field = field;
		this.detail = detail;
	}
	override fields(): Readonly<Record<string, JsonField>> {
		return { source: this.source, field: this.field, ...(this.detail === undefined ? {} : { detail: this.detail }) };
	}
}

/** One missing piece of a shared pool's setup: what it is, its facts, and the command that supplies it. */
export interface SharedPoolSetupProblem {
	readonly code: SharedPoolSetupErrorCode;
	/** What is missing, named without any secret value. */
	readonly subject: string;
	readonly hint: string;
	readonly fields: Readonly<Record<string, JsonField>>;
}

const OPERATIONS: Readonly<Record<SharedPoolOperation, string>> = {
	"shared-placement": 'a root with workers: { placement: "shared" }',
	"worker-host": "startWorkflowWorkerHost",
	resume: "resuming this root here",
	"local-pool": "a root with localWorkers",
};

/**
 * Where a storage selection points, as an error may name it: a SQLite file's path or an adapter's module, never its
 * options or secrets.
 */
export function selectionLocation(selection: {
	readonly kind: string;
	readonly path?: string;
	readonly module?: string;
}): string | undefined {
	if (selection.kind === "sqlite") return selection.path;
	if (selection.kind === "adapter") return selection.module;
	return undefined;
}

/** The command that installs git on this platform. */
export function gitInstallCommand(platform: NodeJS.Platform = process.platform): string {
	if (platform === "darwin") return "xcode-select --install";
	if (platform === "win32") return "winget install --id Git.Git -e";
	return "sudo apt-get install -y git";
}

/** The shared pool problems a setup check finds, one per missing piece. */
export const sharedPoolProblems = {
	sharedJournalRequired(selection: string, location: string | undefined): SharedPoolSetupProblem {
		return {
			code: "shared-journal-required",
			subject: `a shared journal (this node's journal is ${selection}${location === undefined ? "" : ` at ${location}`}, which other hosts cannot open)`,
			hint: `Join this node to the shared storage with \`${SHARED_STORAGE_JOIN_HINT}\`, or select the journal through a storage adapter every host opens, such as { adapter: "@bastani/atomic-storage-libsql", options: { url } }.`,
			fields: { selection, ...(location === undefined ? {} : { location }) },
		};
	},
	adapterUnavailable(module: string): SharedPoolSetupProblem {
		return {
			code: "storage-adapter-unavailable",
			subject: `the storage adapter ${module}, which cannot be loaded`,
			hint: "Install it with `atomic install npm:@bastani/atomic-storage-libsql`, or fix the adapter path.",
			fields: { module },
		};
	},
	secretUnavailable(
		secret: string,
		source: { readonly env: string } | { readonly file: string },
	): SharedPoolSetupProblem {
		return {
			code: "journal-secret-unavailable",
			subject:
				"env" in source
					? `the journal secret ${secret} from environment variable ${source.env}, which is not set`
					: `the journal secret ${secret} from file ${source.file}, which cannot be read`,
			hint:
				"env" in source
					? `Set ${source.env} in this host's environment, for example \`export ${source.env}=...\`.`
					: `Create ${source.file} with the secret, readable by this user.`,
			fields: { secret, ...source },
		};
	},
	gitUnavailable(path: string, platform: NodeJS.Platform = process.platform): SharedPoolSetupProblem {
		return {
			code: "git-unavailable",
			subject: `git at ${path}, which a restore port needs and which does not run`,
			hint: `Install git with \`${gitInstallCommand(platform)}\`, pass its path as git: { path }, or start the host without restore.`,
			fields: { path, platform },
		};
	},
	localContainmentUnavailable(platform: NodeJS.Platform = process.platform): SharedPoolSetupProblem {
		return platform === "win32"
			? {
					code: "process-containment-unavailable",
					subject: "Local worker containment is unavailable on Windows; pooled tool processes cannot be enabled",
					hint: "Run roots with localWorkers on Linux or macOS, or run this one without localWorkers.",
					fields: { platform },
				}
			: {
					code: "process-containment-unavailable",
					subject: "Local worker containment requires native process identity support",
					hint: "Reinstall Atomic so its native module for this platform loads, for example `npm install -g @bastani/atomic`.",
					fields: { platform },
				};
	},
	gitNotProvided(
		failure: { readonly code: string; readonly hint: string },
		platform: NodeJS.Platform = process.platform,
	): SharedPoolSetupProblem {
		return {
			code: "git-unavailable",
			subject: `git, which a restore port needs and which Atomic could not provide (${failure.code})`,
			hint: failure.hint,
			fields: { reason: failure.code, platform },
		};
	},
	processContainmentUnavailable(platform: NodeJS.Platform = process.platform): SharedPoolSetupProblem {
		return {
			code: "process-containment-unavailable",
			subject: `process containment for pooled workers (this host runs ${platform}${platform === "win32" ? "" : " without Atomic's native process identity"}), which their tool processes need`,
			hint:
				platform === "win32"
					? "Run worker hosts on Linux or macOS."
					: "Reinstall Atomic so its native module for this platform loads, for example `npm install -g @bastani/atomic`.",
			fields: { platform },
		};
	},
	poolOnAnotherHost(recordedHost: string, thisHost: string, root: string): SharedPoolSetupProblem {
		return {
			code: "pool-on-another-host",
			subject: `the pool database of host ${recordedHost}, where this root's work queue and leases are (this host is ${thisHost})`,
			hint: `Run \`/workflow resume ${root}\` on host ${recordedHost}; its workers may still be running children. Roots started with workers: { placement: "shared" } on a shared journal resume on any host.`,
			fields: { recordedHost, thisHost, root },
		};
	},
} as const;

/**
 * A shared pool's setup is incomplete: a shared journal, its storage adapter or secrets, git for a restore port or
 * process containment for a worker host's workers is missing, or the root's pool lives on another host. Checked once, before anything is opened or started; every missing
 * piece is in `problems`, and `code` is the first one's.
 */
export class SharedPoolSetupError extends WorkerPlacementError {
	override readonly name = "SharedPoolSetupError" as const;
	declare readonly code: SharedPoolSetupErrorCode;
	readonly operation: SharedPoolOperation;
	readonly problems: readonly SharedPoolSetupProblem[];
	constructor(
		operation: SharedPoolOperation,
		problems: readonly [SharedPoolSetupProblem, ...SharedPoolSetupProblem[]],
		options: { readonly cause?: unknown } = {},
	) {
		const hint = problems.map((problem) => problem.hint).join(" ");
		const missing = problems.map((problem) => `${problem.subject} (${problem.code})`).join("; ");
		super(
			problems[0].code,
			operation === "local-pool"
				? `Local workers cannot start for ${OPERATIONS[operation]}: ${missing}. ${hint}`
				: `Shared worker pool setup incomplete for ${OPERATIONS[operation]}: missing ${missing}. ${hint}`,
			{ hint, retryable: false, cause: options.cause },
		);
		this.operation = operation;
		this.problems = problems;
	}
	override fields(): Readonly<Record<string, JsonField>> {
		return {
			operation: this.operation,
			problems: this.problems.map((problem) => ({ ...problem, fields: { ...problem.fields } })),
		};
	}
}

/**
 * Bound work that no host can run in its recorded workspace: the host has no restore port (`no-restore-port`), or no
 * capable live host claimed the work within the root's claim window (`no-capable-host`). Bound work never runs in the
 * recorded working directory of another host.
 */
export class WorkspaceRestoreUnavailableError extends WorkerPlacementError {
	override readonly name = "WorkspaceRestoreUnavailableError" as const;
	declare readonly code: "workspace-restore-unavailable";
	readonly reason: WorkspaceRestoreUnavailableReason;
	readonly binding: WorkspaceBindingIdentity;
	readonly childRunId: string | undefined;
	readonly claimWindowMs: number | undefined;
	constructor(
		reason: WorkspaceRestoreUnavailableReason,
		binding: WorkspaceBindingIdentity,
		context: { readonly childRunId?: string; readonly claimWindowMs?: number; readonly cause?: unknown } = {},
	) {
		const hint =
			reason === "no-restore-port"
				? "Configure restore on startWorkflowWorkerHost, or run the work on a host that already has this tree."
				: "Start a worker host that has this tree or can restore it (a restore port and git), then resume the root.";
		const subject = `tree ${binding.tree} at ${binding.head}${binding.remotes.length === 0 ? "" : ` of ${binding.remotes.join(", ")}`}`;
		const where =
			reason === "no-restore-port"
				? "this host has no restore port"
				: `no capable live host claimed ${context.childRunId === undefined ? "the work" : `child ${context.childRunId}`} within ${context.claimWindowMs} ms`;
		super(
			"workspace-restore-unavailable",
			`Workspace restore unavailable: ${subject} (workspace-restore-unavailable): ${where}. ${hint}`,
			{ hint, retryable: false, cause: context.cause },
		);
		this.reason = reason;
		this.binding = binding;
		this.childRunId = context.childRunId;
		this.claimWindowMs = context.claimWindowMs;
	}
	override fields(): Readonly<Record<string, JsonField>> {
		return {
			reason: this.reason,
			binding: { ...this.binding, remotes: [...this.binding.remotes] },
			...(this.childRunId === undefined ? {} : { childRunId: this.childRunId }),
			...(this.claimWindowMs === undefined ? {} : { claimWindowMs: this.claimWindowMs }),
		};
	}
}

/**
 * A stage input acknowledged or renewed by a worker that no longer holds the stage: its attempt was replaced
 * (`attempt-replaced`), or another holder took the stage's lease (`stage-lease-replaced`). Nothing was written.
 */
export class StaleStageLeaseError extends WorkerPlacementError {
	override readonly name = "StaleStageLeaseError" as const;
	declare readonly code: "stale-stage-lease";
	readonly reason: StaleStageLeaseReason;
	readonly root: string;
	readonly runId: string;
	readonly stageId: string;
	/** The input the refused holder had taken; null when it was refused before it took one. */
	readonly seq: number | null;
	constructor(
		reason: StaleStageLeaseReason,
		input: { readonly root: string; readonly runId: string; readonly stageId: string; readonly seq: number | null },
		options: { readonly cause?: unknown } = {},
	) {
		const hint = "This worker stops handling the stage; its current holder processes the stage's inputs.";
		super(
			"stale-stage-lease",
			`Stale stage lease: ${input.seq === null ? "" : `input ${input.seq} of `}stage ${input.stageId} in run ${input.runId} (stale-stage-lease): ${reason === "attempt-replaced" ? "the attempt was replaced" : "another holder took the stage"}. ${hint}`,
			{ hint, retryable: false, cause: options.cause },
		);
		this.reason = reason;
		this.root = input.root;
		this.runId = input.runId;
		this.stageId = input.stageId;
		this.seq = input.seq;
	}
	override fields(): Readonly<Record<string, JsonField>> {
		return { reason: this.reason, root: this.root, runId: this.runId, stageId: this.stageId, seq: this.seq };
	}
}

const CONCRETE_NAMES = new Set([
	"WorkerPlacementConfigError",
	"SharedPoolSetupError",
	"WorkspaceRestoreUnavailableError",
	"StaleStageLeaseError",
]);

function structural(value: unknown, name?: string): value is WorkerPlacementError {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as { readonly name?: unknown; readonly code?: unknown; readonly retryable?: unknown };
	if (typeof candidate.code !== "string" || typeof candidate.retryable !== "boolean") return false;
	if (name !== undefined) return candidate.name === name;
	return (
		candidate.name === "WorkerPlacementError" ||
		(typeof candidate.name === "string" && CONCRETE_NAMES.has(candidate.name))
	);
}

function inChain<T>(error: unknown, match: (value: unknown) => value is T): T | undefined {
	let current = error;
	for (let depth = 0; depth < MAX_CAUSE_DEPTH && current !== undefined && current !== null; depth++) {
		if (match(current)) return current;
		current = typeof current === "object" ? (current as { readonly cause?: unknown }).cause : undefined;
	}
	return undefined;
}

/** Whether `error`, or an error in its cause chain, is a {@link WorkerPlacementError}. */
export function isWorkerPlacementError(error: unknown): error is WorkerPlacementError {
	return (
		inChain(
			error,
			(value): value is WorkerPlacementError => value instanceof WorkerPlacementError || structural(value),
		) !== undefined
	);
}

/** Whether `error`, or an error in its cause chain, is a {@link WorkerPlacementConfigError}. */
export function isWorkerPlacementConfigError(error: unknown): error is WorkerPlacementConfigError {
	return (
		inChain(
			error,
			(value): value is WorkerPlacementConfigError =>
				value instanceof WorkerPlacementConfigError || structural(value, "WorkerPlacementConfigError"),
		) !== undefined
	);
}

/** Whether `error`, or an error in its cause chain, is a {@link SharedPoolSetupError}. */
export function isSharedPoolSetupError(error: unknown): error is SharedPoolSetupError {
	return (
		inChain(
			error,
			(value): value is SharedPoolSetupError =>
				value instanceof SharedPoolSetupError || structural(value, "SharedPoolSetupError"),
		) !== undefined
	);
}

/** Whether `error`, or an error in its cause chain, is a {@link WorkspaceRestoreUnavailableError}. */
export function isWorkspaceRestoreUnavailableError(error: unknown): error is WorkspaceRestoreUnavailableError {
	return (
		inChain(
			error,
			(value): value is WorkspaceRestoreUnavailableError =>
				value instanceof WorkspaceRestoreUnavailableError || structural(value, "WorkspaceRestoreUnavailableError"),
		) !== undefined
	);
}

/** Whether `error`, or an error in its cause chain, is a {@link StaleStageLeaseError}. */
export function isStaleStageLeaseError(error: unknown): error is StaleStageLeaseError {
	return (
		inChain(
			error,
			(value): value is StaleStageLeaseError =>
				value instanceof StaleStageLeaseError || structural(value, "StaleStageLeaseError"),
		) !== undefined
	);
}

function serializeCause(cause: unknown, depth: number): SerializedWorkerPlacementError["cause"] {
	if (cause === undefined || cause === null || depth >= MAX_CAUSE_DEPTH) return undefined;
	if (cause instanceof WorkerPlacementError) return serializeAt(cause, depth);
	if (cause instanceof Error) return { name: cause.name, message: cause.message };
	return { name: "Error", message: String(cause) };
}

function serializeAt(error: WorkerPlacementError, depth: number): SerializedWorkerPlacementError {
	const cause = serializeCause(error.cause, depth + 1);
	return {
		name: error.name,
		code: error.code,
		message: error.message,
		...(error.hint === undefined ? {} : { hint: error.hint }),
		retryable: error.retryable,
		fields: error.fields(),
		...(cause === undefined ? {} : { cause }),
	};
}

/** A placement error as JSON, for a process boundary; {@link rehydrateWorkerPlacementError} restores it. */
export function serializeWorkerPlacementError(error: WorkerPlacementError): SerializedWorkerPlacementError {
	return serializeAt(error, 0);
}

function rehydrateCause(cause: SerializedWorkerPlacementError["cause"]): unknown {
	if (cause === undefined) return undefined;
	if ("code" in cause) return rehydrateWorkerPlacementError(cause);
	const error = new Error(cause.message);
	error.name = cause.name;
	return error;
}

/**
 * The error a {@link SerializedWorkerPlacementError} describes, as the same class. An error of an unknown name becomes a
 * {@link WorkerPlacementError} that keeps the original name and code.
 */
export function rehydrateWorkerPlacementError(serialized: SerializedWorkerPlacementError): WorkerPlacementError {
	const cause = rehydrateCause(serialized.cause);
	const fields = serialized.fields as Readonly<Record<string, JsonField | undefined>>;
	if (serialized.name === "WorkerPlacementConfigError")
		return new WorkerPlacementConfigError(
			fields.source as WorkerPlacementConfigSource,
			fields.field as string,
			serialized.code as WorkerPlacementConfigErrorCode,
			fields.detail as string | undefined,
			{ cause },
		);
	if (serialized.name === "SharedPoolSetupError")
		return new SharedPoolSetupError(
			fields.operation as SharedPoolOperation,
			fields.problems as unknown as [SharedPoolSetupProblem, ...SharedPoolSetupProblem[]],
			{ cause },
		);
	if (serialized.name === "WorkspaceRestoreUnavailableError")
		return new WorkspaceRestoreUnavailableError(
			fields.reason as WorkspaceRestoreUnavailableReason,
			fields.binding as unknown as WorkspaceBindingIdentity,
			{
				...(fields.childRunId === undefined ? {} : { childRunId: fields.childRunId as string }),
				...(fields.claimWindowMs === undefined ? {} : { claimWindowMs: fields.claimWindowMs as number }),
				cause,
			},
		);
	if (serialized.name === "StaleStageLeaseError")
		return new StaleStageLeaseError(
			fields.reason as StaleStageLeaseReason,
			{
				root: fields.root as string,
				runId: fields.runId as string,
				stageId: fields.stageId as string,
				seq: fields.seq as number | null,
			},
			{ cause },
		);
	const error = new WorkerPlacementError(serialized.code, serialized.message, {
		...(serialized.hint === undefined ? {} : { hint: serialized.hint }),
		retryable: serialized.retryable,
		cause,
	});
	Object.defineProperty(error, "name", { value: serialized.name, enumerable: false });
	return error;
}
