import { type ChildProcess, fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, rm, rmdir } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import {
	type ProviderRateLimitObservation,
	type SnapshotBlobStore,
	setDebugSetting,
	type WorktreeSnapshot,
} from "@bastani/atomic";
import { JournalShardUnavailableError, type StorageNotificationSubscription } from "@bastani/atomic/storage";
import { listenPoolReady, observeSqlPoolTransactions, sqlPoolStorage } from "../durable/journal/internal.js";
import { PoolRemoteJournal } from "../durable/journal/pool-remote-journal.js";
import { resolveRunJournal } from "../durable/journal/resolution.js";
import "../durable/journal/workflows-host-module.js";
import { poolCheckpointUsage } from "../durable/journal/pool-stage-usage.js";
import {
	openSqlPoolQueue,
	type PoolClaimCandidate,
	type PoolControl,
	type PoolWork,
	type SqlPoolQueue,
} from "../durable/journal/sql-pool-queue.js";
import { openSqlPoolUsage, type PoolUsage, type SqlPoolUsage } from "../durable/journal/sql-pool-usage.js";
import { SqlRateBuckets } from "../durable/journal/sql-rate-buckets.js";
import {
	type SharedPoolConfig,
	SqlSharedPool,
	STAGE_INPUT_PROMPT_ANSWER,
	type StageInputLease,
	WORKER_HOST_TTL_MS,
} from "../durable/journal/sql-shared-pool.js";
import {
	type IntercomMessageInput,
	type PooledStageInputKind,
	type PooledStageInputPayloads,
	type QuestionReadInput,
	stageInputOp,
	type UserMessageInput,
} from "../durable/journal/stage-input-kinds.js";
import { isStaleLeaseError, type Lease, type RunJournal } from "../durable/journal/types.js";
import { refusedAtChildStart } from "../engine/run-resume-preflight.js";
import { registerPendingStageIntercomBridge } from "../extension/pending-stage-intercom.js";
import { EMPTY_STAGE_QUEUED_USER_MESSAGES } from "../runs/foreground/stage-queued-user-messages.js";
import type { StageUserMessageDeliveryAction } from "../runs/foreground/stage-runner-types.js";
import { STAGE_SESSION_HEARTBEAT_INTERVAL_MS } from "../runs/foreground/stage-session-heartbeat.js";
import { rehydrateError, type SerializedError, serializeError } from "../shared/error-codec.js";
import { workflowInvocationIntercomGroup } from "../shared/intercom-group.js";
import { runSnapshotsFromRecord } from "../shared/legacy-waiting-status.js";
import { pathExists } from "../shared/path-exists.js";
import {
	rotateWorkflowPendingStageRouteCapability,
	workflowPendingStageRouteCapability,
} from "../shared/pending-stage-route-capability.js";
import { workflowPendingStageRouteReady } from "../shared/pending-stage-route-readiness.js";
import { createStore, type Store } from "../shared/store.js";
import type { RunSnapshot, StageSnapshot, WorkflowWorktreeRestoreOutcome } from "../shared/store-types.js";
import type { WorkflowSerializableObject } from "../shared/types.js";
import { isStaleWorkLeaseError, PoolNotInitializedError, StaleWorkLeaseError } from "../shared/worker-pool-errors.js";
import {
	failedOnPoolFault,
	infrastructureFaultOf,
	WorkerCleanupUnconfirmedError,
	WorkerLostError,
	WorkerRetryLimitError,
	type WorkerRetryLimitReason,
	WorkerStartupError,
	WorkerStartupTimeoutError,
} from "../shared/workflow-infrastructure-error.js";
import { workerProcessExited } from "./admission-host.js";
import { assertRouteOwned } from "./attempt-view.js";
import { CheckpointShipping } from "./checkpoint-shipping.js";
import type {
	CoordinatorCommand,
	CoordinatorCommandBody,
	CoordinatorEvent,
	CoordinatorInbound,
	CoordinatorNotice,
	CoordinatorPort,
	CoordinatorRequestBody,
	DeliveryPayload,
	PoolActivityEntry,
	PoolCoordinatorOptions,
	PoolRootProjection,
	PoolWorkToken,
	SharedPoolCoordination,
} from "./coordinator-protocol.js";
import {
	failedCoordinatorReply,
	POOL_COORDINATION_STATS_INTERVAL_MS,
	POOL_SUMMARY_INTERVAL_MS,
} from "./coordinator-protocol.js";
import type { WorkerDefinitionSource } from "./definitions.js";
import { missingSnapshotBlob } from "./dispatch-snapshot.js";
import { EndedWatches } from "./ended-watches.js";
import { FleetRateLimiter } from "./fleet-rate-limits.js";
import { hasLiveStageSession, releaseWorkerStages } from "./open-stages.js";
import {
	type BoundWait,
	boundWait,
	carriedSnapshot,
	choosePlacement,
	placedExecution,
	sharedSettlement,
	waitedMs,
} from "./placement-choice.js";
import {
	isStageInputTimeoutError,
	isStaleStageLeaseError,
	RemoteStageCommandUnsupportedError,
	type StageInputIdentity,
	StageInputRefusedError,
	WorkerPlacementConfigError,
	WorkspaceRestoreUnavailableError,
	workspaceBindingIdentity,
} from "./placement-errors.js";
import { PoolCoordinationCounters } from "./pool-coordination-stats.js";
import {
	durableJournalIdentity,
	openDurableJournal,
	type PoolDurableJournal,
	poolWorkerEnvironment,
} from "./pool-journal.js";
import {
	coordinatorWakeUps,
	IDLE_READY_PROBE_MS,
	IdleClaimBackoff,
	IdleClaimWaits,
	IdleReadyProbe,
} from "./pool-wake-ups.js";
import { configurePooledWatchTrace, tracePooledWatch } from "./pooled-watch-trace.js";
import { appendProcessLog, logFailureOf } from "./process-log.js";
import type {
	DistributiveOmit,
	WorkerPoolControl,
	WorkerRateLimits,
	WorkerRequest,
	WorkerStageCommand,
} from "./protocol.js";
import { RateLimitObservationOutbox, RateLimitObservationSet } from "./rate-limit-sharing.js";
import { type RemoteStageWatch, RemoteStageWatches } from "./remote-stage-watches.js";
import {
	type AdmissionConfiguration,
	type ProcessPermitScope,
	reapProcessGroups,
	SqlResourceAdmission,
	unconfirmedProcessGroups,
} from "./resource-admission.js";
import { RestoreBackoff } from "./restore-backoff.js";
import { RunChangesEncoder } from "./run-changes.js";
import { retireEndedShipShards, ShipShard, shipJournalDirectory, shipShardPath } from "./ship-shard.js";
import {
	earlierSessionReceipt,
	endedIntercomReason,
	endedUserMessage,
	type IntercomMessageReceipt,
	intercomMessageOutcome,
	intercomMessageResult,
	type QuestionReadReceipt,
	questionReadOutcome,
	questionReadResult,
	type UserMessageReceipt,
	userMessageOutcome,
	userMessageResult,
} from "./stage-input-receipts.js";
import { awaitStageInputReceipt, isAttempt, StageInputScheduler, workEnded, workHeld } from "./stage-input-wait.js";
import { runsWhilePaused } from "./stage-session-commands.js";
import { StageEventBacklog } from "./stage-watch-coalesce.js";
import type {
	AttemptRef,
	ControlRefusal,
	ControlResult,
	DeliveryOpId,
	DeliveryRefusal,
	DeliveryResult,
	IntercomRefusal,
	PooledBashResult,
	PooledPromptAnswer,
	PooledStageChatSnapshot,
	PooledStageDelivery,
	PooledStageQuestion,
	PooledStageSessionCommand,
	PooledTaskReply,
	PromptRefusal,
	PromptResult,
	SeqEvent,
	SessionCommandResult,
	StageInputDeferral,
	WatchEndReason,
	WatchId,
	WatchRefusal,
	WatchResult,
} from "./stage-watch-types.js";
import { ignoreStaleLease, ignoreStaleWorkLease } from "./stale-refusals.js";
import { startupWaitedMs } from "./startup-timeout.js";
import { PoolPlaces, WaitingWorkerReserve } from "./waiting-workers.js";
import type { WorkerHostGit } from "./worker-host-types.js";
import { AttemptLeaseExtensions, WORKER_REQUEST_LANES, WorkerRequestLanes } from "./worker-request-lanes.js";
import { defaultWorkerHeartbeatMs } from "./worker-timing.js";
import {
	type WorkspaceBinding,
	type WorkspaceHookOptions,
	type WorkspacePreference,
	type WorkspaceRestore,
	workspaceAffinityKey,
} from "./workspace-binding.js";

/** How long a control change waits for its next worker acknowledgement before it stops waiting (see `control`). */
const CONTROL_ACKNOWLEDGEMENT_STALL_MS = 5_000;
const RECOVERY_INTERVAL_MS = 500;
const TICK_INTERVAL_MS = 100;
const STALL_THRESHOLD_MS = 500;
const COORDINATOR_LEASE_MS = 3 * STAGE_SESSION_HEARTBEAT_INTERVAL_MS;
/** How often a pool whose root renews late asks again whether the renewal landed. */
const LATE_ROOT_POLL_MS = RECOVERY_INTERVAL_MS;
/** How often a pool on a journal in another database reads the root's lease there, well inside {@link COORDINATOR_LEASE_MS}. */
const MIRROR_INTERVAL_MS = 10_000;
const STDERR_DRAIN_GRACE_MS = 1_000;
/**
 * How long a worker sent SIGKILL has to be confirmed gone, counted in time this process was not stalled, before the pool
 * reports its cleanup unconfirmed.
 */
const WORKER_EXIT_CONFIRMATION_MS = 5_000;
/** Pause between checks of a worker sent SIGKILL. */
const WORKER_EXIT_POLL_MS = 50;
/** Attempts one child may lose in a root incarnation before only that child fails (#3979). */
const MAX_CHILD_ATTEMPTS = 3;
/**
 * How many times one child's attempts may be handed on uncounted because the shared store kept refusing them (#4768).
 * Past it, a handoff counts as an attempt, so a child whose writes no host gets through ends after its attempt limit
 * instead of moving between hosts for good.
 */
const MAX_CHILD_HANDOFFS = 20;
/** The wait before a handed-on child is claimable again: it doubles with each handoff, up to the cap below. */
const HANDOFF_DELAY_BASE_MS = 500;
const HANDOFF_DELAY_MAX_MS = 30_000;
/** Ready work a worker host reads at once to choose from by workspace affinity (shared placement). */
const PLACEMENT_CANDIDATES = 32;
/** How long a worker host trusts its own answer to whether it has a binding's tree warm. */
const PREFERENCE_CACHE_MS = 1_000;
/** Bindings a worker host remembers its warm answer for, before it forgets them all. */
const PREFERENCE_CACHE_ENTRIES = 256;
/** How often a shared pool's coordinator relays its activity, takes its stages' inputs and reads relayed activity. */
const SHARED_POLL_MS = 500;
/** Stage lease of an input being processed; renewed while it is. */
const STAGE_INPUT_LEASE_MS = 30_000;
/**
 * Longest the root waits for the receipt of a stage input it queued for a stage on another host (#4391), other than a
 * prompt answer, which waits for the attempt that asks. The input stays queued past it and is applied once.
 */
export const STAGE_INPUT_RECEIPT_TIMEOUT_MS = 60_000;
/**
 * Longest a host waits before it takes again an input its stage could not take yet: each time the stage refuses it,
 * the wait doubles from {@link SHARED_POLL_MS} up to this, so a stage that starts slowly costs few journal writes.
 */
export const STAGE_INPUT_RETRY_MAX_MS = 4_000;
/** Workers that may crash without work, in a row, before the pool fails. */
const MAX_WORKER_REPLACEMENTS = 3;
/**
 * Longest a starting stage waits for the broker to hold its run's route before it starts anyway.
 * It covers the route owner's reconnect backoff and its connect and acknowledgement timeouts; past
 * it, the stage's own Intercom keeps waiting for the owner.
 */
const ROUTE_REGISTRATION_WAIT_MS = 120_000;
/**
 * A watch whose undelivered events pass either bound is ended with `resync`; the watcher
 * reopens it for a fresh snapshot instead of the coordinator queueing without bound.
 */
export const STAGE_WATCH_BACKLOG_EVENTS = 2_000;
export const STAGE_WATCH_BACKLOG_BYTES = 8 * 1024 * 1024;
const PENDING_STAGE_MESSAGE_EVENT = "atomic:workflow-pending-stage-message";
const STICKY_LIVE_DELIVERED_EVENT = "atomic:workflow-sticky-live-delivered";
const PENDING_STAGE_UNDELIVERABLE_EVENT = "atomic:workflow-pending-stage-undeliverable";

type RouteOwner = ReturnType<typeof import("../../../intercom/workflow-route-owner.js").createWorkflowRouteOwner>;
type Bridge = ReturnType<typeof registerPendingStageIntercomBridge>;

function unconfirmedCleanup(groups: readonly number[]): WorkerCleanupUnconfirmedError {
	return new WorkerCleanupUnconfirmedError({ processGroups: groups });
}

export function workerLogDirectory(journalPath: string, root: string): string {
	return join(dirname(resolve(journalPath)), "worker-logs", encodeURIComponent(root).replaceAll(".", "%2E"));
}

/** The path beside which this host keeps a pool's diagnostics: its pool database, or its shared pool state directory. */
export function traceAnchor(options: {
	readonly journalPath?: string;
	readonly shared?: { readonly stateDirectory: string };
}): string {
	return options.shared === undefined ? options.journalPath! : join(options.shared.stateDirectory, "shared-pool");
}

function token(work: PoolWork): PoolWorkToken {
	return {
		id: work.id,
		generation: work.generation,
		worker: work.worker,
		epoch: work.epoch,
		renewedAt: work.renewedAt,
		expiresAt: work.expiresAt,
	};
}

/** Whether a later incarnation of a root runs again a child an earlier one completed with this result. */
function rerunsOnRootResume(result: WorkflowSerializableObject): boolean {
	return failedOnPoolFault(result) || refusedAtChildStart(result);
}

/**
 * What a view of a stage on another host's worker opens with (#4391): the stage's status and session from its relayed
 * run, and no transcript, since none streams from that host. Its session and turn read as started, so text sent to it
 * goes out at once; the host holds it until the stage can take it.
 */
function remoteStageSnapshot(stage: StageSnapshot): PooledStageChatSnapshot {
	return {
		sessionId: stage.sessionId,
		status: stage.status,
		publishedActivity: stage.chatActivity ?? "idle",
		isStreaming: false,
		messages: [],
		pendingToolExecutionEvents: [],
		queued: EMPTY_STAGE_QUEUED_USER_MESSAGES,
		deliveredOps: [],
		turnStarted: true,
		sessionStarted: true,
		seq: 0,
	};
}

/** The root run as the route mirror needs it: identities and child links of its stages, no payloads. */
export function projectRootRun(run: RunSnapshot): PoolRootProjection {
	return {
		id: run.id,
		name: run.name,
		status: run.status,
		startedAt: run.startedAt,
		stages: run.stages.map((stage) => ({
			id: stage.id,
			name: stage.name,
			status: stage.status,
			parentIds: [],
			toolEvents: [],
			...(stage.replayKey === undefined ? {} : { replayKey: stage.replayKey }),
			...(stage.intercomGroup === undefined ? {} : { intercomGroup: stage.intercomGroup }),
			...(stage.workflowChildRun === undefined ? {} : { workflowChildRun: stage.workflowChildRun }),
			...(stage.startedChildRunId === undefined ? {} : { startedChildRunId: stage.startedChildRunId }),
			...(stage.workflowChild === undefined ? {} : { workflowChild: { ...stage.workflowChild, outputs: {} } }),
		})),
	};
}

interface Attempt {
	readonly generation: number;
	readonly runs: Set<string>;
	fenced: boolean;
}

/**
 * Pending-stage routes of pooled runs, announced from the coordinator.
 *
 * The coordinator keeps a mirror store holding the root's stage identities and the
 * latest accepted snapshot of every pooled run, and runs the standard pending-stage
 * bridge over it with its own route owner, so the broker connections of pooled runs
 * never live in the root process. Messages and sticky notices that reach those routes
 * are forwarded to the root, whose store owns queued messages.
 */
class PooledRoutes {
	readonly mirror: Store = createStore();
	private readonly owners = new Map<string, PoolWorkToken>();
	private readonly attempts = new Map<string, Attempt>();
	private activated = false;
	private bridge?: Bridge;

	private constructor(
		private readonly root: string,
		private readonly owner: RouteOwner,
	) {}

	static async open(
		root: string,
		cwd: string,
		rootRun: PoolRootProjection | undefined,
		forward: (request: CoordinatorRequestBody) => Promise<unknown>,
	): Promise<PooledRoutes> {
		const { createWorkflowRouteOwner } = await import("../../../intercom/workflow-route-owner.js");
		const owner = createWorkflowRouteOwner(cwd);
		const routes = new PooledRoutes(root, owner);
		if (rootRun !== undefined) routes.updateRoot(rootRun);
		// The bridge announces and tracks readiness; message routing belongs to the root's store.
		routes.bridge = registerPendingStageIntercomBridge(
			{
				events: {
					emit: (event, payload) => owner.events.emit(event, payload),
					on: (event, listener) =>
						event === PENDING_STAGE_MESSAGE_EVENT || event === STICKY_LIVE_DELIVERED_EVENT
							? undefined
							: owner.events.on(event, listener),
				},
			},
			routes.mirror,
			(runId) => routes.activated && routes.owners.has(runId),
		);
		for (const [event, kind] of [
			[PENDING_STAGE_MESSAGE_EVENT, "pending-stage-message"],
			[STICKY_LIVE_DELIVERED_EVENT, "sticky-live-delivered"],
		] as const)
			owner.events.on(event, (payload) => {
				const claimed = payload as { handled?: boolean; completion?: Promise<unknown> };
				if (claimed.handled !== false) return;
				claimed.handled = true;
				const { handled: _handled, completion: _completion, ...forwarded } = claimed as Record<string, unknown>;
				claimed.completion = forward({ kind, payload: forwarded });
			});
		return routes;
	}

	updateRoot(rootRun: PoolRootProjection): void {
		this.mirror.recordRunStart({ ...rootRun, inputs: {}, toolNodes: [], rootRunId: this.root });
	}

	/** The attempt whose acknowledged snapshot is in the mirror for this run. */
	ownerOf(runId: string): PoolWorkToken | undefined {
		return this.owners.get(runId);
	}

	/** Applies publications the root accepted. */
	accept(entries: readonly PoolActivityEntry[]): void {
		this.mirror.batch(() => {
			for (const { work, runs } of entries) {
				let attempt = this.attempts.get(work.id);
				if (attempt !== undefined && work.generation < attempt.generation) continue;
				if (attempt === undefined || attempt.generation !== work.generation) {
					if (attempt !== undefined) this.release(attempt);
					attempt = { generation: work.generation, runs: attempt?.runs ?? new Set(), fenced: false };
					this.attempts.set(work.id, attempt);
				}
				if (attempt.fenced) continue;
				for (const run of runs) {
					attempt.runs.add(run.id);
					this.owners.set(run.id, work);
					const { pendingStageMessages: _messages, ...published } = run;
					this.mirror.recordRunStart({ ...published, rootRunId: this.root });
					if (run.stages.some((stage) => stage.pendingStageDeliveryAvailable === true)) this.activated = true;
				}
			}
		});
	}

	fence(work: Pick<PoolWork, "id" | "generation">): void {
		const attempt = this.attempts.get(work.id);
		if (attempt === undefined || attempt.generation > work.generation) return;
		if (attempt.generation < work.generation) {
			this.release(attempt);
			this.attempts.set(work.id, { generation: work.generation, runs: attempt.runs, fenced: true });
			return;
		}
		this.release(attempt);
		attempt.fenced = true;
	}

	async route(work: PoolWork, runId: string): Promise<string> {
		this.requireOwned(work, runId);
		const readiness = workflowPendingStageRouteReady(this.mirror, runId);
		// A publication that failed is retried by the route owner; the stage waits for that retry below.
		await readiness?.completion.catch(() => {});
		readiness?.assertCurrent();
		// #3904: a stage starts only once the broker holds its run's route, including a route the owner
		// is registering again after its connection dropped since an earlier acknowledgement.
		const waiting = new AbortController();
		await Promise.race([
			this.owner.registered(runId),
			delay(ROUTE_REGISTRATION_WAIT_MS, undefined, { signal: waiting.signal, ref: false }).catch(() => {}),
		]);
		waiting.abort();
		this.requireOwned(work, runId);
		return workflowPendingStageRouteCapability(this.mirror, runId);
	}

	async undeliverable(payload: Record<string, unknown>): Promise<boolean> {
		const event = { ...payload, handled: false } as Record<string, unknown> & {
			handled: boolean;
			completion?: Promise<boolean>;
		};
		this.owner.events.emit(PENDING_STAGE_UNDELIVERABLE_EVENT, event);
		return event.handled && (await event.completion) === true;
	}

	async close(): Promise<void> {
		const bridge = this.bridge;
		if (bridge === undefined) return;
		this.bridge = undefined;
		try {
			await bridge.flush();
		} finally {
			bridge.refresh();
			bridge();
			await this.owner.closeGroup(workflowInvocationIntercomGroup(this.root));
		}
	}

	private requireOwned(work: PoolWork, runId: string): void {
		assertRouteOwned(this.root, this.attempts.get(work.id), work, runId);
	}

	private release(attempt: Attempt): void {
		this.mirror.batch(() => {
			for (const id of attempt.runs) {
				rotateWorkflowPendingStageRouteCapability(this.mirror, id);
				releaseWorkerStages(this.mirror, id);
			}
		});
	}
}

/**
 * Whether a newer attempt, or completion, replaced `work`, among the root's work items as the queue holds them: its
 * item is gone, carries another generation, or completed.
 */
export function attemptSuperseded(items: readonly PoolWork[], work: Pick<PoolWork, "id" | "generation">): boolean {
	const current = items.find((candidate) => candidate.id === work.id);
	return current === undefined || current.generation !== work.generation || current.state === "completed";
}

/** Whether a worker holds an attempt, or has a claim in flight that may become one. */
function holding(slot: WorkerSlot): boolean {
	return slot.work !== undefined || slot.claiming === true;
}

function workerEndsCleanly(slot: WorkerSlot): boolean {
	return slot.leaving === true || slot.recycled === true || slot.retired === true;
}

interface WorkerSlot {
	readonly worker: string;
	readonly child: ChildProcess;
	work?: PoolWork;
	/** A claim it asked for is in flight: the child may be claimed already, its workspace still restoring (#4310). */
	claiming?: boolean;
	/** The child its claim in flight took, while its workspace is placed: a closing host puts it back (#4310). */
	claimed?: PoolWork;
	/** Aborted when the worker exits: its placement in flight is no longer waited for (#4310). */
	readonly exited: AbortController;
	readonly deliveries: Map<string, { resolve: () => void; reject: (error: Error) => void }>;
	/** Runs the current attempt published, so a stage watch can find the worker that runs it. */
	readonly runs: Set<string>;
	/** Stage commands awaiting the worker's result; undefined resolves a worker that exited. */
	readonly stageCommands: Map<number, (result: StageCommandResult | undefined) => void>;
	/** Ends the worker's attempt as its exit does; called for a worker that SIGKILL did not end within the bound. */
	retire?: () => void;
	/** The worker said it ends between children to give its memory back: its exit is not a crash (#4197). */
	recycled?: boolean;
	/** Where the current attempt runs on this host when placement chose it: a warm or restored worktree (#4310). */
	worktree?: string;
	/** The pool had more workers than its waiting attempts needed: this idle worker ends, and nothing replaces it. */
	retired?: boolean;
	leaving?: boolean;
	readonly idle: IdleClaimBackoff;
}

/**
 * What a worker host contributes to a satellite coordinator (#4310): its id, how it places bound work, and how it
 * learns that the satellite stopped serving its root.
 */
export interface SatellitePlacement {
	readonly host: string;
	/** The id the host's provisioner knows its instance by: a drain of the instance stops its claims (#5072). */
	readonly providerId?: string | undefined;
	/** The host's warm worktrees: the path of one whose current tree is the binding's, or undefined. */
	readonly prefer?: WorkspacePreference;
	/** The host's restore port, present only when one is configured and git is available. */
	readonly restore?: WorkspaceRestore;
	/**
	 * When the host restores each binding again whose restores failed, shared by every root it serves (#4416). Without
	 * it, the satellite keeps its own.
	 */
	readonly restoreBackoff?: RestoreBackoff;
	/** Called once when the satellite stops serving its root: its lease was lost or the satellite failed. */
	readonly detached: (reason: Error | undefined) => void;
	/** Called with each failure of `prefer` or `restore`; the work it was for goes back to the queue. */
	readonly placementFailed: (error: Error) => void;
	/** The git the host runs: its workers run it first on their `PATH`, and its hooks are given it. */
	readonly git?: WorkerHostGit;
}

/** Everything a satellite coordinator attaches with: the root it serves, as the shared journal holds it. */
export interface SatelliteAttachment {
	readonly root: string;
	readonly lease: Lease;
	readonly journal: RunJournal;
	readonly config: SharedPoolConfig;
	/** The root's definitions this host can run: the same module path and entry digest. */
	readonly sources: readonly WorkerDefinitionSource[];
	readonly workers: number;
	readonly durable: PoolDurableJournal;
	readonly stateDirectory: string;
	readonly placement: SatellitePlacement;
	/** The module forked for each worker: the shipped worker entry, since the host process is not one. */
	readonly workerEntry: string;
}

interface StageCommandResult {
	readonly snapshot?: PooledStageChatSnapshot;
	readonly refusal?:
		| WatchRefusal
		| DeliveryRefusal
		| ControlRefusal
		| PromptRefusal
		| IntercomRefusal
		| StageInputDeferral;
	readonly action?: StageUserMessageDeliveryAction;
	readonly question?: PooledStageQuestion;
	readonly bash?: PooledBashResult;
	readonly task?: PooledTaskReply;
	readonly error?: SerializedError;
}

/** How many ended watches the coordinator remembers, to refuse late deliveries truthfully. */
const ENDED_WATCHES_REMEMBERED = 1_024;

/** One open stage watch: bound to the attempt it opened on, with at most one batch awaiting the root. */
interface StageWatch {
	readonly slot: WorkerSlot;
	readonly attempt: AttemptRef;
	open: boolean;
	inFlight: boolean;
	readonly pending: StageEventBacklog;
}

/**
 * Owns a local worker pool for one root, outside the root's main thread.
 *
 * It forks and supervises the workers, decodes and answers their IPC, performs every
 * pool journal write on its own SQLite connection, keeps worker leases alive and
 * recovers expired ones, and announces the Intercom routes of pooled runs. The root
 * receives activity summaries coalesced per work attempt at most every
 * {@link POOL_SUMMARY_INTERVAL_MS}, plus results and the lifecycle events that need its store.
 */

/**
 * `work` as claimed, without the worktree snapshot it carries when `blobs`, the root's journal's in another database
 * than the pool's, no longer hold a blob of it (#5077); its row then carries none either. The pool's own database cannot
 * check that as the work is queued, so a child never restores from a snapshot its blobs were collected from.
 */
export async function claimedWithStoredSnapshot(
	queue: SqlPoolQueue,
	work: PoolWork,
	blobs: SnapshotBlobStore | undefined,
): Promise<PoolWork> {
	const snapshot = carriedSnapshot(work.execution);
	if (blobs === undefined || snapshot === undefined) return work;
	return (await missingSnapshotBlob(blobs, snapshot)) === undefined ? work : queue.dropWorkSnapshot(work);
}
export class PoolCoordinator {
	private readonly children = new Set<ChildProcess>();
	private readonly incarnations = new Map<string, ChildProcess>();
	private readonly readyWorkers = new Set<string>();
	private readonly logs = new Map<ChildProcess, string>();
	/** Logs of workers whose cleanup could not be confirmed: close keeps them. */
	private readonly keptLogs = new Set<string>();
	/** Why each worker log the pool could not write failed, by its path; the pool reports the first one. */
	private readonly logFailures = new Map<string, string>();
	private logsOpened: Promise<void> = Promise.resolve();
	/** Workers that SIGKILL did not end within the bound, already reported. */
	private readonly unconfirmedExits = new WeakSet<ChildProcess>();
	/** Set once the pool reported its own failure to the root: close then keeps every worker's log. */
	private failed = false;
	private readonly cleanups = new Set<Promise<void>>();
	private readonly controlAcks = new Map<string, number>();
	private readonly lastHeard = new Map<string, { readonly at: number; readonly stalled: number }>();
	/**
	 * Requests of each worker this coordinator has not answered yet. A worker sends its next heartbeat only once the
	 * previous one is answered, so while one waits here the worker waits on the pool: its silence is the pool's (a slow
	 * journal, a busy root), not the worker's, and lease recovery must not end it.
	 */
	private readonly awaiting = new Map<string, number>();
	private readonly pendingActivity = new Map<string, PoolActivityEntry>();
	private readonly sentRuns = new RunChangesEncoder();
	private readonly batches = new Map<number, { readonly entries: readonly PoolActivityEntry[]; settle(): void }>();
	/** The root's refusal of each work's latest refused publication, bound to the attempt that published it. */
	private readonly publicationFailures = new Map<string, { readonly generation: number; readonly error: Error }>();
	private readonly requests = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
	private readonly deliveryRequests = new Map<number, { readonly slot: WorkerSlot; readonly workerRequest: number }>();
	private readonly inflight = new Set<Promise<unknown>>();
	private readonly slots = new Set<WorkerSlot>();
	private readonly watches = new Map<WatchId, StageWatch>();
	private readonly endedWatches = new EndedWatches(ENDED_WATCHES_REMEMBERED);
	private stageCommandSequence = 0;
	private promptNodes = false;
	/** Provider and model limits recorded anywhere in the pool, sent to every worker and the root (#4023). */
	private readonly rateLimits = new RateLimitObservationSet();
	/** The root's fleet-wide model rate limits and shared cooldowns, on a shared pool that sets them (#4768). */
	private fleetRates?: FleetRateLimiter;
	/** The fleet rate limits' mode last reported in the coordination stats. */
	private reportedRateMode?: string;
	private readonly rateLimitOutbox = new RateLimitObservationOutbox((observations) =>
		this.shareRateLimits(observations),
	);
	private lastTick = performance.now();
	private stalledMs = 0;
	private readonly ticker: NodeJS.Timeout;
	/** Requests and journal writes by kind, sent to the root while they change. */
	private readonly counters = new PoolCoordinationCounters();
	private readonly statsTimer: NodeJS.Timeout;
	/** The newest pool control committed, as pushed to ready workers. */
	private committedControl?: PoolControl;
	private recoveryTimer?: NodeJS.Timeout;
	private readyProbeTimer?: NodeJS.Timeout;
	private claimRetryTimer?: NodeJS.Timeout;
	private claimRetryAt = Number.POSITIVE_INFINITY;
	private poolReady?: StorageNotificationSubscription;
	private readonly idleClaims = new IdleClaimWaits();
	private claimsGated = false;
	private lagGated = false;
	private flushTimer?: NodeJS.Timeout;
	private lastFlushAt = 0;
	private batchSequence = 0;
	private requestSequence = 0;
	private usageChanged = false;
	private budgetBlocked = false;
	private shipping: CheckpointShipping | undefined;
	private readonly progress = new Map<string, { readonly generation: number; at: number; checkpoints: number }>();
	private openingShipping?: Promise<CheckpointShipping | undefined>;
	private desiredControl?: PoolControl["state"];
	private root?: string;
	private lease?: Lease;
	private options?: PoolCoordinatorOptions;
	/** The database holding the pool's tables. */
	private journal?: RunJournal;
	/** The root's durable journal when it lives in another database than `journal` (see {@link PoolRemoteJournal}). */
	private durable?: RunJournal;
	private remote?: PoolRemoteJournal;
	private mirrorTimer?: NodeJS.Timeout;
	private queue?: SqlPoolQueue;
	private usageLedger?: SqlPoolUsage;
	private usageTotal?: PoolUsage;
	private admission?: SqlResourceAdmission;
	private routes?: PooledRoutes;
	private publishing = false;
	private sources: readonly WorkerDefinitionSource[] = [];
	private logDirectory?: string;
	private starting?: Promise<void>;
	private recovering?: Promise<void>;
	private nextRecoveryAt = 0;
	private hasPendingHandoff = false;
	private cleanupFailure?: Error;
	/** Work of exited workers whose leases recovery extends instead of expiring, while their process groups are reaped. */
	private readonly held = new Set<string>();
	/** Workers or attempts whose reap left process groups running; close reports those still running. */
	private readonly unreaped: ProcessPermitScope[] = [];
	/**
	 * Earlier incarnations' attempts kept leased because their process groups were not confirmed gone, by work id.
	 * `enqueued` records that this incarnation's root enqueued the attempt while it was still leased, so its release
	 * must adopt it into the current epoch: the enqueue cannot, as it adopts only released work (#3979).
	 */
	private readonly retained = new Map<string, { enqueued: boolean }>();
	/** Serializes enqueues with releases of retained attempts, so an enqueue is never lost between the two. */
	private retainedTransitions: Promise<void> = Promise.resolve();
	private closed = false;
	/** Aborted when the coordinator closes: a restore in flight is no longer waited for (#4310). */
	private readonly closedSignal = new AbortController();
	/** Aborted when a satellite drains or closes: it places no more work, so a `prefer` call in flight is not waited for. */
	private readonly placingSignal = new AbortController();
	private closing?: Promise<void>;
	private replacements = 0;
	/** Whether the pool has said that its workers' memory limit replaces every worker after one child. */
	private recycleLimitReported = false;
	/** Set once the root's lease is gone: workers then end without counting as crashes, and none is replaced. */
	private rootLeaseLost = false;
	private rootEnded = false;
	/** Settles once a late root renewal lands (true) or the root's lease is lost or the pool closes (false). */
	private lateRoot?: Promise<boolean>;
	/** Generation of each work item when this root incarnation enqueued it: attempts count from here (#3979). */
	private readonly attemptBase = new Map<string, number>();
	/** Extra workers started so attempts that wait released stop occupying the pool. */
	private readonly waitingReserve = new WaitingWorkerReserve();
	/** The pool's places, which bound the attempts that run at once to its count. */
	private readonly places = new PoolPlaces<WorkerSlot>(() => this.options!.workers);
	/** The shared pool's own tables, for a pool whose tables live in the root's shared journal (#4310). */
	private sharedPool?: SqlSharedPool;
	/** Set for a worker host's coordinator, which serves a root that runs on another host (#4310). */
	private satellite?: SatellitePlacement;
	/** Whether this coordinator closes the journal it uses; a satellite uses its host's. */
	private ownsJournal = true;
	private sharedTimer?: NodeJS.Timeout;
	private sharedPass?: Promise<void>;
	/** Final and periodic relays run in order: an older snapshot must not overwrite a completed child's last one. */
	private sharedActivity = Promise.resolve();
	/** Relayed activity already read, by version (the root's coordinator of a shared pool). */
	private activityCursor = 0;
	/** Work whose result reached the root. */
	private readonly reportedResults = new Set<string>();
	/** How long each bound work item has waited for a host that runs it, by `performance.now()` (#4416). */
	private readonly boundWaits = new Map<string, BoundWait>();
	/** When this satellite restores each binding again whose restores failed, unless its host shares its own (#4416). */
	private readonly restoreBackoff = new RestoreBackoff();
	/** Activity of this host's attempts not relayed yet (a satellite). */
	private readonly relayPending = new Map<string, PoolActivityEntry>();
	/** A worker host's claims since its host last took them: see {@link takeClaims}. */
	private readonly claimLog: PoolWork[] = [];
	/** Failures of unclaimed work whose write met an unreachable journal, by work id, until a pass settles them (#4768). */
	private readonly unreportedFailures = new Map<string, WorkerRetryLimitError | WorkspaceRestoreUnavailableError>();
	/** Which stages' next inputs this coordinator takes on a pass, by run and stage. */
	private readonly inputScheduler = new StageInputScheduler(SHARED_POLL_MS, STAGE_INPUT_RETRY_MAX_MS);
	/** Runs of attempts on other hosts, as their activity was relayed, and the root's views of their stages (#4391). */
	private readonly remoteWatches = new RemoteStageWatches(hasLiveStageSession);
	/** Warm worktrees by binding identity, as the host last answered, with when it answered. */
	private readonly preferences = new Map<string, { readonly path: string | undefined; readonly at: number }>();
	/** Set once a satellite stops taking new work, to finish what it holds and close. */
	private draining = false;
	/** Set once a satellite told its host it stopped serving its root. */
	private detachNoticed = false;

	constructor(private readonly port: CoordinatorPort<CoordinatorEvent, CoordinatorInbound>) {
		port.onMessage((message) => this.receive(message));
		this.ticker = setInterval(() => this.observeResponsiveness(), TICK_INTERVAL_MS).unref();
		this.statsTimer = setInterval(() => this.sendCoordinationStats(), POOL_COORDINATION_STATS_INTERVAL_MS).unref();
	}

	/** The pool's journal, with every pool transaction on it counted by the request or task that submits it. */
	private async openCountedJournal(path: string): Promise<RunJournal> {
		return this.countedJournal(await resolveRunJournal({ journal: { path } }));
	}

	private countedJournal(journal: RunJournal): RunJournal {
		observeSqlPoolTransactions(journal, () => this.counters.write());
		return journal;
	}

	private sendCoordinationStats(): void {
		const mode = this.fleetRates?.mode;
		const stats = this.counters.sample(mode === this.reportedRateMode);
		this.reportedRateMode = mode;
		if (stats !== undefined)
			this.port.send({ kind: "coordination", stats: mode === undefined ? stats : { ...stats, rateLimit: mode } });
	}

	/** The fleet rate limits' mode, when the root sets any: `"local-fallback"` while the journal does not answer. */
	get rateLimitMode(): "store" | "local-fallback" | undefined {
		return this.fleetRates?.mode;
	}

	/** Closes the journal connection once the pool is closed and every command already received has settled. */
	async shutdown(): Promise<void> {
		await this.closing?.catch(() => {});
		while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
		if (this.ownsJournal) await this.journal?.close().catch(() => {});
		await this.durable?.close().catch(() => {});
	}

	/**
	 * Runs one pool operation under the root's lease. A root that renews late still holds its lease, with the same holder
	 * and epoch, so a refusal for that reason waits for the renewal and runs the operation again instead of failing the
	 * child or the pool: a busy root process, a reload or other runs starting in it must not end a live root's children.
	 * A refused operation changed nothing, so running it again is safe. A lease that is gone is refused as before.
	 * `resume` runs after each wait, before the operation runs again: an attempt's own work lease can lapse during the
	 * wait, so an operation bound to an attempt renews it there (and is fenced there if another attempt replaced it).
	 */
	private async whileRootLate<T>(
		queue: SqlPoolQueue,
		action: () => Promise<T>,
		resume?: () => Promise<void>,
	): Promise<T> {
		for (let waited = false; ; ) {
			try {
				if (waited) await resume?.();
				return await action();
			} catch (error) {
				if (!isStaleLeaseError(error) || !(await this.rootRenewal(queue))) throw error;
				waited = true;
			}
		}
	}

	/** Whether the root's lease is current again after a late renewal; false once it is lost or the pool closes. */
	private rootRenewal(queue: SqlPoolQueue): Promise<boolean> {
		this.lateRoot ??= this.awaitRootRenewal(queue).finally(() => {
			this.lateRoot = undefined;
		});
		return this.lateRoot;
	}

	private async awaitRootRenewal(queue: SqlPoolQueue): Promise<boolean> {
		const lease = this.lease!;
		const since = performance.now();
		let late = false;
		try {
			for (;;) {
				if (this.closed) return false;
				// A journal in another database is read again for its lease; one that gave the lease away is a lost lease.
				const lost = await this.remote?.fresh(lease).then(
					() => false,
					() => true,
				);
				if (lost) return false;
				const standing = await queue.rootLease(lease, COORDINATOR_LEASE_MS);
				if (standing !== "late") return standing === "current";
				late = true;
				await delay(LATE_ROOT_POLL_MS);
			}
		} finally {
			// Workers wait for their answers while the root is late, so their silence then is the pool's, not theirs.
			if (late) this.stalledMs += performance.now() - since;
		}
	}

	private receive(message: CoordinatorInbound): void {
		if (message.kind === "request-reply") {
			const pending = this.requests.get(message.id);
			this.requests.delete(message.id);
			if (message.error !== undefined) pending?.reject(rehydrateError(message.error));
			else pending?.resolve(message.value);
			return;
		}
		const kind = `root-${message.kind}`;
		this.counters.request(kind);
		if ("id" in message) {
			const command = message as CoordinatorCommand;
			const handled = this.counters
				.within(kind, () => this.execute(command))
				.then(
					(value) => this.port.send({ kind: "reply", id: command.id, value }),
					(error: unknown) => this.port.send(failedCoordinatorReply(command.id, error)),
				);
			this.inflight.add(handled);
			void handled.finally(() => this.inflight.delete(handled));
			return;
		}
		this.counters.within(kind, () => this.notice(message as CoordinatorNotice));
	}

	private notice(notice: CoordinatorNotice): void {
		if (notice.kind === "stage-events-applied") this.stageEventsApplied(notice.watch);
		else if (notice.kind === "budget") this.noteBudget(notice.blocked);
		else if (notice.kind === "root") this.routes?.updateRoot(notice.rootRun);
		else if (notice.kind === "rate-limits") this.observeRateLimits(notice.observations);
		else if (notice.kind === "debug") setDebugSetting(notice.enabled);
		else {
			const batch = this.batches.get(notice.batch);
			this.batches.delete(notice.batch);
			const rejected = new Map(notice.rejected.map((entry) => [entry.workId, entry]));
			for (const entry of rejected.values()) {
				const error = rehydrateError(entry.error);
				// The root's store refused the publication only for a while (unreachable, or busy): it is not the attempt's
				// failure. What the root last took of the attempt is forgotten and its refused activity goes out again, in
				// full, unless newer activity already waits (#4768).
				if (infrastructureFaultOf(error) === "storage_unavailable") {
					this.sentRuns.forget(entry.workId);
					const refused = batch?.entries.find((published) => published.work.id === entry.workId);
					if (refused !== undefined && !this.pendingActivity.has(entry.workId))
						this.pendingActivity.set(entry.workId, refused);
					this.scheduleFlush();
					continue;
				}
				this.publicationFailures.set(entry.workId, { generation: entry.generation, error });
			}
			this.routes?.accept(
				(batch?.entries ?? []).filter((entry) => rejected.get(entry.work.id)?.generation !== entry.work.generation),
			);
			batch?.settle();
		}
	}

	private async execute(command: CoordinatorCommandBody): Promise<unknown> {
		switch (command.kind) {
			case "prepare":
				return this.prepare(command.root, command.lease, command.options, command.control);
			case "control":
				return this.control(command.state);
			case "start":
				this.promptNodes = command.promptNodes === true;
				this.starting ??= this.start(command.sources, command.cwd, command.publish, command.rootRun);
				return this.starting;
			case "enqueue":
				return this.enqueue(command);
			case "transport":
				return this.transport(command.request, command);
			case "undeliverable":
				return (await this.routes?.undeliverable(command.payload)) ?? false;
			case "stage-watch":
				return this.stageWatch(command.watch, command.runId, command.stageId);
			case "stage-unwatch":
				this.stageUnwatch(command.watch);
				this.endedWatches.delete(command.watch);
				return;
			case "stage-deliver":
				return this.stageDeliver(command);
			case "stage-question":
				return this.stageQuestion(command.runId, command.stageId, command.promptId);
			case "stage-intercom":
				return this.stageIntercom(command);
			case "stage-answer":
				return this.stageAnswer(command.runId, command.stageId, command.answer);
			case "stage-pause":
				return this.stageControl(command.watch, { op: "pause" });
			case "stage-session":
				return this.stageSession(command.watch, command.command);
			case "stage-resume":
				return this.stageControl(command.watch, {
					op: "resume",
					...(command.message === undefined
						? {}
						: { message: { deliveryOp: command.message.op, text: command.message.text } }),
				});
			case "close":
				this.closing ??= this.close();
				return this.closing;
		}
	}

	private async prepare(
		root: string,
		lease: Lease,
		options: PoolCoordinatorOptions,
		control: PoolControl["state"] | undefined,
	): Promise<PoolUsage> {
		if (this.closed) throw new Error("Local worker pool is closed");
		if (this.root !== undefined && this.root !== root) throw new Error("Local worker pool belongs to another root");
		this.root = root;
		this.options = options;
		this.desiredControl ??= control;
		configurePooledWatchTrace(traceAnchor(options), "coordinator");
		// A shared pool's tables live in the root's own journal, which this process opens by its durable selection.
		if (options.shared !== undefined)
			this.journal ??= await this.countedJournal(await openDurableJournal(options.durable));
		else {
			if (options.journalShard !== undefined && !(await pathExists(options.journalPath)))
				throw new JournalShardUnavailableError({
					code: "shard-missing",
					shardId: options.journalShard,
					shardPath: options.journalPath,
					runId: root,
				});
			this.journal ??= await this.openCountedJournal(options.journalPath);
			if (options.durable !== undefined && this.remote === undefined) {
				this.durable = await openDurableJournal(options.durable);
				this.remote = new PoolRemoteJournal(this.durable, sqlPoolStorage(this.journal)!);
			}
		}
		// The queue reads the root's status and lease from the database it shares with them: bring them up to date first.
		await this.remote?.mirror(lease);
		this.usageLedger ??= await openSqlPoolUsage(this.journal);
		this.usageTotal = await this.usageLedger.total(root);
		this.lease = lease;
		const queue = await openSqlPoolQueue(this.journal, this.remote);
		await this.whileRootLate(queue, () => queue.initialize(lease, COORDINATOR_LEASE_MS));
		if (options.shared !== undefined) {
			this.sharedPool ??= await SqlSharedPool.open(this.journal, queue);
			await this.startFleetRates();
		}
		if (options.shared !== undefined && this.shipping === undefined) {
			const shipping = await this.openShipping(root, options.durable, options.shared, queue);
			if (this.closed) {
				await shipping?.close().catch(() => {});
				throw new Error("Local worker pool is closed");
			}
			this.shipping = shipping;
		}
		// Events an earlier incarnation of this root accepted and never delivered reach the journal before any attempt runs.
		await this.whileRootLate(queue, () => queue.drainOutbox(lease));
		if (this.remote !== undefined) {
			const remote = this.remote;
			// Keeps the lease the queue sees as fresh as the journal's own while no worker asks; a lease lost for good fails
			// every worker's next request, which is how a pool learns it.
			this.mirrorTimer = setInterval(() => void remote.fresh(lease, 0).catch(() => {}), MIRROR_INTERVAL_MS).unref();
		}
		// An earlier incarnation's attempt whose process groups are not confirmed gone stays leased: replaying it
		// would run alongside them. Its groups on this host are reaped below; recovery releases it once they are gone.
		const retained: PoolWork[] = [];
		for (const work of await queue.inspect(root))
			if (
				work.state === "leased" &&
				work.epoch < lease.epoch &&
				(await unconfirmedProcessGroups(this.journal, root, { attempt: work })).length > 0
			)
				retained.push(work);
		await this.whileRootLate(queue, () =>
			queue.releasePreviousIncarnations(
				lease,
				retained.map((work) => work.id),
			),
		);
		for (;;) {
			const intended = this.desiredControl ?? "running";
			const committed = await this.whileRootLate(queue, () => queue.setControl(lease, intended));
			this.publishControl(committed);
			if (intended === (this.desiredControl ?? "running")) break;
		}
		this.queue = queue;
		for (const work of retained) {
			this.retained.set(work.id, { enqueued: false });
			this.held.add(work.id);
			const reaping = this.reapRetained(work);
			this.cleanups.add(reaping);
			void reaping.finally(() => this.cleanups.delete(reaping));
		}
		return this.usageTotal;
	}

	/**
	 * Reaps a retained earlier attempt's process groups on this host with the bounded SIGTERM, then SIGKILL, sequence,
	 * then releases the attempt for replay. Groups that survive the bound keep their permits quarantined, and close
	 * reports them: they are a health event of the pool, and the child replays within its attempt limit as for any lost
	 * attempt rather than failing. Groups on another host cannot be reaped: the attempt stays retained until recovery
	 * confirms them gone.
	 */
	private async reapRetained(work: PoolWork): Promise<void> {
		try {
			const { survivors, unprobeable } = await reapProcessGroups(this.journal!, this.root!, { attempt: work });
			if (survivors.length > 0) {
				this.unreaped.push({ attempt: work });
				this.reportHealth(
					undefined,
					`${unconfirmedCleanup(survivors).message}; child ${work.childRunId} of an earlier incarnation replays`,
				);
			}
			if (unprobeable.length === 0) await this.releaseRetained(work);
		} catch (error) {
			this.cleanupFailure ??= error instanceof Error ? error : new Error(String(error));
		} finally {
			this.held.delete(work.id);
		}
	}

	/** Releases a retained earlier attempt whose groups are gone, adopting it if this incarnation enqueued it. */
	private releaseRetained(work: PoolWork): Promise<void> {
		return this.retainedTransition(async () => {
			const record = this.retained.get(work.id);
			this.retained.delete(work.id);
			// A stale token means the attempt already changed hands: nothing is left to release.
			await this.whileRootLate(this.queue!, () =>
				this.queue!.releaseRetained(this.lease!, work, record?.enqueued === true),
			).catch(ignoreStaleWorkLease);
		});
	}

	private retainedTransition<T>(action: () => Promise<T>): Promise<T> {
		const result = this.retainedTransitions.then(action);
		this.retainedTransitions = result.then(
			() => {},
			() => {},
		);
		return result;
	}

	/**
	 * Records the pool's control state, pushes it to the ready workers, then waits for them to acknowledge it. The state
	 * is durable: a worker that misses the push reads it again in its next heartbeat's reply, and a worker that starts
	 * later reads it before it claims work. So the wait is a confirmation, not a delivery: it lasts while
	 * acknowledgements keep arriving, and it ends without failing once none has arrived for
	 * {@link CONTROL_ACKNOWLEDGEMENT_STALL_MS}, outside this process's own stalls. A busy host slows the acknowledgements
	 * of hundreds of workers; it never fails a pause or resume. Returns how many ready workers had not acknowledged it yet.
	 */
	private async control(state: PoolControl["state"]): Promise<number> {
		this.desiredControl = state;
		if (!this.queue || !this.lease) return 0;
		const queue = this.queue;
		const lease = this.lease;
		const control = await this.whileRootLate(queue, () => queue.setControl(lease, state));
		this.publishControl(control);
		const unacknowledged = () =>
			[...this.readyWorkers].filter((worker) => (this.controlAcks.get(worker) ?? -1) < control.revision).length;
		let pending = unacknowledged();
		let progressAt = performance.now();
		let stalledAt = this.stalledMs;
		while (pending > 0) {
			if (this.desiredControl !== state) return pending;
			await delay(25);
			this.observeResponsiveness();
			const now = unacknowledged();
			if (now < pending) {
				pending = now;
				progressAt = performance.now();
				stalledAt = this.stalledMs;
			} else if (performance.now() - progressAt - (this.stalledMs - stalledAt) >= CONTROL_ACKNOWLEDGEMENT_STALL_MS)
				break;
		}
		// Whatever workers published before acknowledging reaches the root before the acknowledgement.
		this.flush();
		return pending;
	}

	/**
	 * Pushes committed pool control to every ready worker, so a pause or quit reaches a running attempt at once rather
	 * than with its next heartbeat. An older revision than one already pushed is never sent: commits can settle out of
	 * order. A worker that is not ready yet reads the control itself before it claims work. A worker the push cannot
	 * reach is stopped, as one a reply cannot reach is: the pool replaces it and replays its child.
	 */
	private publishControl(control: PoolControl): void {
		if (this.committedControl !== undefined && control.revision <= this.committedControl.revision) return;
		this.committedControl = control;
		for (const slot of this.slots) slot.idle.reset();
		this.idleClaims.wakeAll();
		const message: WorkerPoolControl = { kind: "pool-control", control };
		for (const slot of this.slots)
			if (this.readyWorkers.has(slot.worker) && slot.child.connected && !workerEndsCleanly(slot))
				slot.child.send(message, (error) => {
					if (error && !workerEndsCleanly(slot)) slot.child.kill("SIGKILL");
				});
	}

	private async start(
		sources: readonly WorkerDefinitionSource[],
		cwd: string,
		publish: boolean,
		rootRun: PoolRootProjection | undefined,
	): Promise<void> {
		if (this.closed) throw new Error("Local worker pool is closed");
		const root = this.root;
		if (!this.queue || !this.lease || !this.options || root === undefined || this.lease.runId !== root)
			throw new PoolNotInitializedError({ root });
		this.sources = sources;
		this.publishing = publish;
		if (publish) {
			this.routes = await PooledRoutes.open(root, cwd, rootRun, (request) => this.request(request));
			if (this.closed) {
				await this.routes.close();
				throw new Error("Local worker pool is closed");
			}
		}
		if (this.options.admission)
			this.admission = await SqlResourceAdmission.open(this.journal!, {
				...this.options.admission,
				root,
				holder: "coordinator",
				...(this.options.shared === undefined ? {} : { crossHost: true }),
			});
		this.logDirectory = workerLogDirectory(traceAnchor(this.options), root);
		await this.publishSharedConfig(sources);
		this.startRecovery();
		const workers = Array.from({ length: this.options.workers }, () => this.spawn());
		try {
			await Promise.any(workers);
		} catch (error) {
			throw (error as AggregateError).errors[0];
		}
	}

	/**
	 * The root's budget block: its own workers start no child and admit no session or command, and a shared pool's root
	 * records it in the journal for the hosts that serve it (#4310).
	 */
	private noteBudget(blocked: boolean): void {
		this.budgetBlocked = blocked;
		if (!blocked) this.gateOpened();
		const shared = this.sharedPool;
		if (shared === undefined || this.satellite !== undefined || this.queue === undefined || this.lease === undefined)
			return;
		const lease = this.lease;
		void this.whileRootLate(this.queue, () => shared.publishBudget(lease, blocked)).catch((error: Error) => {
			if (!isStaleLeaseError(error)) this.fail(error);
		});
	}

	private openShipping(
		root: string,
		durable: PoolDurableJournal | undefined,
		shared: SharedPoolCoordination,
		queue: SqlPoolQueue,
	): Promise<CheckpointShipping | undefined> {
		const opening = this.openRootShipping(root, durable, shared, queue);
		this.openingShipping = opening;
		return opening.finally(() => {
			if (this.openingShipping === opening) this.openingShipping = undefined;
		});
	}

	private async openRootShipping(
		root: string,
		durable: PoolDurableJournal | undefined,
		shared: SharedPoolCoordination,
		queue: SqlPoolQueue,
	): Promise<CheckpointShipping | undefined> {
		if (this.closed || durable === undefined) return undefined;
		const identity = durableJournalIdentity(durable);
		if (this.remote === undefined)
			await retireEndedShipShards(
				shipJournalDirectory(shared.stateDirectory, identity),
				(roots, works, unidentified) => queue.endedShipRoots(roots, works, unidentified),
			).catch(() => {});
		if (this.closed || shared.checkpointShipping === undefined) return undefined;
		if (this.remote !== undefined)
			throw new WorkerPlacementConfigError(
				"sdk",
				"workers.checkpointShipping",
				"unsupported-option",
				'a pool whose root journal is in another database stages and delivers its checkpoints itself; use checkpointShipping "sync", or keep the root journal in the shared database',
			);
		let shard: ShipShard;
		try {
			shard = await ShipShard.open(shipShardPath(shared.stateDirectory, identity, root), root);
		} catch (error) {
			if (!this.closed)
				this.port.send({
					kind: "health",
					message: `checkpoint shipping: the local journal could not open for root ${root}, which commits every checkpoint to the shared journal on this host from now on: ${(error as Error).message}`,
				});
			return undefined;
		}
		if (this.closed) {
			await shard.close().catch(() => {});
			return undefined;
		}
		const shipping = new CheckpointShipping(shard, {
			...shared.checkpointShipping,
			host: shared.host,
			deliver: (attempt, batch) => queue.shipBatch(this.lease!, attempt, batch),
			rootStanding: () => queue.rootLease(this.lease!, COORDINATOR_LEASE_MS),
			sessionState: (attempt, session) => queue.poolSessionState(attempt.id, session),
			snapshotsStored: (checkpoint) => queue.assertSnapshotsStored(checkpoint),
			onFallback: ({ workId, error }) =>
				this.port.send({
					kind: "health",
					message: `checkpoint shipping: the local journal failed for work ${workId}, which commits every checkpoint to the shared journal from now on: ${error.message}`,
				}),
			onReleaseFailure: ({ workId, error }) =>
				this.port.send({
					kind: "health",
					message: `checkpoint shipping: work ${workId} was released with checkpoints still unshipped, which its replay runs again unless this host ships them before another attempt takes the work: ${error.message}`,
				}),
		});
		shipping.start();
		return shipping;
	}

	/** A worker host's satellite takes up its root's budget block, as the host last read it from the journal (#4310). */
	followBudget(blocked: boolean): void {
		this.budgetBlocked = blocked;
		if (!blocked) this.gateOpened();
	}

	private gateOpened(): void {
		this.lagGated = false;
		if (!this.claimsGated) return;
		this.claimsGated = false;
		this.idleClaims.wakeAll();
	}

	private retireWaiting(): void {
		const options = this.options;
		if (options === undefined || this.waitingReserve.size <= Math.min(this.places.waiting, options.workers)) return;
		this.idleClaims.wakeAll();
	}

	/** Starts the recovery of expired attempts, every {@link RECOVERY_INTERVAL_MS}. */
	private startRecovery(): void {
		const recover = () => {
			if (this.lagGated && !this.budgetBlocked && this.shipping?.lagging() !== true) this.gateOpened();
			if (this.hasPendingHandoff) this.nextRecoveryAt = 0;
			this.counters.enter("recovery");
			void this.recoverExpired().catch(async (error: Error) => {
				// A late root renewal stops nothing: the next recovery runs once it lands.
				if (this.queue && isStaleLeaseError(error) && (await this.rootRenewal(this.queue).catch(() => false)))
					return;
				// Nor does a journal that is unreachable for now: the next recovery tries again (#4768).
				if (infrastructureFaultOf(error) === "storage_unavailable") return;
				this.fail(error);
			});
		};
		this.recoveryTimer = setInterval(recover, RECOVERY_INTERVAL_MS).unref();
		this.startReadyProbe();
		// A shared pool's journal on Postgres says when its root's work became ready or an attempt ended (#5103): an idle
		// worker asks for work at once, and the root settles what another host's worker ended, instead of at their polls.
		if (this.options?.shared === undefined) return;
		this.poolReady = listenPoolReady(
			this.journal!,
			coordinatorWakeUps({
				root: () => this.root,
				satellite: this.satellite !== undefined,
				pauses: this.idleClaims,
				recovering: () => this.recovering,
				recover: () => {
					this.nextRecoveryAt = 0;
					recover();
				},
			}),
		);
	}

	private startReadyProbe(): void {
		const notifications = sqlPoolStorage(this.journal!)?.notifications;
		const probe = new IdleReadyProbe({
			waits: this.idleClaims,
			notified: async () =>
				this.poolReady !== undefined &&
				notifications !== undefined &&
				(await notifications.state()).status === "listening",
			mark: async () => {
				const queue = this.queue;
				const root = this.root;
				return queue === undefined || root === undefined || this.closed ? undefined : queue.readyMark(root);
			},
		});
		this.readyProbeTimer = setInterval(() => {
			this.counters.enter("ready-probe");
			void probe.tick();
		}, IDLE_READY_PROBE_MS).unref();
	}

	/** Publishes a shared pool's configuration for worker hosts, and starts its relay and stage input passes. */
	private async publishSharedConfig(sources: readonly WorkerDefinitionSource[]): Promise<void> {
		const options = this.options!;
		const shared = this.sharedPool;
		if (options.shared === undefined || shared === undefined) return;
		const lease = this.lease!;
		const config: SharedPoolConfig = {
			definitions: sources.map(({ path, exportName, digest }) => ({ path, exportName, digest })),
			...(options.admission === undefined ? {} : { admission: options.admission }),
			leaseMs: options.leaseMs,
			heartbeatMs: options.heartbeatMs,
			startupTimeoutMs: options.startupTimeoutMs,
			...(options.stageStartMaxLoadPerCpu === undefined
				? {}
				: { stageStartMaxLoadPerCpu: options.stageStartMaxLoadPerCpu }),
			...(options.maxWorkerRssBytes === undefined ? {} : { maxWorkerRssBytes: options.maxWorkerRssBytes }),
			claimWindowMs: options.shared.claimWindowMs,
			...(options.shared.checkpointShipping === undefined
				? {}
				: { checkpointShipping: options.shared.checkpointShipping }),
			...(this.promptNodes ? { promptNodes: true } : {}),
			...(options.shared.rateLimits === undefined ? {} : { rateLimits: options.shared.rateLimits }),
			...(options.shared.shareCooldowns === true ? { shareCooldowns: true } : {}),
		};
		await this.whileRootLate(this.queue!, () => shared.publishConfig(lease, config, this.budgetBlocked));
		this.startSharedPasses();
	}

	/**
	 * Serves a root whose pool runs on the shared journal from another host (#4310): forks this host's workers for it
	 * and answers them under the root's current lease, as the root's own coordinator does, but does nothing only the root
	 * does (initializing its pool, enqueueing its children, settling its earlier incarnations, failing a child). It stops
	 * once that lease is lost or it fails, and tells its host through `placement.detached`; the host then attaches a new
	 * satellite to the root's next incarnation.
	 */
	async attachSatellite(attachment: SatelliteAttachment): Promise<void> {
		if (this.closed) throw new Error("Local worker pool is closed");
		const { root, lease, journal, config, placement } = attachment;
		this.satellite = placement;
		this.ownsJournal = false;
		this.root = root;
		this.lease = lease;
		this.journal = journal;
		this.options = {
			workers: attachment.workers,
			leaseMs: config.leaseMs,
			heartbeatMs: config.heartbeatMs,
			startupTimeoutMs: config.startupTimeoutMs,
			...(config.admission === undefined ? {} : { admission: config.admission as AdmissionConfiguration }),
			...(config.stageStartMaxLoadPerCpu === undefined
				? {}
				: { stageStartMaxLoadPerCpu: config.stageStartMaxLoadPerCpu }),
			...(config.maxWorkerRssBytes === undefined ? {} : { maxWorkerRssBytes: config.maxWorkerRssBytes }),
			workerEntry: attachment.workerEntry,
			durable: attachment.durable,
			shared: {
				stateDirectory: attachment.stateDirectory,
				host: placement.host,
				claimWindowMs: config.claimWindowMs,
				...(config.checkpointShipping === undefined ? {} : { checkpointShipping: config.checkpointShipping }),
				...(config.rateLimits === undefined ? {} : { rateLimits: config.rateLimits }),
				...(config.shareCooldowns === true ? { shareCooldowns: true } : {}),
			},
		};
		configurePooledWatchTrace(traceAnchor(this.options), `satellite:${placement.host}`);
		this.usageLedger = await openSqlPoolUsage(journal);
		this.usageTotal = await this.usageLedger.total(root);
		const queue = await openSqlPoolQueue(journal);
		this.sharedPool = await SqlSharedPool.open(journal, queue);
		const shipping = await this.openShipping(root, attachment.durable, this.options.shared!, queue);
		if (this.closed) {
			await shipping?.close().catch(() => {});
			return;
		}
		this.shipping = shipping;
		this.queue = queue;
		await this.startFleetRates();
		this.sources = attachment.sources;
		this.promptNodes = config.promptNodes === true;
		if (this.closed) return;
		if (this.options.admission)
			this.admission = await SqlResourceAdmission.open(journal, {
				...this.options.admission,
				root,
				holder: "coordinator",
				// The root saves its own limits; a host that serves it admits against them as saved.
				rootLimits: "unchanged",
				crossHost: true,
			});
		this.logDirectory = workerLogDirectory(traceAnchor(this.options), root);
		await mkdir(this.logDirectory, { recursive: true });
		// A host that stopped while this satellite attached starts nothing for it: its stop does not wait for the attach.
		if (this.closed) return;
		this.starting = Promise.resolve();
		this.startRecovery();
		this.startSharedPasses();
		const workers = Array.from({ length: attachment.workers }, () => this.spawn());
		try {
			await Promise.any(workers);
		} catch (error) {
			// Workers that a stop ended before they were ready are no failed attach.
			if (this.closed) return;
			throw (error as AggregateError).errors[0];
		}
	}

	/** Whether a satellite stopped serving its root: its lease was lost, or it failed. */
	get detached(): boolean {
		return this.detachNoticed;
	}

	/** How many workers this coordinator runs, and how many of them hold an attempt. */
	workerCounts(): { readonly workers: number; readonly busy: number } {
		return { workers: this.slots.size, busy: [...this.slots].filter(holding).length };
	}

	/** The work this coordinator's workers hold now. */
	heldWork(): readonly PoolWork[] {
		return [...this.slots].flatMap((slot) => (slot.work === undefined ? [] : [slot.work]));
	}

	shippingStatus():
		| { readonly lagMs: number; readonly pending: number; readonly lagging: boolean; readonly error?: Error }
		| undefined {
		const shipping = this.shipping;
		if (shipping === undefined) return undefined;
		return { ...shipping.status(), lagging: shipping.lagging() };
	}

	childProgress(
		now = performance.now(),
	): { readonly work: string; readonly agoMs: number; readonly checkpoints: number }[] {
		const held = new Map(this.heldWork().map((work) => [work.id, work.generation]));
		const progress: { readonly work: string; readonly agoMs: number; readonly checkpoints: number }[] = [];
		for (const [work, entry] of this.progress) {
			if (held.get(work) !== entry.generation) {
				this.progress.delete(work);
				continue;
			}
			progress.push({ work, agoMs: Math.max(0, Math.round(now - entry.at)), checkpoints: entry.checkpoints });
		}
		return progress;
	}

	private noteProgress(slot: WorkerSlot, work: PoolWork, checkpoint: boolean): void {
		if (!this.slots.has(slot) || slot.work?.id !== work.id || slot.work.generation !== work.generation) return;
		const entry = this.progress.get(work.id);
		const current = entry?.generation === work.generation ? entry : undefined;
		this.progress.set(work.id, {
			generation: work.generation,
			at: performance.now(),
			checkpoints: (current?.checkpoints ?? 0) + (checkpoint ? 1 : 0),
		});
	}

	private forgetProgress(work: PoolWork): void {
		if (this.progress.get(work.id)?.generation === work.generation) this.progress.delete(work.id);
	}

	private attemptEnded(slot: WorkerSlot, work: PoolWork | undefined): void {
		this.fleetRates?.releaseWorker(slot.worker);
		if (work !== undefined) this.forgetProgress(work);
		slot.work = undefined;
		slot.worktree = undefined;
		this.places.end(slot);
		this.gateOpened();
		this.retireWaiting();
	}

	/** The work a worker host's workers claimed since the last call, however briefly they held it (#4768). */
	takeClaims(): readonly PoolWork[] {
		return this.claimLog.splice(0);
	}

	/**
	 * The worker's attempt waits released and gives its place back. The place goes to a woken attempt that asked for one,
	 * or to the next child; the pool starts a worker for each waiting attempt, at most its `count`, to run it, while the
	 * waiting attempt stays where it runs. A worker host does not: its host bounds its workers. A worker that cannot
	 * start is reported once.
	 */
	private releasePlace(slot: WorkerSlot): void {
		this.places.release(slot);
		this.gateOpened();
		if (this.closed || this.satellite !== undefined) return;
		const reserve = this.waitingReserve;
		for (let started = reserve.grow(this.places.waiting, this.options!.workers); started > 0; started--) {
			void this.spawn().catch((error: Error) => {
				reserve.lost();
				this.reportHealth(undefined, `A worker started while children wait could not start: ${error.message}`);
			});
		}
	}

	/**
	 * Whether an idle worker ends now: fewer attempts wait than the pool started extra workers for, and the pool keeps
	 * `count` ready workers without it.
	 */
	private retiresIdle(slot: WorkerSlot): boolean {
		const count = this.options!.workers;
		let others = 0;
		for (const other of this.slots)
			if (other !== slot && other.retired !== true && this.readyWorkers.has(other.worker)) others++;
		if (others < count || !this.waitingReserve.shrink(this.places.waiting, count)) return false;
		slot.retired = true;
		return true;
	}

	/** A satellite stops taking work, finishes what its workers hold, then closes. */
	async drain(): Promise<void> {
		this.draining = true;
		this.placingSignal.abort();
		this.idleClaims.wakeAll();
		while (!this.closed && [...this.slots].some(holding)) await delay(RECOVERY_INTERVAL_MS);
		this.closing ??= this.close();
		await this.closing;
	}

	/** Closes a satellite at once: its workers stop, and the work they held goes back to the queue. */
	stopSatellite(options: { readonly rootEnded?: boolean } = {}): Promise<void> {
		if (options.rootEnded === true) this.rootEnded = true;
		this.closing ??= this.close();
		return this.closing;
	}

	private detach(reason: Error | undefined): void {
		const satellite = this.satellite;
		if (satellite === undefined || this.detachNoticed) return;
		this.detachNoticed = true;
		satellite.detached(reason);
	}

	private startSharedPasses(): void {
		this.sharedTimer ??= setInterval(() => {
			if (this.sharedPass !== undefined || this.closed) return;
			this.sharedPass = this.sharedPassOnce()
				.catch(async (error: Error) => {
					if (isStaleLeaseError(error)) {
						// A late root is waited out; a lost one ends a satellite, and the root's own pool learns it elsewhere.
						if (this.queue && (await this.rootRenewal(this.queue).catch(() => false))) return;
						if (this.satellite !== undefined) {
							this.rootLeaseLost = true;
							this.detach(error);
						}
						return;
					}
					// The journal is unreachable for now: the next pass tries again, and the workers keep their children
					// while their leases last (#4768).
					if (infrastructureFaultOf(error) === "storage_unavailable") return;
					this.fail(error);
				})
				.finally(() => {
					this.sharedPass = undefined;
				});
		}, SHARED_POLL_MS).unref();
	}

	/**
	 * One pass of a shared pool's coordinator: a satellite relays its attempts' activity to the root; the root's
	 * coordinator reads what other hosts relayed; both take the next input of each stage their workers run.
	 */
	private async sharedPassOnce(): Promise<void> {
		// The passes start once the pool's tables, lease and root are set; they hold off while the root renews late.
		if (this.lateRoot !== undefined) return;
		const shared = this.sharedPool!;
		const lease = this.lease!;
		const root = this.root!;
		await this.syncSharedActivity(shared, lease);
		if (this.satellite === undefined && this.publishing) await this.readPoolUsage(root);
		await this.takeStageInputs(shared, lease, root);
	}

	private syncSharedActivity(shared: SqlSharedPool, lease: Lease): Promise<void> {
		const transfer = this.sharedActivity.then(() => {
			if (this.satellite !== undefined) return this.relayActivity(shared, lease);
			if (this.publishing) return this.readRelayedActivity(shared, lease.runId);
		});
		this.sharedActivity = transfer.catch(() => {});
		return transfer;
	}

	/** Relays the latest activity of this host's attempts, at most once per pass. */
	private async relayActivity(shared: SqlSharedPool, lease: Lease): Promise<void> {
		if (this.relayPending.size === 0) return;
		const entries = [...this.relayPending.values()];
		this.relayPending.clear();
		try {
			await shared.relayActivity(
				lease,
				entries.map((entry) => ({ work: entry.work, runs: JSON.stringify(entry.runs) })),
			);
		} catch (error) {
			// What did not reach the journal goes with the next pass, unless newer activity of the same work replaced it.
			for (const entry of entries)
				if (!this.relayPending.has(entry.work.id)) this.relayPending.set(entry.work.id, entry);
			throw error;
		}
	}

	/** Passes activity other hosts relayed to the root, as this coordinator's own workers' activity reaches it. */
	private async readRelayedActivity(shared: SqlSharedPool, root: string): Promise<void> {
		const relayed = await shared.activityAfter(root, this.activityCursor);
		const local = new Set([...this.slots].flatMap((slot) => (slot.work === undefined ? [] : [slot.work.id])));
		for (const entry of relayed) {
			this.activityCursor = Math.max(this.activityCursor, entry.version);
			// A work item this host now runs publishes through its own worker.
			if (local.has(entry.work.id) || !this.attemptBase.has(entry.work.id)) continue;
			const runs = runSnapshotsFromRecord(JSON.parse(entry.runs) as readonly RunSnapshot[]);
			this.pendingActivity.set(entry.work.id, { work: entry.work, runs });
			for (const [id, reason] of this.remoteWatches.relayed(entry.work, runs)) this.endRemoteWatch(id, reason);
		}
		if (relayed.length > 0) this.scheduleFlush();
	}

	/** Ends a view of a stage on another host for the root, as a worker ends a watch. */
	private endRemoteWatch(id: WatchId, reason: WatchEndReason): void {
		this.endedWatches.remember(id, reason);
		this.port.send({ kind: "stage-watch-ended", watch: id, reason });
	}

	/** Takes up the pool's usage total, which other hosts' workers add to, so the root's budgets count their spending. */
	private async readPoolUsage(root: string): Promise<void> {
		const total = await this.usageLedger!.total(root);
		if (this.usageTotal === undefined || !isDeepStrictEqual(total, this.usageTotal)) this.noteUsage(total);
	}

	/**
	 * Takes and processes the next input of each stage this host's workers run, one input per stage at a time. An
	 * input the stage cannot take yet stays its next input, taken again after a growing wait; a replaced attempt's
	 * input goes to its replacement.
	 */
	private async takeStageInputs(shared: SqlSharedPool, lease: Lease, root: string): Promise<void> {
		// The attempts as the pass starts: one that ends meanwhile takes no input, since the stage lease fences it.
		const held = new Map(
			[...this.slots].flatMap((slot) => (slot.work === undefined ? [] : [[slot.work.id, slot.work] as const])),
		);
		if (held.size === 0) return;
		const waiting = await shared.stagesWithInputs(root, [...held.keys()]);
		for (const { stage, deferred } of this.inputScheduler.start(waiting, performance.now())) {
			const { work, runId, stageId } = stage;
			void this.processStageInput(shared, lease, held.get(work)!, { runId, stageId }, deferred).then(
				(outcome) => this.inputScheduler.finish(stage, performance.now(), outcome),
				(error: Error) => {
					this.inputScheduler.finish(stage, performance.now());
					// The attempt was replaced while it held the input: the replacement takes it, and nothing here was written.
					if (isStaleStageLeaseError(error) || isStaleLeaseError(error)) return;
					// An unreachable journal leaves the input where it was, for a later pass (#4768).
					if (infrastructureFaultOf(error) === "storage_unavailable") return;
					this.fail(error);
				},
			);
		}
	}

	/**
	 * Takes, applies and settles the stage's next input of a kind it does not defer; "retry" or "defer" when the stage
	 * gave it back for later.
	 */
	private async processStageInput(
		shared: SqlSharedPool,
		lease: Lease,
		attempt: PoolWork,
		stage: { readonly runId: string; readonly stageId: string },
		deferred: readonly PooledStageInputKind[],
	): Promise<"retry" | "defer" | "settled" | "idle"> {
		const taken = await shared.takeStageInput(lease, attempt, stage, STAGE_INPUT_LEASE_MS, deferred);
		if (taken === undefined) return "idle";
		const outcome = await this.applyStageInput(taken);
		if (outcome === "retry" || outcome === "defer") {
			await shared.releaseStageInput(lease, taken);
			return outcome;
		}
		await shared.ackStageInput(lease, taken, JSON.stringify(outcome));
		return "settled";
	}

	/**
	 * Gives one stage input to the stage on this host's worker; "retry" leaves it the stage's next input, and "defer"
	 * leaves it waiting while the stage's inputs that are not text go first.
	 */
	private async applyStageInput(taken: StageInputLease): Promise<"retry" | "defer" | object> {
		if (taken.kind === STAGE_INPUT_PROMPT_ANSWER) {
			const result = await this.answerOnWorker(
				taken.runId,
				taken.stageId,
				JSON.parse(taken.payload) as PooledPromptAnswer,
			);
			if (result.ok) return { ok: true };
			// The stage has not raised the prompt yet, or its attempt is changing: the answer waits for it.
			if (result.refusal === "StaleAttempt") return "retry";
			return { ok: false, refusal: result.refusal };
		}
		const slot = [...this.slots].find((candidate) => isAttempt(candidate.work, taken.attempt));
		// The worker holding the attempt exited: the attempt's replacement takes the input.
		if (slot === undefined) return "retry";
		const attempt = { workId: taken.attempt.id, generation: taken.attempt.generation };
		const stage = { runId: taken.runId, stageId: taken.stageId };
		if (taken.kind === "question-read") {
			const { promptId } = JSON.parse(taken.payload) as QuestionReadInput;
			return questionReadOutcome(await this.stageCommand(slot, { attempt, op: "question", ...stage }), promptId);
		}
		if (taken.kind === "user-message")
			return userMessageOutcome(
				await this.stageCommand(slot, {
					attempt,
					op: "user-message",
					...stage,
					...(JSON.parse(taken.payload) as UserMessageInput),
				}),
			);
		const { generation, ...intercom } = JSON.parse(taken.payload) as IntercomMessageInput;
		return (
			earlierSessionReceipt({ generation }, taken.attempt) ??
			intercomMessageOutcome(await this.stageCommand(slot, { attempt, op: "intercom", ...stage, ...intercom }))
		);
	}

	private async enqueue(command: Extract<CoordinatorCommandBody, { kind: "enqueue" }>) {
		if (!this.queue || !this.lease || this.root === undefined) throw new PoolNotInitializedError({ root: this.root });
		if (command.rootRun !== undefined) this.routes?.updateRoot(command.rootRun);
		const queue = this.queue;
		const lease = this.lease;
		const work = await this.retainedTransition(async () => {
			let enqueued = await this.whileRootLate(queue, () =>
				queue.enqueue(lease, command.descriptor, command.boundary, {
					acceptEntryChanges: command.acceptEntryChanges === true,
					...(command.claimSessions === undefined ? {} : { claimSessions: command.claimSessions }),
				}),
			);
			// A child an earlier incarnation completed with a failure of the pool's own, such as a stage that lost its
			// worker's delivery or lease on a busy host, runs again when the resumed root asks for it: the failure was not
			// the child's, and replaying it would fail the child for good. So does a child its start check refused for a
			// missing session (#4440): the resume may bring the storage back, and the child checks again before any work.
			if (enqueued.state === "completed" && enqueued.epoch < lease.epoch)
				enqueued =
					(await this.whileRootLate(queue, () => queue.reopenCompleted(lease, enqueued.id, rerunsOnRootResume))) ??
					enqueued;
			const retained = this.retained.get(enqueued.id);
			if (retained) retained.enqueued = true;
			return enqueued;
		});
		// A retained earlier attempt counts as that incarnation's: attempts in this one start after it (#3979).
		if (!this.attemptBase.has(work.id))
			this.attemptBase.set(
				work.id,
				work.state === "ready" || (work.state === "leased" && work.epoch < lease.epoch) ? work.generation : 0,
			);
		if (work.state === "ready") this.idleClaims.wakeOne();
		const result = await this.queue.result(this.root, work.id);
		return { work, ...(result === undefined ? {} : { result }) };
	}

	private async transport(request: number, payload: DeliveryPayload): Promise<void> {
		const target = this.deliveryRequests.get(request);
		// The root answers a delivery request when its drain ends, so a transport after that is a root defect, not a worker
		// that exited: say so, rather than blame a worker that is still running the stage.
		if (target === undefined) throw new Error("Pooled stage delivery request already answered");
		if (!this.incarnations.has(target.slot.worker))
			throw new WorkerLostError({ phase: "delivery", pid: target.slot.child.pid });
		const { slot, workerRequest } = target;
		await new Promise<void>((resolve, reject) => {
			const id = randomUUID();
			slot.deliveries.set(id, { resolve, reject });
			slot.child.send(
				{ id: workerRequest, delivery: { id, from: payload.from, message: payload.message } },
				(error) => {
					if (error) {
						slot.deliveries.delete(id);
						reject(error);
					}
				},
			);
		});
	}

	private request(body: CoordinatorRequestBody): Promise<unknown> {
		const id = ++this.requestSequence;
		return new Promise((resolve, reject) => {
			this.requests.set(id, { resolve, reject });
			this.port.send({ kind: "request", id, request: body });
		});
	}

	private fail(error: Error): void {
		this.failed = true;
		// A satellite's failure is its own, not its root's pool's: it stops serving, and its host reports why.
		if (this.satellite !== undefined) {
			this.detach(error);
			return;
		}
		this.port.send({ kind: "failure", error: serializeError(error) });
	}

	/** Fails one child without failing the pool. */
	private failWork(work: PoolWork, error: WorkerRetryLimitError | WorkspaceRestoreUnavailableError): void {
		this.port.send({ kind: "work-failure", workId: work.id, error: serializeError(error) });
	}

	/** The error that fails one child once it used up its attempts in this root incarnation. */
	private retryLimit(
		work: PoolWork,
		reason: Exclude<WorkerRetryLimitReason, "worker-crashes">,
		cause: Error | undefined,
		logPath?: string,
		cleanupCause?: Error,
	): WorkerRetryLimitError {
		return new WorkerRetryLimitError(
			{
				reason,
				attempts: this.attempts(work),
				limit: MAX_CHILD_ATTEMPTS,
				childRunId: work.childRunId,
				exportName: work.definition.slice(work.definition.lastIndexOf("#") + 1),
				logPath,
				logFailure: logPath === undefined ? undefined : this.logFailures.get(logPath),
			},
			{ ...(cause === undefined ? {} : { cause }), ...(cleanupCause === undefined ? {} : { cleanupCause }) },
		);
	}

	/** Records the latest activity of one attempt; the root receives it with the next summary. */
	private publish(work: PoolWork, runs: readonly RunSnapshot[]): void {
		const failure = this.publicationFailures.get(work.id);
		if (failure?.generation === work.generation) throw failure.error;
		// A worker host relays its attempts' activity to the root through the shared journal.
		if (this.satellite !== undefined) {
			this.relayPending.set(work.id, { work: token(work), runs });
			return;
		}
		if (!this.publishing) return;
		this.pendingActivity.set(work.id, { work: token(work), runs });
		this.scheduleFlush();
	}

	private scheduleFlush(): void {
		if (this.flushTimer !== undefined || this.closed) return;
		// Fixed rate, and at most one summary awaiting the root at a time.
		const wait = Math.max(0, this.lastFlushAt + POOL_SUMMARY_INTERVAL_MS - performance.now());
		this.flushTimer = setTimeout(() => {
			this.flushTimer = undefined;
			if (this.batches.size > 0) {
				this.lastFlushAt = performance.now();
				this.scheduleFlush();
				return;
			}
			this.flush();
		}, wait);
	}

	/** Sends pending activity now; resolves once the root has applied it. */
	private flush(): Promise<void> {
		clearTimeout(this.flushTimer);
		this.flushTimer = undefined;
		if (this.pendingActivity.size === 0 && !this.usageChanged) {
			const last = [...this.batches.values()].at(-1);
			return last === undefined ? Promise.resolve() : new Promise((resolve) => this.chainSettle(last, resolve));
		}
		this.lastFlushAt = performance.now();
		const batch = ++this.batchSequence;
		const published = [...this.pendingActivity.values()];
		this.pendingActivity.clear();
		const usage = this.usageChanged ? this.usageTotal : undefined;
		this.usageChanged = false;
		const settled = new Promise<void>((resolve) => this.batches.set(batch, { entries: published, settle: resolve }));
		const entries = published.map(({ work, runs }) => ({ work, runs: this.sentRuns.encode(work, runs) }));
		this.port.send({ kind: "activity", batch, entries, ...(usage === undefined ? {} : { usage }) });
		return settled;
	}

	private chainSettle(batch: { settle(): void }, resolve: () => void): void {
		const settle = batch.settle;
		batch.settle = () => {
			settle();
			resolve();
		};
	}

	private noteUsage(usage: PoolUsage): void {
		this.usageTotal = usage;
		this.usageChanged = true;
		this.scheduleFlush();
	}

	private async sendResult(workId: string): Promise<boolean> {
		if (this.satellite !== undefined) return false;
		const result = await this.queue!.result(this.root!, workId);
		if (result === undefined) return false;
		this.reportedResults.add(workId);
		this.flush();
		this.sentRuns.forget(workId);
		this.port.send({
			kind: "result",
			workId,
			result: result as WorkflowSerializableObject,
			...(this.usageTotal === undefined ? {} : { usage: this.usageTotal }),
		});
		return true;
	}

	/** Opens a watch on the worker that holds the stage's run, through that worker's airlock. */
	private async stageWatch(id: WatchId, runId: string, stageId: string): Promise<WatchResult> {
		if (this.closed) return { ok: false, refusal: "PoolClosed" };
		const slot = [...this.slots].find((candidate) => candidate.work !== undefined && candidate.runs.has(runId));
		tracePooledWatch("coordinator.watch.open", {
			watch: id,
			runId,
			stageId,
			worker: slot?.worker,
			workId: slot?.work?.id,
			generation: slot?.work?.generation,
			slots: [...this.slots].map(
				(candidate) => `${candidate.worker}:${candidate.work?.generation ?? "-"}:${candidate.runs.has(runId)}`,
			),
		});
		if (slot?.work === undefined)
			return this.remoteStageWatch(id, runId, stageId) ?? { ok: false, refusal: "StageNotOnWorker" };
		const attempt = { workId: slot.work.id, generation: slot.work.generation };
		const watch: StageWatch = {
			slot,
			attempt,
			open: false,
			inFlight: false,
			pending: new StageEventBacklog({ events: STAGE_WATCH_BACKLOG_EVENTS, bytes: STAGE_WATCH_BACKLOG_BYTES }),
		};
		this.watches.set(id, watch);
		const result = await this.stageCommand(slot, { attempt, op: "watch", watch: id, runId, stageId });
		tracePooledWatch("coordinator.watch.opened", {
			watch: id,
			generation: attempt.generation,
			snapshot: result?.snapshot !== undefined,
			refusal: result?.refusal,
			current: this.watches.get(id) === watch,
		});
		if (this.watches.get(id) !== watch) {
			if (result?.snapshot !== undefined) this.stageCommand(slot, { attempt, op: "unwatch", watch: id });
			return { ok: false, refusal: this.closed ? "PoolClosed" : "AttemptChanging" };
		}
		if (result?.snapshot === undefined) {
			this.watches.delete(id);
			const refusal = result?.refusal;
			return {
				ok: false,
				refusal:
					refusal === "StageNotOnWorker" || refusal === "AttemptChanging" || refusal === "PoolClosed"
						? refusal
						: this.closed
							? "PoolClosed"
							: "AttemptChanging",
			};
		}
		watch.open = true;
		return { ok: true, watch: { id, attempt, snapshot: result.snapshot } };
	}

	private stageUnwatch(id: WatchId): void {
		if (this.remoteWatches.close(id)) return;
		const watch = this.watches.get(id);
		if (watch === undefined) return;
		this.watches.delete(id);
		if (watch.slot.work?.id === watch.attempt.workId && watch.slot.work.generation === watch.attempt.generation)
			void this.stageCommand(watch.slot, { attempt: watch.attempt, op: "unwatch", watch: id });
	}

	/** Admits user text through the airlock of the worker that holds the watch's attempt. */
	private async stageDeliver(delivery: PooledStageDelivery): Promise<DeliveryResult> {
		const remote = this.remoteWatches.get(delivery.watch);
		if (remote !== undefined) return this.deliverRemote(remote, delivery);
		const watch = this.watches.get(delivery.watch);
		if (watch === undefined || !watch.open)
			return {
				ok: false,
				refusal: this.endedWatches.get(delivery.watch) === "stage_finished" ? "StageNotLive" : "StaleAttempt",
			};
		const { slot, attempt } = watch;
		if (slot.work?.id !== attempt.workId || slot.work.generation !== attempt.generation)
			return { ok: false, refusal: "StaleAttempt" };
		const result = await this.stageCommand(slot, {
			attempt,
			op: "deliver",
			watch: delivery.watch,
			deliveryOp: delivery.op,
			text: delivery.text,
			intent: delivery.intent,
			...(delivery.options?.expandPromptTemplates === undefined
				? {}
				: { expandPromptTemplates: delivery.options.expandPromptTemplates }),
		});
		// The worker exited with the command in flight: it may have admitted the text.
		if (result === undefined) return { ok: false, refusal: "Unconfirmed" };
		if (result.error !== undefined) throw rehydrateError(result.error);
		if (result.action !== undefined) return { ok: true, action: result.action };
		const refusal = result.refusal;
		return {
			ok: false,
			refusal: refusal === "StageNotLive" || refusal === "Unconfirmed" ? refusal : "StaleAttempt",
		};
	}

	/**
	 * Opens a view of a stage that runs on another host's worker (#4391), from the root's copy of its relayed run: no
	 * transcript or events stream from that host, so the view shows the stage's status, and its user text goes through
	 * the stage's input queue. Undefined when no other host runs the stage live.
	 */
	private remoteStageWatch(id: WatchId, runId: string, stageId: string): WatchResult | undefined {
		const stage = this.routes?.mirror.run(runId)?.stages.find((candidate) => candidate.id === stageId);
		if (stage === undefined) return undefined;
		const work = this.remoteWatches.open(id, runId, stage, this.routes?.ownerOf(runId));
		if (work === "pending") return { ok: false, refusal: "AttemptChanging" };
		if (work === undefined) return undefined;
		return {
			ok: true,
			watch: { id, attempt: { workId: work.id, generation: work.generation }, snapshot: remoteStageSnapshot(stage) },
		};
	}

	/**
	 * Admits user text into a stage on another host's worker through the stage's input queue (#4391), at most once per
	 * op and attempt: its receipt is the worker's admission. Text whose receipt does not come within the bound stays
	 * queued and reads as unconfirmed, so the stage's handle sends it again by its op.
	 */
	private async deliverRemote(watch: RemoteStageWatch, delivery: PooledStageDelivery): Promise<DeliveryResult> {
		const payload: UserMessageInput = {
			deliveryOp: delivery.op,
			text: delivery.text,
			intent: delivery.intent,
			...(delivery.options?.expandPromptTemplates === undefined
				? {}
				: { expandPromptTemplates: delivery.options.expandPromptTemplates }),
		};
		try {
			const outcome = await this.queueRemoteInput<"user-message", UserMessageReceipt>(
				watch.work,
				watch,
				"user-message",
				stageInputOp("user-message", delivery.op, watch.work.generation),
				payload,
				this.stageInputTimeoutMs(),
			);
			if ("ended" in outcome) return endedUserMessage(outcome.ended);
			return userMessageResult(outcome.receipt, outcome.input);
		} catch (error) {
			if (isStageInputTimeoutError(error)) return { ok: false, refusal: "Unconfirmed" };
			throw error;
		}
	}

	/**
	 * Hands an Intercom message to a stage session on another host's worker through the stage's input queue (#4391),
	 * at most once per message, session and attempt. Settles once the session took it; fails typed when it did not, or
	 * when its receipt does not come within the bound, and the message stays queued in the root's store.
	 */
	private async stageIntercom(command: Extract<CoordinatorCommandBody, { kind: "stage-intercom" }>): Promise<void> {
		const { work, runId, stageId, sessionId, from, message } = command;
		const outcome = await this.queueRemoteInput<"intercom-message", IntercomMessageReceipt>(
			work,
			{ runId, stageId },
			"intercom-message",
			stageInputOp("intercom-message", `${sessionId}:${message.id}`, work.generation),
			{ sessionId, generation: work.generation, from, message },
			this.stageInputTimeoutMs(),
		);
		if ("ended" in outcome) throw new StageInputRefusedError(endedIntercomReason(outcome.ended), outcome.input);
		intercomMessageResult(outcome.receipt, outcome.input);
	}

	/** How long the root waits for the receipt of an input it queued for a stage on another host. */
	private stageInputTimeoutMs(): number {
		// Only a root's coordinator, whose options are set before it serves anything, queues these inputs.
		return this.options!.stageInputTimeoutMs ?? STAGE_INPUT_RECEIPT_TIMEOUT_MS;
	}

	/**
	 * Queues one input for a stage that the attempt `work` runs (#4310, #4391): whichever worker holds the stage's
	 * attempt takes it, in order, one at a time. Resolves with the receipt that worker records, or with why nothing will
	 * take it any more; fails with {@link StageInputTimeoutError} once `timeoutMs` passes without a receipt.
	 */
	private async queueRemoteInput<Kind extends PooledStageInputKind, Receipt>(
		work: PoolWorkToken,
		stage: { readonly runId: string; readonly stageId: string },
		kind: Kind,
		op: string,
		payload: PooledStageInputPayloads[Kind],
		timeoutMs?: number,
	): Promise<
		| { readonly receipt: Receipt; readonly input: StageInputIdentity }
		| { readonly ended: "pool-closed" | "work-ended"; readonly input: StageInputIdentity }
	> {
		// Only a shared pool's root queues stage inputs, so its tables and lease are set.
		const shared = this.sharedPool!;
		const lease = this.lease!;
		const queue = this.queue!;
		const { runId, stageId } = stage;
		const seq = await this.whileRootLate(queue, () =>
			shared.appendStageInput(lease, { work: work.id, runId, stageId, kind, op, payload: JSON.stringify(payload) }),
		);
		const input: StageInputIdentity = { root: lease.runId, runId, stageId, seq, kind };
		const outcome = await awaitStageInputReceipt(input, {
			read: () => shared.stageInput(lease.runId, runId, stageId, seq),
			ended: async () => {
				if (this.closed) return "pool-closed";
				// A child that ended has no stage left to take it.
				return workEnded(await queue.inspect(lease.runId), work.id) ? "work-ended" : undefined;
			},
			workHeld: async () => workHeld(await queue.inspect(lease.runId), work.id),
			pollMs: SHARED_POLL_MS,
			timeoutMs,
		});
		return "ended" in outcome
			? { ended: outcome.ended, input }
			: { receipt: JSON.parse(outcome.receipt) as Receipt, input };
	}

	/**
	 * Answers a prompt of a stage that runs on another host's worker (#4310): the answer becomes that stage's next input,
	 * which whichever worker holds the stage's attempt takes. Its result is the receipt that worker records, as a local
	 * worker's reply is: a refused answer comes back refused, so the root holds it for the attempt that asks again. Each
	 * attempt that asks gets its own input. Undefined when no other host runs the stage's run.
	 */
	private async queueRemoteAnswer(
		runId: string,
		stageId: string,
		answer: PooledPromptAnswer,
	): Promise<PromptResult | undefined> {
		const work = this.remoteWatches.attemptOf(runId);
		if (work === undefined) return undefined;
		const outcome = await this.queueRemoteInput<typeof STAGE_INPUT_PROMPT_ANSWER, PromptResult>(
			work,
			{ runId, stageId },
			STAGE_INPUT_PROMPT_ANSWER,
			`${answer.kind}:${answer.promptId}:${work.generation}`,
			answer,
		);
		if ("ended" in outcome)
			return { ok: false, refusal: outcome.ended === "pool-closed" ? "StaleAttempt" : "StageNotLive" };
		return outcome.receipt;
	}

	/** Reads a stage's brokered question from the worker whose attempt published the stage's run. */
	private async stageQuestion(
		runId: string,
		stageId: string,
		promptId: string,
	): Promise<PooledStageQuestion | undefined> {
		const slot = [...this.slots].find((candidate) => candidate.work !== undefined && candidate.runs.has(runId));
		if (slot?.work === undefined) return this.remoteQuestion(runId, stageId, promptId);
		const attempt = { workId: slot.work.id, generation: slot.work.generation };
		return (await this.stageCommand(slot, { attempt, op: "question", runId, stageId }))?.question;
	}

	/**
	 * Reads the question `promptId` of a stage that runs on another host's worker through the stage's input queue
	 * (#4391). Undefined when no other host runs it, when the stage no longer waits on that question, or when the read's
	 * receipt does not come within the bound: the stage's next publication asks again and finds the same read.
	 */
	private async remoteQuestion(
		runId: string,
		stageId: string,
		promptId: string,
	): Promise<PooledStageQuestion | undefined> {
		const work = this.remoteWatches.attemptOf(runId);
		if (work === undefined) return undefined;
		try {
			const outcome = await this.queueRemoteInput<"question-read", QuestionReadReceipt>(
				work,
				{ runId, stageId },
				"question-read",
				stageInputOp("question-read", promptId, work.generation),
				{ promptId },
				this.stageInputTimeoutMs(),
			);
			return "ended" in outcome ? undefined : questionReadResult(outcome.receipt);
		} catch (error) {
			if (isStageInputTimeoutError(error)) return undefined;
			throw error;
		}
	}

	/** Answers a prompt through the airlock of the worker whose attempt published the stage's run. */
	private async stageAnswer(runId: string, stageId: string, answer: PooledPromptAnswer): Promise<PromptResult> {
		const held = [...this.slots].some((candidate) => candidate.work !== undefined && candidate.runs.has(runId));
		if (!held) {
			const queued = await this.queueRemoteAnswer(runId, stageId, answer);
			if (queued !== undefined) return queued;
		}
		return this.answerOnWorker(runId, stageId, answer);
	}

	/** Answers a prompt of a stage on one of this host's workers. */
	private async answerOnWorker(runId: string, stageId: string, answer: PooledPromptAnswer): Promise<PromptResult> {
		const slot = [...this.slots].find((candidate) => candidate.work !== undefined && candidate.runs.has(runId));
		if (slot?.work === undefined) return { ok: false, refusal: "StaleAttempt" };
		const attempt = { workId: slot.work.id, generation: slot.work.generation };
		const result = await this.stageCommand(slot, { attempt, op: "answer", runId, stageId, answer });
		if (result === undefined) return { ok: false, refusal: "StaleAttempt" };
		if (result.error !== undefined) throw rehydrateError(result.error);
		const refusal = result.refusal;
		if (refusal === undefined) return { ok: true };
		return {
			ok: false,
			refusal: refusal === "StageNotLive" || refusal === "PromptNotPending" ? refusal : "StaleAttempt",
		};
	}

	/** Pauses or resumes one watched stage through its worker's airlock; pool control is untouched. */
	private async stageControl(
		id: WatchId,
		command:
			| { readonly op: "pause" }
			| { readonly op: "resume"; readonly message?: { readonly deliveryOp: DeliveryOpId; readonly text: string } },
	): Promise<ControlResult> {
		const remote = this.remoteWatches.get(id);
		if (remote !== undefined) throw new RemoteStageCommandUnsupportedError(command.op, remote);
		const watch = this.watches.get(id);
		if (watch === undefined || !watch.open)
			return {
				ok: false,
				refusal: this.endedWatches.get(id) === "stage_finished" ? "StageNotLive" : "StaleAttempt",
			};
		const { slot, attempt } = watch;
		if (slot.work?.id !== attempt.workId || slot.work.generation !== attempt.generation)
			return { ok: false, refusal: "StaleAttempt" };
		if (this.desiredControl !== undefined && this.desiredControl !== "running")
			return { ok: false, refusal: "PoolPausedOrQuitting" };
		const result = await this.stageCommand(slot, { attempt, watch: id, ...command });
		if (result === undefined) return { ok: false, refusal: "StaleAttempt" };
		if (result.error !== undefined) throw rehydrateError(result.error);
		const refusal = result.refusal;
		if (refusal === "StageNotLive" || refusal === "PoolPausedOrQuitting" || refusal === "StaleAttempt")
			return { ok: false, refusal };
		if (refusal !== undefined) return { ok: false, refusal: "StaleAttempt" };
		return { ok: true, ...(result.action === undefined ? {} : { action: result.action }) };
	}

	/** Runs a session command on one watched stage through its worker's airlock. */
	private async stageSession(id: WatchId, command: PooledStageSessionCommand): Promise<SessionCommandResult> {
		const remote = this.remoteWatches.get(id);
		if (remote !== undefined) throw new RemoteStageCommandUnsupportedError("session", remote);
		const watch = this.watches.get(id);
		if (watch === undefined || !watch.open)
			return {
				ok: false,
				refusal: this.endedWatches.get(id) === "stage_finished" ? "StageNotLive" : "StaleAttempt",
			};
		const { slot, attempt } = watch;
		if (slot.work?.id !== attempt.workId || slot.work.generation !== attempt.generation)
			return { ok: false, refusal: "StaleAttempt" };
		// A paused or quitting pool starts no new session work, but still stops running work and shows tasks.
		if (this.desiredControl !== undefined && this.desiredControl !== "running" && !runsWhilePaused(command))
			return { ok: false, refusal: "PoolPausedOrQuitting" };
		const result = await this.stageCommand(slot, { attempt, op: "session", watch: id, command });
		if (result === undefined) return { ok: false, refusal: "StaleAttempt" };
		if (result.error !== undefined) throw rehydrateError(result.error);
		const refusal = result.refusal;
		if (refusal === "StageNotLive" || refusal === "PoolPausedOrQuitting") return { ok: false, refusal };
		if (refusal !== undefined) return { ok: false, refusal: "StaleAttempt" };
		return {
			ok: true,
			...(result.bash === undefined ? {} : { bash: result.bash }),
			...(result.task === undefined ? {} : { task: result.task }),
		};
	}

	private stageCommand(
		slot: WorkerSlot,
		command: DistributiveOmit<WorkerStageCommand, "kind" | "commandId">,
	): Promise<StageCommandResult | undefined> {
		if (!this.incarnations.has(slot.worker)) {
			tracePooledWatch("coordinator.command.no-worker", { op: command.op, worker: slot.worker });
			return Promise.resolve(undefined);
		}
		const commandId = ++this.stageCommandSequence;
		tracePooledWatch("coordinator.command.send", {
			commandId,
			op: command.op,
			worker: slot.worker,
			generation: command.attempt.generation,
			watch: "watch" in command ? command.watch : undefined,
		});
		return new Promise((resolve) => {
			slot.stageCommands.set(commandId, (result) => {
				tracePooledWatch("coordinator.command.settled", {
					commandId,
					op: command.op,
					answered: result !== undefined,
					refusal: result?.refusal,
					action: result?.action,
					error: result?.error?.name,
					code: result?.error?.code,
				});
				resolve(result);
			});
			slot.child.send({ kind: "stage-command", commandId, ...command } as WorkerStageCommand, (error) => {
				if (!error) return;
				slot.stageCommands.delete(commandId);
				resolve(undefined);
			});
		});
	}

	/** A worker's batch of watched events; held and merged while the previous batch awaits the root. */
	private stageEvents(slot: WorkerSlot, id: WatchId, events: readonly SeqEvent[]): void {
		const watch = this.watches.get(id);
		if (watch === undefined || watch.slot !== slot) return;
		if (!watch.inFlight && watch.pending.length === 0) {
			watch.inFlight = true;
			this.port.send({ kind: "stage-events", watch: id, events });
			return;
		}
		if (!watch.pending.push(events)) this.endStageWatch(id, "resync");
	}

	private stageEventsApplied(id: WatchId): void {
		const watch = this.watches.get(id);
		if (watch === undefined) return;
		watch.inFlight = false;
		if (watch.pending.length === 0) return;
		const events = watch.pending.drain();
		watch.inFlight = true;
		this.port.send({ kind: "stage-events", watch: id, events });
	}

	/** Ends a watch for the root; no further events of it are forwarded. */
	private endStageWatch(id: WatchId, reason: WatchEndReason): void {
		tracePooledWatch("coordinator.watch.end", {
			watch: id,
			reason,
			generation: this.watches.get(id)?.attempt.generation,
		});
		const watch = this.watches.get(id);
		if (watch === undefined) return;
		this.watches.delete(id);
		this.endedWatches.remember(id, reason);
		if (reason === "resync") {
			// The watcher reopens for a fresh snapshot; the backlog it fell behind on is dropped.
			void this.stageCommand(watch.slot, { attempt: watch.attempt, op: "unwatch", watch: id });
			watch.pending.drain();
		}
		if (!watch.open) return;
		if (watch.pending.length > 0) this.port.send({ kind: "stage-events", watch: id, events: watch.pending.drain() });
		this.port.send({ kind: "stage-watch-ended", watch: id, reason });
	}

	private endStageWatches(match: (watch: StageWatch) => boolean, reason: WatchEndReason): void {
		for (const [id, watch] of [...this.watches]) if (match(watch)) this.endStageWatch(id, reason);
	}

	/** Merges limits one process recorded; those that extend the pool's limits are sent on, coalesced. */
	private observeRateLimits(observations: WorkerRateLimits["observations"]): void {
		if (!Array.isArray(observations)) return;
		for (const observation of observations)
			if (this.rateLimits.merge(observation)) {
				this.rateLimitOutbox.offer(observation);
				this.fleetRates?.shareCooldown(observation);
			}
	}

	/** Cooldowns another host shared through the journal: applied on this host, never written back (#4768). */
	private applyFleetCooldowns(observations: readonly ProviderRateLimitObservation[]): void {
		for (const observation of observations)
			if (this.rateLimits.merge(observation)) this.rateLimitOutbox.offer(observation);
	}

	/** Starts the root's fleet-wide rate limits on a shared pool that sets them (#4768); idempotent. */
	private async startFleetRates(): Promise<void> {
		const shared = this.options?.shared;
		if (this.fleetRates !== undefined || shared === undefined || this.journal === undefined) return;
		if (shared.rateLimits === undefined && shared.shareCooldowns !== true) return;
		const store = await SqlRateBuckets.open(this.journal);
		this.fleetRates = new FleetRateLimiter({
			store,
			limits: shared.rateLimits ?? {},
			shareCooldowns: shared.shareCooldowns === true,
			slots: this.options!.workers,
			applyCooldowns: (observations) => this.applyFleetCooldowns(observations),
		});
		this.fleetRates.start();
	}

	private shareRateLimits(observations: WorkerRateLimits["observations"]): void {
		const message: WorkerRateLimits = { kind: "rate-limits", observations };
		// A worker that is not ready yet receives every current limit when it reports ready.
		for (const slot of this.slots)
			if (this.readyWorkers.has(slot.worker) && slot.child.connected) slot.child.send(message, () => {});
		this.port.send(message);
	}

	private fence(work: PoolWork): void {
		void this.shipping?.release(work);
		this.endStageWatches(
			(watch) => watch.attempt.workId === work.id && watch.attempt.generation <= work.generation,
			"attempt_fenced",
		);
		this.pendingActivity.delete(work.id);
		this.sentRuns.forget(work.id);
		this.routes?.fence(work);
		this.port.send({ kind: "fence", work: { id: work.id, generation: work.generation } });
	}

	private spawn(): Promise<void> {
		if (this.closed) return Promise.reject(new Error("Local worker pool is closed"));
		const root = this.root!;
		const options = this.options!;
		const child = fork(
			options.workerEntry ?? process.argv[1]!,
			[
				JSON.stringify({
					...(options.shared === undefined
						? { journalPath: options.journalPath }
						: { shared: { host: options.shared.host, routes: this.satellite === undefined } }),
					heartbeatMs: options.heartbeatMs,
					leaseMs: options.leaseMs,
					root,
					definitions: this.sources,
					admission: options.admission,
					...(this.promptNodes ? { promptNodes: true } : {}),
					...(options.stageStartMaxLoadPerCpu === undefined
						? {}
						: { stageStartMaxLoadPerCpu: options.stageStartMaxLoadPerCpu }),
					...(options.maxWorkerRssBytes === undefined ? {} : { maxRssBytes: options.maxWorkerRssBytes }),
					...(options.outageHandoffMs === undefined ? {} : { outageHandoffMs: options.outageHandoffMs }),
					...(this.fleetRates === undefined || this.fleetRates.rateScopes.length === 0
						? {}
						: { rateScopes: this.fleetRates.rateScopes }),
				}),
			],
			{
				stdio: ["ignore", "ignore", "pipe", "ipc"],
				execArgv: [],
				// The durable journal's selection goes through the environment: argv is readable by every process on the host.
				env: withHostGit(poolWorkerEnvironment(options.durable), this.satellite?.git),
			},
		);
		const disconnected = new Promise<void>((resolve) => child.once("disconnect", () => resolve()));
		this.children.add(child);
		if (child.pid !== undefined) this.port.send({ kind: "spawned", pid: child.pid });
		const id = randomUUID();
		// A shared pool's worker ids name their host, so its leases say where they run.
		const worker = options.shared === undefined ? id : `${options.shared.host}/${id}`;
		this.incarnations.set(worker, child);
		const slot: WorkerSlot = {
			worker,
			child,
			deliveries: new Map(),
			runs: new Set(),
			stageCommands: new Map(),
			idle: new IdleClaimBackoff(),
			exited: new AbortController(),
		};
		this.slots.add(slot);
		let ready = false;
		// The worker's requests run alongside each other, except where their lanes order them (#4315).
		const lanes = new WorkerRequestLanes();
		const extensions = new AttemptLeaseExtensions(slot, async (attempt) => {
			const work = await this.queue!.extend(this.lease!, attempt, options.leaseMs);
			await this.holdShipping(slot, work, options.leaseMs);
			return work;
		});
		const logPath = join(this.logDirectory!, `${id}.log`);
		this.logs.set(child, logPath);
		// A worker whose log cannot be written still runs: its errors name the log and why it could not be written.
		const log = appendProcessLog(
			child.stderr,
			logPath,
			(failure) => this.logUnwritable(logPath, failure),
			this.logsOpened,
		);
		this.logsOpened = log.opened;
		const startupTimeoutMs = options.startupTimeoutMs;
		const spawnedAt = performance.now();
		let timedOutAt: number | undefined;
		let terminated = false;
		const terminate = () => {
			if (terminated) return;
			terminated = true;
			child.kill("SIGKILL");
		};
		const replied = (error: Error | null) => {
			if (error && !workerEndsCleanly(slot)) terminate();
		};
		return new Promise((resolve, reject) => {
			const startup = setTimeout(() => {
				timedOutAt = performance.now();
				terminate();
			}, startupTimeoutMs);
			child.on("error", (error) => {
				clearTimeout(startup);
				reject(error);
				terminate();
			});
			const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
			// The worker's exit, or its retirement when SIGKILL did not end it within the bound: both end its attempt once.
			let retired = false;
			const retire = () => {
				if (retired) return;
				retired = true;
				slot.exited.abort();
				void Promise.all([Promise.race([closed, delay(STDERR_DRAIN_GRACE_MS)]), log.opened]).then(() =>
					reject(
						timedOutAt === undefined
							? new WorkerStartupError({ logPath, logFailure: this.logFailures.get(logPath) })
							: new WorkerStartupTimeoutError({
									logPath,
									logFailure: this.logFailures.get(logPath),
									timeoutMs: startupTimeoutMs,
									elapsedMs: startupWaitedMs(startupTimeoutMs, spawnedAt, timedOutAt),
								}),
					),
				);
				this.children.delete(child);
				this.logs.delete(child);
				if (child.pid !== undefined) this.port.send({ kind: "exited", pid: child.pid });
				clearTimeout(startup);
				this.incarnations.delete(worker);
				this.readyWorkers.delete(worker);
				this.controlAcks.delete(worker);
				this.lastHeard.delete(worker);
				this.awaiting.delete(worker);
				this.slots.delete(slot);
				this.fleetRates?.releaseWorker(slot.worker);
				this.places.end(slot);
				this.gateOpened();
				this.retireWaiting();
				this.endStageWatches((watch) => watch.slot === slot, "worker_exited");
				for (const settle of slot.stageCommands.values()) settle(undefined);
				slot.stageCommands.clear();
				if (slot.work) {
					this.forgetProgress(slot.work);
					this.fence(slot.work);
				}
				const lost = new WorkerLostError({
					phase: "delivery",
					pid: child.pid,
					exitCode: child.exitCode ?? undefined,
					signal: child.signalCode ?? undefined,
				});
				for (const delivery of slot.deliveries.values()) delivery.reject(lost);
				slot.deliveries.clear();
				// The exited worker's work stays leased until its process groups are reaped, so no other worker can
				// claim it while they are being reaped.
				const held = slot.work;
				if (held) this.held.add(held.id);
				// Set when the reap leaves process groups running: the worker's health event, never its child's failure.
				let unconfirmed: WorkerCleanupUnconfirmedError | undefined;
				const cleanup = Promise.all([disconnected, log.opened])
					.then(() => lanes.settled())
					.then(async () => {
						try {
							const admission = this.admission;
							if (!admission || (await admission.releaseStoppedSessions(worker)) === 0) return;
							// The exited worker's tool process groups belong to its fenced attempt. Reaping them is bounded.
							const alive = await admission.reapStoppedProcesses(worker);
							if (alive.length > 0) this.unreaped.push({ holder: worker });
							// Close still reports any cleanup left unconfirmed, including permits never bound to a group.
							if (this.closed && (alive.length > 0 || (await admission.releaseStoppedSessions(worker)) > 0))
								throw unconfirmedCleanup(alive);
							if (alive.length === 0) return;
							// Groups that survive the reap keep their permits quarantined, and close reports them. They are a
							// health event of the worker, which is retired and replaced, and never its child's failure: a child
							// whose result is recorded keeps it, and an unfinished one replays on another worker within its
							// attempt limit, as for any lost attempt (below).
							unconfirmed = unconfirmedCleanup(alive);
							this.reportHealth(logPath, `${unconfirmed.message}; the worker was retired and replaced`);
						} catch (error) {
							this.cleanupFailure = error instanceof Error ? error : new Error(String(error));
							throw this.cleanupFailure;
						} finally {
							if (held) this.held.delete(held.id);
						}
					})
					.then(async () => {
						// A worker that ended itself between children to give its memory back (`maxWorkerRssBytes`, #4197) and
						// exited cleanly leaves nothing to diagnose: its log goes with it, so a long run does not pile them up.
						if (
							(slot.recycled === true || slot.retired === true) &&
							slot.work === undefined &&
							child.exitCode === 0 &&
							!this.keptLogs.has(logPath)
						)
							await rm(logPath, { force: true }).catch(() => {});
						if (this.closed || !ready || this.desiredControl === "quit" || this.rootLeaseLost) return;
						let work = slot.work;
						if (work && (await this.sendResult(work.id))) {
							work = undefined;
							slot.work = undefined;
							this.replacements = 0;
						}
						if (this.closed) return;
						// The third lost attempt of one child fails only that child: the pool and its other children keep
						// running. Its work item ends failed in the same transaction, so no worker claims it again. A worker
						// host never fails a child: it releases it, and the root's own pool counts its attempts.
						// A worker that died before it confirmed its claim never ran the child: its attempt goes back as a
						// handoff, which counts as none of the child's attempts (#5034).
						const current = work === undefined ? undefined : await this.counted(work);
						const unconfirmedClaim =
							current !== undefined &&
							current.state === "leased" &&
							current.generation === work!.generation &&
							this.handoffs(current) < MAX_CHILD_HANDOFFS &&
							!(await this.queue!.confirmed(current));
						const exhausted =
							this.satellite === undefined &&
							current !== undefined &&
							!unconfirmedClaim &&
							this.attempts(current) >= MAX_CHILD_ATTEMPTS;
						const queue = this.queue!;
						const lease = this.lease!;
						const attempt = work;
						if (attempt !== undefined) await this.shipping?.release(attempt);
						const settled =
							attempt !== undefined &&
							(await this.whileRootLate(queue, () =>
								exhausted
									? queue.failExited(lease, attempt)
									: queue.releaseExited(lease, attempt, unconfirmedClaim ? { delayMs: 0 } : undefined),
							));
						if (attempt !== undefined) await this.shipping?.release(attempt);
						// An exit whose attempt another one already replaced is not that child's failure: its owner keeps it.
						const superseded = work !== undefined && !settled && (await this.superseded(work));
						if (work !== undefined && exhausted && !superseded)
							// The worker's exit is the fault; process groups it left running are a cleanup that failed after it.
							// Its attempts are counted from the work as the queue holds it, which carries its handoffs.
							this.failWork(
								work,
								this.retryLimit(current ?? work, "worker-lost", undefined, logPath, unconfirmed),
							);
						// Workers that crash without work are a pool-wide fault. A child that lost its worker consumes its own
						// attempts, so those replacements are bounded by the children and never count toward this limit. A
						// worker that ended itself between children for its memory did not crash: it is replaced without
						// counting. A draining worker host replaces none.
						if (this.draining) return;
						if (slot.retired === true) return;
						if (work === undefined && slot.recycled === true) await this.spawn();
						else if (work === undefined && ++this.replacements > MAX_WORKER_REPLACEMENTS)
							this.fail(
								new WorkerRetryLimitError({
									reason: "worker-crashes",
									attempts: this.replacements,
									limit: MAX_WORKER_REPLACEMENTS,
									logPath,
									logFailure: this.logFailures.get(logPath),
								}),
							);
						else await this.spawn();
					})
					.catch((error: Error) => {
						this.fail(error);
					});
				this.cleanups.add(cleanup);
				void cleanup.finally(() => this.cleanups.delete(cleanup));
			};
			slot.retire = retire;
			child.once("exit", retire);
			child.on("message", (message: WorkerRequest) => {
				this.observeResponsiveness();
				this.lastHeard.set(worker, { at: performance.now(), stalled: this.stalledMs });
				this.counters.request(message.kind);
				if (message.kind === "stage-command-result") {
					const settle = slot.stageCommands.get(message.commandId);
					slot.stageCommands.delete(message.commandId);
					settle?.(message);
					return;
				}
				if (message.kind === "stage-events") {
					this.stageEvents(slot, message.watch, message.events);
					return;
				}
				if (message.kind === "stage-watch-ended") {
					if (this.watches.get(message.watch)?.slot === slot) this.endStageWatch(message.watch, message.reason);
					return;
				}
				if (message.kind === "rate-limits") {
					this.observeRateLimits(message.observations);
					return;
				}
				if (message.kind === "delivery-ack") {
					const pending = slot.deliveries.get(message.deliveryId);
					slot.deliveries.delete(message.deliveryId);
					if (message.error !== undefined) pending?.reject(rehydrateError(message.error));
					else pending?.resolve();
					return;
				}
				let routeReady: Promise<string> | undefined;
				const answer = async () => {
					if (message.kind === "ready") {
						if (terminated) return;
						ready = true;
						// Sent before the readiness reply, so the worker holds them before it claims any work.
						const limits = this.rateLimits.current();
						if (limits.length > 0)
							child.send({ kind: "rate-limits", observations: limits } satisfies WorkerRateLimits, replied);
						const control = this.committedControl;
						if (control !== undefined)
							child.send({ kind: "pool-control", control } satisfies WorkerPoolControl, replied);
						this.readyWorkers.add(worker);
						clearTimeout(startup);
						resolve();
						return;
					}
					await this.starting;
					const queue = this.queue!;
					const lease = this.lease!;
					// While the root renews late, the worker's request waits for the renewal rather than ending its attempt.
					// The worker's own renewals wait for it too, so the wait can outlast the attempt's work lease: it is
					// renewed before the request runs again, which fences the request only if another attempt replaced it.
					const renewAttempt = async () => {
						await extensions.extendHeld();
						if (slot.work !== undefined) await this.holdShipping(slot, slot.work, options.leaseMs);
					};
					// A request from this worker shows it is alive, so a work lease that only lapsed while the request waited
					// (this process starved of CPU, the journal's write lock held by other writers) does not fence it: the
					// lease is extended and the request runs again. `extend` checks the attempt's identity, so an attempt that
					// recovery replaced stays refused (#3888).
					const current = async <T>(action: () => Promise<T>): Promise<T> => {
						try {
							return await action();
						} catch (error) {
							if (!isStaleWorkLeaseError(error) || slot.work === undefined) throw error;
							await renewAttempt();
							return action();
						}
					};
					const leased = <T>(action: () => Promise<T>) =>
						this.whileRootLate(queue, () => current(action), renewAttempt);
					if (message.kind === "control") return leased(() => queue.control(lease));
					// Never refused: a token the fleet cannot give in time is metered here, so no call fails on it (#4768).
					if (message.kind === "rate-acquire")
						return this.fleetRates === undefined
							? 0
							: this.fleetRates
									.acquire(message.provider, message.model, slot.worker, message.request)
									.catch(() => 0);
					if (message.kind === "rate-release") {
						this.fleetRates?.releaseRequest(slot.worker, message.request);
						return 0;
					}
					if (message.kind === "fenced") {
						const fenced = slot.work;
						// The slot keeps the attempt until its release below is recorded: a store that refuses it leaves the
						// attempt held, renewed and the worker's, which sends its end again, instead of a row no worker holds and a
						// handoff never recorded (#4768).
						const end = () => {
							if (slot.work !== fenced) return;
							if (fenced !== undefined) void this.shipping?.release(fenced);
							this.attemptEnded(slot, fenced);
						};
						// Its current owner keeps superseded work. Work still leased to this attempt was refused by the root,
						// or its run failed on a fault of the pool: it is released for replay and counts as a failed attempt,
						// so refusals and faults stay bounded.
						if (fenced !== undefined) await this.shipping?.release(fenced);
						if (fenced && !(await this.superseded(fenced))) {
							// Views of the attempt's stages end with it, so they reconnect to its replay.
							this.fence(fenced);
							const current = await this.counted(fenced);
							const handoffs = this.handoffs(current);
							// A handoff, which the store's refusals forced, goes back to the queue recorded as such, claimable
							// after a growing wait: it counts as none of the child's attempts, up to MAX_CHILD_HANDOFFS (#4768).
							if (message.handoff === true && handoffs < MAX_CHILD_HANDOFFS)
								await leased(() => queue.releaseExited(lease, fenced, { delayMs: handoffDelayMs(handoffs) }));
							// A worker host releases the attempt whatever its count: the root's own pool fails a child.
							else if (this.satellite !== undefined || this.attempts(current) < MAX_CHILD_ATTEMPTS) {
								await leased(() => queue.releaseExited(lease, fenced));
								this.idleClaims.wakeOne();
							} else if (await leased(() => queue.failExited(lease, fenced))) {
								const fault = message.fault === undefined ? undefined : rehydrateError(message.fault);
								this.failWork(
									fenced,
									this.retryLimit(current, fault === undefined ? "refused-stale" : "pool-fault", fault),
								);
							}
						}
						end();
						return;
					}
					if (message.kind === "controlled") {
						const control = await leased(() => queue.control(lease));
						if (message.revision > control.revision) throw new Error("Unknown control revision");
						// A paused or quit attempt has shipped every checkpoint it accepted before its control counts (#4768).
						const shipping = this.shipping;
						const acknowledged = slot.work;
						if (shipping !== undefined && acknowledged !== undefined)
							await leased(() => shipping.flush(acknowledged));
						this.controlAcks.set(worker, Math.max(this.controlAcks.get(worker) ?? -1, message.revision));
						return;
					}
					if (message.kind === "recycle") {
						if (slot.work) throw new Error("Worker holds an attempt");
						slot.recycled = true;
						// Past its limit after its first child, a worker shows the limit is below what any worker uses: every
						// worker is then replaced after each child, which is correct but costs a worker start per child.
						if (message.attempts <= 1 && !this.recycleLimitReported) {
							this.recycleLimitReported = true;
							this.port.send({
								kind: "health",
								message: `localWorkers.maxWorkerRssBytes (${options.maxWorkerRssBytes} bytes) is below the resident memory of a worker that ran one child (${message.rssBytes} bytes), so every worker is replaced after each child it runs; set it well above that`,
							});
						}
						return;
					}
					if (message.kind === "claim") {
						if (slot.work) throw new Error("Worker already holds an attempt");
						if (this.retiresIdle(slot)) return undefined;
						const claimed = await this.idleClaims.claim(
							slot.idle,
							async (found) => {
								if (this.draining) return undefined;
								const shipping = this.shipping;
								const lagging = shipping?.lagging() === true;
								if (lagging) {
									this.lagGated = true;
									void shipping
										?.flushAll()
										.then(() => {
											if (!shipping.lagging()) this.gateOpened();
										})
										.catch(() => {});
								}
								if (this.budgetBlocked || lagging || !this.places.claim(slot)) {
									this.claimsGated = true;
									return undefined;
								}
								let taken: Awaited<ReturnType<typeof this.claimFor>>;
								slot.claiming = true;
								try {
									taken = await leased(async () => {
										await this.recoverExpired();
										slot.runs.clear();
										return this.claimFor(queue, lease, worker, options.leaseMs, slot, found);
									});
								} finally {
									slot.claiming = false;
									slot.claimed = undefined;
									if (taken === undefined) {
										this.places.end(slot);
										this.gateOpened();
									}
								}
								return taken;
							},
							slot.exited.signal,
						);
						// A host that closed while the claim was in flight put its child back with the rest it held.
						if (this.closed || claimed === undefined) return undefined;
						slot.work = claimed.work;
						slot.worktree = claimed.worktree;
						await this.holdShipping(slot, claimed.work, options.leaseMs);
						if (this.satellite !== undefined) this.claimLog.push(claimed.work);
						// Views of the work on another host's attempt reconnect to this worker's (#4391).
						for (const id of this.remoteWatches.takenOver(claimed.work.id))
							this.endRemoteWatch(id, "attempt_fenced");
						// A child placed on a warm or restored worktree runs there, not in the root's recorded directory.
						return claimed.worktree === undefined
							? claimed.work
							: {
									...claimed.work,
									execution: placedExecution(claimed.work.execution, claimed.worktree, claimed.partial),
								};
					}
					const held = slot.work;
					if (!held) throw new Error("Worker has no active attempt");
					if (message.kind === "place") {
						if (message.op === "release") return this.releasePlace(slot);
						const granted = await this.places.reacquire(slot);
						this.retireWaiting();
						return granted;
					}
					// The heartbeat renews the attempt, records its usage and reads pool control in one transaction.
					if (message.kind === "heartbeat") {
						const record = this.usageLedger!.recording(lease, held, message.reports);
						const beat = await leased(() => queue.heartbeat(lease, held, options.leaseMs, record));
						extensions.adopt(beat.work);
						await this.holdShipping(slot, beat.work, options.leaseMs);
						this.noteUsage(beat.recorded);
						return beat.control;
					}
					// Any other request of a worker whose heartbeat is overdue renews its attempt on the way.
					const work =
						held.expiresAt - Date.now() <= options.leaseMs / 2
							? await leased(() => extensions.extend(held))
							: held;
					if (work !== held) await this.holdShipping(slot, work, options.leaseMs);
					if (message.kind === "activity") {
						for (const run of message.runs) slot.runs.add(run.id);
						return this.publish(work, message.runs);
					}
					if (message.kind === "stage-workspace") {
						const shared = this.sharedPool;
						const host = options.shared?.host;
						if (shared === undefined || host === undefined) return;
						const worktree = slot.worktree ?? String(work.execution.cwd);
						const binding = (work.execution.workspaceBinding as WorkspaceBinding | undefined) ?? null;
						return leased(() =>
							shared.recordStageWorkspace(lease, work, {
								runId: message.runId,
								stageId: message.stageId,
								host,
								worktree,
								binding,
							}),
						);
					}
					if (message.kind === "route") {
						if (this.routes === undefined) return undefined;
						await this.flush();
						this.assertPublished(work);
						routeReady = this.routes.route(work, message.runId);
						return;
					}
					if (message.kind === "delivery-ready") {
						if (!this.publishing) return;
						await this.flush();
						this.assertPublished(work);
						return this.request({
							kind: "ready",
							work: token(work),
							runId: message.runId,
							stageId: message.stageId,
							stageName: message.stageName,
							...(message.sessionId === undefined ? {} : { sessionId: message.sessionId }),
						});
					}
					if (message.kind === "delivery") {
						if (!message.recipient) throw new Error("Worker delivery requires a session identity");
						if (!this.publishing) return;
						await this.flush();
						this.assertPublished(work);
						const id = ++this.requestSequence;
						this.deliveryRequests.set(id, { slot, workerRequest: message.id });
						try {
							return await new Promise((resolve, reject) => {
								this.requests.set(id, { resolve, reject });
								this.port.send({
									kind: "request",
									id,
									request: {
										kind: "deliver",
										work: token(work!),
										runId: message.runId,
										stageId: message.stageId,
										stageName: message.stageName,
										recipient: message.recipient!,
									},
								});
							});
						} finally {
							this.deliveryRequests.delete(id);
						}
					}
					// The worker reads a session it wrote from the shared journal, which holds what it wrote once it is shipped.
					if (message.kind === "session-sync") {
						const shipping = this.shipping;
						if (shipping !== undefined) await leased(() => shipping.flushSession(work, message.sessionId));
						return;
					}
					if (message.kind === "commit") {
						if (
							message.attempt !== undefined &&
							(message.attempt.id !== work.id || message.attempt.generation !== work.generation)
						)
							throw new StaleWorkLeaseError({
								root,
								workId: message.attempt.id,
								generation: message.attempt.generation,
								reason: "superseded",
							});
						const commitShared = () => queue.commit(lease, work, message.operation, message.mutation);
						const shipping = this.shipping;
						const receipt = await leased(() =>
							shipping === undefined
								? commitShared()
								: shipping.commit(work, message.mutation, commitShared, {
										operation: message.operation,
										renewAttempt: () => this.whileRootLate(queue, renewAttempt),
									}),
						);
						this.noteProgress(slot, work, message.mutation.kind !== "session-append");
						// A checkpoint that bills usage is shipped by the time the host acknowledges it from its local journal.
						if (
							message.mutation.kind === "checkpoint"
								? receipt.local !== true || poolCheckpointUsage(message.mutation.checkpoint) !== undefined
								: message.mutation.kind !== "session-append" && receipt.local !== true
						)
							this.noteUsage(await this.usageLedger!.total(root));
						return receipt;
					}
					if (message.kind === "budget") {
						await leased(() => queue.assertCurrent(lease, work));
						if (this.budgetBlocked) throw new Error("Root workflow budget exhausted");
						return leased(() => queue.control(lease));
					}
					if (message.kind !== "complete") throw new Error("Invalid worker operation");
					const shipping = this.shipping;
					if (shipping !== undefined) await leased(() => shipping.flush(work));
					// Relays only accept leased work. Commit this host's last activity before completion releases that lease.
					if (this.satellite !== undefined) await leased(() => this.syncSharedActivity(this.sharedPool!, lease));
					await leased(() => queue.complete(lease, work, message.result as unknown as WorkflowSerializableObject));
					await shipping?.release(work);
					this.endStageWatches((watch) => watch.slot === slot, "stage_finished");
					this.replacements = 0;
					this.attemptEnded(slot, work);
					await this.sendResult(work.id);
				};
				const handled = this.counters.within(message.kind, () =>
					lanes.run(WORKER_REQUEST_LANES[message.kind], answer),
				);
				const response = handled.then((value) => routeReady ?? value);
				// A delivery waits on the worker's own acknowledgements, so it does not count as the pool's wait.
				if (message.kind !== "delivery" && message.kind !== "delivery-ready") {
					this.awaiting.set(worker, (this.awaiting.get(worker) ?? 0) + 1);
					// The worker's silence counts from the pool's answer, not from its question.
					const answered = () => {
						const left = (this.awaiting.get(worker) ?? 1) - 1;
						if (left > 0) this.awaiting.set(worker, left);
						else this.awaiting.delete(worker);
						if (this.incarnations.get(worker) === child)
							this.lastHeard.set(worker, { at: performance.now(), stalled: this.stalledMs });
					};
					void handled.then(answered, answered);
				}
				void response.then(
					(value) => {
						if (!child.connected && workerEndsCleanly(slot)) return;
						child.send(
							{
								id: message.id,
								value,
								...(slot.retired === true ? { retire: true } : {}),
							},
							replied,
						);
					},
					(error: unknown) => {
						// The root's lease is gone (a late one was waited out above): workers end without counting as crashes.
						if (isStaleLeaseError(error)) {
							this.rootLeaseLost = true;
							slot.leaving = true;
							this.detach(error);
						}
						if (!child.connected && workerEndsCleanly(slot)) return;
						child.send({ id: message.id, error: serializeError(error) }, replied);
					},
				);
			});
		});
	}

	/**
	 * Claims work for one of this coordinator's workers. The root's own pool takes any ready work, or, when the pool is
	 * shared, only work without a workspace binding: its host cannot vouch for a tree. A worker host chooses by
	 * placement (#4310): bound work whose tree it has warm first, then the oldest work without a binding, or bound work
	 * it can restore and does not back off from. Bound work it can neither find warm nor restore is never its to run,
	 * however long it waited. A restored child runs at the restore's verified path; a failed restore puts the work back,
	 * as no attempt of the child, for another host, and this host backs off from the binding (#4416).
	 */
	private async claimFor(
		queue: SqlPoolQueue,
		lease: Lease,
		worker: string,
		leaseMs: number,
		slot: WorkerSlot,
		found: () => void,
	): Promise<
		| {
				readonly work: PoolWork;
				readonly worktree?: string;
				readonly partial?: WorkflowWorktreeRestoreOutcome;
		  }
		| undefined
	> {
		const definitions = this.sources.map((source) => ({
			definition: `${source.path}#${source.exportName}`,
			digest: source.digest,
		}));
		const satellite = this.satellite;
		if (satellite === undefined) {
			const shared = this.options?.shared !== undefined;
			const work = await queue.claim(
				lease,
				worker,
				definitions,
				leaseMs,
				shared ? { kind: "unbound" } : undefined,
				(error) => {
					if (infrastructureFaultOf(error) === "storage_unavailable") throw error;
					slot.idle.reset();
				},
			);
			if (work !== undefined) found();
			// A journal in another database than the pool's holds the snapshot's blobs: they are checked as the work is claimed.
			const blobs = this.remote === undefined ? undefined : this.durable?.snapshotBlobs;
			return work === undefined ? undefined : { work: await claimedWithStoredSnapshot(queue, work, blobs) };
		}
		const backoff = satellite.restoreBackoff ?? this.restoreBackoff;
		let chosen: Awaited<ReturnType<typeof choosePlacement>>;
		let work: PoolWork | undefined;
		let refused: { readonly id: string; readonly generation: number } | undefined;
		const attempted = new Map<string, number>();
		for (let remaining = PLACEMENT_CANDIDATES; remaining > 0; remaining--) {
			const ready = await queue.readyCandidates(lease, definitions, PLACEMENT_CANDIDATES);
			const previous = refused;
			if (
				previous !== undefined &&
				ready.some((candidate) => candidate.id === previous.id && candidate.generation === previous.generation)
			) {
				const admission = await queue.acceptsClaim(lease, {
					id: satellite.host,
					providerId: satellite.providerId,
				});
				if (admission === "drain") {
					this.scheduleClaimRetry(SHARED_POLL_MS);
					this.scheduleCandidateRetries(satellite, backoff, ready);
				}
				if (admission !== "accepted") return undefined;
				slot.idle.reset();
			}
			const candidates = ready.filter((candidate) => attempted.get(candidate.id) !== candidate.generation);
			chosen = await choosePlacement(
				candidates,
				(binding) => this.warmWorktree(satellite, binding, slot.exited.signal),
				(binding) => {
					if (satellite.restore === undefined) return false;
					const waitMs = backoff.remaining(workspaceAffinityKey(binding));
					if (waitMs > 0) this.scheduleClaimRetry(waitMs);
					return waitMs === 0;
				},
			);
			if (this.draining || this.closed || slot.exited.signal.aborted) return undefined;
			if (chosen === undefined) {
				this.scheduleCandidateRetries(satellite, backoff, candidates);
				return undefined;
			}
			work = await queue.claim(lease, worker, definitions, leaseMs, {
				kind: "work",
				id: chosen.candidate.id,
				generation: chosen.candidate.generation,
				host: { id: satellite.host, providerId: satellite.providerId },
			});
			if (work !== undefined) break;
			refused = chosen.candidate;
			attempted.set(refused.id, refused.generation);
		}
		if (work === undefined || chosen === undefined) return undefined;
		found();
		const { candidate, worktree } = chosen;
		if (this.closed) {
			await this.releaseHeld(work);
			return undefined;
		}
		slot.claimed = work;
		const binding = candidate.workspace;
		const restore = satellite.restore;
		if (!chosen.restore || binding === undefined || restore === undefined)
			return worktree === undefined ? { work } : { work, worktree };
		let partial: WorkflowWorktreeRestoreOutcome | undefined;
		const restored = await this.whileHolding(
			queue,
			lease,
			work,
			leaseMs,
			async (signal) => {
				const result = await restore(
					binding,
					this.restoreOptions(satellite, signal, carriedSnapshot(work.execution)),
				);
				if (typeof result === "string") return result;
				partial = result.partial;
				return result.path;
			},
			AbortSignal.any([this.closedSignal.signal, slot.exited.signal]),
		);
		// A host that closed put the child back with the rest its workers held; one whose worker exited puts it back here.
		if (this.closed) return undefined;
		if ("closed" in restored) {
			await this.releaseHeld(work);
			return undefined;
		}
		if ("path" in restored) {
			await this.restoreSucceeded(satellite, backoff, binding);
			// A worktree restored with less than the binding's tree still runs the child, which is told (#4738).
			return partial === undefined ? { work, worktree: restored.path } : { work, worktree: restored.path, partial };
		}
		satellite.placementFailed(restored.error);
		// The work goes back to the queue unplaced, for a host that can restore it; an attempt replaced meanwhile has
		// nothing to put back.
		try {
			await queue.releaseUnplaced(lease, work);
		} finally {
			this.shipping?.release(work);
		}
		if (restored.lost !== true) await this.restoreFailed(satellite, backoff, binding, restored.error);
		return undefined;
	}

	private scheduleCandidateRetries(
		satellite: SatellitePlacement,
		backoff: RestoreBackoff,
		candidates: readonly PoolClaimCandidate[],
	): void {
		if (satellite.restore === undefined) return;
		for (const candidate of candidates) {
			if (candidate.workspace === undefined) continue;
			const waitMs = backoff.remaining(workspaceAffinityKey(candidate.workspace));
			if (waitMs > 0) this.scheduleClaimRetry(waitMs);
		}
	}

	private scheduleClaimRetry(waitMs: number): void {
		if (this.closed) return;
		const at = performance.now() + waitMs;
		if (at >= this.claimRetryAt) return;
		clearTimeout(this.claimRetryTimer);
		this.claimRetryAt = at;
		this.claimRetryTimer = setTimeout(() => {
			this.claimRetryTimer = undefined;
			this.claimRetryAt = Number.POSITIVE_INFINITY;
			if (!this.closed) this.idleClaims.wakeOne();
		}, Math.ceil(waitMs)).unref();
	}

	private async restoreFailed(
		satellite: SatellitePlacement,
		backoff: RestoreBackoff,
		binding: WorkspaceBinding,
		error: Error,
	): Promise<void> {
		const key = workspaceAffinityKey(binding);
		const waitMs = backoff.failed(key);
		await this.sharedPool!.recordRestoreBackoff(satellite.host, key, waitMs, serializeError(error)).catch(
			(recording: Error) => satellite.placementFailed(recording),
		);
		this.scheduleClaimRetry(backoff.remaining(key));
	}

	/**
	 * Forgets this host's failed restores of `binding`, which it restored now, here and in the shared journal (#4416). A
	 * record that fails is reported as a placement failure; the restored child runs all the same.
	 */
	private async restoreSucceeded(
		satellite: SatellitePlacement,
		backoff: RestoreBackoff,
		binding: WorkspaceBinding,
	): Promise<void> {
		const key = workspaceAffinityKey(binding);
		if (!backoff.succeeded(key)) return;
		this.idleClaims.wakeOne();
		await this.sharedPool!.clearRestoreBackoff(satellite.host, key).catch((clearing: Error) =>
			satellite.placementFailed(clearing),
		);
	}

	/** Where this host has `binding`'s tree warm, as its `prefer` hook answered within {@link PREFERENCE_CACHE_MS}. */
	private async warmWorktree(
		satellite: SatellitePlacement,
		binding: WorkspaceBinding,
		workerExited: AbortSignal,
	): Promise<string | undefined> {
		const prefer = satellite.prefer;
		if (prefer === undefined) return undefined;
		const key = workspaceAffinityKey(binding);
		const now = performance.now();
		const cached = this.preferences.get(key);
		if (cached !== undefined && now - cached.at < PREFERENCE_CACHE_MS) return cached.path;
		let path: string | undefined;
		try {
			const answered = await this.untilClosed(
				(signal) => Promise.resolve(prefer(binding, this.hookOptions(satellite, signal))),
				AbortSignal.any([this.placingSignal.signal, workerExited]),
			);
			// A satellite that drains or closes, or whose asking worker exited, stopped waiting for the hook: nothing is
			// placed, and nothing is remembered.
			if ("closed" in answered) return undefined;
			path = answered.value;
		} catch (error) {
			// A host whose hook failed does not have the tree warm, as far as placement can tell; the host reports why.
			satellite.placementFailed(error instanceof Error ? error : new Error(String(error)));
		}
		if (this.preferences.size >= PREFERENCE_CACHE_ENTRIES) this.preferences.clear();
		this.preferences.set(key, { path, at: now });
		return path;
	}

	/**
	 * Runs `action` while renewing `work`'s lease on the worker heartbeat. Its failure is returned, never thrown, and so
	 * is a renewal that failed meanwhile (`lost`): the attempt was replaced, or the root's lease moved, and its work is
	 * not handed out. Once `signal` aborts (by default when the coordinator closes), it stops waiting for `action` and
	 * renewing.
	 */
	private async whileHolding(
		queue: SqlPoolQueue,
		lease: Lease,
		work: PoolWork,
		leaseMs: number,
		action: (signal: AbortSignal) => Promise<string>,
		signal: AbortSignal = this.closedSignal.signal,
	): Promise<{ readonly path: string } | { readonly error: Error; readonly lost?: true } | { readonly closed: true }> {
		let renewal: Promise<void> | undefined;
		let lost: Error | undefined;
		const heartbeat = setInterval(() => {
			if (this.closed) return;
			renewal ??= queue
				.extend(lease, work, leaseMs)
				.then(
					() => {},
					(error: Error) => {
						lost ??= error;
					},
				)
				.finally(() => {
					renewal = undefined;
				});
		}, defaultWorkerHeartbeatMs(leaseMs)).unref();
		try {
			// Once `signal` aborts the action is no longer waited for, and its result is not used.
			const outcome = await this.untilClosed(action, signal);
			if ("closed" in outcome) return outcome;
			await renewal;
			return lost === undefined ? { path: outcome.value } : { error: lost, lost: true };
		} catch (error) {
			return { error: error instanceof Error ? error : new Error(String(error)) };
		} finally {
			clearInterval(heartbeat);
			await renewal;
		}
	}

	/** What a worker host's hook is given: the signal that ends the wait for it, and the git the host runs. */
	private hookOptions(satellite: SatellitePlacement, signal: AbortSignal): WorkspaceHookOptions {
		return satellite.git === undefined ? { signal } : { signal, git: satellite.git };
	}

	/** What a worker host's `restore` is given for work: its hook options, and the snapshot the work carries (#4492). */
	private restoreOptions(
		satellite: SatellitePlacement,
		signal: AbortSignal,
		snapshot: WorktreeSnapshot | undefined,
	): WorkspaceHookOptions {
		const options = this.hookOptions(satellite, signal);
		return snapshot === undefined ? options : { ...options, snapshot };
	}

	/**
	 * Runs a hook of the worker host (`prefer`, `restore`) with `signal`, by default the coordinator's close signal, and
	 * stops waiting for it once that aborts: stopping a host never waits on a hook that does not settle (#4310).
	 */
	private async untilClosed<T>(
		hook: (signal: AbortSignal) => Promise<T>,
		signal: AbortSignal = this.closedSignal.signal,
	): Promise<{ readonly value: T } | { readonly closed: true }> {
		if (signal.aborted) return { closed: true };
		let onClose: (() => void) | undefined;
		const closed = new Promise<{ readonly closed: true }>((resolve) => {
			onClose = () => resolve({ closed: true });
			signal.addEventListener("abort", onClose, { once: true });
		});
		try {
			return await Promise.race([hook(signal).then((value) => ({ value })), closed]);
		} finally {
			signal.removeEventListener("abort", onClose!);
		}
	}

	/**
	 * Attempts of a work item in this root incarnation; earlier incarnations' attempts do not count (#3979), nor do its
	 * attempts the shared store's refusals handed on (#4768). `work` as {@link counted} reads it carries those handoffs.
	 */
	private attempts(work: PoolWork): number {
		return work.generation - (this.attemptBase.get(work.id) ?? 0) - this.handoffs(work);
	}

	/** The handoffs of `work` in this root incarnation: those of earlier generations than its base were theirs. */
	private handoffs(work: PoolWork): number {
		const base = this.attemptBase.get(work.id) ?? 0;
		return (work.handoffs ?? []).filter((generation) => generation > base).length;
	}

	/** `work` as the queue holds it now, with its handoffs; `work` itself when the queue no longer has it. */
	private async counted(work: PoolWork): Promise<PoolWork> {
		return (await this.queue!.inspect(this.root!)).find((candidate) => candidate.id === work.id) ?? work;
	}

	/** Whether a newer attempt, or completion, replaced this one. */
	private async superseded(work: PoolWork): Promise<boolean> {
		return attemptSuperseded(await this.queue!.inspect(this.root!), work);
	}

	private assertPublished(work: PoolWork): void {
		const failure = this.publicationFailures.get(work.id);
		if (failure?.generation === work.generation) throw failure.error;
	}

	private recoverExpired(): Promise<void> {
		if (this.recovering) return this.recovering;
		const root = this.root;
		if (
			this.closed ||
			root === undefined ||
			!this.queue ||
			this.lateRoot !== undefined ||
			performance.now() < this.nextRecoveryAt
		)
			return Promise.resolve();
		const queue = this.queue;
		const lease = this.lease!;
		const leaseMs = this.options!.leaseMs;
		this.recovering = (async () => {
			await new Promise<void>((resolve) => setImmediate(resolve));
			await this.admission?.reconcile();
			const expiredBefore = Date.now();
			const rows = await queue.inspect(root);
			this.hasPendingHandoff = rows.some(
				(work) => work.state === "ready" && work.epoch === lease.epoch && this.handoffs(work) > 0,
			);
			const expired = rows.filter((work) => work.state === "leased" && work.expiresAt < expiredBefore);
			// A root that renews late holds back its workers' answers, and so their renewals: nothing is stopped or
			// expired for that silence. Recovery resumes once the renewal lands.
			if (expired.length > 0 && (await queue.rootLease(lease, COORDINATOR_LEASE_MS)) === "late") {
				void this.rootRenewal(queue).catch(() => {});
				return;
			}
			for (const work of expired) {
				// A worker host recovers only its own workers' attempts; the root's own pool recovers every other host's.
				if (this.satellite !== undefined && (work.worker === null || !this.incarnations.has(work.worker))) continue;
				if (this.held.has(work.id)) {
					await queue.extend(lease, work, leaseMs).catch(ignoreStaleWorkLease);
					continue;
				}
				const child = work.worker === null ? undefined : this.incarnations.get(work.worker);
				if (child && work.worker !== null && this.isLive(work.worker, child)) {
					// A live worker keeps only an attempt it knows it holds. One whose claim committed while its answer was lost,
					// or whose placement could not be put back, holds the row without knowing it: extended for as long as the
					// worker lived, its child would never run. It goes back to the queue instead, and the worker, busy or idle, is
					// left alone. No worker ever ran that generation, so it goes back as a handoff, which counts as none of the
					// child's attempts (#4768).
					if (this.slotHolds(work.worker, work)) {
						const renewed = await queue.extend(lease, work, leaseMs).catch(ignoreStaleWorkLease);
						if (renewed !== undefined && this.shipping !== undefined && this.slotRuns(work.worker, renewed))
							await this.shipping.hold(renewed, leaseMs);
					} else {
						await queue.releaseExited(lease, work, { delayMs: 0 });
						await this.shipping?.release(work);
					}
					continue;
				}
				// A worker that outlives SIGKILL is retired without waiting for its exit: its child replays on a replacement
				// within its attempt limit, as for a worker that exited.
				if (child && !(await this.stop(child))) this.retireUnconfirmed(child);
				// Stopping the worker began its exit cleanup, which holds its work until its process groups are reaped.
				if (this.held.has(work.id)) continue;
				// An attempt whose process groups are not confirmed gone is never released for replay, in any incarnation.
				if ((await unconfirmedProcessGroups(this.journal!, root, { attempt: work })).length > 0) continue;
				if (work.epoch < lease.epoch) await this.releaseRetained(work);
				// An attempt that changed hands since it was read (its worker's exit released it, its worker completed it,
				// another worker claimed it) has nothing left to expire. Its fault is never the pool's: thrown from here it
				// failed the whole pool, and so every unfinished child of the pool at once. An attempt whose worker never
				// confirmed its claim, as when the claim's answer was lost before the worker died, goes back as a handoff: no
				// worker ever ran it, so it counts as none of the child's attempts (#5034).
				else {
					await queue
						.expire(lease, work, { handOffUnconfirmed: this.handoffs(work) < MAX_CHILD_HANDOFFS })
						.catch(ignoreStaleWorkLease);
					await this.shipping?.release(work);
				}
			}
			if (expired.length > 0 || this.hasPendingHandoff) this.idleClaims.wakeOne();
			if (this.satellite === undefined && this.sharedPool !== undefined)
				await this.settleShared(queue, lease, this.sharedPool, rows);
		})().finally(() => {
			this.recovering = undefined;
			this.nextRecoveryAt = performance.now() + RECOVERY_INTERVAL_MS;
		});
		return this.recovering;
	}

	/**
	 * What the root's own coordinator of a shared pool settles for work other hosts run (#4310): a result another host
	 * recorded reaches the root; a child other hosts released as often as its attempt limit allows fails, as one this
	 * host's workers lost would; and bound work that waited the claim window for a host that runs it while no live host
	 * could restore its binding, as none can or each backs off from it after its restores failed (#4416), fails with a
	 * {@link WorkspaceRestoreUnavailableError} whose cause is the last of those failures, since no host may run it
	 * anywhere but in its binding's tree.
	 */
	private async settleShared(
		queue: SqlPoolQueue,
		lease: Lease,
		shared: SqlSharedPool,
		rows: readonly PoolWork[],
	): Promise<void> {
		const local = new Set([...this.slots].flatMap((slot) => (slot.work === undefined ? [] : [slot.work.id])));
		const claimWindowMs = this.options?.shared?.claimWindowMs ?? 0;
		const capable = new Map<string, boolean>();
		let readFinalActivity = false;
		for (const work of rows) {
			if (!this.attemptBase.has(work.id)) continue;
			// A failure an unreachable journal may have written reaches the root once a pass reads the work failed; work the
			// journal still has unsettled is settled again below (#4768).
			const unreported = this.unreportedFailures.get(work.id);
			if (unreported !== undefined) {
				this.unreportedFailures.delete(work.id);
				if (work.state === "failed") {
					this.failWork(work, unreported);
					continue;
				}
			}
			const now = performance.now();
			const wait = boundWait(this.boundWaits.get(work.id), work, now);
			if (wait === undefined) this.boundWaits.delete(work.id);
			else this.boundWaits.set(work.id, wait);
			const settlement = sharedSettlement(work, {
				reported: this.reportedResults.has(work.id),
				heldHere: local.has(work.id),
				epoch: lease.epoch,
				attempts: this.attempts(work),
				maxAttempts: MAX_CHILD_ATTEMPTS,
				readyForMs: waitedMs(wait, now),
				claimWindowMs,
			});
			if (settlement === "report-result") {
				// All completions in these rows already have their final relay. Read it before sendResult flushes to the root.
				if (!readFinalActivity) {
					await this.syncSharedActivity(shared, lease);
					readFinalActivity = true;
				}
				await this.sendResult(work.id);
			} else if (settlement === "attempts-exhausted") {
				const failure = this.retryLimit(work, "worker-lost", undefined);
				if (await this.failUnclaimed(queue, lease, work, failure)) this.failWork(work, failure);
			} else if (settlement === "claim-window-passed") {
				const binding = work.execution.workspaceBinding as unknown as WorkspaceBinding;
				const key = workspaceAffinityKey(binding);
				let live = capable.get(key);
				if (live === undefined) {
					live = await shared.capableHostLive(this.root!, WORKER_HOST_TTL_MS, key);
					capable.set(key, live);
				}
				if (live) continue;
				// Read before the work fails, so the failure the root receives never waits on another read (#4768).
				const cause = await shared.restoreFailure(key);
				const failure = new WorkspaceRestoreUnavailableError("no-capable-host", workspaceBindingIdentity(binding), {
					childRunId: work.childRunId,
					claimWindowMs,
					cause: cause === undefined ? undefined : rehydrateError(cause),
				});
				if (!(await this.failUnclaimed(queue, lease, work, failure))) continue;
				this.boundWaits.delete(work.id);
				this.failWork(work, failure);
			}
		}
	}

	/**
	 * Fails unclaimed work, remembering `failure` when the journal could not be reached: the write may have landed, so a
	 * later pass that reads the work failed reports it to the root (#4768).
	 */
	private async failUnclaimed(
		queue: SqlPoolQueue,
		lease: Lease,
		work: PoolWork,
		failure: WorkerRetryLimitError | WorkspaceRestoreUnavailableError,
	): Promise<boolean> {
		try {
			return await queue.failUnclaimed(lease, work);
		} catch (error) {
			if (infrastructureFaultOf(error) === "storage_unavailable") this.unreportedFailures.set(work.id, failure);
			throw error;
		}
	}

	/** Stall accounting for this event loop: a coordinator stall must not count as worker silence. */
	private observeResponsiveness(): void {
		const now = performance.now();
		const gap = now - this.lastTick;
		if (gap > STALL_THRESHOLD_MS) this.stalledMs += gap - TICK_INTERVAL_MS;
		this.lastTick = now;
	}

	/**
	 * Whether a worker still runs its attempt: it is running and connected, and it either waits for this coordinator's
	 * answer or was heard within its work lease, not counting this process's own stalls.
	 */
	/** Whether `worker`'s slot holds `work`'s attempt: running it, or placing the claim that took it. */
	private slotHolds(worker: string, work: PoolWork): boolean {
		for (const slot of this.slots) {
			if (slot.worker !== worker) continue;
			const held = slot.work ?? slot.claimed;
			return held !== undefined && held.id === work.id && held.generation === work.generation;
		}
		return false;
	}

	private slotRuns(worker: string, work: PoolWork): boolean {
		for (const slot of this.slots) {
			if (slot.worker === worker) return this.attemptIsLive(slot, work);
		}
		return false;
	}

	private attemptIsLive(slot: WorkerSlot, work: PoolWork): boolean {
		return (
			this.slots.has(slot) &&
			slot.work !== undefined &&
			slot.work.id === work.id &&
			slot.work.generation === work.generation
		);
	}

	private async holdShipping(slot: WorkerSlot, work: PoolWork, leaseMs: number): Promise<void> {
		if (this.shipping !== undefined && this.attemptIsLive(slot, work)) await this.shipping.hold(work, leaseMs);
	}

	private isLive(worker: string, child: ChildProcess): boolean {
		this.observeResponsiveness();
		const heard = this.lastHeard.get(worker);
		return (
			child.exitCode === null &&
			child.signalCode === null &&
			child.connected &&
			heard !== undefined &&
			((this.awaiting.get(worker) ?? 0) > 0 ||
				performance.now() - heard.at - (this.stalledMs - heard.stalled) < this.options!.leaseMs)
		);
	}

	/**
	 * Sends SIGKILL to a worker and resolves whether its exit was confirmed: by its exit event, or by the kernel, which
	 * reports it gone, or a zombie awaiting this process's reaping (which holds nothing). The bound counts only time this
	 * process was not stalled: a coordinator too busy to handle a worker's exit in time, as on a host running hundreds of
	 * workers, never reports the exit unconfirmed (the timer used to fire before the exit, which waited behind it).
	 */
	private async stop(child: ChildProcess): Promise<boolean> {
		const pid = child.pid;
		const exited = () => child.exitCode !== null || child.signalCode !== null;
		if (pid === undefined || exited()) return true;
		const exit = new Promise<void>((resolve) => child.once("exit", () => resolve()));
		// Once the kernel reports the worker exited, its exit event follows as soon as this process handles it; waiting
		// for it lets the exit begin the worker's cleanup before the caller goes on, as it did before.
		const confirmed = async () => {
			await Promise.race([exit, delay(WORKER_EXIT_CONFIRMATION_MS)]);
			return true;
		};
		this.observeResponsiveness();
		child.kill("SIGKILL");
		const since = performance.now();
		const stalledAt = this.stalledMs;
		for (;;) {
			await Promise.race([exit, delay(WORKER_EXIT_POLL_MS)]);
			if (exited()) return true;
			if (await workerProcessExited(pid)) return confirmed();
			this.observeResponsiveness();
			if (performance.now() - since - (this.stalledMs - stalledAt) >= WORKER_EXIT_CONFIRMATION_MS)
				return exited() || ((await workerProcessExited(pid, true)) && confirmed());
		}
	}

	/**
	 * Retires a worker that SIGKILL did not end within the bound: a health event of the pool, reported once. Its channel
	 * is closed and its attempt ends as on its exit, so its tool process groups are reaped, its child replays on a
	 * replacement within its attempt limit, and a replacement starts. Its exit, if it ever comes, changes nothing more.
	 */
	private retireUnconfirmed(child: ChildProcess): void {
		if (this.unconfirmedExits.has(child)) return;
		this.unconfirmedExits.add(child);
		this.reportHealth(
			this.logs.get(child),
			`Local worker cleanup was not confirmed: worker process ${child.pid} was still running ${WORKER_EXIT_CONFIRMATION_MS} ms after SIGKILL; it was retired and replaced`,
		);
		if (child.connected) child.disconnect();
		for (const slot of this.slots) if (slot.child === child) slot.retire?.();
	}

	/**
	 * Reports a worker's cleanup that could not be confirmed. It is a health event of the pool, never a child's failure:
	 * the line is appended to the worker's log, which the pool then keeps, and the root shows it as a warning on the run.
	 */
	private reportHealth(log: string | undefined, message: string): void {
		if (log !== undefined && !this.logFailures.has(log)) {
			this.keptLogs.add(log);
			void appendFile(log, `[atomic ${new Date().toISOString()}] ${message}\n`).catch((error: Error) =>
				this.logUnwritable(log, logFailureOf(error)),
			);
		}
		this.port.send({ kind: "health", message: log === undefined ? message : `${message} (worker log: ${log})` });
	}

	/**
	 * A worker log the pool could not write: that worker's errors say why, and the pool reports the first such log
	 * once, as a health event, rather than once per worker.
	 */
	private logUnwritable(log: string, failure: string): void {
		const first = this.logFailures.size === 0;
		this.logFailures.set(log, failure);
		if (first)
			this.port.send({
				kind: "health",
				message: `Local worker log ${log} could not be written (${failure}); workers keep running, and their errors name each log that failed`,
			});
	}

	private async close(): Promise<void> {
		this.closed = true;
		this.idleClaims.wakeAll();
		this.closedSignal.abort();
		this.placingSignal.abort();
		clearInterval(this.ticker);
		clearInterval(this.recoveryTimer);
		clearInterval(this.readyProbeTimer);
		clearTimeout(this.claimRetryTimer);
		this.poolReady?.close();
		clearInterval(this.mirrorTimer);
		clearInterval(this.statsTimer);
		clearInterval(this.sharedTimer);
		this.rateLimitOutbox.close();
		await this.fleetRates?.close();
		let failure: unknown;
		let stopping: { readonly child: ChildProcess; readonly log?: string }[] = [];
		let confirmed: boolean[] = [];
		// A worker host's attempts go back to the queue for another worker once its workers are stopped.
		const held =
			this.satellite === undefined
				? []
				: [...this.slots].flatMap((slot) => {
						const work = slot.work ?? slot.claimed;
						return work === undefined ? [] : [work];
					});
		try {
			await this.recovering?.catch(() => {});
			await this.sharedPass;
			stopping = [...this.children].map((child) => ({ child, log: this.logs.get(child) }));
			confirmed = await Promise.all(stopping.map(({ child }) => this.stop(child)));
			const opened = await this.openingShipping?.catch(() => undefined);
			const shipping = this.shipping ?? opened;
			this.shipping = undefined;
			await shipping?.flushAll().catch(() => {});
			await shipping?.close({ retire: this.runEnded() }).catch(() => {});
			// A worker still running after SIGKILL is retired: the pool closes without it and reports it.
			stopping.forEach(({ child }, index) => {
				if (!confirmed[index]) this.retireUnconfirmed(child);
			});
			await Promise.all([...this.cleanups]);
			if (this.cleanupFailure) throw this.cleanupFailure;
			// A reap that finished before close may have left groups running; close reports those still running.
			const alive: number[] = [];
			for (const scope of this.unreaped)
				for (const group of await unconfirmedProcessGroups(this.journal!, this.root!, scope))
					if (!alive.includes(group)) alive.push(group);
			if (alive.length > 0) throw unconfirmedCleanup(alive);
			// Every worker is stopped: work they still held is no attempt's any more, so it does not stay leased
			// after the root ends (#3996). A quit keeps it leased for the root's resume.
			if (this.satellite !== undefined) {
				for (const work of held) await this.releaseHeld(work);
			} else if (this.desiredControl !== "quit" && this.queue !== undefined && this.lease !== undefined)
				// A root that no longer holds its lease has handed its work to its next incarnation.
				await this.queue.releaseClosed(this.lease).catch(ignoreStaleLease);
		} catch (error) {
			failure = error;
		}
		// Logs of the workers close stopped are removed when everything closed cleanly. Those of a pool that failed, and of
		// workers whose cleanup could not be confirmed, are kept for diagnosis.
		if (failure === undefined && !this.failed) {
			const stopped = stopping.flatMap(({ log }, index) =>
				log !== undefined && !this.keptLogs.has(log) && confirmed[index] === true ? [log] : [],
			);
			await Promise.all(stopped.map((log) => rm(log, { force: true }).catch(() => {})));
			if (this.logDirectory !== undefined) await rmdir(this.logDirectory).catch(() => {});
		}
		this.endStageWatches(() => true, "pool_closed");
		this.flush();
		try {
			await this.routes?.close();
		} catch (error) {
			failure ??= error;
		}
		for (const batch of this.batches.values()) batch.settle();
		this.batches.clear();
		this.sendCoordinationStats();
		for (const pending of this.requests.values()) pending.reject(new Error("Local worker pool is closed"));
		this.requests.clear();
		if (failure !== undefined) throw failure;
	}

	private runEnded(): boolean {
		if (this.satellite !== undefined) return this.rootEnded;
		return !this.rootLeaseLost && (this.desiredControl === undefined || this.desiredControl === "running");
	}

	/**
	 * Puts a stopped worker host's attempt back in the queue. A root whose lease was lost, or an attempt another one
	 * replaced, has nothing to put back: the root's next incarnation, or the attempt's new owner, has the work.
	 */
	private async releaseHeld(work: PoolWork): Promise<void> {
		await this.shipping?.release(work);
		try {
			await this.queue!.releaseExited(this.lease!, work);
		} catch (error) {
			if (!isStaleLeaseError(error)) throw error;
		} finally {
			await this.shipping?.release(work);
		}
	}
}

/**
 * A worker's environment with the host's git (#4310): its variables set, and an absolute path's directory first on
 * `PATH`, so the git commands the worker runs resolve to it.
 */
function withHostGit(env: NodeJS.ProcessEnv, git: WorkerHostGit | undefined): NodeJS.ProcessEnv {
	if (git === undefined) return env;
	const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
	return {
		...env,
		...git.env,
		...(isAbsolute(git.path) ? { [pathKey]: [dirname(git.path), env[pathKey]].filter(Boolean).join(delimiter) } : {}),
	};
}

/** Channel to the root host over this process's IPC. */
function processPort(): CoordinatorPort<CoordinatorEvent, CoordinatorInbound> {
	return {
		send(message) {
			// The root may already be gone; its disconnect ends this process.
			if (process.connected) process.send?.(message, () => {});
		},
		onMessage(listener) {
			process.on("message", (message) => listener(message as CoordinatorInbound));
		},
		onClose(listener) {
			process.once("disconnect", () => listener(new Error("Root host disconnected")));
		},
		async close() {
			if (process.connected) process.disconnect();
		},
	};
}

/** Entry of the coordinator process; it lives exactly as long as the root's IPC channel. */
export function runPoolCoordinator(): PoolCoordinator {
	if (typeof process.send !== "function") throw new Error("Local worker pool coordinator requires an IPC channel");
	const port = processPort();
	const coordinator = new PoolCoordinator(port);
	// The root closes the channel after a graceful close, or by dying (even by SIGKILL). Either way this
	// process ends at once, and its workers end when their own channels to it close.
	port.onClose(() => process.exit(0));
	return coordinator;
}

/** How long a child handed on for the `handoffs`-th time waits before it is claimable again: full jitter. */
function handoffDelayMs(handoffs: number): number {
	return Math.random() * Math.min(HANDOFF_DELAY_MAX_MS, HANDOFF_DELAY_BASE_MS * 2 ** Math.min(handoffs, 16));
}
