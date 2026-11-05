/**
 * Run time travel (#4321): fork a durable run into a new run that replays the source's checkpoints up
 * to a stage and continues from there. The source run is never written; the fork is a new run, so the
 * run graph stays acyclic.
 */
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { type SessionEntry, SessionManager, type SessionStore } from "@bastani/atomic";
import { StorageError } from "@bastani/atomic/storage";
import { isWorkflowDefinition } from "../runs/foreground/executor-child-helpers.js";
import { resolveAndValidateInputs } from "../runs/foreground/executor-inputs.js";
import { isFullRunId, isRunIdPrefix, resolveRunIdTarget } from "../shared/run-id.js";
import { stageSessionStore } from "../shared/stage-session-store.js";
import type { PendingStageMessage, PendingStageMessageDelivery } from "../shared/store-types.js";
import { isToolPayloadObject } from "../shared/tool-payload-bounds.js";
import type {
	WorkflowDefinition,
	WorkflowInputValues,
	WorkflowOutputValues,
	WorkflowSerializableValue,
} from "../shared/types.js";
import { formatWorkflowStageTarget, parseWorkflowStageTarget } from "../shared/workflow-stage-target.js";
import { poolSessionStore } from "../workers/pool-session-store.js";
import { workflowNamesEqual } from "../workflows/identity.js";
import type { DurableWorkflowBackend } from "./backend.js";
import { durableHash } from "./durable-hash.js";
import {
	ForkClaimReleaseError,
	ForkCleanupError,
	type ForkCleanupStep,
	ForkConfigError,
	type ForkConfigIssue,
	type ForkConfigSource,
	ForkCopyFailedError,
	ForkDefinitionMismatchError,
	ForkError,
	type ForkJournalPhase,
	ForkJournalUnavailableError,
	ForkJournalUnsupportedError,
	ForkSessionNotFoundError,
	ForkSessionUnavailableError,
	ForkSourceBusyError,
	ForkSourceNotFoundError,
	type ForkStorageScope,
	ForkTargetNotFoundError,
} from "./fork-errors.js";
import { decodeJournalEventHandle, JournalDurableBackend } from "./journal/journal-backend.js";
import {
	RUN_EVENT_TYPES as E,
	type JournalEntry,
	type Lease,
	type RunEvent,
	type RunJournal,
	type RunJournalSeedEvent,
	StaleLeaseError,
} from "./journal/types.js";
import { FOREIGN_LIVE_WORKFLOW_WINDOW_MS } from "./resume-eligibility.js";
import { claimsOf, hasForkClaim, hasResumeClaim, pendingForks } from "./run-claims.js";
import { RUN_RESULT_CHECKPOINT_NAME } from "./run-result.js";
import type {
	DurableCheckpoint,
	DurableStageCheckpoint,
	DurableStageRunTopology,
	DurableWorkflowHandle,
	WorkflowForkedFrom,
} from "./types.js";
import { parseWorkflowChildResult } from "./workflow-child-result.js";

/** Which Intercom messages and prompt answers a fork carries: those before the fork point (default) or all. */
export type ForkCarryMessages = "before" | "all";

/** A completed stage a run can be forked from. */
export interface ForkPoint {
	/** Dot path of the stage: enclosing nested-workflow stage names, then the stage name. */
	readonly stagePath: string;
	/** Agent session the stage ran in, when it ran one. */
	readonly sessionId?: string;
	/** Last entry of that session, for `forkFromEntryId`. */
	readonly entryId?: string;
	readonly completedAt: number;
}

export interface ForkSourceOptions {
	/** Session store holding the source run's stage sessions; defaults to the source project's store. */
	readonly sourceSessionStore?: SessionStore;
	/** The root run of a nested run this process knows, so a nested run id is reported as one. */
	readonly rootRunOf?: (runId: string) => string | undefined;
}

export interface DurableForkRequest<TDefinition = WorkflowDefinition> extends ForkSourceOptions {
	readonly source: ForkConfigSource;
	readonly runId: string;
	readonly fromStage?: string;
	readonly inputs?: WorkflowInputValues;
	/** Destination directory of the fork's stages and session store. Omitted: the source run's directory. */
	readonly cwd?: string;
	readonly carryMessages: ForkCarryMessages;
	readonly definition?: TDefinition;
	readonly resolveDefinition?: (name: string, cwd: string | undefined) => Promise<WorkflowDefinition | undefined>;
	/** Session store for the fork's stage sessions; defaults to the destination project's store. */
	readonly sessionStore?: SessionStore;
	readonly modelOwner?: string;
	readonly signal?: AbortSignal;
	/** Whether this process is executing the run outside the durable backend's own leases. */
	readonly isLiveRun?: (runId: string) => boolean;
	/**
	 * Called with the source's recorded handle before claiming it and again with its fenced handle before copying or
	 * writing. Validation must be repeatable. Throwing refuses the fork without copying sessions or creating a run.
	 */
	readonly validateSource?: (handle: DurableWorkflowHandle) => void;
}

export interface DurableForkResult {
	readonly runId: string;
	readonly forkedFrom: WorkflowForkedFrom;
	readonly definition: WorkflowDefinition;
	readonly inputs: WorkflowInputValues;
	readonly cwd: string;
}

interface CheckpointEvent {
	readonly seq: number;
	readonly checkpoint: DurableCheckpoint;
}

interface ForkPointRecord {
	readonly stagePath: string;
	readonly replayKey: string;
	readonly sessionId?: string;
	readonly completedAt: number;
	/** Sequence of the first event of the stage: the fork copies only events before it. */
	readonly firstSeq: number;
}

interface ForkSource {
	readonly runId: string;
	readonly entries: readonly JournalEntry[];
	readonly handle: DurableWorkflowHandle;
	readonly checkpoints: readonly CheckpointEvent[];
	readonly backend: JournalDurableBackend;
}

const STAGE_PATH_SEPARATOR = ".";

function forkJournal(backend: DurableWorkflowBackend): JournalDurableBackend & {
	readonly journal: RunJournal & Required<Pick<RunJournal, "createRunWithEvents">>;
} {
	if (!(backend instanceof JournalDurableBackend) || typeof backend.journal.createRunWithEvents !== "function")
		throw new ForkJournalUnsupportedError();
	return backend as JournalDurableBackend & {
		readonly journal: RunJournal & Required<Pick<RunJournal, "createRunWithEvents">>;
	};
}

/**
 * Checks `forkRun` options in one pass before any journal or session I/O, reporting every invalid
 * option together. The run id is resolved against the journal afterwards.
 */
export function validateForkOptions(
	source: ForkConfigSource,
	runId: unknown,
	options: {
		readonly fromStage?: unknown;
		readonly inputs?: unknown;
		readonly cwd?: unknown;
		readonly carryMessages?: unknown;
		readonly definition?: unknown;
		readonly signal?: unknown;
		/** Process-bound run options passed together with `localWorkers`, which a worker pool refuses. */
		readonly processBound?: readonly string[];
	},
): void {
	const issues: ForkConfigIssue[] = [];
	let cause: Error | undefined;
	if (typeof runId !== "string" || runId.trim().length === 0)
		issues.push({ field: "runId", expected: "a run id or 8-character prefix" });
	if (options.fromStage !== undefined && (typeof options.fromStage !== "string" || options.fromStage.length === 0))
		issues.push({ field: "fromStage", expected: "a stage path from listForkPoints" });
	if (
		options.inputs !== undefined &&
		(typeof options.inputs !== "object" || options.inputs === null || Array.isArray(options.inputs))
	)
		issues.push({ field: "inputs", expected: "an object of workflow inputs" });
	if (options.cwd !== undefined) {
		let directory = false;
		if (typeof options.cwd === "string" && options.cwd.length > 0) {
			try {
				directory = statSync(resolve(options.cwd)).isDirectory();
			} catch (error) {
				cause = error as Error;
			}
		}
		if (!directory) issues.push({ field: "cwd", expected: "an existing directory" });
	}
	if (options.carryMessages !== undefined && options.carryMessages !== "before" && options.carryMessages !== "all")
		issues.push({ field: "carryMessages", expected: `"before" or "all"` });
	if (options.definition !== undefined && !isWorkflowDefinition(options.definition))
		issues.push({ field: "definition", expected: "a workflow definition created with workflow()" });
	if (
		options.signal !== undefined &&
		(typeof options.signal !== "object" || options.signal === null || !("aborted" in options.signal))
	)
		issues.push({ field: "signal", expected: "an AbortSignal" });
	if (options.processBound !== undefined && options.processBound.length > 0)
		issues.push({
			field: "localWorkers",
			expected: `localWorkers without options bound to this process (${options.processBound.join(", ")})`,
		});
	const [first, ...rest] = issues;
	if (first !== undefined) throw new ForkConfigError({ source, issues: [first, ...rest] }, { cause });
}

type ResolvedForkRequest = DurableForkRequest & { readonly cwd: string };

/** The destination directory of a fork: `cwd` resolved against the process directory, or the source run's directory. */
function forkDestinationCwd(cwd: string | undefined, source: DurableWorkflowHandle): string {
	if (cwd === undefined) return source.invocationCwd ?? process.cwd();
	return isAbsolute(cwd) ? cwd : resolve(cwd);
}

const LOCAL_ONLY_ADAPTERS: ReadonlySet<string> = new Set(["memory", "node-sqlite", "jsonl"]);

/** Whether storage is local to this node: the in-process and file adapters, and libSQL on a `file:` URL. */
function storageScope(descriptor: { readonly adapter: string; readonly location: string } | undefined): {
	readonly adapter: string;
	readonly scope: ForkStorageScope;
} {
	if (descriptor === undefined) return { adapter: "memory", scope: "local-only" };
	const { adapter, location } = descriptor;
	const local = LOCAL_ONLY_ADAPTERS.has(adapter) || (adapter === "libsql" && /^file:/i.test(location));
	return { adapter, scope: local ? "local-only" : "shared" };
}

function journalStorage(journal: RunJournal) {
	return storageScope(
		(journal as { readonly descriptor?: { readonly adapter: string; readonly location: string } }).descriptor,
	);
}

/** `operation`'s result; a storage failure of the journal becomes a {@link ForkJournalUnavailableError}. */
async function inJournal<T>(
	journal: RunJournal,
	context: { readonly runId: string; readonly phase: ForkJournalPhase; readonly forkRunId?: string },
	operation: () => Promise<T>,
): Promise<T> {
	try {
		return await operation();
	} catch (error) {
		if (!(error instanceof StorageError)) throw error;
		throw new ForkJournalUnavailableError({ ...context, storage: journalStorage(journal) }, { cause: error });
	}
}

async function readForkSource(
	backend: JournalDurableBackend,
	target: string,
	rootRunOf: ForkSourceOptions["rootRunOf"],
): Promise<ForkSource> {
	const journal = backend.journal;
	if (!isFullRunId(target) && !isRunIdPrefix(target))
		throw new ForkSourceNotFoundError({ runId: target, reason: "malformed" });
	const { runId, entries } = await inJournal(journal, { runId: target, phase: "read" }, async () => {
		const runIds = isFullRunId(target)
			? (await journal.getRun(target)) === undefined
				? []
				: [target]
			: (await journal.listRuns()).map((run) => run.runId);
		const resolution = resolveRunIdTarget(target, runIds);
		if (resolution.kind === "ambiguous")
			throw new ForkSourceNotFoundError({ runId: target, reason: "ambiguous", matches: resolution.matches });
		if (resolution.kind !== "exact" && resolution.kind !== "unique_prefix") {
			const rootRunId = rootRunOf?.(target);
			throw rootRunId === undefined || rootRunId === target
				? new ForkSourceNotFoundError({ runId: target, reason: "not-found", storage: journalStorage(journal) })
				: new ForkSourceNotFoundError({ runId: target, reason: "not-root", rootRunId });
		}
		const read: JournalEntry[] = [];
		for await (const entry of journal.read(resolution.runId)) read.push(entry);
		return { runId: resolution.runId, entries: read };
	});
	let handle: DurableWorkflowHandle | undefined;
	const checkpoints: CheckpointEvent[] = [];
	for (const entry of entries) {
		if (entry.event.type === E.checkpointRecorded)
			checkpoints.push({ seq: entry.seq, checkpoint: entry.event.payload as unknown as DurableCheckpoint });
		else handle = decodeJournalEventHandle(entry.event, handle) ?? handle;
	}
	if (handle === undefined)
		throw new ForkSourceNotFoundError({ runId: target, reason: "not-found", storage: journalStorage(journal) });
	if (handle.rootWorkflowId !== undefined && handle.rootWorkflowId !== runId)
		throw new ForkSourceNotFoundError({ runId: target, reason: "not-root", rootRunId: handle.rootWorkflowId });
	return { runId, entries, handle, checkpoints, backend };
}

function stageSessionId(checkpoint: DurableStageCheckpoint): string | undefined {
	if (checkpoint.sessionId !== undefined) return checkpoint.sessionId;
	const output = checkpoint.output;
	return isToolPayloadObject(output) && typeof output.text === "string" && typeof output.sessionId === "string"
		? output.sessionId
		: undefined;
}

/** Completed stages of a run in completion order, each with a unique dot path. */
function forkPointRecords(checkpoints: readonly CheckpointEvent[]): readonly ForkPointRecord[] {
	const boundaries = new Map<string, string>();
	const firstSeq = new Map<string, number>();
	for (const { seq, checkpoint } of checkpoints) {
		if (checkpoint.kind !== "stage") continue;
		if (!firstSeq.has(checkpoint.replayKey)) firstSeq.set(checkpoint.replayKey, seq);
		if (checkpoint.topology?.boundary !== undefined && !boundaries.has(checkpoint.replayKey))
			boundaries.set(checkpoint.replayKey, checkpoint.name);
	}
	const enclosing = (replayKey: string): string[] =>
		[...boundaries.keys()]
			.filter((boundary) => replayKey.startsWith(`${boundary}:`))
			.sort((a, b) => a.length - b.length)
			.map((boundary) => boundaries.get(boundary)!);
	const seen = new Set<string>();
	const occurrences = new Map<string, number>();
	const records: ForkPointRecord[] = [];
	for (const { checkpoint } of checkpoints) {
		if (
			checkpoint.kind !== "stage" ||
			checkpoint.output === undefined ||
			checkpoint.topology?.occurrenceKey !== undefined ||
			seen.has(checkpoint.replayKey)
		)
			continue;
		seen.add(checkpoint.replayKey);
		const base = [...enclosing(checkpoint.replayKey), checkpoint.name].join(STAGE_PATH_SEPARATOR);
		let occurrence = occurrences.get(base) ?? 0;
		let stagePath: string;
		do {
			occurrence++;
			stagePath = occurrence === 1 ? base : `${base}#${occurrence}`;
		} while (records.some((record) => record.stagePath === stagePath));
		occurrences.set(base, occurrence);
		const sessionId = stageSessionId(checkpoint);
		records.push({
			stagePath,
			replayKey: checkpoint.replayKey,
			sessionId,
			completedAt: checkpoint.completedAt,
			firstSeq: firstSeq.get(checkpoint.replayKey)!,
		});
	}
	return records;
}

function forkKeepsWorkspace(source: DurableWorkflowHandle, cwd: string): boolean {
	return (source.invocationCwd ?? cwd) === cwd;
}

function forkSessionStoreCwd(source: DurableWorkflowHandle, cwd: string): string {
	return forkKeepsWorkspace(source, cwd) ? (source.workflowCwd ?? cwd) : cwd;
}

interface SourceSessions {
	readonly store: SessionStore;
	readonly owned: boolean;
	readonly backend: JournalDurableBackend;
	/** The source's root run, whose shard of the journal store holds its pool's sessions (#4325). */
	readonly rootRunId: string;
	pool?: { readonly store: SessionStore | undefined };
}

async function sourceSessionStoreFor(
	backend: JournalDurableBackend,
	handle: DurableWorkflowHandle,
	options: ForkSourceOptions,
	cwd: string,
): Promise<SourceSessions> {
	const rootRunId = handle.rootWorkflowId ?? handle.workflowId;
	return options.sourceSessionStore === undefined
		? {
				store: await stageSessionStore({ cwd: handle.workflowCwd ?? handle.invocationCwd ?? cwd }),
				owned: true,
				backend,
				rootRunId,
			}
		: { store: options.sourceSessionStore, owned: false, backend, rootRunId };
}

async function closeSourceSessions(sessions: SourceSessions | undefined, cleanup: ForkCleanup): Promise<void> {
	if (sessions?.owned === true) await cleanup.step("close-source-sessions", undefined, () => sessions.store.close());
	const pooled = sessions?.pool?.store;
	if (pooled !== undefined) await cleanup.step("close-source-sessions", undefined, () => pooled.close());
}

/** A session store's own errors, told apart by name: they come from `@bastani/atomic`'s session stores. */
function sessionStoreFailure(error: unknown): "not-found" | "unavailable" | undefined {
	if (error instanceof StorageError) return "unavailable";
	if (!(error instanceof Error)) return undefined;
	if (error.name === "SessionNotFoundError") return "not-found";
	return error.name === "StorageUnavailableError" ? "unavailable" : undefined;
}

type SessionContext = { readonly runId: string; readonly stagePath?: string };

async function loadSession(sessions: SourceSessions, sessionId: string, context: SessionContext) {
	try {
		return await sessions.store.load(sessionId);
	} catch (error) {
		const failure = sessionStoreFailure(error);
		const details = { sessionId, ...context, storage: storageScope(sessions.store.descriptor) };
		if (failure === "unavailable") throw new ForkSessionUnavailableError(details, { cause: error as Error });
		if (failure !== "not-found") throw error;
		const pooled = await loadPoolSession(sessions, sessionId, context);
		if (pooled !== undefined) return pooled;
		throw new ForkSessionNotFoundError(
			{ ...details, storeSource: sessions.owned ? "project" : "supplied" },
			{ cause: error as Error },
		);
	}
}

async function loadPoolSession(sessions: SourceSessions, sessionId: string, context: SessionContext) {
	const storage = journalStorage(sessions.backend.journal);
	try {
		sessions.pool ??= { store: await poolSessionStore(sessions.backend, sessions.rootRunId) };
		return await sessions.pool.store?.load(sessionId);
	} catch (error) {
		const failure = sessionStoreFailure(error);
		if (failure === "not-found") return undefined;
		if (failure === "unavailable")
			throw new ForkSessionUnavailableError({ sessionId, ...context, storage }, { cause: error as Error });
		throw error;
	}
}

/**
 * The completed stages of a run, in completion order, that `forkRun` can fork from. Read-only: the
 * run is not claimed. A point's `entryId` is read from its stage session.
 */
export async function* durableForkPoints(
	backend: DurableWorkflowBackend,
	runId: string,
	options: ForkSourceOptions & { readonly cwd?: string } = {},
): AsyncGenerator<ForkPoint, void, undefined> {
	const journalBackend = forkJournal(backend);
	const source = await readForkSource(journalBackend, runId, options.rootRunOf);
	const cleanup = new ForkCleanup(source.runId);
	let sessions: SourceSessions | undefined;
	let primary: unknown;
	try {
		for (const record of forkPointRecords(source.checkpoints)) {
			if (record.sessionId === undefined) {
				yield { stagePath: record.stagePath, completedAt: record.completedAt };
				continue;
			}
			sessions ??= await sourceSessionStoreFor(journalBackend, source.handle, options, options.cwd ?? process.cwd());
			const snapshot = await loadSession(sessions, record.sessionId, {
				runId: source.runId,
				stagePath: record.stagePath,
			});
			const entryId = snapshot.entries.at(-1)?.id;
			yield {
				stagePath: record.stagePath,
				sessionId: record.sessionId,
				...(entryId === undefined ? {} : { entryId }),
				completedAt: record.completedAt,
			};
		}
	} catch (error) {
		primary = error;
		throw error;
	} finally {
		await closeSourceSessions(sessions, cleanup);
		cleanup.settle(primary);
	}
}

/**
 * The cleanup failures of one fork or fork-point listing. A step never throws; `settle` attaches every
 * failure to a primary `ForkError`, or logs each once when the outcome is a success, a cancellation or
 * another error, so cleanup never replaces the outcome.
 */
class ForkCleanup {
	readonly #runId: string;
	readonly #failures: ForkError[] = [];

	constructor(runId: string) {
		this.#runId = runId;
	}

	async step(step: ForkCleanupStep, forkRunId: string | undefined, action: () => Promise<void>): Promise<void> {
		try {
			await action();
		} catch (error) {
			this.#failures.push(new ForkCleanupError({ runId: this.#runId, step, forkRunId }, { cause: error as Error }));
		}
	}

	async releaseClaim(claim: SourceClaim): Promise<void> {
		try {
			await claim.release();
		} catch (error) {
			this.#failures.push(
				new ForkClaimReleaseError(
					{ runId: this.#runId, claimExpiresInMs: FOREIGN_LIVE_WORKFLOW_WINDOW_MS },
					{ cause: error as Error },
				),
			);
		}
	}

	settle(primary: unknown): void {
		for (const failure of this.#failures) {
			if (primary instanceof ForkError) primary.withCleanupCause(failure);
			else console.warn(failure);
		}
	}
}

/** How often a fork renews its claim on the source: a quarter of the window after which others may take it over. */
const SOURCE_CLAIM_RENEW_MS = FOREIGN_LIVE_WORKFLOW_WINDOW_MS / 4;

interface SourceClaim {
	/**
	 * Renews the claim and so proves, by the journal's clock and lease epoch, that nobody took the source over
	 * since it was claimed. A takeover starts a new epoch, so a renewal that succeeds also proves none happened
	 * earlier. Rejects with `ForkSourceBusyError` (`lease-lost`) once the source was taken over, and with
	 * `ForkJournalUnavailableError` (`claim`) when the journal cannot answer.
	 */
	assertHeld(): Promise<void>;
	/** Throws the typed failure as soon as a periodic renewal found the source taken over. Never reads the journal. */
	throwIfLost(): void;
	/** Stops the periodic renewal, waits for the one in flight, and releases the claim unless it was lost. */
	release(): Promise<void>;
}

async function claimSource(
	backend: JournalDurableBackend,
	runId: string,
	request: Pick<DurableForkRequest, "isLiveRun">,
): Promise<SourceClaim> {
	if (hasForkClaim(backend, runId)) throw new ForkSourceBusyError({ runId, reason: "fork-in-progress" });
	if (hasResumeClaim(backend, runId)) throw new ForkSourceBusyError({ runId, reason: "resume-in-progress" });
	if (backend.hasWorkflowExecution(runId) || request.isLiveRun?.(runId) === true)
		throw new ForkSourceBusyError({ runId, reason: "live-execution" });
	const claims = claimsOf(pendingForks, backend);
	claims.add(runId);
	const releaseLocal = () => {
		claims.delete(runId);
	};
	try {
		const claim = { runId, phase: "claim" } as const;
		const current = await inJournal(backend.journal, claim, () => backend.journal.leaseState(runId));
		// This process already holds the source's lease (its run ended here): that lease is kept alive and checked
		// like one the fork takes, and left to its holder at the end.
		if (current?.holderId === backend.holderId)
			return heldSourceClaim(
				backend,
				{ runId, holderId: current.holderId, epoch: current.epoch },
				releaseLocal,
				false,
			);
		const outcome = await inJournal(backend.journal, claim, () =>
			backend.journal.takeoverExpired(runId, `fork:${randomUUID()}`, FOREIGN_LIVE_WORKFLOW_WINDOW_MS),
		);
		if (outcome.status === "held")
			throw new ForkSourceBusyError({ runId, reason: "foreign-lease", holderId: outcome.holderId ?? undefined });
		return heldSourceClaim(backend, outcome.lease, releaseLocal, true);
	} catch (error) {
		releaseLocal();
		throw error;
	}
}

/** A `StaleLeaseError`, also one that crossed a bundle or realm boundary: by class, then by name, never by message. */
function isStaleLease(error: unknown): error is Error {
	return error instanceof StaleLeaseError || (error instanceof Error && error.name === "StaleLeaseError");
}

/**
 * The claim on a source whose journal lease the fork holds (`fromFork`) or this process already held. The lease lapses after
 * {@link FOREIGN_LIVE_WORKFLOW_WINDOW_MS} without a renewal, after which a resume may take the run over, so it is
 * renewed every {@link SOURCE_CLAIM_RENEW_MS} until released. A renewal that finds the lease taken over is
 * remembered as a `ForkSourceBusyError` and ends the renewals; a renewal the journal fails is retried on the next
 * tick, and `assertHeld` reports a failure that persists.
 *
 * What this guarantees: the fork materializes everything it reads from the source (journal events, then every
 * session entry) and calls `assertHeld` after that and before it writes. A takeover starts a new lease epoch and
 * the renewal checks the epoch, so a renewal that succeeds proves the source was not taken over, and so was not
 * written by a resume, at any time since the claim; the snapshot is one consistent state of the source. Nothing is
 * read from the source afterwards, so the write itself needs no fence: a takeover is possible only
 * {@link FOREIGN_LIVE_WORKFLOW_WINDOW_MS} after the last renewal, and it cannot change a snapshot already read.
 * A holder that was paused past its own lease and writes after waking is fenced out of the journal by its stale
 * epoch; its writes to a session store are not.
 */
function heldSourceClaim(
	backend: JournalDurableBackend,
	lease: Lease,
	releaseLocal: () => void,
	fromFork: boolean,
): SourceClaim {
	const { runId } = lease;
	let lost: ForkSourceBusyError | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let inFlight: Promise<void> | undefined;
	let stopped = false;
	const renew = async (): Promise<void> => {
		try {
			await backend.journal.renew(lease);
		} catch (error) {
			if (isStaleLease(error)) {
				// The epoch changed: the source was taken over. Who holds it now is not known from here.
				lost = new ForkSourceBusyError({ runId, reason: "lease-lost" }, { cause: error });
				throw lost;
			}
			if (!(error instanceof StorageError)) throw error;
			throw new ForkJournalUnavailableError(
				{ runId, phase: "claim", storage: journalStorage(backend.journal) },
				{ cause: error },
			);
		}
	};
	let warned = false;
	let timerFailure: unknown;
	const tick = async (): Promise<void> => {
		try {
			await renew();
			warned = false;
		} catch (error) {
			// A lost lease is thrown by the next `assertHeld`. Any other failure is retried on the next tick, and
			// logged once per streak of failures, with what failed as the cause, instead of being dropped.
			if (error === lost) return;
			const typed =
				error instanceof ForkJournalUnavailableError
					? error
					: new ForkJournalUnavailableError(
							{ runId, phase: "claim", storage: journalStorage(backend.journal) },
							{ cause: error as Error },
						);
			if (!warned) {
				warned = true;
				console.warn(typed);
			}
		}
	};
	const schedule = () => {
		if (stopped || lost !== undefined) return;
		timer = setTimeout(() => {
			inFlight = tick().then(
				() => {
					inFlight = undefined;
					schedule();
				},
				(error) => {
					// Only the report of a failure can fail here; `release` throws it once the release was attempted.
					timerFailure = error;
					inFlight = undefined;
					schedule();
				},
			);
		}, SOURCE_CLAIM_RENEW_MS);
		timer.unref();
	};
	schedule();
	return {
		assertHeld: async () => {
			await inFlight;
			if (lost !== undefined) throw lost;
			await renew();
			// A renewal that finds the source taken over can finish while this one's reply is still on its way.
			if (lost !== undefined) throw lost;
		},
		throwIfLost: () => {
			if (lost !== undefined) throw lost;
		},
		release: async () => {
			stopped = true;
			clearTimeout(timer);
			let failure: unknown = timerFailure;
			try {
				await inFlight;
				if (fromFork && lost === undefined) await backend.journal.release(lease);
			} catch (error) {
				failure =
					failure === undefined ? error : new AggregateError([failure, error], "The claim was not released");
			} finally {
				releaseLocal();
			}
			if (failure !== undefined) throw failure;
		},
	};
}

async function resolveForkDefinition(
	request: DurableForkRequest,
	handle: DurableWorkflowHandle,
): Promise<{ readonly definition: WorkflowDefinition; readonly inputs: WorkflowInputValues }> {
	let definition = request.definition;
	if (definition === undefined) {
		try {
			definition = await request.resolveDefinition?.(handle.name, handle.invocationCwd);
		} catch (error) {
			throw new ForkDefinitionMismatchError(
				{ runId: handle.workflowId, workflow: handle.name, reason: "definition-unavailable" },
				{ cause: error as Error },
			);
		}
	}
	if (!isWorkflowDefinition(definition))
		throw new ForkDefinitionMismatchError({
			runId: handle.workflowId,
			workflow: handle.name,
			reason: "definition-unavailable",
		});
	if (!workflowNamesEqual(definition.name, handle.name))
		throw new ForkDefinitionMismatchError({
			runId: handle.workflowId,
			workflow: handle.name,
			reason: "name-changed",
			definition: definition.name,
		});
	const label = `workflow "${definition.name}"`;
	if (request.inputs !== undefined) {
		try {
			return { definition, inputs: resolveAndValidateInputs(definition.inputs, request.inputs, label) };
		} catch (error) {
			throw new ForkConfigError(
				{ source: request.source, field: "inputs", expected: `inputs that satisfy ${label}` },
				{ cause: error as Error },
			);
		}
	}
	try {
		return {
			definition,
			inputs: resolveAndValidateInputs(definition.inputs, handle.inputs as WorkflowInputValues, label),
		};
	} catch (error) {
		throw new ForkDefinitionMismatchError(
			{ runId: handle.workflowId, workflow: handle.name, reason: "inputs-incompatible" },
			{ cause: error as Error },
		);
	}
}

interface ForkSelection {
	readonly stagePath?: string;
	readonly checkpoints: readonly DurableCheckpoint[];
	readonly messageEvents: readonly JournalEntry[];
	readonly pendingStageMessages: readonly PendingStageMessage[];
}

function selectForkEvents(source: ForkSource, request: DurableForkRequest): ForkSelection {
	const records = forkPointRecords(source.checkpoints);
	const target = records.find((record) => record.stagePath === request.fromStage);
	if (request.fromStage !== undefined && target === undefined)
		throw new ForkTargetNotFoundError({
			runId: source.runId,
			fromStage: request.fromStage,
			validStagePaths: records.map((record) => record.stagePath),
			totalValidStagePaths: records.length,
		});
	const cut = target?.firstSeq ?? Number.POSITIVE_INFINITY;
	const carryAll = request.carryMessages === "all";
	const prefix = source.checkpoints.filter((event) => event.seq < cut);
	const completed = new Set(
		prefix.flatMap(({ checkpoint }) =>
			checkpoint.kind === "stage" && checkpoint.output !== undefined ? [checkpoint.replayKey] : [],
		),
	);
	const keep = ({ seq, checkpoint }: CheckpointEvent): boolean => {
		if (seq >= cut) return carryAll && checkpoint.kind === "ui";
		if (target === undefined) return true;
		if (checkpoint.kind === "tool") return checkpoint.name !== RUN_RESULT_CHECKPOINT_NAME;
		if (checkpoint.kind === "ui") return true;
		return checkpoint.topology?.boundary !== undefined || completed.has(checkpoint.replayKey);
	};
	let handleAtCut: DurableWorkflowHandle | undefined;
	for (const entry of source.entries) {
		if (entry.seq >= cut) break;
		handleAtCut = decodeJournalEventHandle(entry.event, handleAtCut) ?? handleAtCut;
	}
	const messageHandle = carryAll ? source.handle : (handleAtCut ?? source.handle);
	return {
		...(target === undefined ? {} : { stagePath: target.stagePath }),
		checkpoints: source.checkpoints.filter(keep).map((event) => event.checkpoint),
		messageEvents: source.entries.filter(
			(entry) =>
				(entry.event.type === E.messageSettled || entry.event.type === E.messageDelivered) &&
				(carryAll || entry.seq < cut),
		),
		pendingStageMessages: messageHandle.pendingStageMessages ?? [],
	};
}

class ForkIdentities {
	private readonly ids: Map<string, string>;
	readonly sessions = new Map<string, { readonly id: string; readonly file: string | undefined }>();

	constructor(
		readonly sourceRunId: string,
		readonly forkRunId: string,
	) {
		this.ids = new Map([[sourceRunId, forkRunId]]);
	}

	run(id: string): string {
		let mapped = this.ids.get(id);
		if (mapped === undefined) {
			mapped = randomUUID();
			this.ids.set(id, mapped);
		}
		return mapped;
	}

	known(id: string): string {
		return this.ids.get(id) ?? id;
	}

	target(target: string): string {
		const parsed = parseWorkflowStageTarget(target);
		if (parsed === undefined || parsed.rootRunId !== this.sourceRunId) return target;
		return formatWorkflowStageTarget(this.forkRunId, ...parsed.segments.map((segment) => this.known(segment)));
	}

	session(id: string | undefined): string | undefined {
		return id === undefined ? undefined : (this.sessions.get(id)?.id ?? id);
	}

	sessionFile(id: string | undefined, file: string | undefined): string | undefined {
		const copied = id === undefined ? undefined : this.sessions.get(id);
		return copied === undefined ? file : copied.file;
	}

	runTopology(run: DurableStageRunTopology): DurableStageRunTopology {
		return {
			...run,
			runId: this.run(run.runId),
			...(run.parentRunId === undefined ? {} : { parentRunId: this.run(run.parentRunId) }),
			...(run.rootRunId === undefined ? {} : { rootRunId: this.forkRunId }),
		};
	}

	key(key: string | undefined): string | undefined {
		if (key === undefined) return undefined;
		const parsed = JSON.parse(key) as readonly (string | number)[];
		return JSON.stringify(parsed.map((part) => (typeof part === "string" ? this.known(part) : part)));
	}
}

/**
 * A copied `ctx.ui` answer under the fork's identity. A prompt identity hashes its root run id, so the
 * answer is rekeyed to the fork's id; an answer recorded before identities carried it is copied as is.
 */
function forkUiCheckpoint(checkpoint: Extract<DurableCheckpoint, { kind: "ui" }>, ids: ForkIdentities) {
	const copy = { ...checkpoint, workflowId: ids.forkRunId };
	let identity: Record<string, WorkflowSerializableValue> | null;
	try {
		identity = JSON.parse(checkpoint.message) as Record<string, WorkflowSerializableValue>;
	} catch {
		return copy;
	}
	if (identity?.rootWorkflowId !== ids.sourceRunId) return copy;
	const previous = durableHash(identity);
	if (!checkpoint.promptHash.endsWith(previous) || !checkpoint.checkpointId.endsWith(`ui:${previous}`)) return copy;
	const rekeyed = { ...identity, rootWorkflowId: ids.forkRunId };
	const hash = durableHash(rekeyed);
	return {
		...copy,
		checkpointId: `${checkpoint.checkpointId.slice(0, -previous.length)}${hash}`,
		promptHash: `${checkpoint.promptHash.slice(0, -previous.length)}${hash}`,
		message: JSON.stringify(rekeyed),
	};
}

function forkCheckpoint(checkpoint: DurableCheckpoint, ids: ForkIdentities): DurableCheckpoint {
	if (checkpoint.kind === "ui") return forkUiCheckpoint(checkpoint, ids);
	if (checkpoint.kind === "tool") {
		const toolTopology = checkpoint.topology;
		return {
			...checkpoint,
			workflowId: ids.forkRunId,
			...(toolTopology?.run === undefined
				? {}
				: { topology: { ...toolTopology, run: ids.runTopology(toolTopology.run) } }),
		};
	}
	const { sessionId: sourceSessionId, sessionFile: sourceSessionFile, ...stage } = checkpoint;
	const topology = checkpoint.topology;
	const boundary = topology?.boundary;
	const sourceSession = stageSessionId(checkpoint);
	const output = checkpoint.output;
	const taskOutput = isToolPayloadObject(output) && typeof output.text === "string" ? output : undefined;
	const childOutput = boundary === undefined ? undefined : parseWorkflowChildResult(output);
	const sessionId = ids.session(sourceSessionId);
	const sessionFile = ids.sessionFile(sourceSession, sourceSessionFile);
	const forkTaskOutput = () => {
		if (taskOutput === undefined || typeof taskOutput.sessionId !== "string") return undefined;
		const { sessionFile: taskFile, ...rest } = taskOutput;
		const file = typeof taskFile === "string" ? ids.sessionFile(taskOutput.sessionId, taskFile) : undefined;
		return {
			...rest,
			sessionId: ids.session(taskOutput.sessionId)!,
			...(file === undefined ? {} : { sessionFile: file }),
		};
	};
	const forkedTaskOutput = forkTaskOutput();
	return {
		...stage,
		workflowId: ids.forkRunId,
		...(childOutput === undefined ? {} : { output: { ...childOutput, runId: ids.run(childOutput.runId) } }),
		...(forkedTaskOutput === undefined ? {} : { output: forkedTaskOutput }),
		...(sessionId === undefined ? {} : { sessionId }),
		...(sessionFile === undefined ? {} : { sessionFile }),
		...(topology === undefined
			? {}
			: {
					topology: {
						...topology,
						intercomGroup: undefined,
						...(topology.run === undefined ? {} : { run: ids.runTopology(topology.run) }),
						...(boundary === undefined
							? {}
							: {
									boundary: {
										...boundary,
										child: {
											...boundary.child,
											runId: ids.run(boundary.child.runId),
											parentRunId: ids.run(boundary.child.parentRunId),
											rootRunId: ids.forkRunId,
										},
									},
								}),
					},
				}),
	};
}

function forkDelivery(delivery: PendingStageMessageDelivery, ids: ForkIdentities): PendingStageMessageDelivery {
	const sessionId = ids.session(delivery.sessionId);
	return { ...delivery, runId: ids.known(delivery.runId), ...(sessionId === undefined ? {} : { sessionId }) };
}

function forkMessage(message: PendingStageMessage, ids: ForkIdentities): PendingStageMessage {
	return {
		...message,
		runId: ids.known(message.runId),
		stageKey: ids.target(message.stageKey),
		...(message.targetPath === undefined ? {} : { targetPath: ids.target(message.targetPath) }),
		...(message.deliveries === undefined
			? {}
			: { deliveries: message.deliveries.map((delivery) => forkDelivery(delivery, ids)) }),
	};
}

function forkMessageEvent(entry: JournalEntry, ids: ForkIdentities): RunJournalSeedEvent {
	const key = ids.key(entry.key);
	const withKey = (event: RunEvent): RunJournalSeedEvent => (key === undefined ? { event } : { event, key });
	if (entry.event.type === E.messageSettled) {
		const payload = entry.event.payload as unknown as { readonly message: PendingStageMessage };
		return withKey({
			type: E.messageSettled,
			payload: { message: forkMessage(payload.message, ids) } as unknown as RunEvent["payload"],
		} as RunEvent);
	}
	const payload = entry.event.payload as unknown as {
		readonly messageId: string;
		readonly delivery: PendingStageMessageDelivery;
		readonly accounting?: { readonly messageRunId: string; readonly deliveryCount: number };
	};
	return withKey({
		type: E.messageDelivered,
		payload: {
			messageId: payload.messageId,
			delivery: forkDelivery(payload.delivery, ids),
			...(payload.accounting === undefined
				? {}
				: { accounting: { ...payload.accounting, messageRunId: ids.known(payload.accounting.messageRunId) } }),
		} as unknown as RunEvent["payload"],
	} as RunEvent);
}

function forkHandle(
	source: DurableWorkflowHandle,
	ids: ForkIdentities,
	request: ResolvedForkRequest,
	selection: ForkSelection,
	inputs: WorkflowInputValues,
): DurableWorkflowHandle {
	const {
		transitionClaimId: _transitionClaimId,
		rootWorkflowId: _rootWorkflowId,
		sessionFile: _sessionFile,
		releasedModelOwner: _releasedModelOwner,
		ownerExecutorId: _ownerExecutorId,
		ownerLiveness: _ownerLiveness,
		error: _error,
		exited: _exited,
		exitReason: _exitReason,
		failureKind: _failureKind,
		failureCode: _failureCode,
		failureRecoverability: _failureRecoverability,
		failureDisposition: _failureDisposition,
		failedToolNodeId: _failedToolNodeId,
		summary,
		summarizedThrough,
		modelOwner: _modelOwner,
		workflowCwd,
		repositoryRoot,
		gitWorktreeRoot,
		...carried
	} = source;
	const sameCwd = forkKeepsWorkspace(source, request.cwd);
	const now = Date.now();
	return {
		...carried,
		...(sameCwd && workflowCwd !== undefined ? { workflowCwd } : {}),
		...(sameCwd && repositoryRoot !== undefined ? { repositoryRoot } : {}),
		...(sameCwd && gitWorktreeRoot !== undefined ? { gitWorktreeRoot } : {}),
		...(request.modelOwner === undefined ? {} : { modelOwner: request.modelOwner }),
		...(selection.stagePath === undefined && summary !== undefined ? { summary, summarizedThrough } : {}),
		workflowId: ids.forkRunId,
		inputs: inputs as DurableWorkflowHandle["inputs"],
		invocationCwd: request.cwd,
		createdAt: now,
		updatedAt: now,
		status: "paused",
		resumable: true,
		completedCheckpoints: 0,
		pendingPrompts: 0,
		pendingStageMessages: selection.pendingStageMessages.map((message) => forkMessage(message, ids)),
		forkedFrom: {
			runId: source.workflowId,
			...(selection.stagePath === undefined ? {} : { stagePath: selection.stagePath }),
		},
	};
}

function checkpointKey(checkpoint: DurableCheckpoint): string {
	return JSON.stringify([E.checkpointRecorded, checkpoint.kind, checkpoint.checkpointId]);
}

/** The copies the fork made in one session store. */
interface CopiedSessions {
	readonly store: SessionStore;
	/** Each copy and the run its header names, so cleanup removes only the fork's own copies. */
	readonly copies: { readonly id: string; readonly runId: string }[];
	/** Whether the fork opened the store, and so closes it. */
	readonly owned: boolean;
}

async function removeSessions(copied: CopiedSessions): Promise<void> {
	const failures: Error[] = [];
	for (const { id, runId } of copied.copies) {
		try {
			if ((await copied.store.readHeader(id))?.workflow?.runId !== runId) continue;
			await copied.store.delete(id);
		} catch (error) {
			failures.push(error as Error);
		}
	}
	if (failures.length > 0)
		throw failures.length === 1
			? failures[0]
			: new AggregateError(failures, `${failures.length} copied fork sessions were not removed`);
}

async function removeCopies(copied: readonly CopiedSessions[], forkRunId: string, cleanup: ForkCleanup): Promise<void> {
	for (const group of copied) await cleanup.step("remove-copied-sessions", forkRunId, () => removeSessions(group));
}

async function closeCopies(copied: readonly CopiedSessions[], forkRunId: string, cleanup: ForkCleanup): Promise<void> {
	for (const group of copied)
		if (group.owned) await cleanup.step("close-destination-sessions", forkRunId, () => group.store.close());
}

/**
 * What the journal says about the fork run after its write rejected with `failure`. The write is one transaction,
 * so a run that is there is complete (`written`). A run that is absent is certainly unwritten (`absent`) only on a
 * journal local to this node, where a rejected write cannot commit later. On a shared journal a rejection can be a
 * lost reply to a commit that still lands, and a failed read-back says nothing: both are returned, not thrown, as
 * a non-retryable `ForkJournalUnavailableError` (`commit`) naming the fork run, and the caller keeps the copies.
 */
async function forkRunOutcome(
	journal: RunJournal,
	runId: string,
	forkRunId: string,
	failure: Error,
): Promise<"written" | "absent" | ForkJournalUnavailableError> {
	const storage = journalStorage(journal);
	const unconfirmed = (cause: Error) =>
		new ForkJournalUnavailableError({ runId, phase: "commit", forkRunId, storage }, { cause });
	let present: boolean;
	try {
		present = (await journal.getRun(forkRunId)) !== undefined;
	} catch (readFailure) {
		return unconfirmed(
			new AggregateError(
				[failure, readFailure],
				`Writing fork run ${forkRunId} failed, and reading it back failed too`,
			),
		);
	}
	if (present) return "written";
	return storage.scope === "local-only" ? "absent" : unconfirmed(failure);
}

/**
 * Fork a durable run. Every precondition is checked before the first write: the options, the source
 * run, the claim, the definition and inputs, the fork point and the readability of every session to
 * copy. Then sessions are copied and the fork's journal events are written in one transaction. On a
 * failure before that write nothing is left behind; on an abort the signal's reason is thrown. A rejected write
 * is read back: a fork the journal holds goes on, and an unconfirmed one on a shared journal keeps its copied
 * sessions (`ForkJournalUnavailableError`, `commit`, or the signal's reason after an abort). A failed cleanup step never replaces the outcome: it is
 * attached to a `ForkError`, or logged once.
 */
export async function forkDurableRun<
	TInputs extends WorkflowInputValues,
	TOutputs extends WorkflowOutputValues,
	TRunInputs extends WorkflowInputValues = TInputs,
>(
	backend: DurableWorkflowBackend,
	typedRequest: DurableForkRequest<WorkflowDefinition<TInputs, TOutputs, TRunInputs>>,
): Promise<DurableForkResult> {
	const forkRequest = typedRequest as never as DurableForkRequest;
	validateForkOptions(forkRequest.source, forkRequest.runId, { ...forkRequest, cwd: undefined });
	if (forkRequest.cwd !== undefined && (typeof forkRequest.cwd !== "string" || forkRequest.cwd.length === 0))
		throw new ForkConfigError({ source: forkRequest.source, field: "cwd", expected: "a directory path" });
	let request = forkRequest as ResolvedForkRequest;
	request.signal?.throwIfAborted();
	const journalBackend = forkJournal(backend);
	const preview = await readForkSource(journalBackend, request.runId, request.rootRunOf);
	request.signal?.throwIfAborted();
	forkRequest.validateSource?.(preview.handle);
	const claim = await claimSource(journalBackend, preview.runId, request);
	const cleanup = new ForkCleanup(preview.runId);
	let primary: unknown;
	try {
		const source = await readForkSource(journalBackend, preview.runId, request.rootRunOf);
		forkRequest.validateSource?.(source.handle);
		request = { ...forkRequest, cwd: forkDestinationCwd(forkRequest.cwd, source.handle) };
		request.signal?.throwIfAborted();
		const { definition, inputs } = await resolveForkDefinition(request, source.handle);
		const selection = selectForkEvents(source, request);
		const ids = new ForkIdentities(source.runId, randomUUID());
		const sessionCheckpoints = selection.checkpoints.flatMap((checkpoint) => {
			const sessionId = checkpoint.kind === "stage" ? stageSessionId(checkpoint) : undefined;
			return sessionId === undefined ? [] : [{ sessionId, checkpoint: checkpoint as DurableStageCheckpoint }];
		});
		const copied = await copySessions(source, sessionCheckpoints, ids, request, cleanup, claim);
		let retainCopies = false;
		try {
			request.signal?.throwIfAborted();
			const checkpoints = selection.checkpoints.map((checkpoint) => forkCheckpoint(checkpoint, ids));
			const messages = selection.messageEvents.map((entry) => forkMessageEvent(entry, ids));
			const handle = forkHandle(source.handle, ids, request, selection, inputs);
			const events: RunJournalSeedEvent[] = [
				{ event: { type: E.runStarted, payload: handle as unknown as RunEvent["payload"] } as RunEvent },
				...checkpoints.map((checkpoint) => ({
					event: {
						type: E.checkpointRecorded,
						payload: checkpoint as unknown as Extract<RunEvent, { type: "CheckpointRecorded" }>["payload"],
					} as RunEvent,
					key: checkpointKey(checkpoint),
				})),
				...messages,
				{
					event: {
						type: E.statusChanged,
						payload: { ...handle, completedCheckpoints: checkpoints.length } as unknown as Extract<
							RunEvent,
							{ type: "StatusChanged" }
						>["payload"],
					} as RunEvent,
				},
			];
			// Everything read from the source is in memory: if the claim still holds, it is one consistent state.
			await claim.assertHeld();
			request.signal?.throwIfAborted();
			let created: "created" | "exists" | undefined;
			let writeFailure: Error | undefined;
			try {
				created = await journalBackend.journal.createRunWithEvents(
					{
						runId: ids.forkRunId,
						name: handle.name,
						cwd: request.cwd,
						createdAt: handle.createdAt,
						status: handle.status,
						inputs: handle.inputs as unknown as RunEvent["payload"],
					},
					events,
				);
			} catch (error) {
				writeFailure = error as Error;
			}
			if (created === "exists")
				throw new ForkCopyFailedError(
					{ runId: source.runId, forkRunId: ids.forkRunId, phase: "journal" },
					{ cause: new Error(`Run ${ids.forkRunId} already exists`) },
				);
			if (writeFailure !== undefined) {
				// A rejection can follow the commit (a failed close, a lost reply): ask the journal before touching the copies.
				const outcome = await forkRunOutcome(journalBackend.journal, source.runId, ids.forkRunId, writeFailure);
				if (outcome === "absent") {
					request.signal?.throwIfAborted();
					throw new ForkCopyFailedError(
						{ runId: source.runId, forkRunId: ids.forkRunId, phase: "journal" },
						{ cause: writeFailure },
					);
				}
				if (outcome === "written")
					console.warn(
						new ForkJournalUnavailableError(
							{
								runId: source.runId,
								phase: "commit-confirmed",
								forkRunId: ids.forkRunId,
								storage: journalStorage(journalBackend.journal),
							},
							{ cause: writeFailure },
						),
					);
				else {
					// The fork may exist, so its copied sessions are live: keep them. A cancelled caller gets
					// the signal's reason, and the uncertainty is logged once instead.
					retainCopies = true;
					if (request.signal?.aborted !== true) throw outcome;
					console.warn(outcome);
					request.signal.throwIfAborted();
				}
			}
		} catch (error) {
			if (!retainCopies) await removeCopies(copied, ids.forkRunId, cleanup);
			throw error;
		} finally {
			await closeCopies(copied, ids.forkRunId, cleanup);
		}
		await inJournal(journalBackend.journal, { runId: source.runId, phase: "hydrate", forkRunId: ids.forkRunId }, () =>
			backend.hydrateWorkflow(ids.forkRunId),
		);
		return {
			runId: ids.forkRunId,
			forkedFrom: {
				runId: source.runId,
				...(selection.stagePath === undefined ? {} : { stagePath: selection.stagePath }),
			},
			definition,
			inputs,
			cwd: request.cwd,
		};
	} catch (error) {
		primary = error;
		throw error;
	} finally {
		await cleanup.releaseClaim(claim);
		cleanup.settle(primary);
	}
}

type SessionSnapshots = Map<
	string,
	{ readonly entries: readonly SessionEntry[]; readonly checkpoint: DurableStageCheckpoint }
>;

async function readSessions(
	source: ForkSource,
	sessions: readonly { readonly sessionId: string; readonly checkpoint: DurableStageCheckpoint }[],
	request: ResolvedForkRequest,
	cleanup: ForkCleanup,
	claim: SourceClaim,
): Promise<SessionSnapshots> {
	const sourceStore = await sourceSessionStoreFor(source.backend, source.handle, request, request.cwd);
	const snapshots: SessionSnapshots = new Map();
	try {
		for (const { sessionId, checkpoint } of sessions) {
			const known = snapshots.get(sessionId);
			if (known !== undefined) {
				if (known.checkpoint.topology === undefined) snapshots.set(sessionId, { ...known, checkpoint });
				continue;
			}
			claim.throwIfLost();
			const snapshot = await loadSession(sourceStore, sessionId, { runId: source.runId });
			snapshots.set(sessionId, { entries: snapshot.entries, checkpoint });
		}
		return snapshots;
	} finally {
		await closeSourceSessions(sourceStore, cleanup);
	}
}

/**
 * Copies the source's stage sessions under new ids, each where the fork's stage reopens it. A run with local workers
 * runs its child workflows on them, so the session of a stage in a child run is copied into the journal's pool tables,
 * which the child's work takes over once queued (`claimSessions`). Every other session goes to the fork's session
 * store. A copy's header names the stage's own run, as the session it copies does.
 */
async function copySessions(
	source: ForkSource,
	sessions: readonly { readonly sessionId: string; readonly checkpoint: DurableStageCheckpoint }[],
	ids: ForkIdentities,
	request: ResolvedForkRequest,
	cleanup: ForkCleanup,
	claim: SourceClaim,
): Promise<readonly CopiedSessions[]> {
	if (sessions.length === 0) return [];
	await claim.assertHeld();
	const snapshots = await readSessions(source, sessions, request, cleanup, claim);
	request.signal?.throwIfAborted();
	await claim.assertHeld();
	const copied: CopiedSessions[] = [];
	let project: CopiedSessions | undefined;
	let pool: CopiedSessions | undefined;
	const destinationFor = async (pooled: boolean): Promise<CopiedSessions> => {
		if (pooled) {
			if (pool === undefined) {
				const store = await poolSessionStore(source.backend, ids.forkRunId);
				if (store === undefined) throw new Error("The journal has no pool session tables for the fork's workers");
				pool = { store, copies: [], owned: true };
				copied.push(pool);
			}
			return pool;
		}
		if (project === undefined) {
			project = {
				store:
					request.sessionStore ??
					(await stageSessionStore({ cwd: forkSessionStoreCwd(source.handle, request.cwd) })),
				copies: [],
				owned: request.sessionStore === undefined,
			};
			copied.push(project);
		}
		return project;
	};
	try {
		for (const [sessionId, { entries, checkpoint }] of snapshots) {
			request.signal?.throwIfAborted();
			claim.throwIfLost();
			const stageRun = checkpoint.topology?.run?.runId;
			const destination = await destinationFor(
				source.handle.resources?.localWorkers !== undefined && stageRun !== undefined && stageRun !== source.runId,
			);
			const id = randomUUID();
			const runId = stageRun === undefined ? ids.forkRunId : ids.run(stageRun);
			destination.copies.push({ id, runId });
			await destination.store.create(
				{
					id,
					version: 4,
					createdAt: new Date().toISOString(),
					cwd: request.cwd,
					parentSessionId: sessionId,
					internal: true,
					workflow: {
						runId,
						stageId: checkpoint.topology?.stageId ?? checkpoint.checkpointId,
						stageName: checkpoint.name,
					},
				},
				entries,
			);
			const file = (await SessionManager.open(destination.store, id, request.cwd)).getSessionFile();
			ids.sessions.set(sessionId, { id, file });
		}
		return copied;
	} catch (error) {
		await removeCopies(copied, ids.forkRunId, cleanup);
		await closeCopies(copied, ids.forkRunId, cleanup);
		if (request.signal?.aborted === true && error === request.signal.reason) throw error;
		// A source taken over mid-copy is the claim's failure, not a failure of the copy itself.
		if (error instanceof ForkSourceBusyError) throw error;
		throw new ForkCopyFailedError(
			{ runId: source.runId, forkRunId: ids.forkRunId, phase: "sessions" },
			{ cause: error as Error },
		);
	}
}
