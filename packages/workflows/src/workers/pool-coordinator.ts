import { type ChildProcess, fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm, rmdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
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
import type { Lease, RunJournal } from "../durable/journal/types.js";
import { registerPendingStageIntercomBridge } from "../extension/pending-stage-intercom.js";
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
import { POOL_SUMMARY_INTERVAL_MS } from "./coordinator-protocol.js";
import type { WorkerDefinitionSource } from "./definitions.js";
import type { DistributiveOmit, WorkerRequest, WorkerStageCommand } from "./protocol.js";
import {
	type ProcessPermitScope,
	reapProcessGroups,
	SqlResourceAdmission,
	unconfirmedProcessGroups,
} from "./resource-admission.js";
import { StageEventBacklog } from "./stage-watch-coalesce.js";
import type {
	AttemptRef,
	PooledStageChatSnapshot,
	SeqEvent,
	WatchEndReason,
	WatchId,
	WatchRefusal,
	WatchResult,
} from "./stage-watch-types.js";
import { startupTimeoutMessage } from "./startup-timeout.js";

const CONTROL_ACKNOWLEDGEMENT_TIMEOUT_MS = 5_000;
const RECOVERY_INTERVAL_MS = 500;
const TICK_INTERVAL_MS = 100;
const STALL_THRESHOLD_MS = 500;
const COORDINATOR_LEASE_MS = 3 * STAGE_SESSION_HEARTBEAT_INTERVAL_MS;
const STDERR_TAIL_CHARACTERS = 8192;
const STDERR_DRAIN_GRACE_MS = 1_000;
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
				const run = this.mirror.runs().find((candidate) => candidate.id === id);
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
}

interface StageCommandResult {
	readonly snapshot?: PooledStageChatSnapshot;
	readonly refusal?: WatchRefusal;
}

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
	private readonly cleanups = new Set<Promise<void>>();
	private readonly controlAcks = new Map<string, number>();
	private readonly lastHeard = new Map<string, { readonly at: number; readonly stalled: number }>();
	private readonly pendingActivity = new Map<string, PoolActivityEntry>();
	private readonly batches = new Map<number, { readonly entries: readonly PoolActivityEntry[]; settle(): void }>();
	private readonly publicationFailures = new Map<string, { readonly generation: number; readonly error: string }>();
	private readonly requests = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
	private readonly deliveryRequests = new Map<number, { readonly slot: WorkerSlot; readonly workerRequest: number }>();
	private readonly inflight = new Set<Promise<unknown>>();
	private readonly slots = new Set<WorkerSlot>();
	private readonly watches = new Map<WatchId, StageWatch>();
	private stageCommandSequence = 0;
	private lastTick = performance.now();
	private stalledMs = 0;
	private readonly ticker: NodeJS.Timeout;
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
	private journal?: RunJournal;
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
	/** Held work whose process groups survived reaping; its child failed and it is never released for replay. */
	private readonly quarantined = new Set<string>();
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
	/** Generation of each work item when this root incarnation enqueued it: attempts count from here (#3979). */
	private readonly attemptBase = new Map<string, number>();

	constructor(private readonly port: CoordinatorPort<CoordinatorEvent, CoordinatorInbound>) {
		port.onMessage((message) => this.receive(message));
		this.ticker = setInterval(() => this.observeResponsiveness(), TICK_INTERVAL_MS).unref();
	}

	/** Closes the journal connection once the pool is closed and every command already received has settled. */
	async shutdown(): Promise<void> {
		await this.closing?.catch(() => {});
		while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
		await this.journal?.close().catch(() => {});
	}

	private receive(message: CoordinatorInbound): void {
		if (message.kind === "request-reply") {
			const pending = this.requests.get(message.id);
			this.requests.delete(message.id);
			if (message.error !== undefined) pending?.reject(new Error(message.error));
			else pending?.resolve(message.value);
			return;
		}
		if ("id" in message) {
			const command = message as CoordinatorCommand;
			const handled = this.execute(command).then(
				(value) => this.port.send({ kind: "reply", id: command.id, value }),
				(error: Error) => this.port.send({ kind: "reply", id: command.id, error: error.message }),
			);
			this.inflight.add(handled);
			void handled.finally(() => this.inflight.delete(handled));
			return;
		}
		this.notice(message as CoordinatorNotice);
	}

	private notice(notice: CoordinatorNotice): void {
		if (notice.kind === "stage-events-applied") this.stageEventsApplied(notice.watch);
		else if (notice.kind === "budget") this.budgetBlocked = notice.blocked;
		else if (notice.kind === "root") this.routes?.updateRoot(notice.rootRun);
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
				return;
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
		this.journal ??= await resolveRunJournal({ journal: { path: options.journalPath } });
		this.usageLedger ??= await openSqlPoolUsage(this.journal);
		this.usageTotal = await this.usageLedger.total(root);
		this.lease = lease;
		const queue = await openSqlPoolQueue(this.journal);
		await queue.initialize(lease, COORDINATOR_LEASE_MS);
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
		await queue.releasePreviousIncarnations(
			lease,
			retained.map((work) => work.id),
		);
		for (;;) {
			const intended = this.desiredControl ?? "running";
			await queue.setControl(lease, intended);
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
	 * Reaps a retained earlier attempt's process groups on this host with the bounded SIGTERM, then SIGKILL, sequence.
	 * Once they are gone the attempt is released for replay. If any survive, only that child fails and the attempt
	 * stays quarantined. Groups on another host cannot be reaped: the attempt stays retained until recovery confirms
	 * them gone.
	 */
	private async reapRetained(work: PoolWork): Promise<void> {
		try {
			const { survivors, unprobeable } = await reapProcessGroups(this.journal!, this.root!, { attempt: work });
			if (survivors.length > 0) {
				this.quarantined.add(work.id);
				this.unreaped.push({ attempt: work });
				this.port.send({ kind: "work-failure", workId: work.id, error: unconfirmedCleanup(survivors).message });
				return;
			}
			if (unprobeable.length === 0) await this.releaseRetained(work);
		} catch (error) {
			this.cleanupFailure ??= error instanceof Error ? error : new Error(String(error));
		} finally {
			if (!this.quarantined.has(work.id)) this.held.delete(work.id);
		}
	}

	/** Releases a retained earlier attempt whose groups are gone, adopting it if this incarnation enqueued it. */
	private releaseRetained(work: PoolWork): Promise<void> {
		return this.retainedTransition(async () => {
			const record = this.retained.get(work.id);
			this.retained.delete(work.id);
			// A stale token means the attempt already changed hands: nothing is left to release.
			await this.queue!.releaseRetained(this.lease!, work, record?.enqueued === true).catch((error: Error) => {
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

	private async control(state: PoolControl["state"]): Promise<void> {
		this.desiredControl = state;
		if (!this.queue || !this.lease) return;
		const control = await this.queue.setControl(this.lease, state);
		const deadline = Date.now() + CONTROL_ACKNOWLEDGEMENT_TIMEOUT_MS;
		while ([...this.readyWorkers].some((worker) => (this.controlAcks.get(worker) ?? -1) < control.revision)) {
			if (this.desiredControl !== state) return;
			if (Date.now() >= deadline) {
				if (state === "quit") break;
				throw new Error("Worker control acknowledgement unresolved");
			}
			await delay(25);
		}
		// Whatever workers published before acknowledging reaches the root before the acknowledgement.
		this.flush();
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
			void this.recoverExpired().catch((error: Error) => this.fail(error));
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
			const enqueued = await queue.enqueue(lease, command.descriptor, command.boundary);
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
		if (target === undefined || !this.incarnations.has(target.slot.worker))
			throw new Error("Worker exited before delivery acknowledgement");
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
		this.port.send({ kind: "failure", error: error.message });
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
		if (this.watches.get(id) !== watch) {
			if (result?.snapshot !== undefined) this.stageCommand(slot, { attempt, op: "unwatch", watch: id });
			return { ok: false, refusal: this.closed ? "PoolClosed" : "AttemptChanging" };
		}
		if (result?.snapshot === undefined) {
			this.watches.delete(id);
			return { ok: false, refusal: result?.refusal ?? (this.closed ? "PoolClosed" : "AttemptChanging") };
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

	private stageCommand(
		slot: WorkerSlot,
		command: DistributiveOmit<WorkerStageCommand, "kind" | "commandId">,
	): Promise<StageCommandResult | undefined> {
		if (!this.incarnations.has(slot.worker)) return Promise.resolve(undefined);
		const commandId = ++this.stageCommandSequence;
		return new Promise((resolve) => {
			slot.stageCommands.set(commandId, resolve);
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
		const watch = this.watches.get(id);
		if (watch === undefined) return;
		this.watches.delete(id);
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
					root,
					definitions: this.sources,
					admission: options.admission,
				}),
			],
			{ stdio: ["ignore", "ignore", "pipe", "ipc"], execArgv: [] },
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
			child.once("exit", () => {
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
				this.slots.delete(slot);
				this.endStageWatches((watch) => watch.slot === slot, "worker_exited");
				for (const settle of slot.stageCommands.values()) settle(undefined);
				slot.stageCommands.clear();
				if (slot.work) this.fence(slot.work);
				for (const delivery of slot.deliveries.values())
					delivery.reject(new Error("Worker exited before delivery acknowledgement"));
				slot.deliveries.clear();
				// The exited worker's work stays leased until its process groups are reaped, so no other worker can
				// claim it and replay alongside them.
				const held = slot.work;
				if (held) this.held.add(held.id);
				const cleanup = disconnected
					.then(() => serial)
					.then(async () => {
						try {
							const admission = this.admission;
							if (!admission || (await admission.releaseStoppedSessions(worker)) === 0) return;
							// The exited worker's tool process groups belong to its fenced attempt. Reaping them is bounded;
							// groups that survive it fail only that worker's child, and never the rest of the pool.
							const alive = await admission.reapStoppedProcesses(worker);
							if (alive.length > 0) this.unreaped.push({ holder: worker });
							// Close still reports any cleanup left unconfirmed, including permits never bound to a group.
							if (this.closed && (alive.length > 0 || (await admission.releaseStoppedSessions(worker)) > 0))
								throw unconfirmedCleanup(alive);
							if (alive.length === 0) return;
							const error = unconfirmedCleanup(alive);
							if (held && (await this.queue!.result(this.root!, held.id)) === undefined) {
								// Its lease stays held for the pool's lifetime: the child never replays alongside those groups.
								this.quarantined.add(held.id);
								slot.work = undefined;
								this.port.send({ kind: "work-failure", workId: held.id, error: error.message });
							}
						} catch (error) {
							this.cleanupFailure = error instanceof Error ? error : new Error(String(error));
							throw this.cleanupFailure;
						} finally {
							if (held && !this.quarantined.has(held.id)) this.held.delete(held.id);
						}
					})
					.then(async () => {
						if (this.closed || !ready || this.desiredControl === "quit") return;
						let work = slot.work;
						if (work && (await this.sendResult(work.id))) {
							work = undefined;
							slot.work = undefined;
							this.replacements = 0;
						}
						if (this.closed) return;
						// An exit whose attempt another one already replaced is not that child's failure: its owner keeps it.
						const superseded =
							work !== undefined &&
							!(await this.queue!.releaseExited(this.lease!, work)) &&
							(await this.superseded(work));
						const exhausted = superseded ? false : work ? this.attempts(work) >= 3 : ++this.replacements > 3;
						if (exhausted) this.fail(diagnosed("Local worker retry limit"));
						else await this.spawn();
					})
					.catch((error: Error) => {
						this.fail(error);
					});
				this.cleanups.add(cleanup);
				void cleanup.finally(() => this.cleanups.delete(cleanup));
			});
			child.on("message", (message: WorkerRequest) => {
				this.observeResponsiveness();
				this.lastHeard.set(worker, { at: performance.now(), stalled: this.stalledMs });
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
				if (message.kind === "delivery-ack") {
					const pending = slot.deliveries.get(message.deliveryId);
					slot.deliveries.delete(message.deliveryId);
					if (message.error) pending?.reject(new Error(message.error));
					else pending?.resolve();
					return;
				}
				// A route's registration wait can outlast a reconnect; it settles outside the worker's serial chain so
				// the worker's control polls, acknowledgements and lease renewals are answered meanwhile.
				let routeReady: Promise<string> | undefined;
				const handled = serial.then(async () => {
					if (message.kind === "ready") {
						if (terminated) return;
						ready = true;
						this.readyWorkers.add(worker);
						clearTimeout(startup);
						resolve();
						return;
					}
					await this.starting;
					const queue = this.queue!;
					const lease = this.lease!;
					if (message.kind === "control") return queue.control(lease);
					if (message.kind === "fenced") {
						const fenced = slot.work;
						slot.work = undefined;
						// Its current owner keeps superseded work. Work still leased to this attempt was refused by the root,
						// not replaced: it is released for replay and counts as a failed attempt, so refusals stay bounded.
						if (fenced && !(await this.superseded(fenced)) && (await queue.releaseExited(lease, fenced)))
							if (this.attempts(fenced) >= 3)
								this.fail(new Error("Local worker retry limit: the root refused every attempt as stale"));
						return;
					}
					if (message.kind === "controlled") {
						const control = await queue.control(lease);
						if (message.revision > control.revision) throw new Error("Unknown control revision");
						this.controlAcks.set(worker, Math.max(this.controlAcks.get(worker) ?? -1, message.revision));
						return;
					}
					if (message.kind === "claim") {
						if (slot.work) throw new Error("Worker already holds an attempt");
						if (this.budgetBlocked) return;
						await this.recoverExpired();
						slot.runs.clear();
						slot.work = await queue.claim(
							lease,
							worker,
							this.sources.map((source) => ({
								definition: `${source.path}#${source.exportName}`,
								digest: source.digest,
							})),
							options.leaseMs,
						);
						return slot.work;
					}
					let work = slot.work;
					if (!work) throw new Error("Worker has no active attempt");
					if (message.kind === "renew" || work.expiresAt - Date.now() < options.leaseMs / 2) {
						work = await queue.extend(lease, work, options.leaseMs);
						slot.work = work;
					}
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
					if (message.kind === "renew") return;
					if (message.kind === "commit") {
						const receipt = await queue.commit(lease, work, message.operation, message.mutation);
						// #3983: a session append bills no usage, so its receipt does not wait on another transaction.
						if (message.mutation.kind !== "session-append") this.noteUsage(await this.usageLedger!.total(root));
						return receipt;
					}
					if (message.kind === "usage") {
						this.noteUsage(await this.usageLedger!.report(lease, work, message.reports));
						return;
					}
					if (message.kind === "budget") {
						await queue.assertCurrent(lease, work);
						if (this.budgetBlocked) throw new Error("Root workflow budget exhausted");
						return queue.control(lease);
					}
					if (message.kind !== "complete") throw new Error("Invalid worker operation");
					await queue.complete(lease, work, message.result as unknown as WorkflowSerializableObject);
					this.endStageWatches((watch) => watch.slot === slot, "stage_finished");
					this.replacements = 0;
					slot.work = undefined;
					await this.sendResult(work.id);
				});
				const response = handled.then((value) => routeReady ?? value);
				if (message.kind !== "delivery" && message.kind !== "delivery-ready")
					serial = handled.then(
						() => {},
						() => {},
					);
				void response.then(
					(value) => child.send({ id: message.id, value }, replied),
					(error: Error) =>
						child.send(
							{
								id: message.id,
								error: error.message,
								...(error.message === STALE_WORK_LEASE ? { fenced: true } : {}),
							},
							replied,
						),
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
		if (this.closed || root === undefined || !this.queue || performance.now() < this.nextRecoveryAt)
			return Promise.resolve();
		const queue = this.queue;
		const lease = this.lease!;
		const leaseMs = this.options!.leaseMs;
		this.recovering = (async () => {
			await new Promise<void>((resolve) => setImmediate(resolve));
			await this.admission?.reconcile();
			const expiredBefore = Date.now();
			for (const work of await queue.inspect(root)) {
				if (work.state !== "leased" || work.expiresAt >= expiredBefore) continue;
				if (this.quarantined.has(work.id)) continue;
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
				if (
					child &&
					!(await this.stop(child).then(
						() => true,
						() => false,
					))
				)
					continue;
				// Stopping the worker began its exit cleanup, which holds its work until its process groups are reaped.
				if (this.held.has(work.id) || this.quarantined.has(work.id)) continue;
				// An attempt whose process groups are not confirmed gone is never released for replay, in any incarnation.
				if ((await unconfirmedProcessGroups(this.journal!, root, { attempt: work })).length > 0) continue;
				if (work.epoch < lease.epoch) await this.releaseRetained(work);
				else await queue.expire(lease, work);
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

	private isLive(worker: string, child: ChildProcess): boolean {
		this.observeResponsiveness();
		const heard = this.lastHeard.get(worker);
		return (
			child.exitCode === null &&
			child.signalCode === null &&
			child.connected &&
			heard !== undefined &&
			performance.now() - heard.at - (this.stalledMs - heard.stalled) < this.options!.leaseMs
		);
	}

	private stop(child: ChildProcess): Promise<void> {
		if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => reject(new Error("Local worker cleanup was not confirmed")), 5_000);
			child.once("exit", () => {
				clearTimeout(timeout);
				resolve();
			});
			child.kill("SIGKILL");
		});
	}

	private async close(): Promise<void> {
		this.closed = true;
		clearInterval(this.ticker);
		clearInterval(this.recoveryTimer);
		let failure: unknown;
		let stopping: { readonly child: ChildProcess; readonly log?: string }[] = [];
		try {
			await this.recovering?.catch(() => {});
			stopping = [...this.children].map((child) => ({ child, log: this.logs.get(child) }));
			await Promise.all(stopping.map(({ child }) => this.stop(child)));
			await Promise.all([...this.cleanups]);
			if (this.cleanupFailure) throw this.cleanupFailure;
			// A reap that finished before close may have left groups running; close reports those still running.
			const alive: number[] = [];
			for (const scope of this.unreaped)
				for (const group of await unconfirmedProcessGroups(this.journal!, this.root!, scope))
					if (!alive.includes(group)) alive.push(group);
			if (alive.length > 0) throw unconfirmedCleanup(alive);
		} catch (error) {
			failure = error;
		}
		if (failure === undefined) {
			const stopped = stopping.flatMap(({ child, log }) =>
				log !== undefined && (child.exitCode !== null || child.signalCode !== null) ? [log] : [],
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
		for (const pending of this.requests.values()) pending.reject(new Error("Local worker pool is closed"));
		this.requests.clear();
		if (failure !== undefined) throw failure;
	}
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
