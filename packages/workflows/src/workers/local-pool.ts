import { type ChildProcess, fork } from "node:child_process";
import { randomUUID } from "node:crypto";
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
import type { StageControlRegistry } from "../runs/foreground/stage-control-registry.js";
import {
	claimExternalRunRoute,
	type ExternalRunRouteOwner,
	pendingStageMessageRouter,
} from "../shared/external-run-routes.js";
import type { StageUiBroker } from "../shared/stage-ui-broker.js";
import type { Store } from "../shared/store.js";
import type { PendingPrompt, RunSnapshot } from "../shared/store-types.js";
import type {
	WorkflowDefinition,
	WorkflowSerializableObject,
	WorkflowSerializableValue,
	WorkflowUIAdapter,
} from "../shared/types.js";
import { asWorkflowInfrastructureError, WorkflowInfrastructureError } from "../shared/workflow-infrastructure-error.js";
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
import { POOLED_CUSTOM_PROMPT_UNAVAILABLE } from "./pooled-prompt-limits.js";
import type { OutboundEntry, PooledStageHandle, PooledStageTransport } from "./pooled-stage-handle.js";
import type { PooledStageRegistrations } from "./pooled-stage-registry.js";
import { type PooledStageLease, registerPooledStageSource } from "./pooled-stage-sources.js";
import { WORKER_HEARTBEAT_INTERVAL_MS } from "./protocol.js";
import type { AdmissionConfiguration } from "./resource-admission.js";
import { PoolStageHandoff, type PoolStageQueue } from "./stage-handoff.js";
import type {
	ControlResult,
	DeliveryOpId,
	DeliveryResult,
	PooledPromptAnswer,
	PooledStageDelivery,
	PooledStageQuestion,
	PooledStageRef,
	PooledStageWatchMessage,
	PromptResult,
	WatchEndReason,
	WatchId,
	WatchResult,
} from "./stage-watch-types.js";

/** A live view of one pooled stage, shared by everything that holds it. */
interface StageView {
	readonly key: string;
	opening: Promise<PooledStageHandle | undefined>;
	holders: number;
	handle?: PooledStageHandle;
	reconnect?: () => Promise<boolean>;
	reconnecting?: Promise<void>;
}

import { defaultStartupTimeoutMs } from "./startup-timeout.js";

const INTERNAL_WORKFLOW_WORKER_ARG = "--internal-workflow-worker";
const DEFAULT_WORK_LEASE_MS = 30_000;
const MINIMUM_WORK_LEASE_MS = 2 * WORKER_HEARTBEAT_INTERVAL_MS;
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
	/** Children the coordinator failed on their own, without failing the pool. */
	private readonly workFailures = new Map<string, WorkflowInfrastructureError>();
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
	/** Open stage watches, by id, to the listener their events go to (#3996). */
	private readonly stageWatches = new Map<WatchId, (message: PooledStageWatchMessage) => void>();
	/** One shared live view per watched stage, with the number of holders. */
	private readonly stageViews = new Map<string, StageView>();
	/** Text sent to each watched stage, by run and stage, kept until it arrives or the stage ends (#3996). */
	private readonly outboxes = new Map<string, OutboundEntry[]>();
	/** Stages whose outbox a view is being opened to deliver. */
	private readonly outboxDeliveries = new Set<string>();
	/** Views whose watch ended with their attempt; each reconnects once a replacement runs the stage. */
	private readonly reconnectingViews = new Set<StageView>();
	private releaseStageSource?: () => void;
	/** An SDK caller's `ui`, which answers the `ctx.ui` prompts of pooled children. */
	private promptUi?: WorkflowUIAdapter;
	/** Prompts of pooled stages the root is routing an answer for, by run, stage and prompt id. */
	private readonly routedPrompts = new Set<string>();
	/** Brokered questions of pooled stages shown in the root, by run and stage. */
	private readonly routedQuestions = new Map<
		string,
		{ readonly promptId: string; readonly controller: AbortController }
	>();
	/** An SDK caller's `stageUiBroker`, which shows the brokered questions of pooled stages. */
	private questionBroker?: StageUiBroker;
	/** Runs this pool's workers published, so answers for another pool's runs pass it by. */
	private readonly ownedRuns = new Set<string>();
	/** Registrations in the caller's registry, loaded and applied in activity order. */
	private registrations?: Promise<PooledStageRegistrations>;
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
			/**
			 * A caller's registry (SDK `RunOpts.stageControlRegistry`) that receives a handle for
			 * every live pooled stage. A handle opens a watch only while it is used.
			 */
			readonly stageControlRegistry?: StageControlRegistry;
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
				startupTimeoutMs: this.options.startupTimeoutMs ?? defaultStartupTimeoutMs(this.options.workers),
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
			if (state === "quit") await this.shutdown();
		}
	}
	validateOptions(options: RunOpts): void {
		if (options[hostWorkerBindings]) return;
		for (const key of [
			"adapters",
			"persistence",
			"mcp",
			"overlay",
			"models",
			"registry",
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
	private async start(root: string, promptNodes: boolean): Promise<void> {
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
			this.releaseStageSource = registerPooledStageSource(store, {
				acquire: (runId, stageId) => this.acquirePooledStage(runId, stageId),
				// Another pool sharing this store may own the run: only this pool's runs are answered here.
				answer: (runId, stageId, answer) =>
					this.ownedRuns.has(runId)
						? this.answerPooledStagePrompt(runId, stageId, answer)
						: Promise.resolve(undefined),
			});
			this.handoff = new PoolStageHandoff(this.backend, store, this.queueView(), this.lease, (runId) => {
				this.routeClaims.set(runId, claimExternalRunRoute(store, runId, routeOwner));
			});
		}
		await this.command({
			kind: "start",
			sources: this.sources,
			cwd,
			publish: store !== undefined,
			...(promptNodes ? { promptNodes } : {}),
			...this.rootRun(),
		});
	}
	/**
	 * Opens a live, attempt-bound view of one running pooled stage (#3996). `listener` receives
	 * the stage's session events after the returned snapshot, in order, and finally the watch's
	 * end; the first of them may arrive before this promise settles. Events flow only while the
	 * watch is open: a stage nobody watches sends none.
	 */
	async watchPooledStage(
		ref: PooledStageRef,
		listener: (message: PooledStageWatchMessage) => void,
	): Promise<WatchResult> {
		if (this.closed || this.coordinatorLost !== undefined) return { ok: false, refusal: "PoolClosed" };
		if (this.coordinator === undefined) return { ok: false, refusal: "StageNotOnWorker" };
		const watch = randomUUID() as WatchId;
		this.stageWatches.set(watch, listener);
		try {
			const result = (await this.command({ kind: "stage-watch", watch, ...ref })) as WatchResult;
			if (!result.ok) this.stageWatches.delete(watch);
			return result;
		} catch {
			this.stageWatches.delete(watch);
			return { ok: false, refusal: "PoolClosed" };
		}
	}
	/** Stops a watch's events. Idempotent; unknown ids succeed. */
	async unwatchPooledStage(watch: WatchId): Promise<void> {
		if (!this.stageWatches.delete(watch) || this.closed || this.coordinatorLost !== undefined) return;
		await this.command({ kind: "stage-unwatch", watch }).catch(() => {});
	}
	/**
	 * The one door for user text into a pooled stage's session (#3996). Admits `delivery.text`
	 * into the watched attempt at most once per `delivery.op`; this is irreversible once
	 * admitted, since the model may act on it. A lost reply is retried once with the same op;
	 * when the outcome is still unknown the result is `Unconfirmed`.
	 */
	async deliverToPooledStage(delivery: PooledStageDelivery): Promise<DeliveryResult> {
		for (let attempt = 0; attempt < 2; attempt++) {
			if (this.closed || this.coordinatorLost !== undefined) break;
			try {
				return (await this.command({ kind: "stage-deliver", ...delivery })) as DeliveryResult;
			} catch (error) {
				if (this.closed || this.coordinatorLost !== undefined) break;
				// The stage refused the text; retrying the same op returns the same refusal.
				if (attempt === 1) throw error;
			}
		}
		return { ok: false, refusal: "Unconfirmed" };
	}
	/**
	 * Answers a human-input prompt a pooled stage raised (#3996), bound to its prompt id:
	 * a workflow `ctx.ui` prompt node or a stage's brokered question such as `ask_user_question`.
	 */
	async answerPooledStagePrompt(runId: string, stageId: string, answer: PooledPromptAnswer): Promise<PromptResult> {
		if (this.closed || this.coordinatorLost !== undefined) return { ok: false, refusal: "StaleAttempt" };
		return (await this.command({ kind: "stage-answer", runId, stageId, answer })) as PromptResult;
	}
	/**
	 * Carries answers to `ctx.ui` prompts of pooled stages back to their workers. The root's store
	 * holds each prompt as published, so every root answer path (stage chat, `workflow answer`)
	 * resolves it there; an SDK caller's `ui` is asked instead when one was given.
	 */
	private routePrompts(publications: readonly { readonly runs: readonly RunSnapshot[] }[]): void {
		const store = this.store;
		for (const { runs } of publications)
			for (const run of runs) {
				this.ownedRuns.add(run.id);
				for (const stage of run.stages) {
					this.routeQuestion(run.id, stage.id, stage.inputRequest?.id);
					const prompt = stage.pendingPrompt;
					if (prompt === undefined) continue;
					const key = JSON.stringify([run.id, stage.id, prompt.id]);
					if (this.routedPrompts.has(key)) continue;
					this.routedPrompts.add(key);
					const fail = (error: Error) =>
						this.answerPooledStagePrompt(run.id, stage.id, {
							kind: "failed",
							promptId: prompt.id,
							error: error.message,
						});
					// A custom prompt renders a component that exists only in the worker: fail it at once.
					const answered =
						prompt.kind === "custom"
							? Promise.reject(new Error(POOLED_CUSTOM_PROMPT_UNAVAILABLE))
							: this.promptUi !== undefined
								? askPromptUi(this.promptUi, prompt)
								: (store?.awaitStagePendingPrompt(run.id, stage.id, prompt.id) ??
									Promise.reject(new Error("No workflow store answers this prompt.")));
					const answer = answered.then(
						(response) =>
							this.answerPooledStagePrompt(run.id, stage.id, {
								kind: "prompt",
								promptId: prompt.id,
								response: response as WorkflowSerializableValue,
							}),
						// A `ui` that rejects fails the prompt in the child; it is never asked again silently.
						(error: Error) => (this.promptUi !== undefined || prompt.kind === "custom" ? fail(error) : undefined),
					);
					// A prompt answered or failed stays routed: asking again would ask the user twice. Only an
					// answer its attempt never received re-arms it, for the replacement that asks again.
					void answer
						.then((result) => {
							if (result?.ok === false && result.refusal === "StaleAttempt") this.routedPrompts.delete(key);
						})
						.catch(() => this.routedPrompts.delete(key));
				}
			}
	}
	/**
	 * Shows a pooled stage's brokered question (`ask_user_question`) in the root's stage UI broker
	 * (#3996), with the exact form an in-process stage shows: the attached stage chat renders it,
	 * and an SDK caller's `stageUiBroker` receives it. The answer goes to the worker that asked.
	 * When the worker's question is answered elsewhere or goes away, the root's request ends.
	 */
	private routeQuestion(runId: string, stageId: string, promptId: string | undefined): void {
		const key = JSON.stringify([runId, stageId]);
		const active = this.routedQuestions.get(key);
		if (active !== undefined && active.promptId === promptId) return;
		if (active !== undefined) {
			this.routedQuestions.delete(key);
			active.controller.abort(new Error("The stage's question was answered or withdrawn."));
		}
		if (promptId === undefined || this.closed) return;
		const controller = new AbortController();
		this.routedQuestions.set(key, { promptId, controller });
		void this.askQuestion(runId, stageId, promptId, controller.signal).catch(() => {});
	}
	private async askQuestion(runId: string, stageId: string, promptId: string, signal: AbortSignal): Promise<void> {
		// Loaded on first use, so pools whose stages never ask never load them.
		const [question, atomic, { currentStageUiBroker }, { buildStagePromptAdapter }] = await Promise.all([
			this.command({ kind: "stage-question", runId, stageId }) as Promise<PooledStageQuestion | undefined>,
			import("@bastani/atomic"),
			import("../shared/stage-ui-broker.js"),
			import("../shared/stage-prompt.js"),
		]);
		if (question?.promptId !== promptId || signal.aborted) return;
		const broker = this.questionBroker ?? currentStageUiBroker();
		const adapter = buildStagePromptAdapter(promptId, question.kind, question.params, Date.now());
		if (adapter !== undefined) broker.provideStagePrompt(runId, stageId, adapter);
		let answered: { readonly value: unknown } | undefined;
		try {
			const execute = atomic.createAskUserQuestionToolDefinition().execute;
			if (execute === undefined) return;
			const context = {
				hasUI: true,
				ui: {
					custom: async (factory: unknown, options?: unknown): Promise<unknown> => {
						const value = await broker.requestCustomUi(
							runId,
							stageId,
							factory as Parameters<StageUiBroker["requestCustomUi"]>[2],
							options as Parameters<StageUiBroker["requestCustomUi"]>[3],
							signal,
						);
						answered = { value };
						return value;
					},
				},
			};
			await execute(
				promptId,
				question.params as Parameters<typeof execute>[1],
				signal,
				undefined,
				context as unknown as Parameters<typeof execute>[4],
			);
		} finally {
			if (signal.aborted) broker.clearStagePrompt(runId, stageId);
		}
		if (answered === undefined || signal.aborted) return;
		// The form's result, as the worker's own form would have returned it.
		await this.answerPooledStagePrompt(runId, stageId, { kind: "input", promptId, answer: { raw: answered.value } });
	}
	/** Holds one watched stage's turn loop without touching pool-wide control (#3996). */
	async pausePooledStage(watch: WatchId): Promise<ControlResult> {
		if (this.closed || this.coordinatorLost !== undefined) return { ok: false, refusal: "StaleAttempt" };
		return (await this.command({ kind: "stage-pause", watch })) as ControlResult;
	}
	/**
	 * Releases a stage paused on its own. `message` is admitted at most once per op, through
	 * the same ledger as {@link deliverToPooledStage}.
	 */
	async resumePooledStage(
		watch: WatchId,
		message?: { readonly op: DeliveryOpId; readonly text: string },
	): Promise<ControlResult> {
		if (this.closed || this.coordinatorLost !== undefined) return { ok: false, refusal: "StaleAttempt" };
		return (await this.command({
			kind: "stage-resume",
			watch,
			...(message === undefined ? {} : { message }),
		})) as ControlResult;
	}
	/** The watch doors of this pool for one live view; ends of a view's watches go to `ended`. */
	private stageTransport(onEnded: (reason: WatchEndReason) => void): PooledStageTransport {
		return {
			watch: (ref, listener) =>
				this.watchPooledStage(ref, (message) => {
					listener(message);
					if (message.kind === "ended") onEnded(message.reason);
				}),
			unwatch: (watch) => this.unwatchPooledStage(watch),
			deliver: (delivery) => this.deliverToPooledStage(delivery),
			pause: (watch) => this.pausePooledStage(watch),
			resume: (watch, message) => this.resumePooledStage(watch, message),
		};
	}
	/**
	 * A shared live view of a running pooled stage, held until released; the last release
	 * closes its watch. Undefined when the stage is not running on one of this pool's workers.
	 * When the stage's attempt is fenced or its worker exits, the view reconnects to the
	 * replacement attempt on later activity.
	 */
	private async acquirePooledStage(runId: string, stageId: string): Promise<PooledStageLease | undefined> {
		const key = JSON.stringify([runId, stageId]);
		let view = this.stageViews.get(key);
		if (view === undefined) {
			const stageName =
				this.store
					?.runs()
					.find((run) => run.id === runId)
					?.stages.find((stage) => stage.id === stageId)?.name ?? stageId;
			const created: StageView = { key, holders: 0, opening: Promise.resolve(undefined) };
			const transport = this.stageTransport((reason) => {
				if (this.stageViews.get(key) !== created) return;
				if (reason === "attempt_fenced" || reason === "worker_exited" || reason === "resync")
					this.reconnectingViews.add(created);
				else this.stageViews.delete(key);
			});
			// The stage's outbox outlives its views, so text survives a chat that closes and reopens.
			let outbox = this.outboxes.get(key);
			if (outbox === undefined) {
				outbox = [];
				this.outboxes.set(key, outbox);
			}
			const outbound = outbox;
			created.opening = (async () => {
				// Loaded on first use, so pools nobody attaches to never load it.
				const module = await import("./pooled-stage-handle.js");
				const opened = await module.openPooledStageHandle(
					transport,
					{ runId, stageId },
					stageName,
					() => {
						if (this.stageViews.get(key) === created) this.stageViews.delete(key);
						this.reconnectingViews.delete(created);
					},
					outbound,
				);
				if (!opened.ok) return undefined;
				created.handle = opened.handle;
				created.reconnect = () => module.reconnectPooledStageHandle(opened.handle, transport);
				// A view nobody holds stays open only until its outbox drains.
				opened.handle.onDrained(() => {
					if (created.holders === 0 && !opened.handle.hasPending) opened.handle.dispose();
				});
				return opened.handle;
			})();
			view = created;
			this.stageViews.set(key, created);
		}
		const current = view;
		current.holders++;
		const handle = await current.opening.catch(() => undefined);
		if (handle === undefined || handle.isDisposed || handle.endReason !== undefined) {
			current.holders--;
			if (this.stageViews.get(key) === current) this.stageViews.delete(key);
			return undefined;
		}
		let released = false;
		return {
			handle,
			onReconnected: (listener) => handle.onRebind(listener),
			release: () => {
				if (released) return;
				released = true;
				if (--current.holders > 0) return;
				// Text still on its way keeps the view (and its watch) open until it arrives.
				if (handle.hasPending) return;
				this.reconnectingViews.delete(current);
				handle.dispose();
			},
		};
	}
	/**
	 * Keeps every stage's outbox moving (#3996): views whose attempt ended reconnect to the
	 * replacement; a stage with text its current attempt has not admitted, and no view, gets a
	 * view that delivers it and closes; a stage or run that ended reports what never arrived.
	 */
	private reconnectStageViews(): void {
		const runs = this.store?.runs() ?? [];
		const stageOf = (key: string) => {
			const [runId, stageId] = JSON.parse(key) as [string, string];
			const run = runs.find((candidate) => candidate.id === runId);
			return { runId, stageId, run, stage: run?.stages.find((candidate) => candidate.id === stageId) };
		};
		const ended = (key: string): boolean => {
			const { run, stage } = stageOf(key);
			return (
				run?.endedAt !== undefined ||
				stage?.status === "completed" ||
				stage?.status === "failed" ||
				stage?.status === "skipped"
			);
		};
		for (const view of this.reconnectingViews) {
			if (view.reconnecting !== undefined || view.reconnect === undefined || view.handle === undefined) continue;
			const handle = view.handle;
			if (ended(view.key)) {
				this.reconnectingViews.delete(view);
				handle.receive({ kind: "ended", reason: "stage_finished" });
				if (this.stageViews.get(view.key) === view) this.stageViews.delete(view.key);
				this.outboxes.delete(view.key);
				continue;
			}
			view.reconnecting = view
				.reconnect()
				.then((bound) => {
					// A watch that ended again after this rebind queued the view anew; keep it queued.
					if (bound && !handle.isReconnecting) this.reconnectingViews.delete(view);
					if (bound && view.holders === 0 && !handle.hasPending) handle.dispose();
				})
				.catch(() => {})
				.finally(() => {
					view.reconnecting = undefined;
				});
		}
		for (const [key, outbox] of this.outboxes) {
			if (this.stageViews.has(key)) continue;
			if (ended(key)) {
				this.outboxes.delete(key);
				continue;
			}
			const { runId, stageId, stage } = stageOf(key);
			const generation = stage?.workerExecution?.generation;
			// Text admitted by an attempt that has since been replaced may have died with it.
			if (generation === undefined || !outbox.some((entry) => entry.admittedBy !== generation)) continue;
			if (this.outboxDeliveries.has(key)) continue;
			this.outboxDeliveries.add(key);
			void this.acquirePooledStage(runId, stageId)
				.then((lease) => lease?.release())
				.catch(() => {})
				.finally(() => this.outboxDeliveries.delete(key));
		}
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
			// Only this child failed; the pool and its other children keep running.
			if (error instanceof WorkflowInfrastructureError && [...this.workFailures.values()].includes(error))
				throw error;
			try {
				if (this.desiredControl !== "quit" || !findWorkflowGracefulQuit(error)) await this.shutdown();
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
		if (this.closed) throw this.closedError(options.parentRun?.rootRunId);
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
		// A pooled child's `ctx.ui` prompts wait for the root to answer them when the root can:
		// through prompt nodes in the host, or through an SDK caller's `ui` (#3996). This is the
		// pool's setting, not part of a child's work, so a resume re-enqueues identical work.
		this.starting ??= this.start(root, options.usePromptNodesForUi === true || options.ui !== undefined);
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
		if (options.ui !== undefined && options.usePromptNodesForUi !== true) this.promptUi ??= options.ui;
		if (options.stageUiBroker !== undefined) this.questionBroker ??= options.stageUiBroker;
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
				if (this.closed) throw this.closedError(root);
				const result = this.results.get(work.id);
				if (result) {
					await this.inbound;
					await this.backend.catchUpWorkflow(root);
					await this.handoff?.complete(work);
					// The child's stages are final now; end views still waiting to reconnect to them.
					if (this.reconnectingViews.size > 0 || this.outboxes.size > 0) this.reconnectStageViews();
					return result as unknown as RunResult;
				}
				const failed = this.workFailures.get(work.id);
				if (failed) throw failed;
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
				void this.registrations?.then((registrations) => registrations.forget(event.workId));
				this.signalChange();
				return;
			case "work-failure":
				this.workFailures.set(
					event.workId,
					new WorkflowInfrastructureError("worker_cleanup_unconfirmed", event.error),
				);
				this.signalChange();
				return;
			case "failure":
				this.failure ??= new Error(event.error);
				this.signalChange();
				return;
			case "stage-events":
				this.stageWatches.get(event.watch)?.({ kind: "events", events: event.events });
				this.notice({ kind: "stage-events-applied", watch: event.watch });
				return;
			case "stage-watch-ended": {
				const listener = this.stageWatches.get(event.watch);
				this.stageWatches.delete(event.watch);
				listener?.({ kind: "ended", reason: event.reason });
				return;
			}
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
			this.routePrompts(publications.filter((_, index) => outcomes[index] === undefined));
			const registry = this.options.stageControlRegistry;
			if (registry !== undefined) {
				const accepted = publications.filter((_, index) => outcomes[index] === undefined);
				this.registrations = (
					this.registrations ??
					import("./pooled-stage-registry.js").then(
						({ PooledStageRegistrations }) =>
							new PooledStageRegistrations(registry, (runId, stageId) =>
								this.acquirePooledStage(runId, stageId),
							),
					)
				).then((registrations) => {
					try {
						if (!this.closed)
							for (const { work, runs } of accepted)
								if (!this.results.has(work.id)) registrations.sync(work, runs);
					} catch {
						// A caller registry that refuses a handle keeps the others; nothing may reject unhandled.
					}
					return registrations;
				});
			}
		}
		this.notice({ kind: "published", batch, rejected });
		this.refreshRootRun();
		if (this.reconnectingViews.size > 0 || this.outboxes.size > 0) this.reconnectStageViews();
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
	/** Why a closed pool refuses a child; a failed or quit pool keeps refusing until its owner closes it. */
	private closedError(root: string | undefined): Error {
		if (this.failure) return this.failure;
		if (this.desiredControl === "quit" && root !== undefined)
			return new WorkflowGracefulQuitError(root, "worker pool teardown");
		return new Error("Local worker pool is closed");
	}
	private closing?: Promise<void>;
	/** The owner's close: stops the pool and detaches it, so later roots on this backend may bind their own. */
	close(): Promise<void> {
		const closing = this.shutdown();
		this.releaseBinding();
		return closing;
	}
	/**
	 * Stops the pool but keeps it bound to its root. A child the root starts afterwards then fails with the pool's
	 * failure, or suspends after a quit, instead of running in the host, whose session store cannot see the pool's
	 * stage sessions (#3979).
	 */
	private shutdown(): Promise<void> {
		this.closing ??= this.dispose();
		return this.closing;
	}
	private async dispose(): Promise<void> {
		this.closed = true;
		for (const { controller } of this.routedQuestions.values())
			controller.abort(new Error("Local worker pool is closed"));
		this.routedQuestions.clear();
		clearInterval(this.ticker);
		this.ticker = undefined;
		this.releaseStageSource?.();
		// A pool that failed takes its unfinished children with it: show them failed rather than
		// running forever (#3996). A graceful quit leaves them resumable.
		const poolFailure = this.failure;
		const store = this.store;
		if (poolFailure !== undefined && store !== undefined)
			store.batch(() => {
				for (const run of store.runs())
					if (
						run.endedAt === undefined &&
						run.rootRunId === this.root &&
						run.id !== this.root &&
						run.stages.some((stage) => stage.workerExecution !== undefined)
					)
						store.recordRunEnd(run.id, "failed", undefined, poolFailure.message);
			});
		void this.registrations?.then((registrations) => registrations.clear());
		const watches = [...this.stageWatches.values()];
		this.stageWatches.clear();
		for (const listener of watches) listener({ kind: "ended", reason: "pool_closed" });
		// Views between attempts have no open watch to end; tell them the pool is gone.
		for (const view of this.stageViews.values()) view.handle?.receive({ kind: "ended", reason: "pool_closed" });
		this.reconnectingViews.clear();
		this.outboxes.clear();
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

/** Asks an SDK caller's `ui` a pooled stage's prompt; custom prompts never reach it. */
function askPromptUi(ui: WorkflowUIAdapter, prompt: PendingPrompt): Promise<WorkflowSerializableValue> {
	switch (prompt.kind) {
		case "input":
			return ui.input(prompt.message);
		case "confirm":
			return ui.confirm(prompt.message);
		case "select":
			return ui.select(prompt.message, prompt.choices ?? []);
		case "editor":
			return ui.editor(prompt.initial);
		default:
			return Promise.reject(new Error(POOLED_CUSTOM_PROMPT_UNAVAILABLE));
	}
}
