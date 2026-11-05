import { type ChildProcess, fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { appendFile, mkdir, rm, rmdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { observeSqlPoolTransactions, sqlPoolStorage } from "../durable/journal/internal.js";
import { PoolRemoteJournal } from "../durable/journal/pool-remote-journal.js";
import { resolveRunJournal } from "../durable/journal/resolution.js";
import "../durable/journal/workflows-host-module.js";
import {
	openSqlPoolQueue,
	type PoolControl,
	type PoolWork,
	type SqlPoolQueue,
	STALE_WORK_LEASE,
} from "../durable/journal/sql-pool-queue.js";
import { openSqlPoolUsage, type PoolUsage, type SqlPoolUsage } from "../durable/journal/sql-pool-usage.js";
import { type Lease, type RunJournal, StaleLeaseError } from "../durable/journal/types.js";
import { registerPendingStageIntercomBridge } from "../extension/pending-stage-intercom.js";
import type { StageUserMessageDeliveryAction } from "../runs/foreground/stage-runner-types.js";
import { STAGE_SESSION_HEARTBEAT_INTERVAL_MS } from "../runs/foreground/stage-session-heartbeat.js";
import { workflowInvocationIntercomGroup } from "../shared/intercom-group.js";
import {
	rotateWorkflowPendingStageRouteCapability,
	workflowPendingStageRouteCapability,
} from "../shared/pending-stage-route-capability.js";
import { workflowPendingStageRouteReady } from "../shared/pending-stage-route-readiness.js";
import { createStore, type Store } from "../shared/store.js";
import type { RunSnapshot, StageSnapshot } from "../shared/store-types.js";
import type { WorkflowSerializableObject } from "../shared/types.js";
import { failedOnInfrastructureFault } from "../shared/workflow-infrastructure-error.js";
import { workerProcessExited } from "./admission-host.js";
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
} from "./coordinator-protocol.js";
import { POOL_COORDINATION_STATS_INTERVAL_MS, POOL_SUMMARY_INTERVAL_MS } from "./coordinator-protocol.js";
import type { WorkerDefinitionSource } from "./definitions.js";
import { PoolCoordinationCounters } from "./pool-coordination-stats.js";
import { openDurableJournal, POOL_DURABLE_JOURNAL_ENV } from "./pool-journal.js";
import { configurePooledWatchTrace, tracePooledWatch } from "./pooled-watch-trace.js";
import type {
	DistributiveOmit,
	WorkerPoolControl,
	WorkerRateLimits,
	WorkerRequest,
	WorkerStageCommand,
} from "./protocol.js";
import { RateLimitObservationOutbox, RateLimitObservationSet } from "./rate-limit-sharing.js";
import {
	type ProcessPermitScope,
	reapProcessGroups,
	SqlResourceAdmission,
	unconfirmedProcessGroups,
} from "./resource-admission.js";
import { runsWhilePaused } from "./stage-session-commands.js";
import { StageEventBacklog } from "./stage-watch-coalesce.js";
import type {
	AttemptRef,
	ControlRefusal,
	ControlResult,
	DeliveryOpId,
	DeliveryRefusal,
	DeliveryResult,
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
	WatchEndReason,
	WatchId,
	WatchRefusal,
	WatchResult,
} from "./stage-watch-types.js";
import { startupTimeoutMessage } from "./startup-timeout.js";

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
const STDERR_TAIL_CHARACTERS = 8192;
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

/**
 * A refusal under the root's own lease: it is gone (released at teardown, or taken by another incarnation), which is not
 * a worker fault (#3979), or its renewal is late, which the pool waits out (see `PoolCoordinator.whileRootLate`).
 */
function isRootLeaseLost(error: Error): boolean {
	return error instanceof StaleLeaseError || error.message.startsWith("Stale lease for run ");
}

type RouteOwner = ReturnType<typeof import("../../../intercom/workflow-route-owner.js").createWorkflowRouteOwner>;
type Bridge = ReturnType<typeof registerPendingStageIntercomBridge>;

function unconfirmedCleanup(groups: readonly number[]): Error {
	return new Error(
		`Local worker process cleanup unconfirmed; ${groups.length > 0 ? `process groups ${groups.join(", ")} still running after SIGKILL; ` : ""}permits quarantined`,
	);
}

export function workerLogDirectory(journalPath: string, root: string): string {
	return join(dirname(resolve(journalPath)), "worker-logs", encodeURIComponent(root).replaceAll(".", "%2E"));
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

function outside(runId: string): Error {
	return new Error(`Pool stage publication is outside the work subtree: ${runId}`);
}

function isLiveStage(stage: StageSnapshot): boolean {
	return (
		(stage.sessionId !== undefined || stage.sessionFile !== undefined) &&
		stage.status !== "completed" &&
		stage.status !== "failed" &&
		stage.status !== "skipped"
	);
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
	private readonly owners = new Map<string, string>();
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
					this.owners.set(run.id, work.id);
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
		const attempt = this.attempts.get(work.id);
		if (attempt === undefined || attempt.generation !== work.generation || attempt.fenced)
			throw new Error(STALE_WORK_LEASE);
		if (!attempt.runs.has(runId)) throw outside(runId);
	}

	private release(attempt: Attempt): void {
		this.mirror.batch(() => {
			for (const id of attempt.runs) {
				rotateWorkflowPendingStageRouteCapability(this.mirror, id);
				const run = this.mirror.run(id);
				if (run?.stages.some(isLiveStage) !== true) continue;
				this.mirror.recordRunStart({
					...run,
					stages: run.stages.map((stage) => {
						if (!isLiveStage(stage)) return stage;
						const { sessionId: _session, sessionFile: _file, ...rest } = stage;
						return { ...rest, attachable: false, attached: false };
					}),
				});
			}
		});
	}
}

interface WorkerSlot {
	readonly worker: string;
	readonly child: ChildProcess;
	work?: PoolWork;
	readonly deliveries: Map<string, { resolve: () => void; reject: (error: Error) => void }>;
	/** Runs the current attempt published, so a stage watch can find the worker that runs it. */
	readonly runs: Set<string>;
	/** Stage commands awaiting the worker's result; undefined resolves a worker that exited. */
	readonly stageCommands: Map<number, (result: StageCommandResult | undefined) => void>;
	/** Ends the worker's attempt as its exit does; called for a worker that SIGKILL did not end within the bound. */
	retire?: () => void;
	/** The worker said it ends between children to give its memory back: its exit is not a crash (#4197). */
	recycled?: boolean;
}

interface StageCommandResult {
	readonly snapshot?: PooledStageChatSnapshot;
	readonly refusal?: WatchRefusal | DeliveryRefusal | ControlRefusal | PromptRefusal;
	readonly action?: StageUserMessageDeliveryAction;
	readonly question?: PooledStageQuestion;
	readonly bash?: PooledBashResult;
	readonly task?: PooledTaskReply;
	readonly error?: string;
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
export class PoolCoordinator {
	private readonly children = new Set<ChildProcess>();
	private readonly incarnations = new Map<string, ChildProcess>();
	private readonly readyWorkers = new Set<string>();
	private readonly logs = new Map<ChildProcess, string>();
	/** Logs of workers whose cleanup could not be confirmed: close keeps them. */
	private readonly keptLogs = new Set<string>();
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
	private readonly batches = new Map<number, { readonly entries: readonly PoolActivityEntry[]; settle(): void }>();
	private readonly publicationFailures = new Map<string, { readonly generation: number; readonly error: string }>();
	private readonly requests = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
	private readonly deliveryRequests = new Map<number, { readonly slot: WorkerSlot; readonly workerRequest: number }>();
	private readonly inflight = new Set<Promise<unknown>>();
	private readonly slots = new Set<WorkerSlot>();
	private readonly watches = new Map<WatchId, StageWatch>();
	private readonly endedWatches = new Map<WatchId, WatchEndReason>();
	private stageCommandSequence = 0;
	private promptNodes = false;
	/** Provider and model limits recorded anywhere in the pool, sent to every worker and the root (#4023). */
	private readonly rateLimits = new RateLimitObservationSet();
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
	private flushTimer?: NodeJS.Timeout;
	private lastFlushAt = 0;
	private batchSequence = 0;
	private requestSequence = 0;
	private usageChanged = false;
	private budgetBlocked = false;
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
	private closing?: Promise<void>;
	private replacements = 0;
	/** Whether the pool has said that its workers' memory limit replaces every worker after one child. */
	private recycleLimitReported = false;
	/** Set once the root's lease is gone: workers then end without counting as crashes, and none is replaced. */
	private rootLeaseLost = false;
	/** Settles once a late root renewal lands (true) or the root's lease is lost or the pool closes (false). */
	private lateRoot?: Promise<boolean>;
	/** Generation of each work item when this root incarnation enqueued it: attempts count from here (#3979). */
	private readonly attemptBase = new Map<string, number>();

	constructor(private readonly port: CoordinatorPort<CoordinatorEvent, CoordinatorInbound>) {
		port.onMessage((message) => this.receive(message));
		this.ticker = setInterval(() => this.observeResponsiveness(), TICK_INTERVAL_MS).unref();
		this.statsTimer = setInterval(() => this.sendCoordinationStats(), POOL_COORDINATION_STATS_INTERVAL_MS).unref();
	}

	/** The pool's journal, with every pool transaction on it counted by the request or task that submits it. */
	private async openCountedJournal(path: string): Promise<RunJournal> {
		const journal = await resolveRunJournal({ journal: { path } });
		observeSqlPoolTransactions(journal, () => this.counters.write());
		return journal;
	}

	private sendCoordinationStats(): void {
		const stats = this.counters.sample(true);
		if (stats !== undefined) this.port.send({ kind: "coordination", stats });
	}

	/** Closes the journal connection once the pool is closed and every command already received has settled. */
	async shutdown(): Promise<void> {
		await this.closing?.catch(() => {});
		while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
		await this.journal?.close().catch(() => {});
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
				if (!(error instanceof Error) || !isRootLeaseLost(error) || !(await this.rootRenewal(queue))) throw error;
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
			if (message.error !== undefined) pending?.reject(new Error(message.error));
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
					(error: Error) => this.port.send({ kind: "reply", id: command.id, error: error.message }),
				);
			this.inflight.add(handled);
			void handled.finally(() => this.inflight.delete(handled));
			return;
		}
		this.counters.within(kind, () => this.notice(message as CoordinatorNotice));
	}

	private notice(notice: CoordinatorNotice): void {
		if (notice.kind === "stage-events-applied") this.stageEventsApplied(notice.watch);
		else if (notice.kind === "budget") this.budgetBlocked = notice.blocked;
		else if (notice.kind === "root") this.routes?.updateRoot(notice.rootRun);
		else if (notice.kind === "rate-limits") this.observeRateLimits(notice.observations);
		else {
			const batch = this.batches.get(notice.batch);
			this.batches.delete(notice.batch);
			const rejected = new Map(notice.rejected.map((entry) => [entry.workId, entry]));
			for (const entry of rejected.values())
				this.publicationFailures.set(entry.workId, { generation: entry.generation, error: entry.error });
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
				return this.stageQuestion(command.runId, command.stageId);
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
		configurePooledWatchTrace(options.journalPath, "coordinator");
		this.journal ??= await this.openCountedJournal(options.journalPath);
		if (options.durable !== undefined && this.remote === undefined) {
			this.durable = await openDurableJournal(options.durable);
			this.remote = new PoolRemoteJournal(this.durable, sqlPoolStorage(this.journal)!);
		}
		// The queue reads the root's status and lease from the database it shares with them: bring them up to date first.
		await this.remote?.mirror(lease);
		this.usageLedger ??= await openSqlPoolUsage(this.journal);
		this.usageTotal = await this.usageLedger.total(root);
		this.lease = lease;
		const queue = await openSqlPoolQueue(this.journal, this.remote);
		await this.whileRootLate(queue, () => queue.initialize(lease, COORDINATOR_LEASE_MS));
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
			).catch((error: Error) => {
				if (error.message !== STALE_WORK_LEASE) throw error;
			});
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
		const message: WorkerPoolControl = { kind: "pool-control", control };
		for (const slot of this.slots)
			if (this.readyWorkers.has(slot.worker) && slot.child.connected)
				slot.child.send(message, (error) => {
					if (error) slot.child.kill("SIGKILL");
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
			throw new Error("Local worker pool requires root preparation");
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
			});
		this.logDirectory = workerLogDirectory(this.options.journalPath, root);
		await mkdir(this.logDirectory, { recursive: true }).catch(() => undefined);
		this.recoveryTimer = setInterval(() => {
			this.counters.enter("recovery");
			void this.recoverExpired().catch(async (error: Error) => {
				// A late root renewal stops nothing: the next recovery runs once it lands.
				if (this.queue && isRootLeaseLost(error) && (await this.rootRenewal(this.queue).catch(() => false))) return;
				this.fail(error);
			});
		}, RECOVERY_INTERVAL_MS).unref();
		const workers = Array.from({ length: this.options.workers }, () => this.spawn());
		try {
			await Promise.any(workers);
		} catch (error) {
			throw (error as AggregateError).errors[0];
		}
	}

	private async enqueue(command: Extract<CoordinatorCommandBody, { kind: "enqueue" }>) {
		if (!this.queue || !this.lease || this.root === undefined)
			throw new Error("Local worker pool requires root preparation");
		if (command.rootRun !== undefined) this.routes?.updateRoot(command.rootRun);
		const queue = this.queue;
		const lease = this.lease;
		const work = await this.retainedTransition(async () => {
			let enqueued = await this.whileRootLate(queue, () =>
				queue.enqueue(lease, command.descriptor, command.boundary, {
					acceptEntryChanges: command.acceptEntryChanges === true,
				}),
			);
			// A child an earlier incarnation completed with a failure of the pool's own, such as a stage that lost its
			// worker's delivery or lease on a busy host, runs again when the resumed root asks for it: the failure was not
			// the child's, and replaying it would fail the child for good.
			if (enqueued.state === "completed" && enqueued.epoch < lease.epoch)
				enqueued =
					(await this.whileRootLate(queue, () =>
						queue.reopenCompleted(lease, enqueued.id, failedOnInfrastructureFault),
					)) ?? enqueued;
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
		const result = await this.queue.result(this.root, work.id);
		return { work, ...(result === undefined ? {} : { result }) };
	}

	private async transport(request: number, payload: DeliveryPayload): Promise<void> {
		const target = this.deliveryRequests.get(request);
		// The root answers a delivery request when its drain ends, so a transport after that is a root defect, not a worker
		// that exited: say so, rather than blame a worker that is still running the stage.
		if (target === undefined) throw new Error("Pooled stage delivery request already answered");
		if (!this.incarnations.has(target.slot.worker)) throw new Error("Worker exited before delivery acknowledgement");
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
		this.port.send({ kind: "failure", error: error.message });
	}

	/** Fails one child without failing the pool. */
	private failWork(work: PoolWork, error: Error): void {
		this.port.send({ kind: "work-failure", workId: work.id, error: error.message });
	}

	/** Records the latest activity of one attempt; the root receives it with the next summary. */
	private publish(work: PoolWork, runs: readonly RunSnapshot[]): void {
		const failure = this.publicationFailures.get(work.id);
		if (failure?.generation === work.generation) throw new Error(failure.error);
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
		const entries = [...this.pendingActivity.values()];
		this.pendingActivity.clear();
		const usage = this.usageChanged ? this.usageTotal : undefined;
		this.usageChanged = false;
		const settled = new Promise<void>((resolve) => this.batches.set(batch, { entries, settle: resolve }));
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
		const result = await this.queue!.result(this.root!, workId);
		if (result === undefined) return false;
		this.flush();
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
		if (slot?.work === undefined) return { ok: false, refusal: "StageNotOnWorker" };
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
		const watch = this.watches.get(id);
		if (watch === undefined) return;
		this.watches.delete(id);
		if (watch.slot.work?.id === watch.attempt.workId && watch.slot.work.generation === watch.attempt.generation)
			void this.stageCommand(watch.slot, { attempt: watch.attempt, op: "unwatch", watch: id });
	}

	/** Admits user text through the airlock of the worker that holds the watch's attempt. */
	private async stageDeliver(delivery: PooledStageDelivery): Promise<DeliveryResult> {
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
		if (result.error !== undefined) throw new Error(result.error);
		if (result.action !== undefined) return { ok: true, action: result.action };
		const refusal = result.refusal;
		return {
			ok: false,
			refusal: refusal === "StageNotLive" || refusal === "Unconfirmed" ? refusal : "StaleAttempt",
		};
	}

	/** Reads a stage's brokered question from the worker whose attempt published the stage's run. */
	private async stageQuestion(runId: string, stageId: string): Promise<PooledStageQuestion | undefined> {
		const slot = [...this.slots].find((candidate) => candidate.work !== undefined && candidate.runs.has(runId));
		if (slot?.work === undefined) return undefined;
		const attempt = { workId: slot.work.id, generation: slot.work.generation };
		return (await this.stageCommand(slot, { attempt, op: "question", runId, stageId }))?.question;
	}

	/** Answers a prompt through the airlock of the worker whose attempt published the stage's run. */
	private async stageAnswer(runId: string, stageId: string, answer: PooledPromptAnswer): Promise<PromptResult> {
		const slot = [...this.slots].find((candidate) => candidate.work !== undefined && candidate.runs.has(runId));
		if (slot?.work === undefined) return { ok: false, refusal: "StaleAttempt" };
		const attempt = { workId: slot.work.id, generation: slot.work.generation };
		const result = await this.stageCommand(slot, { attempt, op: "answer", runId, stageId, answer });
		if (result === undefined) return { ok: false, refusal: "StaleAttempt" };
		if (result.error !== undefined) throw new Error(result.error);
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
		if (result.error !== undefined) throw new Error(result.error);
		const refusal = result.refusal;
		if (refusal === "StageNotLive" || refusal === "PoolPausedOrQuitting" || refusal === "StaleAttempt")
			return { ok: false, refusal };
		if (refusal !== undefined) return { ok: false, refusal: "StaleAttempt" };
		return { ok: true, ...(result.action === undefined ? {} : { action: result.action }) };
	}

	/** Runs a session command on one watched stage through its worker's airlock. */
	private async stageSession(id: WatchId, command: PooledStageSessionCommand): Promise<SessionCommandResult> {
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
		if (result.error !== undefined) throw new Error(result.error);
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
					error: result?.error,
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
		this.endedWatches.set(id, reason);
		if (this.endedWatches.size > ENDED_WATCHES_REMEMBERED)
			this.endedWatches.delete(this.endedWatches.keys().next().value!);
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
			if (this.rateLimits.merge(observation)) this.rateLimitOutbox.offer(observation);
	}

	private shareRateLimits(observations: WorkerRateLimits["observations"]): void {
		const message: WorkerRateLimits = { kind: "rate-limits", observations };
		// A worker that is not ready yet receives every current limit when it reports ready.
		for (const slot of this.slots)
			if (this.readyWorkers.has(slot.worker) && slot.child.connected) slot.child.send(message, () => {});
		this.port.send(message);
	}

	private fence(work: PoolWork): void {
		this.endStageWatches(
			(watch) => watch.attempt.workId === work.id && watch.attempt.generation <= work.generation,
			"attempt_fenced",
		);
		this.pendingActivity.delete(work.id);
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
					journalPath: options.journalPath,
					heartbeatMs: options.heartbeatMs,
					root,
					definitions: this.sources,
					admission: options.admission,
					...(this.promptNodes ? { promptNodes: true } : {}),
					...(options.stageStartMaxLoadPerCpu === undefined
						? {}
						: { stageStartMaxLoadPerCpu: options.stageStartMaxLoadPerCpu }),
					...(options.maxWorkerRssBytes === undefined ? {} : { maxRssBytes: options.maxWorkerRssBytes }),
				}),
			],
			{
				stdio: ["ignore", "ignore", "pipe", "ipc"],
				execArgv: [],
				// The durable journal's selection goes through the environment: argv is readable by every process on the host.
				...(options.durable === undefined
					? {}
					: { env: { ...process.env, [POOL_DURABLE_JOURNAL_ENV]: JSON.stringify(options.durable) } }),
			},
		);
		const disconnected = new Promise<void>((resolve) => child.once("disconnect", () => resolve()));
		this.children.add(child);
		if (child.pid !== undefined) this.port.send({ kind: "spawned", pid: child.pid });
		const worker = randomUUID();
		this.incarnations.set(worker, child);
		const slot: WorkerSlot = { worker, child, deliveries: new Map(), runs: new Set(), stageCommands: new Map() };
		this.slots.add(slot);
		let ready = false;
		let serial: Promise<void> = Promise.resolve();
		const logPath = join(this.logDirectory!, `${worker}.log`);
		this.logs.set(child, logPath);
		let logFailure: string | undefined;
		const log = createWriteStream(logPath, { flags: "a" });
		log.on("error", (error) => {
			logFailure = error.message;
		});
		let stderr = "";
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr = (stderr + chunk.toString()).slice(-STDERR_TAIL_CHARACTERS);
		});
		child.stderr?.on("error", (error) => {
			logFailure ??= error.message;
			log.end();
		});
		child.stderr?.pipe(log);
		const diagnosed = (summary: string) =>
			new Error(
				`${summary} (worker stderr log: ${logFailure === undefined ? logPath : `unavailable, ${logFailure}`})${stderr ? `: ${stderr}` : ""}`,
			);
		const startupTimeoutMs = options.startupTimeoutMs;
		let timedOut = false;
		let terminated = false;
		const terminate = () => {
			if (terminated) return;
			terminated = true;
			child.kill("SIGKILL");
		};
		const replied = (error: Error | null) => {
			if (error) terminate();
		};
		return new Promise((resolve, reject) => {
			const startup = setTimeout(() => {
				timedOut = true;
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
				void Promise.race([closed, delay(STDERR_DRAIN_GRACE_MS)]).then(() =>
					reject(
						diagnosed(
							timedOut ? startupTimeoutMessage(startupTimeoutMs) : "Local worker exited before readiness",
						),
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
				this.endStageWatches((watch) => watch.slot === slot, "worker_exited");
				for (const settle of slot.stageCommands.values()) settle(undefined);
				slot.stageCommands.clear();
				if (slot.work) this.fence(slot.work);
				for (const delivery of slot.deliveries.values())
					delivery.reject(new Error("Worker exited before delivery acknowledgement"));
				slot.deliveries.clear();
				// The exited worker's work stays leased until its process groups are reaped, so no other worker can
				// claim it while they are being reaped.
				const held = slot.work;
				if (held) this.held.add(held.id);
				// Set when the reap leaves process groups running: the worker's health event, never its child's failure.
				let unconfirmed: Error | undefined;
				const cleanup = disconnected
					.then(() => serial)
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
							slot.recycled === true &&
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
						// running. Its work item ends failed in the same transaction, so no worker claims it again.
						const exhausted = work !== undefined && this.attempts(work) >= MAX_CHILD_ATTEMPTS;
						const queue = this.queue!;
						const lease = this.lease!;
						const attempt = work;
						const settled =
							attempt !== undefined &&
							(await this.whileRootLate(queue, () =>
								exhausted ? queue.failExited(lease, attempt) : queue.releaseExited(lease, attempt),
							));
						// An exit whose attempt another one already replaced is not that child's failure: its owner keeps it.
						const superseded = work !== undefined && !settled && (await this.superseded(work));
						if (work !== undefined && exhausted && !superseded)
							this.failWork(
								work,
								diagnosed(
									`${childRetryLimit(work, "lost its worker")}${unconfirmed === undefined ? "" : `; ${unconfirmed.message}`}`,
								),
							);
						// Workers that crash without work are a pool-wide fault. A child that lost its worker consumes its own
						// attempts, so those replacements are bounded by the children and never count toward this limit. A
						// worker that ended itself between children for its memory did not crash: it is replaced without
						// counting.
						if (work === undefined && slot.recycled === true) await this.spawn();
						else if (work === undefined && ++this.replacements > 3)
							this.fail(diagnosed("Local worker retry limit"));
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
					if (message.error) pending?.reject(new Error(message.error));
					else pending?.resolve();
					return;
				}
				// A route's registration wait can outlast a reconnect; it settles outside the worker's serial chain so
				// the worker's heartbeats and control acknowledgements are answered meanwhile.
				let routeReady: Promise<string> | undefined;
				const answer = async () => {
					if (message.kind === "ready") {
						if (terminated) return;
						ready = true;
						// Sent before the readiness reply, so the worker holds them before it claims any work.
						const limits = this.rateLimits.current();
						if (limits.length > 0)
							child.send({ kind: "rate-limits", observations: limits } satisfies WorkerRateLimits, replied);
						this.readyWorkers.add(worker);
						clearTimeout(startup);
						resolve();
						return;
					}
					await this.starting;
					const queue = this.queue!;
					const lease = this.lease!;
					// While the root renews late, the worker's request waits for the renewal rather than ending its attempt.
					// The worker's own renewals queue behind that request, so the wait can outlast the attempt's work lease:
					// it is renewed before the request runs again, which fences the request only if another attempt replaced it.
					const renewAttempt = async () => {
						const attempt = slot.work;
						if (attempt === undefined) return;
						const renewed = await queue.extend(lease, attempt, options.leaseMs);
						if (slot.work === attempt) slot.work = renewed;
					};
					// A request from this worker shows it is alive, so a work lease that only lapsed while the request waited
					// (this process starved of CPU, the journal's write lock held by other writers) does not fence it: the
					// lease is extended and the request runs again. `extend` checks the attempt's identity, so an attempt that
					// recovery replaced stays refused (#3888).
					const current = async <T>(action: () => Promise<T>): Promise<T> => {
						try {
							return await action();
						} catch (error) {
							if (!(error instanceof Error) || error.message !== STALE_WORK_LEASE || slot.work === undefined)
								throw error;
							await renewAttempt();
							return action();
						}
					};
					const leased = <T>(action: () => Promise<T>) =>
						this.whileRootLate(queue, () => current(action), renewAttempt);
					if (message.kind === "control") return leased(() => queue.control(lease));
					if (message.kind === "fenced") {
						const fenced = slot.work;
						slot.work = undefined;
						// Its current owner keeps superseded work. Work still leased to this attempt was refused by the root,
						// or its run failed on a fault of the pool: it is released for replay and counts as a failed attempt,
						// so refusals and faults stay bounded.
						if (fenced && !(await this.superseded(fenced))) {
							// Views of the attempt's stages end with it, so they reconnect to its replay.
							this.fence(fenced);
							if (this.attempts(fenced) < MAX_CHILD_ATTEMPTS)
								await leased(() => queue.releaseExited(lease, fenced));
							else if (await leased(() => queue.failExited(lease, fenced)))
								this.failWork(
									fenced,
									new Error(
										childRetryLimit(
											fenced,
											message.fault === undefined
												? "was refused by the root as stale on every attempt"
												: `failed on a fault of the pool on every attempt (last: ${message.fault})`,
										),
									),
								);
						}
						return;
					}
					if (message.kind === "controlled") {
						const control = await leased(() => queue.control(lease));
						if (message.revision > control.revision) throw new Error("Unknown control revision");
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
						if (this.budgetBlocked) return;
						slot.work = await leased(async () => {
							await this.recoverExpired();
							slot.runs.clear();
							return queue.claim(
								lease,
								worker,
								this.sources.map((source) => ({
									definition: `${source.path}#${source.exportName}`,
									digest: source.digest,
								})),
								options.leaseMs,
							);
						});
						return slot.work;
					}
					const held = slot.work;
					if (!held) throw new Error("Worker has no active attempt");
					// The heartbeat renews the attempt, records its usage and reads pool control in one transaction.
					if (message.kind === "heartbeat") {
						const record = this.usageLedger!.recording(lease, held, message.reports);
						const beat = await leased(() => queue.heartbeat(lease, held, options.leaseMs, record));
						slot.work = beat.work;
						this.noteUsage(beat.recorded);
						return beat.control;
					}
					// Any other request of a worker whose heartbeat is overdue renews its attempt on the way.
					const work =
						held.expiresAt - Date.now() < options.leaseMs / 2
							? await leased(() => queue.extend(lease, held, options.leaseMs))
							: held;
					slot.work = work;
					if (message.kind === "activity") {
						for (const run of message.runs) slot.runs.add(run.id);
						return this.publish(work, message.runs);
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
					if (message.kind === "commit") {
						const receipt = await leased(() => queue.commit(lease, work, message.operation, message.mutation));
						// #3983: a session append bills no usage, so its receipt does not wait on another transaction.
						if (message.mutation.kind !== "session-append") this.noteUsage(await this.usageLedger!.total(root));
						return receipt;
					}
					if (message.kind === "budget") {
						await leased(() => queue.assertCurrent(lease, work));
						if (this.budgetBlocked) throw new Error("Root workflow budget exhausted");
						return leased(() => queue.control(lease));
					}
					if (message.kind !== "complete") throw new Error("Invalid worker operation");
					await leased(() => queue.complete(lease, work, message.result as unknown as WorkflowSerializableObject));
					this.endStageWatches((watch) => watch.slot === slot, "stage_finished");
					this.replacements = 0;
					slot.work = undefined;
					await this.sendResult(work.id);
				};
				const handled = this.counters.within(message.kind, () => serial.then(answer));
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
					serial = handled.then(answered, answered);
				}
				void response.then(
					(value) => child.send({ id: message.id, value }, replied),
					(error: Error) => {
						const rootLeaseLost = isRootLeaseLost(error);
						if (rootLeaseLost) this.rootLeaseLost = true;
						child.send(
							{
								id: message.id,
								error: error.message,
								...(error.message === STALE_WORK_LEASE ? { fenced: true } : {}),
								...(rootLeaseLost ? { rootLeaseLost: true } : {}),
							},
							replied,
						);
					},
				);
			});
		});
	}

	/** Attempts of a work item in this root incarnation; earlier incarnations' attempts do not count (#3979). */
	private attempts(work: PoolWork): number {
		return work.generation - (this.attemptBase.get(work.id) ?? 0);
	}

	/** Whether a newer attempt, or completion, replaced this one. */
	private async superseded(work: PoolWork): Promise<boolean> {
		const current = (await this.queue!.inspect(this.root!)).find((candidate) => candidate.id === work.id);
		return current === undefined || current.generation !== work.generation || current.state === "completed";
	}

	private assertPublished(work: PoolWork): void {
		const failure = this.publicationFailures.get(work.id);
		if (failure?.generation === work.generation) throw new Error(failure.error);
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
			const expired = (await queue.inspect(root)).filter(
				(work) => work.state === "leased" && work.expiresAt < expiredBefore,
			);
			// A root that renews late holds back its workers' answers, and so their renewals: nothing is stopped or
			// expired for that silence. Recovery resumes once the renewal lands.
			if (expired.length > 0 && (await queue.rootLease(lease, COORDINATOR_LEASE_MS)) === "late") {
				void this.rootRenewal(queue).catch(() => {});
				return;
			}
			for (const work of expired) {
				if (this.held.has(work.id)) {
					await queue.extend(lease, work, leaseMs).catch((error: Error) => {
						if (error.message !== STALE_WORK_LEASE) throw error;
					});
					continue;
				}
				const child = work.worker === null ? undefined : this.incarnations.get(work.worker);
				if (child && work.worker !== null && this.isLive(work.worker, child)) {
					await queue.extend(lease, work, leaseMs).catch((error: Error) => {
						if (error.message !== STALE_WORK_LEASE) throw error;
					});
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
				// failed the whole pool, and so every unfinished child of the pool at once.
				else
					await queue.expire(lease, work).catch((error: Error) => {
						if (error.message !== STALE_WORK_LEASE) throw error;
					});
			}
		})().finally(() => {
			this.recovering = undefined;
			this.nextRecoveryAt = performance.now() + RECOVERY_INTERVAL_MS;
		});
		return this.recovering;
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
			if (workerProcessExited(pid)) return confirmed();
			this.observeResponsiveness();
			if (performance.now() - since - (this.stalledMs - stalledAt) >= WORKER_EXIT_CONFIRMATION_MS)
				return exited() || (workerProcessExited(pid, true) && confirmed());
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
		if (log !== undefined) {
			this.keptLogs.add(log);
			void appendFile(log, `[atomic ${new Date().toISOString()}] ${message}\n`).catch(() => {});
		}
		this.port.send({ kind: "health", message: log === undefined ? message : `${message} (worker log: ${log})` });
	}

	private async close(): Promise<void> {
		this.closed = true;
		clearInterval(this.ticker);
		clearInterval(this.recoveryTimer);
		clearInterval(this.mirrorTimer);
		clearInterval(this.statsTimer);
		this.rateLimitOutbox.close();
		let failure: unknown;
		let stopping: { readonly child: ChildProcess; readonly log?: string }[] = [];
		let confirmed: boolean[] = [];
		try {
			await this.recovering?.catch(() => {});
			stopping = [...this.children].map((child) => ({ child, log: this.logs.get(child) }));
			confirmed = await Promise.all(stopping.map(({ child }) => this.stop(child)));
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
			if (this.desiredControl !== "quit" && this.queue !== undefined && this.lease !== undefined)
				// A root that no longer holds its lease has handed its work to its next incarnation.
				await this.queue.releaseClosed(this.lease).catch((error: Error) => {
					if (!(error instanceof StaleLeaseError)) throw error;
				});
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
}

/** The retry limit message of one child, naming it by its child run and definition export. */
function childRetryLimit(work: PoolWork, reason: string): string {
	const exportName = work.definition.slice(work.definition.lastIndexOf("#") + 1);
	return `Local worker retry limit: child ${work.childRunId} (${exportName}) ${reason} ${MAX_CHILD_ATTEMPTS} times`;
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
