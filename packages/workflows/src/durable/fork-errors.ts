/**
 * Typed failures of run forking (`forkRun`, `listForkPoints`) and of stage forks at an exact
 * entry (`forkFromEntryId`). Every concrete error has a stable `code`, readonly JSON-safe
 * fields, a `hint`, and an explicit `retryable` flag. Errors that cross a worker boundary
 * serialize with `toJSON()` and come back as the same class through `rehydrateForkError`.
 */

export type ForkErrorCode =
	| "target-not-found"
	| "definition-mismatch"
	| "source-busy"
	| "entry-not-found"
	| "session-not-found"
	| "invalid-option"
	| "source-not-found"
	| "source-not-owned"
	| "journal-unsupported"
	| "journal-unavailable"
	| "copy-failed"
	| "claim-release-failed"
	| "session-unavailable"
	| "cleanup-failed"
	| "session-claim-refused";

export type ForkErrorName =
	| "ForkTargetNotFoundError"
	| "ForkDefinitionMismatchError"
	| "ForkSourceBusyError"
	| "ForkEntryNotFoundError"
	| "ForkSessionNotFoundError"
	| "ForkConfigError"
	| "ForkSourceNotFoundError"
	| "ForkSourceOwnershipError"
	| "ForkJournalUnsupportedError"
	| "ForkJournalUnavailableError"
	| "ForkCopyFailedError"
	| "ForkClaimReleaseError"
	| "ForkSessionUnavailableError"
	| "ForkCleanupError"
	| "ForkSessionClaimError";

export type ForkErrorFieldValue =
	| string
	| number
	| boolean
	| null
	| readonly ForkErrorFieldValue[]
	| { readonly [key: string]: ForkErrorFieldValue };
export type ForkErrorFields = Readonly<Record<string, ForkErrorFieldValue>>;

/** The wire form of a fork error: what a worker or coordinator sends, and what `rehydrateForkError` reads. */
export interface SerializedForkError {
	readonly name: string;
	readonly code: string;
	readonly message: string;
	readonly hint?: string;
	readonly retryable: boolean;
	readonly fields: ForkErrorFields;
	readonly cause?: SerializedErrorCause;
	/** The cleanup failures attached after this error; several are an `AggregateError` with `errors`. */
	readonly cleanupCause?: SerializedErrorCause;
}

/**
 * A cause in the wire form. Fork causes keep their fields; other causes keep only their name, message and
 * code, and an `AggregateError` also keeps its `errors`.
 */
export interface SerializedErrorCause {
	readonly name: string;
	readonly message: string;
	readonly code?: string;
	readonly fork?: SerializedForkError;
	readonly errors?: readonly SerializedErrorCause[];
	readonly cause?: SerializedErrorCause;
}

/** Whether the storage a fork read is local to this node or shared with other nodes. */
export type ForkStorageScope = "local-only" | "shared";

/** The storage a fork read: its adapter and whether it is local to this node. */
export interface ForkStorage {
	readonly adapter: string;
	readonly scope: ForkStorageScope;
}

/** The command that joins this node to a team's shared storage. */
export const FORK_JOIN_SHARED_STORAGE_COMMAND = "atomic team join <url> --token-file <path>";

/** How deep guards walk `cause` chains, and how many causes a serialized error keeps. */
export const FORK_ERROR_MAX_CAUSE_DEPTH = 8;

/** At most this many stage paths are listed in a fork error. */
export const FORK_ERROR_MAX_LISTED_PATHS = 10;

const FORK_ERROR_CODE_BY_NAME: Readonly<Record<ForkErrorName, ForkErrorCode>> = {
	ForkTargetNotFoundError: "target-not-found",
	ForkDefinitionMismatchError: "definition-mismatch",
	ForkSourceBusyError: "source-busy",
	ForkEntryNotFoundError: "entry-not-found",
	ForkSessionNotFoundError: "session-not-found",
	ForkConfigError: "invalid-option",
	ForkSourceNotFoundError: "source-not-found",
	ForkSourceOwnershipError: "source-not-owned",
	ForkJournalUnsupportedError: "journal-unsupported",
	ForkJournalUnavailableError: "journal-unavailable",
	ForkCopyFailedError: "copy-failed",
	ForkClaimReleaseError: "claim-release-failed",
	ForkSessionUnavailableError: "session-unavailable",
	ForkCleanupError: "cleanup-failed",
	ForkSessionClaimError: "session-claim-refused",
};

interface ForkErrorInit {
	readonly name: string;
	readonly code: string;
	/** What failed, before the subject: `<what failed>: <subject> (<code>). <hint>`. */
	readonly what: string;
	readonly subject: string;
	readonly hint: string;
	readonly retryable: boolean;
	readonly fields: Readonly<Record<string, ForkErrorFieldValue | undefined>>;
	readonly cause?: Error;
}

/** The fields without their undefined entries, so the wire form names only facts that exist. */
function defined(fields: Readonly<Record<string, ForkErrorFieldValue | undefined>>): ForkErrorFields {
	return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as ForkErrorFields;
}

/**
 * Base of every fork failure. Catch it to handle any fork failure; branch on `code` or the
 * concrete class, never on `message`. A rehydrated error whose name this version does not
 * know is a `ForkError` that keeps the original `name` and `code`.
 */
export class ForkError extends Error {
	override readonly name: string;
	readonly code: string;
	readonly hint: string;
	readonly retryable: boolean;
	readonly fields: ForkErrorFields;
	/**
	 * The cleanup failures that happened after this error; never replace it. One failure is itself, several
	 * are an `AggregateError` whose `errors` are in the order they happened.
	 */
	declare readonly cleanupCause?: Error;
	readonly #cleanupFailures: Error[] = [];

	constructor(init: ForkErrorInit) {
		super(
			`${init.what}: ${init.subject} (${init.code}). ${init.hint}`,
			init.cause === undefined ? undefined : { cause: init.cause },
		);
		this.name = init.name;
		this.code = init.code;
		this.hint = init.hint;
		this.retryable = init.retryable;
		this.fields = defined(init.fields);
	}

	/** This error with one more cleanup failure attached; the primary failure is unchanged. */
	withCleanupCause(cleanupCause: Error): this {
		const failures = this.#cleanupFailures;
		failures.push(cleanupCause);
		(this as { cleanupCause?: Error }).cleanupCause =
			failures.length === 1
				? cleanupCause
				: new AggregateError([...failures], `${failures.length} fork cleanup steps failed`);
		return this;
	}

	toJSON(): SerializedForkError {
		return serializeForkError(this);
	}
}

function listedPaths(paths: readonly string[], total: number): string {
	const more = total - paths.length;
	return more > 0 ? `${paths.join(", ")} (and ${more} more)` : paths.join(", ");
}

/** `fromStage` names no completed stage of the source run. Nothing was written. */
export class ForkTargetNotFoundError extends ForkError {
	declare readonly name: "ForkTargetNotFoundError";
	declare readonly code: "target-not-found";
	declare readonly retryable: false;
	readonly runId: string;
	readonly fromStage: string;
	/** Up to 10 completed stage paths of the run, in completion order. */
	readonly validStagePaths: readonly string[];
	/** How many completed stage paths the run has in total. */
	readonly totalValidStagePaths: number;

	constructor(input: {
		readonly runId: string;
		readonly fromStage: string;
		readonly validStagePaths: readonly string[];
		readonly totalValidStagePaths?: number;
	}) {
		const validStagePaths = input.validStagePaths.slice(0, FORK_ERROR_MAX_LISTED_PATHS);
		const totalValidStagePaths = Math.max(input.totalValidStagePaths ?? 0, input.validStagePaths.length);
		super({
			name: "ForkTargetNotFoundError",
			code: "target-not-found",
			what: "Fork target not found",
			subject: `stage "${input.fromStage}" in run ${input.runId}`,
			hint:
				validStagePaths.length === 0
					? `The run has no completed stage to fork from yet; listForkPoints("${input.runId}") lists stages once they complete.`
					: `Pass one of: ${listedPaths(validStagePaths, totalValidStagePaths)}; listForkPoints("${input.runId}") lists them all.`,
			retryable: false,
			fields: { runId: input.runId, fromStage: input.fromStage, validStagePaths, totalValidStagePaths },
		});
		this.runId = input.runId;
		this.fromStage = input.fromStage;
		this.validStagePaths = validStagePaths;
		this.totalValidStagePaths = totalValidStagePaths;
	}
}

export type ForkDefinitionMismatchReason = "definition-unavailable" | "name-changed" | "inputs-incompatible";

/** The workflow definition cannot replay the source run. Nothing was written. */
export class ForkDefinitionMismatchError extends ForkError {
	declare readonly name: "ForkDefinitionMismatchError";
	declare readonly code: "definition-mismatch";
	declare readonly retryable: false;
	readonly runId: string;
	/** Workflow name recorded on the source run. */
	readonly workflow: string;
	readonly reason: ForkDefinitionMismatchReason;
	/** Name of the definition that was supplied or resolved, when one was. */
	readonly definition?: string;

	constructor(
		input: {
			readonly runId: string;
			readonly workflow: string;
			readonly reason: ForkDefinitionMismatchReason;
			readonly definition?: string;
		},
		options?: { readonly cause?: Error },
	) {
		const subjects: Record<ForkDefinitionMismatchReason, string> = {
			"definition-unavailable": `workflow "${input.workflow}" of run ${input.runId} could not be resolved`,
			"name-changed": `definition "${input.definition}" does not match workflow "${input.workflow}" of run ${input.runId}`,
			"inputs-incompatible": `the recorded inputs of run ${input.runId} no longer satisfy workflow "${input.workflow}"`,
		};
		super({
			name: "ForkDefinitionMismatchError",
			code: "definition-mismatch",
			what: "Fork definition mismatch",
			subject: subjects[input.reason],
			hint:
				input.reason === "inputs-incompatible"
					? "Pass replacement inputs that satisfy the current definition with the inputs option."
					: `Pass the "${input.workflow}" definition with the definition option, or register it in the registry option.`,
			retryable: false,
			fields: { runId: input.runId, workflow: input.workflow, reason: input.reason, definition: input.definition },
			cause: options?.cause,
		});
		this.runId = input.runId;
		this.workflow = input.workflow;
		this.reason = input.reason;
		this.definition = input.definition;
	}
}

export type ForkSourceBusyReason =
	| "fork-in-progress"
	| "resume-in-progress"
	| "live-execution"
	| "foreign-lease"
	| "lease-lost";

const BUSY_SUBJECTS: Record<ForkSourceBusyReason, string> = {
	"fork-in-progress": "is already being forked",
	"resume-in-progress": "is being resumed",
	"live-execution": "is executing in this process",
	"foreign-lease": "is held by another Atomic process",
	"lease-lost": "no longer matches this fork's lease claim",
};

/** Another fork, a resume or a live execution holds the source run. Nothing was written; retry once it settles. */
export class ForkSourceBusyError extends ForkError {
	declare readonly name: "ForkSourceBusyError";
	declare readonly code: "source-busy";
	declare readonly retryable: true;
	readonly runId: string;
	readonly reason: ForkSourceBusyReason;
	/** Lease holder of another process, when the run is held there. */
	readonly holderId?: string;

	constructor(
		input: { readonly runId: string; readonly reason: ForkSourceBusyReason; readonly holderId?: string },
		options?: { readonly cause?: Error },
	) {
		super({
			name: "ForkSourceBusyError",
			code: "source-busy",
			what: "Fork source busy",
			subject: `run ${input.runId} ${BUSY_SUBJECTS[input.reason]}`,
			hint:
				input.reason === "fork-in-progress" || input.reason === "resume-in-progress"
					? "Retry after the other fork or resume finishes."
					: input.reason === "lease-lost"
						? `The fork lost its source claim before writing. Check /workflow status ${input.runId} and retry once the source is paused or idle.`
						: `Pause or quit the run (/workflow quit ${input.runId}), then fork it.`,
			retryable: true,
			fields: { runId: input.runId, reason: input.reason, holderId: input.holderId },
			cause: options?.cause,
		});
		this.runId = input.runId;
		this.reason = input.reason;
		this.holderId = input.holderId;
	}
}

/** `forkFromEntryId` names no entry of the source session. The stage did not start. */
export class ForkEntryNotFoundError extends ForkError {
	declare readonly name: "ForkEntryNotFoundError";
	declare readonly code: "entry-not-found";
	declare readonly retryable: false;
	readonly sessionId: string;
	readonly entryId: string;
	/** Stage that requested the fork, when known. */
	readonly stageName?: string;

	constructor(input: { readonly sessionId: string; readonly entryId: string; readonly stageName?: string }) {
		super({
			name: "ForkEntryNotFoundError",
			code: "entry-not-found",
			what: "Fork entry not found",
			subject: `entry ${input.entryId} in session ${input.sessionId}${input.stageName === undefined ? "" : ` for stage "${input.stageName}"`}`,
			hint: "Pass an entry id from that session, for example a fork point's entryId from listForkPoints().",
			retryable: false,
			fields: { sessionId: input.sessionId, entryId: input.entryId, stageName: input.stageName },
		});
		this.sessionId = input.sessionId;
		this.entryId = input.entryId;
		this.stageName = input.stageName;
	}
}

/** A stage session the fork needs cannot be read. Nothing was written. */
/** Where a fork read stage sessions: a store the caller passed as `sourceSessionStore`, or the source project's own. */
export type ForkSessionStoreSource = "supplied" | "project";

const FROM_OWNING_PROJECT =
	"from the project that ran the run (with forkRun, pass that project's session store as sourceSessionStore)";

/** A stage session the fork copies or lists is not in the session store that was read. Nothing was written. */
export class ForkSessionNotFoundError extends ForkError {
	declare readonly name: "ForkSessionNotFoundError";
	declare readonly code: "session-not-found";
	declare readonly retryable: false;
	readonly sessionId: string;
	readonly runId?: string;
	readonly stagePath?: string;
	/** Adapter of the session store that was read, and whether it is local to this node. */
	readonly storage?: ForkStorage;
	/** Whether the store was passed as `sourceSessionStore` or is the source project's own. */
	readonly storeSource: ForkSessionStoreSource;

	constructor(
		input: {
			readonly sessionId: string;
			readonly runId?: string;
			readonly stagePath?: string;
			readonly storage?: ForkStorage;
			readonly storeSource: ForkSessionStoreSource;
		},
		options?: { readonly cause?: Error },
	) {
		const stage = input.stagePath === undefined ? "" : ` of stage "${input.stagePath}"`;
		const run = input.runId === undefined ? "" : ` in run ${input.runId}`;
		const hint =
			input.storeSource === "supplied"
				? "The store passed as sourceSessionStore does not hold it; pass the session store of the project that ran the run."
				: input.storage?.scope === "local-only"
					? `This node reads sessions from local-only ${input.storage.adapter} storage and is not joined to the shared storage; run ${FORK_JOIN_SHARED_STORAGE_COMMAND}, or fork ${FROM_OWNING_PROJECT}.`
					: `Fork ${FROM_OWNING_PROJECT}.`;
		super({
			name: "ForkSessionNotFoundError",
			code: "session-not-found",
			what: "Fork session not found",
			subject: `session ${input.sessionId}${stage}${run}`,
			hint,
			retryable: false,
			fields: {
				sessionId: input.sessionId,
				runId: input.runId,
				stagePath: input.stagePath,
				storage: input.storage === undefined ? undefined : { ...input.storage },
				storeSource: input.storeSource,
			},
			cause: options?.cause,
		});
		this.sessionId = input.sessionId;
		this.runId = input.runId;
		this.stagePath = input.stagePath;
		this.storage = input.storage === undefined ? undefined : { ...input.storage };
		this.storeSource = input.storeSource;
	}
}

/** The session store failed while the fork read a stage session. Nothing was written; safe to retry. */
export class ForkSessionUnavailableError extends ForkError {
	declare readonly name: "ForkSessionUnavailableError";
	declare readonly code: "session-unavailable";
	declare readonly retryable: true;
	readonly sessionId: string;
	readonly runId?: string;
	readonly stagePath?: string;
	/** Adapter of the session store, and whether it is local to this node. */
	readonly storage?: ForkStorage;

	constructor(
		input: {
			readonly sessionId: string;
			readonly runId?: string;
			readonly stagePath?: string;
			readonly storage?: ForkStorage;
		},
		options: { readonly cause: Error },
	) {
		const stage = input.stagePath === undefined ? "" : ` of stage "${input.stagePath}"`;
		const run = input.runId === undefined ? "" : ` in run ${input.runId}`;
		const store =
			input.storage === undefined ? "" : ` from the ${input.storage.scope} ${input.storage.adapter} session store`;
		super({
			name: "ForkSessionUnavailableError",
			code: "session-unavailable",
			what: "Fork session unavailable",
			subject: `reading session ${input.sessionId}${stage}${run}${store}`,
			hint: "Nothing was written and the source run is unchanged; retry once the session store is reachable. atomic storage status shows the storage in use.",
			retryable: true,
			fields: {
				sessionId: input.sessionId,
				runId: input.runId,
				stagePath: input.stagePath,
				storage: input.storage === undefined ? undefined : { ...input.storage },
			},
			cause: options.cause,
		});
		this.sessionId = input.sessionId;
		this.runId = input.runId;
		this.stagePath = input.stagePath;
		this.storage = input.storage === undefined ? undefined : { ...input.storage };
	}
}

export type ForkConfigSource = "sdk" | "cli";
export type ForkConfigField =
	| "runId"
	| "fromStage"
	| "inputs"
	| "cwd"
	| "carryMessages"
	| "definition"
	| "registry"
	| "signal"
	| "localWorkers"
	| "admission";

/** One invalid fork option: the option and what its value must be. */
export interface ForkConfigIssue {
	readonly field: ForkConfigField;
	readonly expected: string;
}

/**
 * `forkRun` options or `/workflow fork` arguments are invalid. Checked in one pass before any I/O;
 * `issues` lists every invalid option and `field`/`expected` name the first.
 */
export class ForkConfigError extends ForkError {
	declare readonly name: "ForkConfigError";
	declare readonly code: "invalid-option";
	declare readonly retryable: false;
	readonly source: ForkConfigSource;
	readonly field: ForkConfigField;
	/** What the first invalid value must be. */
	readonly expected: string;
	readonly issues: readonly ForkConfigIssue[];

	constructor(
		input:
			| { readonly source: ForkConfigSource; readonly field: ForkConfigField; readonly expected: string }
			| { readonly source: ForkConfigSource; readonly issues: readonly [ForkConfigIssue, ...ForkConfigIssue[]] },
		options?: { readonly cause?: Error },
	) {
		const issues: readonly ForkConfigIssue[] =
			"issues" in input
				? input.issues.map(({ field, expected }) => ({ field, expected }))
				: [{ field: input.field, expected: input.expected }];
		const first = issues[0]!;
		const kind = input.source === "cli" ? "argument" : "option";
		super({
			name: "ForkConfigError",
			code: "invalid-option",
			what: "Invalid fork option",
			subject: `${input.source} ${kind}${issues.length === 1 ? "" : "s"} ${issues.map((issue) => issue.field).join(", ")}`,
			hint: issues.map((issue) => `Pass ${issue.field} as ${issue.expected}.`).join(" "),
			retryable: false,
			fields: {
				source: input.source,
				field: first.field,
				expected: first.expected,
				issues: issues.map(({ field, expected }) => ({ field, expected })),
			},
			cause: options?.cause,
		});
		this.source = input.source;
		this.field = first.field;
		this.expected = first.expected;
		this.issues = issues;
	}
}

export type ForkSourceNotFoundReason = "not-found" | "malformed" | "ambiguous" | "not-root";

/** The run id does not name exactly one durable root run in this node's journal. Nothing was written. */
export class ForkSourceNotFoundError extends ForkError {
	declare readonly name: "ForkSourceNotFoundError";
	declare readonly code: "source-not-found";
	declare readonly retryable: false;
	readonly runId: string;
	readonly reason: ForkSourceNotFoundReason;
	/** Full run ids an ambiguous prefix matched, at most 10. */
	readonly matches: readonly string[];
	/** Adapter of the journal that was read, and whether it is local to this node. */
	readonly storage?: ForkStorage;
	/** The root run of a nested run (`reason: "not-root"`). */
	readonly rootRunId?: string;

	constructor(input: {
		readonly runId: string;
		readonly reason: ForkSourceNotFoundReason;
		readonly matches?: readonly string[];
		readonly storage?: ForkStorage;
		readonly rootRunId?: string;
	}) {
		const all = input.matches ?? [];
		const matches = all.slice(0, FORK_ERROR_MAX_LISTED_PATHS);
		const journal =
			input.storage === undefined ? "" : ` in the ${input.storage.scope} ${input.storage.adapter} journal`;
		const subjects: Record<ForkSourceNotFoundReason, string> = {
			"not-found": `no durable root run ${input.runId}${journal}`,
			malformed: `"${input.runId}" is neither a full run id nor an 8-character prefix`,
			ambiguous: `prefix "${input.runId}" matches ${listedPaths(matches, all.length)}`,
			"not-root": `run ${input.runId} is a nested run${input.rootRunId === undefined ? "" : ` of root run ${input.rootRunId}`}`,
		};
		const hints: Record<ForkSourceNotFoundReason, string> = {
			"not-found":
				input.storage?.scope === "local-only"
					? `This node uses a local-only journal and is not joined to the shared storage; run ${FORK_JOIN_SHARED_STORAGE_COMMAND} to fork runs started on other nodes, or pass a root run id from /workflow list (a nested workflow's run is forked through its root run).`
					: "Pass a root run id from /workflow list (a nested workflow's run is forked through its root run), or pass the journal that holds the run with the journal option.",
			malformed:
				"Pass a run id from /workflow list, or pass the journal that holds the run with the journal option.",
			ambiguous: "Pass the full run id.",
			"not-root":
				input.rootRunId === undefined
					? "Fork its root run; listForkPoints on the root lists the nested stage paths."
					: `Fork the root run ${input.rootRunId}; listForkPoints("${input.rootRunId}") lists the nested stage paths.`,
		};
		super({
			name: "ForkSourceNotFoundError",
			code: "source-not-found",
			what: "Fork source not found",
			subject: subjects[input.reason],
			hint: hints[input.reason],
			retryable: false,
			fields: {
				runId: input.runId,
				reason: input.reason,
				matches,
				storage: input.storage === undefined ? undefined : { ...input.storage },
				rootRunId: input.rootRunId,
			},
		});
		this.runId = input.runId;
		this.reason = input.reason;
		this.matches = matches;
		this.storage = input.storage === undefined ? undefined : { ...input.storage };
		this.rootRunId = input.rootRunId;
	}
}

export type ForkSourceOwnershipReason = "foreign-owner" | "owner-unavailable";

export class ForkSourceOwnershipError extends ForkError {
	declare readonly name: "ForkSourceOwnershipError";
	declare readonly code: "source-not-owned";
	declare readonly retryable: false;
	readonly runId: string;
	readonly reason: ForkSourceOwnershipReason;

	constructor(input: { readonly runId: string; readonly reason: ForkSourceOwnershipReason }) {
		super({
			name: "ForkSourceOwnershipError",
			code: "source-not-owned",
			what: "Fork source not owned",
			subject:
				input.reason === "foreign-owner"
					? `run ${input.runId} belongs to another session`
					: `run ${input.runId} was started by an agent whose session was not recorded`,
			hint:
				input.reason === "foreign-owner"
					? `Fork it from the session that started it, or ask the user to run /workflow fork ${input.runId}.`
					: `Ask the user to run /workflow fork ${input.runId}.`,
			retryable: false,
			fields: { runId: input.runId, reason: input.reason },
		});
		this.runId = input.runId;
		this.reason = input.reason;
	}
}

/** The run journal cannot create a run with its events in one transaction, so a fork could leave half a run. */
export class ForkJournalUnsupportedError extends ForkError {
	declare readonly name: "ForkJournalUnsupportedError";
	declare readonly code: "journal-unsupported";
	declare readonly retryable: false;
	/** The missing journal member. */
	readonly capability: "createRunWithEvents";

	constructor() {
		super({
			name: "ForkJournalUnsupportedError",
			code: "journal-unsupported",
			what: "Fork journal unsupported",
			subject: "the run journal has no atomic createRunWithEvents",
			hint: "Use the SQLite or memory run journal, or implement RunJournal.createRunWithEvents.",
			retryable: false,
			fields: { capability: "createRunWithEvents" },
		});
		this.capability = "createRunWithEvents";
	}
}

/**
 * When the journal failed: reading or claiming the source run, writing the fork run without being able to tell
 * whether it exists (`commit`), a write that reported an error although reading the fork run back confirmed it
 * (`commit-confirmed`, logged, never thrown), or loading the fork run just written.
 */
export type ForkJournalPhase = "read" | "claim" | "commit" | "commit-confirmed" | "hydrate";

/**
 * The run journal's storage failed during the fork. In the `read` and `claim` phases nothing was written and a
 * retry is safe. In the `commit` phase the write failed and the journal could not say whether the fork run exists,
 * so its copied sessions were kept and that exact run is inspected after the storage recovers, never forked again
 * blindly. In the `hydrate` phase the fork run was written, so it is resumed rather than forked again.
 */
export class ForkJournalUnavailableError extends ForkError {
	declare readonly name: "ForkJournalUnavailableError";
	declare readonly code: "journal-unavailable";
	readonly runId: string;
	readonly phase: ForkJournalPhase;
	/** The fork run that was written (`hydrate`) or that may have been (`commit`). */
	readonly forkRunId?: string;
	/** Adapter of the journal, and whether it is local to this node. */
	readonly storage: ForkStorage;

	constructor(
		input: {
			readonly runId: string;
			readonly phase: ForkJournalPhase;
			readonly forkRunId?: string;
			readonly storage: ForkStorage;
		},
		options: { readonly cause: Error },
	) {
		const journal = `the ${input.storage.scope} ${input.storage.adapter} journal`;
		const subjects: Record<ForkJournalPhase, string> = {
			read: `reading run ${input.runId} from ${journal}`,
			claim: `claiming run ${input.runId} in ${journal}`,
			commit: `writing fork run ${input.forkRunId} of run ${input.runId} to ${journal} could not be confirmed`,
			"commit-confirmed": `writing fork run ${input.forkRunId} of run ${input.runId} to ${journal} reported an error, but reading it back confirmed the fork run was written`,
			hydrate: `loading fork run ${input.forkRunId} of run ${input.runId} from ${journal}`,
		};
		const status = "atomic storage status shows the storage in use.";
		const hints: Record<ForkJournalPhase, string> = {
			read: `Nothing was written and run ${input.runId} is unchanged; retry the fork once the journal is reachable. ${status}`,
			claim: `Nothing was written and run ${input.runId} is unchanged; retry the fork once the journal is reachable. ${status}`,
			commit: `Fork run ${input.forkRunId} may have been written, and its copied stage sessions were kept. Once the journal is reachable, inspect that exact run with /workflow status ${input.forkRunId} and resume it with /workflow resume ${input.forkRunId} if it exists. Do not fork run ${input.runId} again before that check: a missing run does not prove the write will never land. ${status}`,
			"commit-confirmed": `Nothing to do: fork run ${input.forkRunId} was written and the fork continues. If the journal keeps failing, ${status}`,
			hydrate: `Fork run ${input.forkRunId} was written; resume it with /workflow resume ${input.forkRunId} once the journal is reachable instead of forking again. ${status}`,
		};
		const hint = hints[input.phase];
		super({
			name: "ForkJournalUnavailableError",
			code: "journal-unavailable",
			what: "Fork journal unavailable",
			subject: subjects[input.phase],
			hint,
			retryable: input.phase === "read" || input.phase === "claim",
			fields: {
				runId: input.runId,
				phase: input.phase,
				forkRunId: input.forkRunId,
				storage: { ...input.storage },
			},
			cause: options.cause,
		});
		this.runId = input.runId;
		this.phase = input.phase;
		this.forkRunId = input.forkRunId;
		this.storage = { ...input.storage };
	}
}

export type ForkCopyPhase = "sessions" | "journal";

/** Copying failed; the fork run was not created and copied sessions were removed. Safe to retry. */
export class ForkCopyFailedError extends ForkError {
	declare readonly name: "ForkCopyFailedError";
	declare readonly code: "copy-failed";
	declare readonly retryable: true;
	readonly runId: string;
	readonly forkRunId: string;
	readonly phase: ForkCopyPhase;

	constructor(
		input: { readonly runId: string; readonly forkRunId: string; readonly phase: ForkCopyPhase },
		options: { readonly cause: Error },
	) {
		const copied: Record<ForkCopyPhase, string> = { sessions: "stage sessions", journal: "journal events" };
		super({
			name: "ForkCopyFailedError",
			code: "copy-failed",
			what: "Fork copy failed",
			subject: `${copied[input.phase]} of run ${input.runId} into ${input.forkRunId}`,
			hint: "Retry the fork; the source run was not changed.",
			retryable: true,
			fields: { runId: input.runId, forkRunId: input.forkRunId, phase: input.phase },
			cause: options.cause,
		});
		this.runId = input.runId;
		this.forkRunId = input.forkRunId;
		this.phase = input.phase;
	}
}

/**
 * Releasing the fork's claim on its source run failed. Whatever the fork did is unaffected; the claim
 * lapses on its own, and until then other forks and resumes of the source report it busy.
 */
export class ForkClaimReleaseError extends ForkError {
	declare readonly name: "ForkClaimReleaseError";
	declare readonly code: "claim-release-failed";
	declare readonly retryable: false;
	readonly runId: string;
	/** Longest time the source stays claimed: the claim's lease window. */
	readonly claimExpiresInMs: number;

	constructor(
		input: { readonly runId: string; readonly claimExpiresInMs: number },
		options: { readonly cause: Error },
	) {
		const seconds = Math.ceil(input.claimExpiresInMs / 1000);
		super({
			name: "ForkClaimReleaseError",
			code: "claim-release-failed",
			what: "Fork claim release failed",
			subject: `run ${input.runId} stays claimed by this fork for up to ${seconds} s`,
			hint: `Forks and resumes of run ${input.runId} report it busy until the claim expires; retry them after ${seconds} s.`,
			retryable: false,
			fields: { runId: input.runId, claimExpiresInMs: input.claimExpiresInMs },
			cause: options.cause,
		});
		this.runId = input.runId;
		this.claimExpiresInMs = input.claimExpiresInMs;
	}
}

export type ForkCleanupStep = "close-source-sessions" | "close-destination-sessions" | "remove-copied-sessions";

/**
 * A cleanup step failed after a fork or a fork-point listing: closing a session store it opened, or
 * removing the stage sessions a failed fork had copied. Never thrown in place of the outcome: attached to
 * a failed fork as `cleanupCause`, or logged once after one that succeeded or was cancelled.
 */
export class ForkCleanupError extends ForkError {
	declare readonly name: "ForkCleanupError";
	declare readonly code: "cleanup-failed";
	declare readonly retryable: false;
	readonly runId: string;
	readonly step: ForkCleanupStep;
	/** The fork the step belonged to; absent when listing fork points. */
	readonly forkRunId?: string;

	constructor(
		input: { readonly runId: string; readonly step: ForkCleanupStep; readonly forkRunId?: string },
		options: { readonly cause: Error },
	) {
		const owner =
			input.forkRunId === undefined ? `run ${input.runId}` : `fork ${input.forkRunId} of run ${input.runId}`;
		const subjects: Record<ForkCleanupStep, string> = {
			"close-source-sessions": `the session store read for ${owner} was not closed`,
			"close-destination-sessions": `the session store written for ${owner} was not closed`,
			"remove-copied-sessions": `the stage sessions copied for ${owner} were not removed`,
		};
		const closeHint =
			"Nothing to undo: the outcome and the source run are unaffected. If it repeats, check the session storage with atomic storage status.";
		const hints: Record<ForkCleanupStep, string> = {
			"close-source-sessions": closeHint,
			"close-destination-sessions": closeHint,
			"remove-copied-sessions": `The fork was not created and the source run is unchanged; the leftover copies are internal sessions of run ${input.forkRunId ?? input.runId} that nothing reads, so they can be deleted.`,
		};
		super({
			name: "ForkCleanupError",
			code: "cleanup-failed",
			what: "Fork cleanup failed",
			subject: subjects[input.step],
			hint: hints[input.step],
			retryable: false,
			fields: { runId: input.runId, step: input.step, forkRunId: input.forkRunId },
			cause: options.cause,
		});
		this.runId = input.runId;
		this.step = input.step;
		this.forkRunId = input.forkRunId;
	}
}

/**
 * Why a forked child's work could not take over a stage session the fork copied for it: the stage is outside the
 * work's scope, another work owns the session, the work already took it over for another stage, the session is not in
 * the pool tables, it is not a fork's copy, or its header names another run than the stage.
 */
export type ForkSessionClaimReason =
	| "outside-scope"
	| "owned-by-other-work"
	| "claimed-for-other-stage"
	| "missing"
	| "not-fork-copy"
	| "run-mismatch";

const CLAIM_SUBJECTS: Record<ForkSessionClaimReason, string> = {
	"outside-scope": "its stage is outside the child's scope",
	"owned-by-other-work": "another work owns it",
	"claimed-for-other-stage": "the child's work already took it over for another stage",
	missing: "it is not in the pool tables",
	"not-fork-copy": "it is not a copy the fork made",
	"run-mismatch": "its header names another run than its stage",
};

/**
 * A forked run's child could not be queued on its local workers because a stage session the fork copied for it could
 * not be handed to the child's work. This enqueue attempt changes no session owners; existing work may remain.
 */
export class ForkSessionClaimError extends ForkError {
	declare readonly name: "ForkSessionClaimError";
	declare readonly code: "session-claim-refused";
	declare readonly retryable: false;
	readonly reason: ForkSessionClaimReason;
	readonly sessionId: string;
	/** The forked root whose child was being queued. */
	readonly rootRunId: string;
	/** The forked child run being queued, and the scope of its boundary. */
	readonly childRunId: string;
	readonly scope: string;
	/** The stage that recorded the session, and the run that stage belongs to. */
	readonly replayKey: string;
	readonly stageRunId: string;

	constructor(input: {
		readonly reason: ForkSessionClaimReason;
		readonly sessionId: string;
		readonly rootRunId: string;
		readonly childRunId: string;
		readonly scope: string;
		readonly replayKey: string;
		readonly stageRunId: string;
	}) {
		super({
			name: "ForkSessionClaimError",
			code: "session-claim-refused",
			what: "Fork session claim refused",
			subject: `session ${input.sessionId} of forked run ${input.rootRunId} was not given to child run ${input.childRunId} because ${CLAIM_SUBJECTS[input.reason]}`,
			hint: `This enqueue attempt changed no session owners. Inspect /workflow status ${input.rootRunId} before retrying; resume only with the fork's original journal and session copies. Do not fork again or reassign session owners blindly.`,
			retryable: false,
			fields: {
				reason: input.reason,
				sessionId: input.sessionId,
				rootRunId: input.rootRunId,
				childRunId: input.childRunId,
				scope: input.scope,
				replayKey: input.replayKey,
				stageRunId: input.stageRunId,
			},
		});
		this.reason = input.reason;
		this.sessionId = input.sessionId;
		this.rootRunId = input.rootRunId;
		this.childRunId = input.childRunId;
		this.scope = input.scope;
		this.replayKey = input.replayKey;
		this.stageRunId = input.stageRunId;
	}
}

export type KnownForkError =
	| ForkTargetNotFoundError
	| ForkDefinitionMismatchError
	| ForkSourceBusyError
	| ForkEntryNotFoundError
	| ForkSessionNotFoundError
	| ForkConfigError
	| ForkSourceNotFoundError
	| ForkSourceOwnershipError
	| ForkJournalUnsupportedError
	| ForkJournalUnavailableError
	| ForkCopyFailedError
	| ForkClaimReleaseError
	| ForkSessionUnavailableError
	| ForkCleanupError
	| ForkSessionClaimError;

interface ForkErrorShape {
	readonly name?: string;
	readonly code?: string;
	readonly cause?: ForkErrorShape;
}

/** An object whose name is a known fork error's and whose code is that error's code. */
function hasForkShape(value: unknown, name?: ForkErrorName): boolean {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as ForkErrorShape;
	const expected = name ?? candidate.name;
	return (
		candidate.name === expected &&
		Object.hasOwn(FORK_ERROR_CODE_BY_NAME, expected as string) &&
		candidate.code === FORK_ERROR_CODE_BY_NAME[expected as ForkErrorName]
	);
}

function guard<T extends KnownForkError>(
	errorClass: abstract new (...args: never[]) => T,
	name: T["name"],
): (value: unknown) => value is T {
	return (value: unknown): value is T => value instanceof errorClass || hasForkShape(value, name);
}

/** True for any fork error: an instance of the family, or an object with a fork error's name and code. */
export function isForkError(value: unknown): value is ForkError {
	return value instanceof ForkError || hasForkShape(value);
}
export const isForkTargetNotFoundError = guard(ForkTargetNotFoundError, "ForkTargetNotFoundError");
export const isForkDefinitionMismatchError = guard(ForkDefinitionMismatchError, "ForkDefinitionMismatchError");
export const isForkSourceBusyError = guard(ForkSourceBusyError, "ForkSourceBusyError");
export const isForkEntryNotFoundError = guard(ForkEntryNotFoundError, "ForkEntryNotFoundError");
export const isForkSessionNotFoundError = guard(ForkSessionNotFoundError, "ForkSessionNotFoundError");
export const isForkConfigError = guard(ForkConfigError, "ForkConfigError");
export const isForkSourceNotFoundError = guard(ForkSourceNotFoundError, "ForkSourceNotFoundError");
export function isForkSourceOwnershipError(value: unknown): boolean {
	let current = value as ForkErrorShape | undefined;
	for (let depth = 0; depth < FORK_ERROR_MAX_CAUSE_DEPTH && current != null; depth++) {
		if (current instanceof ForkSourceOwnershipError || hasForkShape(current, "ForkSourceOwnershipError")) return true;
		current = current.cause;
	}
	return false;
}
export const isForkJournalUnsupportedError = guard(ForkJournalUnsupportedError, "ForkJournalUnsupportedError");
export const isForkJournalUnavailableError = guard(ForkJournalUnavailableError, "ForkJournalUnavailableError");
export const isForkCopyFailedError = guard(ForkCopyFailedError, "ForkCopyFailedError");
export const isForkClaimReleaseError = guard(ForkClaimReleaseError, "ForkClaimReleaseError");
export const isForkSessionUnavailableError = guard(ForkSessionUnavailableError, "ForkSessionUnavailableError");
export const isForkCleanupError = guard(ForkCleanupError, "ForkCleanupError");
/** True when a {@link ForkSessionClaimError} is in `value`'s cause chain, within {@link FORK_ERROR_MAX_CAUSE_DEPTH} links. */
export function isForkSessionClaimError(value: unknown): boolean {
	let current = value as ForkErrorShape | undefined;
	for (let depth = 0; depth < FORK_ERROR_MAX_CAUSE_DEPTH && current != null; depth++) {
		if (current instanceof ForkSessionClaimError || hasForkShape(current, "ForkSessionClaimError")) return true;
		current = current.cause;
	}
	return false;
}

/** The first fork error in `value`'s cause chain, walking at most {@link FORK_ERROR_MAX_CAUSE_DEPTH} links. */
export function findForkError(value: unknown): ForkError | undefined {
	let current = value as ForkErrorShape | undefined;
	for (let depth = 0; depth < FORK_ERROR_MAX_CAUSE_DEPTH && current != null; depth++) {
		if (isForkError(current)) return current;
		current = current.cause;
	}
	return undefined;
}

/** True when a fork error in the cause chain says the fork may succeed if retried. */
export function isRetryableForkError(value: unknown): boolean {
	let current = value as ForkErrorShape | undefined;
	for (let depth = 0; depth < FORK_ERROR_MAX_CAUSE_DEPTH && current != null; depth++) {
		if (isForkError(current) && current.retryable) return true;
		current = current.cause;
	}
	return false;
}

function serializeCause(cause: unknown, depth: number): SerializedErrorCause | undefined {
	if (depth >= FORK_ERROR_MAX_CAUSE_DEPTH || !(cause instanceof Error)) return undefined;
	if (isForkError(cause)) {
		const fork = serializeForkErrorAt(cause, depth + 1);
		return { name: fork.name, message: fork.message, code: fork.code, fork };
	}
	const code = (cause as Error & { readonly code?: unknown }).code;
	const errors =
		cause instanceof AggregateError
			? cause.errors.flatMap((error: unknown) => serializeCause(error, depth + 1) ?? [])
			: [];
	const next = serializeCause(cause.cause, depth + 1);
	return {
		name: cause.name,
		message: cause.message,
		...(typeof code === "string" ? { code } : {}),
		...(errors.length === 0 ? {} : { errors }),
		...(next === undefined ? {} : { cause: next }),
	};
}

/** `depth` counts the causes already serialized above this error. */
function serializeForkErrorAt(error: ForkError, depth: number): SerializedForkError {
	const cause = serializeCause(error.cause, depth);
	const cleanupCause = serializeCause(error.cleanupCause, depth);
	return {
		name: error.name,
		code: error.code,
		message: error.message,
		hint: error.hint,
		retryable: error.retryable,
		fields: error.fields,
		...(cause === undefined ? {} : { cause }),
		...(cleanupCause === undefined ? {} : { cleanupCause }),
	};
}

/** The wire form of a fork error, keeping at most {@link FORK_ERROR_MAX_CAUSE_DEPTH} causes. */
export function serializeForkError(error: ForkError): SerializedForkError {
	return serializeForkErrorAt(error, 0);
}

type WireFields = Readonly<Record<string, ForkErrorFieldValue | undefined>>;

function text(fields: WireFields, key: string): string {
	return String(fields[key] ?? "");
}

function optionalText(fields: WireFields, key: string): string | undefined {
	const value = fields[key];
	return value === undefined ? undefined : String(value);
}

function texts(fields: WireFields, key: string): readonly string[] {
	const value = fields[key];
	return Array.isArray(value) ? value.map(String) : [];
}

function storage(fields: WireFields): ForkStorage | undefined {
	const value = fields.storage as Partial<ForkStorage> | undefined;
	return value === undefined ? undefined : { adapter: String(value.adapter), scope: value.scope as ForkStorageScope };
}

function rehydrateCause(cause: SerializedErrorCause | undefined): Error | undefined {
	return cause === undefined ? undefined : rehydrateSerializedCause(cause);
}

function rehydrateSerializedCause(cause: SerializedErrorCause): Error {
	if (cause.fork !== undefined) return rehydrateForkError(cause.fork);
	const next = rehydrateCause(cause.cause);
	const error =
		cause.errors === undefined
			? new Error(cause.message, { cause: next })
			: new AggregateError(cause.errors.map(rehydrateSerializedCause), cause.message, { cause: next });
	error.name = cause.name;
	if (cause.code !== undefined) Object.assign(error, { code: cause.code });
	return error;
}

type Rehydrate = (fields: WireFields, cause: Error | undefined) => ForkError;

const REHYDRATE: Record<ForkErrorName, Rehydrate> = {
	ForkTargetNotFoundError: (f) =>
		new ForkTargetNotFoundError({
			runId: text(f, "runId"),
			fromStage: text(f, "fromStage"),
			validStagePaths: texts(f, "validStagePaths"),
			totalValidStagePaths: Number(f.totalValidStagePaths ?? 0),
		}),
	ForkDefinitionMismatchError: (f, cause) =>
		new ForkDefinitionMismatchError(
			{
				runId: text(f, "runId"),
				workflow: text(f, "workflow"),
				reason: text(f, "reason") as ForkDefinitionMismatchReason,
				definition: optionalText(f, "definition"),
			},
			{ cause },
		),
	ForkSourceBusyError: (f, cause) =>
		new ForkSourceBusyError(
			{
				runId: text(f, "runId"),
				reason: text(f, "reason") as ForkSourceBusyReason,
				holderId: optionalText(f, "holderId"),
			},
			{ cause },
		),
	ForkEntryNotFoundError: (f) =>
		new ForkEntryNotFoundError({
			sessionId: text(f, "sessionId"),
			entryId: text(f, "entryId"),
			stageName: optionalText(f, "stageName"),
		}),
	ForkSessionNotFoundError: (f, cause) =>
		new ForkSessionNotFoundError(
			{
				sessionId: text(f, "sessionId"),
				runId: optionalText(f, "runId"),
				stagePath: optionalText(f, "stagePath"),
				storage: storage(f),
				storeSource: f.storeSource === "supplied" ? "supplied" : "project",
			},
			{ cause },
		),
	ForkSessionUnavailableError: (f, cause) =>
		new ForkSessionUnavailableError(
			{
				sessionId: text(f, "sessionId"),
				runId: optionalText(f, "runId"),
				stagePath: optionalText(f, "stagePath"),
				storage: storage(f),
			},
			{ cause: cause ?? new Error("The session store failure's cause was not serialized.") },
		),
	ForkConfigError: (f, cause) => {
		const issues = (f.issues as readonly ForkConfigIssue[] | undefined) ?? [];
		const [first, ...rest] =
			issues.length > 0 ? issues : [{ field: f.field, expected: f.expected } as ForkConfigIssue];
		return new ForkConfigError(
			{ source: text(f, "source") as ForkConfigSource, issues: [first!, ...rest] },
			{ cause },
		);
	},
	ForkSourceNotFoundError: (f) =>
		new ForkSourceNotFoundError({
			runId: text(f, "runId"),
			reason: text(f, "reason") as ForkSourceNotFoundReason,
			matches: texts(f, "matches"),
			storage: storage(f),
			rootRunId: optionalText(f, "rootRunId"),
		}),
	ForkSourceOwnershipError: (f) =>
		new ForkSourceOwnershipError({
			runId: text(f, "runId"),
			reason: text(f, "reason") as ForkSourceOwnershipReason,
		}),
	ForkJournalUnsupportedError: () => new ForkJournalUnsupportedError(),
	ForkJournalUnavailableError: (f, cause) =>
		new ForkJournalUnavailableError(
			{
				runId: text(f, "runId"),
				phase: text(f, "phase") as ForkJournalPhase,
				forkRunId: optionalText(f, "forkRunId"),
				storage: storage(f) ?? { adapter: "unknown", scope: "shared" },
			},
			{ cause: cause ?? new Error("The journal failure's cause was not serialized.") },
		),
	ForkCopyFailedError: (f, cause) =>
		new ForkCopyFailedError(
			{ runId: text(f, "runId"), forkRunId: text(f, "forkRunId"), phase: text(f, "phase") as ForkCopyPhase },
			{ cause: cause ?? new Error("The copy failure's cause was not serialized.") },
		),
	ForkClaimReleaseError: (f, cause) =>
		new ForkClaimReleaseError(
			{ runId: text(f, "runId"), claimExpiresInMs: Number(f.claimExpiresInMs ?? 0) },
			{ cause: cause ?? new Error("The release failure's cause was not serialized.") },
		),
	ForkSessionClaimError: (f) =>
		new ForkSessionClaimError({
			reason: text(f, "reason") as ForkSessionClaimReason,
			sessionId: text(f, "sessionId"),
			rootRunId: text(f, "rootRunId"),
			childRunId: text(f, "childRunId"),
			scope: text(f, "scope"),
			replayKey: text(f, "replayKey"),
			stageRunId: text(f, "stageRunId"),
		}),
	ForkCleanupError: (f, cause) =>
		new ForkCleanupError(
			{ runId: text(f, "runId"), step: text(f, "step") as ForkCleanupStep, forkRunId: optionalText(f, "forkRunId") },
			{ cause: cause ?? new Error("The cleanup failure's cause was not serialized.") },
		),
};

/**
 * The fork error a {@link SerializedForkError} describes, as its own class, with its cleanup failures
 * attached. A name this version does not know becomes a {@link ForkError} with the original name, code,
 * message and fields.
 */
export function rehydrateForkError(serialized: SerializedForkError): ForkError {
	const error = rehydrateForkErrorClass(serialized);
	const cleanupCause = rehydrateCause(serialized.cleanupCause);
	return cleanupCause === undefined ? error : error.withCleanupCause(cleanupCause);
}

function rehydrateForkErrorClass(serialized: SerializedForkError): ForkError {
	const cause = rehydrateCause(serialized.cause);
	const rehydrate = Object.hasOwn(REHYDRATE, serialized.name)
		? REHYDRATE[serialized.name as ForkErrorName]
		: undefined;
	if (rehydrate !== undefined) return rehydrate(serialized.fields, cause);
	const unknown = new ForkError({
		name: serialized.name,
		code: serialized.code,
		what: "",
		subject: "",
		hint: serialized.hint ?? "",
		retryable: serialized.retryable,
		fields: serialized.fields,
		cause,
	});
	unknown.message = serialized.message;
	return unknown;
}
