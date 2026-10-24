import { type ChildProcess, fork } from "node:child_process";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { isBunBinary } from "@bastani/atomic";
import { sqlPoolStorage } from "../durable/journal/internal.js";
import type { JournalDurableBackend } from "../durable/journal/journal-backend.js";
import {
	openSqlPoolQueue,
	type PoolControl,
	type PoolWork,
	type SqlPoolQueue,
	STALE_WORK_LEASE,
} from "../durable/journal/sql-pool-queue.js";
import type { PoolUsage } from "../durable/journal/sql-pool-usage.js";
import { SqlRunJournal } from "../durable/journal/sql-run-journal.js";
import type { Lease } from "../durable/journal/types.js";
import { findWorkflowGracefulQuit, WorkflowGracefulQuitError } from "../engine/workflow-tool-abort.js";
import type { ResolvedInputs, RunOpts, RunResult } from "../runs/foreground/executor-types.js";
import { acquireStandaloneIntercom } from "../runs/foreground/sdk-intercom.js";
import {
	claimExternalRunRoute,
	type ExternalRunRouteOwner,
	pendingStageMessageRouter,
} from "../shared/external-run-routes.js";
import type { Store } from "../shared/store.js";
import type { WorkflowDefinition, WorkflowSerializableObject } from "../shared/types.js";
import { asWorkflowInfrastructureError } from "../shared/workflow-infrastructure-error.js";
import { workflowResourceAdmission } from "./admission-binding.js";
import {
	type CoordinatorCommandBody,
	type CoordinatorEvent,
	type CoordinatorInbound,
	type CoordinatorNotice,
	type CoordinatorPort,
	type CoordinatorRequestBody,
	POOL_COORDINATOR_ROLE,
	POOL_SUMMARY_INTERVAL_MS,
	type PoolActivityEntry,
	type PoolRootProjection,
	type PoolWorkToken,
} from "./coordinator-protocol.js";
import {
	definitionDigest,
	type WorkerDefinitionBinding,
	type WorkerDefinitionSource,
	workerDefinitionSources,
} from "./definitions.js";
import { bindChildWorkerDispatcher } from "./dispatch.js";
import { hostWorkerBindings } from "./host-options.js";
import { PoolCoordinator, projectRootRun } from "./pool-coordinator.js";
import { WORKER_HEARTBEAT_INTERVAL_MS } from "./protocol.js";
import type { AdmissionConfiguration } from "./resource-admission.js";
import { PoolStageHandoff, type PoolStageQueue } from "./stage-handoff.js";

const INTERNAL_WORKFLOW_WORKER_ARG = "--internal-workflow-worker";
const DEFAULT_WORK_LEASE_MS = 30_000;
const MINIMUM_WORK_LEASE_MS = 2 * WORKER_HEARTBEAT_INTERVAL_MS;
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const COORDINATOR_STDERR_TAIL_CHARACTERS = 8192;
const COORDINATOR_EXIT_GRACE_MS = 5_000;

type MainPort = CoordinatorPort<CoordinatorInbound, CoordinatorEvent>;

interface Coordinator {
	readonly port: MainPort;
	readonly pid?: number;
}

/** The shipped worker module; it also runs the pool coordinator. */
function defaultWorkerEntry(): string {
	return isBunBinary
		? INTERNAL_WORKFLOW_WORKER_ARG
		: fileURLToPath(new URL("./local-worker-entry.mjs", import.meta.url));
}

/** The coordinator child process, forked like a worker with a coordinator start descriptor. */
function launchCoordinatorProcess(): Coordinator {
	const child: ChildProcess = fork(defaultWorkerEntry(), [JSON.stringify({ role: POOL_COORDINATOR_ROLE })], {
		stdio: ["ignore", "ignore", "pipe", "ipc"],
		execArgv: [],
	});
	let stderr = "";
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr = (stderr + chunk.toString()).slice(-COORDINATOR_STDERR_TAIL_CHARACTERS);
	});
	const listeners: ((reason: Error) => void)[] = [];
	let lostReason: Error | undefined;
	const lose = (reason: Error) => {
		if (lostReason !== undefined) return;
		lostReason = reason;
		for (const listener of listeners) listener(reason);
	};
	const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
	child.on("error", lose);
	child.once("exit", (code, signal) =>
		lose(
			new Error(
				`Local worker pool coordinator exited (${signal ?? `code ${code}`})${stderr ? `: ${stderr.trim()}` : ""}`,
			),
		),
	);
	return {
		pid: child.pid,
		port: {
			send(message) {
				if (lostReason !== undefined || !child.connected) return;
				child.send(message, (error) => {
					if (error) lose(error);
				});
			},
			onMessage(listener) {
				child.on("message", (message) => listener(message as CoordinatorEvent));
			},
			onClose(listener) {
				if (lostReason !== undefined) listener(lostReason);
				else listeners.push(listener);
			},
			async close() {
				// The coordinator exits when its channel closes; a stuck one is killed after a grace period.
				if (child.connected) child.disconnect();
				if (child.exitCode !== null || child.signalCode !== null) return;
				const timedOut = await Promise.race([exited.then(() => false), delay(COORDINATOR_EXIT_GRACE_MS, true)]);
				if (timedOut) {
					child.kill("SIGKILL");
					await exited;
				}
			},
		},
	};
}

/**
 * Tests only: the coordinator in this process, behind the same message boundary with every
 * message serialized as IPC would. Production pools always launch the coordinator process.
 */
function launchCoordinatorInProcess(): Coordinator {
	const mainListeners: ((message: CoordinatorEvent) => void)[] = [];
	const coordinatorListeners: ((message: CoordinatorInbound) => void)[] = [];
	const copy = <T>(message: T): T => JSON.parse(JSON.stringify(message)) as T;
	const coordinator = new PoolCoordinator({
		send(message) {
			const copied = copy(message);
			setImmediate(() => {
				for (const listener of mainListeners) listener(copied);
			});
		},
		onMessage(listener) {
			coordinatorListeners.push(listener);
		},
		onClose() {},
		async close() {},
	});
	return {
		pid: process.pid,
		port: {
			send(message) {
				const copied = copy(message);
				setImmediate(() => {
					for (const listener of coordinatorListeners) listener(copied);
				});
			},
			onMessage(listener) {
				mainListeners.push(listener);
			},
			onClose() {},
			async close() {
				void coordinator.shutdown();
			},
		},
	};
}

/**
 * Root-side handle of a local worker pool.
 *
 * Every per-worker concern runs in the pool's coordinator process (`pool-coordinator.ts`):
 * worker processes and their IPC, pool journal writes, lease heartbeats and recovery, and
 * the Intercom routes of pooled runs. This side, on the root's main thread, enqueues
 * children, waits for their results, forwards control and budget decisions, and applies the
 * coordinator's activity summaries to the root's store in one batched update each, at most
 * every {@link POOL_SUMMARY_INTERVAL_MS}.
 */
export class LocalWorkerPool {
	private readonly pids = new Set<number>();
	private coordinator?: Coordinator;
	private coordinatorLost?: Error;
	private readonly commands = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
	private commandSequence = 0;
	private inbound: Promise<void> = Promise.resolve();
	private readonly works = new Map<string, PoolWork>();
	private readonly attempts = new Map<string, PoolWorkToken & { fenced: boolean }>();
	private readonly results = new Map<string, WorkflowSerializableObject>();
	private changed = Promise.withResolvers<void>();
	private waiting = 0;
	private ticker?: NodeJS.Timeout;
	private readonly leaseMs: number;
	private desiredControl?: PoolControl["state"];
	private root?: string;
	private store?: Store;
	private handoff?: PoolStageHandoff;
	private releaseRoutes?: () => Promise<void>;
	/** Releases of this pool's route claims on the root's store, per pooled run. */
	private readonly routeClaims = new Map<string, () => void>();
	private sources: WorkerDefinitionSource[] = [];
	private queue?: SqlPoolQueue;
	private lease?: Lease;
	private usageTotal?: PoolUsage;
	private rootBudget?: RunOpts["rootBudget"];
	private budgetBlocked = false;
	private rootSignature?: string;
	private starting?: Promise<void>;
	private failure?: Error;
	private closed = false;
	private readonly releaseBinding: () => void;
	constructor(
		private readonly backend: JournalDurableBackend,
		private readonly options: {
			readonly journalPath: string;
			readonly rootId?: string;
			readonly workers: number;
			readonly definitions: readonly WorkerDefinitionBinding[];
			readonly admission?: AdmissionConfiguration;
			readonly startupTimeoutMs?: number;
			readonly leaseMs?: number;
			/**
			 * Internal: module path forked for each worker instead of the shipped worker entry.
			 * Load tests use it to run protocol-level stub workers; public options never set it.
			 */
			readonly workerEntry?: string;
			/**
			 * Internal, tests only: run the coordinator in this process, behind the same serialized
			 * message boundary, so a test can intercept coordinator-side calls. Public options never set it.
			 */
			readonly coordinator?: "in-process";
		},
	) {
		if (!Number.isSafeInteger(options.workers) || options.workers < 1) throw new Error("Invalid local worker count");
		if (
			options.startupTimeoutMs !== undefined &&
			(!Number.isSafeInteger(options.startupTimeoutMs) ||
				options.startupTimeoutMs < 1 ||
				options.startupTimeoutMs > MAX_TIMER_DELAY_MS)
		)
			throw new Error("Invalid local worker startup timeout");
		if (
			options.leaseMs !== undefined &&
			(!Number.isSafeInteger(options.leaseMs) ||
				options.leaseMs < MINIMUM_WORK_LEASE_MS ||
				options.leaseMs > MAX_TIMER_DELAY_MS)
		)
			throw new Error(
				`Invalid local worker lease: must be an integer from ${MINIMUM_WORK_LEASE_MS} to ${MAX_TIMER_DELAY_MS} ms`,
			);
		this.leaseMs = options.leaseMs ?? DEFAULT_WORK_LEASE_MS;
		this.releaseBinding = bindChildWorkerDispatcher(backend, this, options.rootId);
		if (options.admission && options.rootId === undefined) workflowResourceAdmission.set(backend, options.admission);
	}
	get workerPids(): number[] {
		return [...this.pids];
	}
	/** Process id of the pool's coordinator once it runs; the workers are its children. */
	get coordinatorPid(): number | undefined {
		return this.coordinator?.pid;
	}
	usage(): PoolUsage | undefined {
		return this.usageTotal;
	}
	async prepare(root: string, store?: Store): Promise<void> {
		if (this.closed) throw new Error("Local worker pool is closed");
		if (
			!(this.backend.journal instanceof SqlRunJournal) ||
			resolve(this.options.journalPath) !== resolve(this.backend.journal.path) ||
			sqlPoolStorage(this.backend.journal)?.tables.runs !== "wf_runs"
		)
			throw new Error("Local workers require the same default-prefix SQLite journal");
		if (this.root !== undefined && this.root !== root) throw new Error("Local worker pool belongs to another root");
		this.root = root;
		if (store) this.store = store;
		const state = await this.backend.journal.leaseState(root);
		if (!state || state.holderId !== this.backend.holderId)
			throw new Error("Local worker pool requires the root owner");
		this.lease = { runId: root, holderId: state.holderId, epoch: state.epoch };
		const workerEntry =
			this.options.workerEntry ??
			(isBunBinary || this.options.coordinator === "in-process" ? defaultWorkerEntry() : undefined);
		this.usageTotal = (await this.command({
			kind: "prepare",
			root,
			lease: this.lease,
			options: {
				journalPath: this.options.journalPath,
				workers: this.options.workers,
				leaseMs: this.leaseMs,
				startupTimeoutMs: this.options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
				...(this.options.admission === undefined ? {} : { admission: this.options.admission }),
				...(workerEntry === undefined ? {} : { workerEntry }),
			},
			...(this.desiredControl === undefined ? {} : { control: this.desiredControl }),
		})) as PoolUsage;
		// Read only: a delivery receipt checks its work lease inside the root's own journal append.
		this.queue ??= await openSqlPoolQueue(this.backend.journal);
	}
	async control(state: PoolControl["state"]): Promise<void> {
		this.desiredControl = state;
		try {
			if (this.coordinator !== undefined) await this.command({ kind: "control", state });
		} finally {
			if (state === "quit") await this.close();
		}
	}
	validateOptions(options: RunOpts): void {
		if (options[hostWorkerBindings]) return;
		for (const key of [
			"adapters",
			"ui",
			"persistence",
			"mcp",
			"overlay",
			"models",
			"registry",
			"stageControlRegistry",
			"stageUiBroker",
			"toolAdmissionBoundary",
			"onStageStart",
			"onStageEnd",
			"onStageSession",
			"onStageSessionEvent",
			"confirmStageReadiness",
			"rootBudget",
		] as const)
			if (options[key] !== undefined) throw new Error(`Local workers refuse process-bound override: ${key}`);
	}
	private async start(root: string): Promise<void> {
		if (this.closed) throw new Error("Local worker pool is closed");
		if (!this.queue || !this.lease || this.lease.runId !== root)
			throw new Error("Local worker pool requires root preparation");
		this.sources = await Promise.all(
			this.options.definitions.map(async (binding) => {
				const source = {
					path: binding.path,
					exportName: binding.exportName,
					digest: await definitionDigest(binding.path),
				};
				const loaded = workerDefinitionSources.get(binding.definition);
				if (
					!loaded ||
					loaded.path !== source.path ||
					loaded.exportName !== source.exportName ||
					loaded.digest !== source.digest
				)
					throw new Error(`Worker definition is not importable: ${binding.exportName}`);
				return source;
			}),
		);
		const cwd = String(this.backend.getWorkflow(root)?.invocationCwd ?? process.cwd());
		const store = this.store;
		if (store) {
			// The root's own route stays here; pooled runs are announced by the coordinator.
			this.releaseRoutes = await acquireStandaloneIntercom(store, root, cwd);
			if (this.closed) {
				await this.releaseRoutes();
				this.releaseRoutes = undefined;
				throw new Error("Local worker pool is closed");
			}
			const routeOwner: ExternalRunRouteOwner = {
				notifyUndeliverable: async (payload) =>
					!this.closed && (await this.command({ kind: "undeliverable", payload })) === true,
			};
			this.handoff = new PoolStageHandoff(this.backend, store, this.queueView(), this.lease, (runId) => {
				this.routeClaims.set(runId, claimExternalRunRoute(store, runId, routeOwner));
			});
		}
		await this.command({
			kind: "start",
			sources: this.sources,
			cwd,
			publish: store !== undefined,
			...this.rootRun(),
		});
	}
	/** Lease checks for the handoff, answered from the coordinator's in-order attempt and fence events. */
	private queueView(): PoolStageQueue {
		return {
			assertCurrent: async (_lease, work) => {
				const current = this.attempts.get(work.id);
				if (
					current === undefined ||
					current.fenced ||
					current.generation !== work.generation ||
					current.worker !== work.worker ||
					current.epoch !== work.epoch
				)
					throw new Error(STALE_WORK_LEASE);
			},
			withCurrentAppend: (lease, work, assertSession, action) =>
				this.queue!.withCurrentAppend(lease, work, assertSession, action),
			result: async (root, id) => this.results.get(id) ?? this.queue!.result(root, id),
		};
	}
	private rootProjection(): PoolRootProjection | undefined {
		const run = this.store?.runs().find((candidate) => candidate.id === this.root);
		return run === undefined ? undefined : projectRootRun(run);
	}
	private rootRun(): { readonly rootRun?: PoolRootProjection } {
		const rootRun = this.rootProjection();
		if (rootRun === undefined) return {};
		this.rootSignature = JSON.stringify(rootRun);
		return { rootRun };
	}
	/** Keeps the coordinator's view of the root's boundaries current, at the summary rate. */
	private refreshRootRun(): void {
		const rootRun = this.rootProjection();
		if (rootRun === undefined) return;
		const signature = JSON.stringify(rootRun);
		if (signature === this.rootSignature) return;
		this.rootSignature = signature;
		this.notice({ kind: "root", rootRun });
	}
	async run(definition: WorkflowDefinition, inputs: ResolvedInputs, options: RunOpts): Promise<RunResult> {
		try {
			return await this.dispatch(definition, inputs, options);
		} catch (error) {
			try {
				if (this.desiredControl !== "quit" || !findWorkflowGracefulQuit(error)) await this.close();
			} catch (closeError) {
				throw asWorkflowInfrastructureError(closeError) ?? closeError;
			}
			throw asWorkflowInfrastructureError(error) ?? error;
		}
	}
	private async dispatch(
		definition: WorkflowDefinition,
		inputs: ResolvedInputs,
		options: RunOpts,
	): Promise<RunResult> {
		if (options.budget !== undefined) throw new Error("Local workers refuse process-bound override: budget");
		const source = workerDefinitionSources.get(definition);
		const index = this.options.definitions.findIndex(
			(binding) =>
				binding.definition === definition ||
				(source !== undefined &&
					source.path === binding.path &&
					source.exportName === binding.exportName &&
					source.digest === workerDefinitionSources.get(binding.definition)?.digest),
		);
		if (index < 0) throw new Error(`Worker definition is not importable: ${definition.name}`);
		if (!options.parentRun || !options.durableScope)
			throw new Error("Local workers require a durable child boundary");
		this.rootBudget = options.rootBudget;
		const root = options.parentRun.rootRunId;
		this.starting ??= this.start(root);
		await this.starting;
		if (this.lease!.runId !== root) throw new Error("Local worker pool belongs to another root");
		const selectedSource = this.sources[index]!;
		if ((await definitionDigest(selectedSource.path)) !== selectedSource.digest)
			throw new Error("Worker definition compatibility error");
		await this.backend.catchUpWorkflow(root);
		const boundary = this.backend
			.listCheckpoints(root)
			.find(
				(entry) =>
					entry.kind === "stage" &&
					entry.topology?.boundary?.event === "start" &&
					entry.topology.stageId === options.parentRun!.stageId,
			);
		if (boundary?.kind !== "stage") throw new Error("Missing durable child boundary");
		const execution = JSON.parse(
			JSON.stringify({
				cwd: options.cwd,
				depth: options.depth,
				parentRun: options.parentRun,
				config: options.config,
				executionMode: options.executionMode,
			}),
		) as WorkflowSerializableObject;
		this.evaluateBudget();
		const enqueued = (await this.command({
			kind: "enqueue",
			descriptor: {
				boundaryId: options.parentRun.stageId,
				childRunId: options.runId!,
				scope: options.durableScope.scopePrefix,
				definition: `${selectedSource.path}#${selectedSource.exportName}`,
				digest: selectedSource.digest,
				inputs,
				execution,
			},
			boundary,
			...this.rootRun(),
		})) as { readonly work: PoolWork; readonly result?: WorkflowSerializableObject };
		const work = enqueued.work;
		this.works.set(work.id, work);
		if (enqueued.result !== undefined && !this.results.has(work.id)) this.results.set(work.id, enqueued.result);
		this.waiting++;
		this.ticker ??= setInterval(() => {
			this.evaluateBudget();
			this.signalChange();
		}, POOL_SUMMARY_INTERVAL_MS).unref();
		try {
			for (;;) {
				options.signal?.throwIfAborted();
				if (this.closed) {
					if (this.failure) throw this.failure;
					if (this.desiredControl === "quit") throw new WorkflowGracefulQuitError(root, "worker pool teardown");
					throw new Error("Local worker pool is closed");
				}
				const result = this.results.get(work.id);
				if (result) {
					await this.inbound;
					await this.backend.catchUpWorkflow(root);
					await this.handoff?.complete(work);
					return result as unknown as RunResult;
				}
				if (this.failure) throw this.failure;
				if (this.budgetBlocked) await this.rootBudget!.stopAtBoundaryAsync(definition.name);
				await this.nextChange(options.signal);
			}
		} finally {
			if (--this.waiting === 0) {
				clearInterval(this.ticker);
				this.ticker = undefined;
			}
		}
	}
	/** One budget decision for every waiting child; the coordinator refuses claims while it blocks. */
	private evaluateBudget(): void {
		const decision = this.rootBudget?.checkpoint();
		const blocked = decision?.kind === "exhausted" || decision?.kind === "wrap_up";
		if (blocked === this.budgetBlocked) return;
		this.budgetBlocked = blocked;
		this.notice({ kind: "budget", blocked });
	}
	private signalChange(): void {
		const changed = this.changed;
		this.changed = Promise.withResolvers<void>();
		changed.resolve();
	}
	private nextChange(signal: AbortSignal | undefined): Promise<void> {
		const changed = this.changed.promise;
		if (signal === undefined) return changed;
		return new Promise<void>((resolve, reject) => {
			const abort = () => reject(signal.reason);
			signal.addEventListener("abort", abort, { once: true });
			void changed.then(() => {
				signal.removeEventListener("abort", abort);
				resolve();
			});
		});
	}
	private connect(): Coordinator {
		if (this.coordinator !== undefined) return this.coordinator;
		const coordinator =
			this.options.coordinator === "in-process" ? launchCoordinatorInProcess() : launchCoordinatorProcess();
		this.coordinator = coordinator;
		coordinator.port.onMessage((event) => {
			// Every event, replies included, is applied in the order the coordinator sent it.
			this.inbound = this.inbound.then(() => this.receive(event)).catch(() => {});
		});
		coordinator.port.onClose((reason) => {
			this.coordinatorLost = reason;
			this.inbound = this.inbound.then(() => this.lost(reason));
		});
		return coordinator;
	}
	private lost(reason: Error): void {
		this.pids.clear();
		if (!this.closed) this.failure ??= reason;
		for (const pending of this.commands.values()) pending.reject(reason);
		this.commands.clear();
		this.signalChange();
	}
	private command(body: CoordinatorCommandBody): Promise<unknown> {
		const coordinator = this.connect();
		if (this.coordinatorLost !== undefined) return Promise.reject(this.coordinatorLost);
		const id = ++this.commandSequence;
		return new Promise((resolve, reject) => {
			this.commands.set(id, { resolve, reject });
			coordinator.port.send({ ...body, id });
		});
	}
	private notice(notice: CoordinatorNotice): void {
		this.coordinator?.port.send(notice);
	}
	private async receive(event: CoordinatorEvent): Promise<void> {
		switch (event.kind) {
			case "reply": {
				const pending = this.commands.get(event.id);
				this.commands.delete(event.id);
				if (event.error !== undefined) pending?.reject(new Error(event.error));
				else pending?.resolve(event.value);
				return;
			}
			case "activity":
				return this.applyActivity(event.batch, event.entries, event.usage);
			case "spawned":
				this.pids.add(event.pid);
				return;
			case "exited":
				this.pids.delete(event.pid);
				return;
			case "fence": {
				const current = this.attempts.get(event.work.id);
				if (current?.generation === event.work.generation) current.fenced = true;
				this.handoff?.fence(event.work);
				return;
			}
			case "result":
				if (event.usage !== undefined) this.usageTotal = event.usage;
				this.results.set(event.workId, event.result);
				this.signalChange();
				return;
			case "failure":
				this.failure ??= new Error(event.error);
				this.signalChange();
				return;
			case "request":
				// Started in order and answered whenever they finish: a delivery waits on its worker.
				void this.serve(event.id, event.request);
				return;
		}
	}
	private async applyActivity(
		batch: number,
		entries: readonly PoolActivityEntry[],
		usage: PoolUsage | undefined,
	): Promise<void> {
		if (usage !== undefined) this.usageTotal = usage;
		const rejected: { workId: string; generation: number; error: string }[] = [];
		const handoff = this.handoff;
		if (handoff !== undefined) {
			const publications = entries.flatMap((entry) => {
				const work = this.track(entry.work);
				if (work !== undefined) return [{ work, runs: entry.runs }];
				rejected.push({ workId: entry.work.id, generation: entry.work.generation, error: STALE_WORK_LEASE });
				return [];
			});
			const outcomes = await handoff.publishBatch(publications);
			outcomes.forEach((error, index) => {
				const { work } = publications[index]!;
				if (error !== undefined)
					rejected.push({ workId: work.id, generation: work.generation, error: error.message });
			});
		}
		this.notice({ kind: "published", batch, rejected });
		this.refreshRootRun();
	}
	/** The full work of an attempt token, recording the attempt as current when it is newer. */
	private track(attempt: PoolWorkToken): PoolWork | undefined {
		const work = this.works.get(attempt.id);
		if (work === undefined) return undefined;
		const current = this.attempts.get(attempt.id);
		if (current === undefined || attempt.generation > current.generation)
			this.attempts.set(attempt.id, { ...attempt, fenced: false });
		return { ...work, ...attempt, state: "leased" };
	}
	private async serve(id: number, request: CoordinatorRequestBody): Promise<void> {
		try {
			const value = await this.answer(id, request);
			this.coordinator?.port.send({ kind: "request-reply", id, ...(value === undefined ? {} : { value }) });
		} catch (error) {
			this.coordinator?.port.send({
				kind: "request-reply",
				id,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	private async answer(id: number, request: CoordinatorRequestBody): Promise<unknown> {
		if (request.kind === "pending-stage-message" || request.kind === "sticky-live-delivered") {
			const router = this.store === undefined ? undefined : pendingStageMessageRouter(this.store);
			const event: Record<string, unknown> & { handled: boolean; completion?: Promise<unknown> } = {
				...request.payload,
				handled: false,
			};
			if (request.kind === "pending-stage-message") router?.route(event);
			else router?.sticky(event);
			if (event.handled && event.completion !== undefined) return await event.completion;
			return request.kind === "pending-stage-message"
				? { outcome: "refused", reason: "Session not found" }
				: undefined;
		}
		const handoff = this.handoff;
		const work = this.track(request.work);
		if (handoff === undefined || work === undefined) throw new Error(STALE_WORK_LEASE);
		if (request.kind === "ready")
			return handoff.ready(work, request.runId, request.stageId, request.stageName, request.sessionId);
		return handoff.deliver(
			work,
			request.runId,
			request.stageId,
			request.stageName,
			request.recipient,
			async (from, message) => {
				await this.command({ kind: "transport", request: id, from, message });
			},
		);
	}
	private closing?: Promise<void>;
	close(): Promise<void> {
		this.closing ??= this.dispose();
		return this.closing;
	}
	private async dispose(): Promise<void> {
		this.closed = true;
		clearInterval(this.ticker);
		this.ticker = undefined;
		this.releaseBinding();
		if (this.options.rootId === undefined) workflowResourceAdmission.delete(this.backend);
		this.signalChange();
		let failure: unknown;
		const coordinator = this.coordinator;
		if (coordinator !== undefined) {
			// A coordinator that is already gone has nothing left to close; its loss is the pool's failure.
			if (this.coordinatorLost === undefined) {
				try {
					await this.command({ kind: "close" });
				} catch (error) {
					failure = error;
				}
			}
			await this.inbound;
			await coordinator.port.close();
			this.pids.clear();
		}
		// The root's store outlives this pool; a claim left behind would keep the closed pool reachable.
		for (const release of this.routeClaims.values()) release();
		this.routeClaims.clear();
		try {
			await this.releaseRoutes?.();
		} catch (error) {
			failure ??= error;
		}
		if (failure !== undefined) throw failure;
	}
}
