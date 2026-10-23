import { type ChildProcess, fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { sqlPoolStorage } from "../durable/journal/internal.js";
import type { JournalDurableBackend } from "../durable/journal/journal-backend.js";
import {
	openSqlPoolQueue,
	type PoolControl,
	type PoolWork,
	type SqlPoolQueue,
} from "../durable/journal/sql-pool-queue.js";
import { openSqlPoolUsage, type PoolUsage, type SqlPoolUsage } from "../durable/journal/sql-pool-usage.js";
import { SqlRunJournal } from "../durable/journal/sql-run-journal.js";
import type { Lease } from "../durable/journal/types.js";
import { findWorkflowGracefulQuit, WorkflowGracefulQuitError } from "../engine/workflow-tool-abort.js";
import type { ResolvedInputs, RunOpts, RunResult } from "../runs/foreground/executor-types.js";
import { acquireStandaloneIntercom } from "../runs/foreground/sdk-intercom.js";
import { STAGE_SESSION_HEARTBEAT_INTERVAL_MS } from "../runs/foreground/stage-session-heartbeat.js";
import type { Store } from "../shared/store.js";
import type { WorkflowDefinition, WorkflowSerializableObject } from "../shared/types.js";
import { workflowResourceAdmission } from "./admission-binding.js";
import {
	definitionDigest,
	type WorkerDefinitionBinding,
	type WorkerDefinitionSource,
	workerDefinitionSources,
} from "./definitions.js";
import { childWorkerDispatchers } from "./dispatch.js";
import type { WorkerRequest } from "./protocol.js";
import { type AdmissionConfiguration, SqlResourceAdmission } from "./resource-admission.js";
import { PoolStageHandoff } from "./stage-handoff.js";

const WORK_LEASE_MS = 5_000;
const RECOVERY_INTERVAL_MS = 500;
const COORDINATOR_LEASE_MS = 3 * STAGE_SESSION_HEARTBEAT_INTERVAL_MS;

export class LocalWorkerPool {
	private readonly children = new Set<ChildProcess>();
	private readonly incarnations = new Map<string, ChildProcess>();
	private readonly cleanups = new Set<Promise<void>>();
	private recovering?: Promise<void>;
	private nextRecoveryAt = 0;
	private readonly controlAcks = new Map<string, number>();
	private desiredControl?: PoolControl["state"];
	private store?: Store;
	private handoff?: PoolStageHandoff;
	private releaseRoutes?: () => Promise<void>;
	private sources: WorkerDefinitionSource[] = [];
	private queue?: SqlPoolQueue;
	private lease?: Lease;
	private admission?: SqlResourceAdmission;
	private usageLedger?: SqlPoolUsage;
	private usageTotal?: PoolUsage;
	private rootBudget?: RunOpts["rootBudget"];
	private starting?: Promise<void>;
	private cleanupFailure?: Error;
	private failure?: Error;
	private closed = false;
	private replacements = 0;
	constructor(
		private readonly backend: JournalDurableBackend,
		private readonly options: {
			readonly journalPath: string;
			readonly workers: number;
			readonly definitions: readonly WorkerDefinitionBinding[];
			readonly admission?: AdmissionConfiguration;
		},
	) {
		if (!Number.isSafeInteger(options.workers) || options.workers < 1) throw new Error("Invalid local worker count");
		if (childWorkerDispatchers.has(backend)) throw new Error("Local worker pool already attached");
		childWorkerDispatchers.set(backend, this);
		if (options.admission) workflowResourceAdmission.set(backend, options.admission);
	}
	get workerPids(): number[] {
		return [...this.children].flatMap((child) => (child.pid === undefined ? [] : [child.pid]));
	}
	usage(): PoolUsage | undefined {
		return this.usageTotal;
	}
	async prepare(root: string, store?: Store): Promise<void> {
		if (store) this.store = store;
		this.usageLedger ??= await openSqlPoolUsage(this.backend.journal);
		this.usageTotal = await this.usageLedger.total(root);
	}
	async control(state: PoolControl["state"]): Promise<void> {
		this.desiredControl = state;
		try {
			if (!this.queue || !this.lease) return;
			const control = await this.queue.setControl(this.lease, state);
			const deadline = Date.now() + WORK_LEASE_MS;
			while (
				[...this.incarnations.keys()].some((worker) => (this.controlAcks.get(worker) ?? -1) < control.revision)
			) {
				if (this.desiredControl !== state) return;
				if (Date.now() >= deadline) {
					if (state === "quit") break;
					throw new Error("Worker control acknowledgement unresolved");
				}
				await delay(25);
			}
		} finally {
			if (state === "quit") await this.close();
		}
	}
	validateOptions(options: RunOpts): void {
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
		if (
			!(this.backend.journal instanceof SqlRunJournal) ||
			resolve(this.options.journalPath) !== resolve(this.backend.journal.path) ||
			sqlPoolStorage(this.backend.journal)?.tables.runs !== "wf_runs"
		)
			throw new Error("Local workers require the same default-prefix SQLite journal");
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
		const state = await this.backend.journal.leaseState(root);
		if (!state || state.holderId !== this.backend.holderId)
			throw new Error("Local worker pool requires the root owner");
		this.lease = { runId: root, holderId: state.holderId, epoch: state.epoch };
		const queue = await openSqlPoolQueue(this.backend.journal);
		await queue.initialize(this.lease, COORDINATOR_LEASE_MS);
		for (;;) {
			const intended = this.desiredControl ?? "running";
			await queue.setControl(this.lease, intended);
			if (intended === (this.desiredControl ?? "running")) break;
		}
		this.queue = queue;
		await this.prepare(root);
		if (this.store) {
			this.releaseRoutes = await acquireStandaloneIntercom(
				this.store,
				root,
				String(this.backend.getWorkflow(root)?.invocationCwd ?? process.cwd()),
			);
			if (this.closed) {
				await this.releaseRoutes();
				this.releaseRoutes = undefined;
				throw new Error("Local worker pool is closed");
			}
			this.handoff = new PoolStageHandoff(this.backend, this.store, this.queue, this.lease);
		}
		if (this.options.admission)
			this.admission = await SqlResourceAdmission.open(this.backend.journal, {
				...this.options.admission,
				root,
				holder: "coordinator",
			});
		await Promise.all(Array.from({ length: this.options.workers }, () => this.spawn(root)));
	}
	private spawn(root: string): Promise<void> {
		if (this.closed) return Promise.reject(new Error("Local worker pool is closed"));
		const child = fork(
			fileURLToPath(new URL("./local-worker-entry.mjs", import.meta.url)),
			[
				JSON.stringify({
					journalPath: this.options.journalPath,
					root,
					definitions: this.sources,
					admission: this.options.admission,
				}),
			],
			{ stdio: ["ignore", "ignore", "pipe", "ipc"], execArgv: [] },
		);
		const disconnected = new Promise<void>((resolve) => child.once("disconnect", () => resolve()));
		this.children.add(child);
		const worker = randomUUID();
		this.incarnations.set(worker, child);
		let ready = false;
		let serial: Promise<void> = Promise.resolve();
		let work: PoolWork | undefined;
		const deliveries = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
		let stderr = "";
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr = (stderr + chunk.toString()).slice(-8192);
		});
		return new Promise((resolve, reject) => {
			const startup = setTimeout(() => {
				this.failure = new Error("Local worker startup timed out");
				reject(this.failure);
				child.kill("SIGKILL");
			}, 30_000);
			child.once("error", (error) => {
				clearTimeout(startup);
				reject(error);
			});
			child.once("exit", () => {
				this.children.delete(child);
				clearTimeout(startup);
				this.incarnations.delete(worker);
				reject(new Error(`Local worker exited before readiness: ${stderr}`));
				this.controlAcks.delete(worker);
				if (work) this.handoff?.fence(work);
				for (const delivery of deliveries.values())
					delivery.reject(new Error("Worker exited before delivery acknowledgement"));
				deliveries.clear();
				const cleanup = disconnected
					.then(() => serial)
					.then(async () => {
						try {
							if (await this.admission?.releaseStoppedSessions(worker))
								throw new Error("Local worker process cleanup unconfirmed; permits quarantined");
						} catch (error) {
							this.cleanupFailure = error instanceof Error ? error : new Error(String(error));
							throw this.cleanupFailure;
						}
					})
					.then(async () => {
						if (this.closed || !ready || this.desiredControl === "quit") return;
						if (work && (await this.queue!.result(root, work.id))) {
							work = undefined;
							this.replacements = 0;
						}
						if (this.closed) return;
						const exhausted = work ? work.generation >= 3 : ++this.replacements > 3;
						if (exhausted) this.failure = new Error(`Local worker retry limit: ${stderr}`);
						else await this.spawn(root);
					})
					.catch((error: Error) => {
						this.failure = error;
					});
				this.cleanups.add(cleanup);
				void cleanup.finally(() => this.cleanups.delete(cleanup));
			});
			child.on("message", (message: WorkerRequest) => {
				if (message.kind === "delivery-ack") {
					const pending = deliveries.get(message.deliveryId);
					deliveries.delete(message.deliveryId);
					if (message.error) pending?.reject(new Error(message.error));
					else pending?.resolve();
					return;
				}
				const response = serial.then(async () => {
					if (message.kind === "ready") {
						ready = true;
						clearTimeout(startup);
						resolve();
						return;
					}
					await this.starting;
					const queue = this.queue!;
					const lease = this.lease!;
					if (message.kind === "control") return queue.control(lease);
					if (message.kind === "controlled") {
						const control = await queue.control(lease);
						if (message.revision > control.revision) throw new Error("Unknown control revision");
						this.controlAcks.set(worker, Math.max(this.controlAcks.get(worker) ?? -1, message.revision));
						return;
					}
					if (message.kind === "claim") {
						if (work) throw new Error("Worker already holds an attempt");
						const decision = this.rootBudget?.checkpoint();
						if (decision?.kind === "exhausted" || decision?.kind === "wrap_up") return;
						await this.recoverExpired(root);
						work = await queue.claim(
							lease,
							worker,
							this.sources.map((source) => ({
								definition: `${source.path}#${source.exportName}`,
								digest: source.digest,
							})),
							WORK_LEASE_MS,
						);
						return work;
					}
					if (!work) throw new Error("Worker has no active attempt");
					if (message.kind === "activity") return this.handoff?.publish(work, message.runs);
					if (message.kind === "route") return this.handoff?.route(work, message.runId);
					if (message.kind === "delivery-ready")
						return this.handoff?.ready(
							work,
							message.runId,
							message.stageId,
							message.stageName,
							message.sessionId,
						);
					if (message.kind === "delivery") {
						if (!message.recipient) throw new Error("Worker delivery requires a session identity");
						return this.handoff?.deliver(
							work,
							message.runId,
							message.stageId,
							message.stageName,
							message.recipient,
							(from, payload) =>
								new Promise<void>((resolve, reject) => {
									const id = randomUUID();
									deliveries.set(id, { resolve, reject });
									child.send({ id: message.id, delivery: { id, from, message: payload } }, (error) => {
										if (error) {
											deliveries.delete(id);
											reject(error);
										}
									});
								}),
						);
					}
					if (message.kind === "renew") {
						work = await queue.renew(lease, work, randomUUID(), WORK_LEASE_MS);
						return;
					}
					if (message.kind === "commit") {
						const receipt = await queue.commit(lease, work, message.operation, message.mutation);
						this.usageTotal = await this.usageLedger!.total(root);
						return receipt;
					}
					if (message.kind === "usage") {
						this.usageTotal = await this.usageLedger!.report(lease, work, message.reports);
						return;
					}
					if (message.kind === "budget") {
						await queue.assertCurrent(lease, work);
						const decision = this.rootBudget?.checkpoint();
						if (decision?.kind === "exhausted" || decision?.kind === "wrap_up")
							throw new Error("Root workflow budget exhausted");
						return queue.control(lease);
					}
					if (message.kind !== "complete") throw new Error("Invalid worker operation");
					await queue.complete(lease, work, message.result as unknown as WorkflowSerializableObject);
					this.replacements = 0;
					work = undefined;
				});
				if (message.kind !== "delivery" && message.kind !== "delivery-ready")
					serial = response.then(
						() => {},
						() => {},
					);
				void response.then(
					(value) => {
						if (child.connected) child.send({ id: message.id, value });
					},
					(error: Error) => {
						if (child.connected) child.send({ id: message.id, error: error.message });
					},
				);
			});
		});
	}
	private recoverExpired(root: string): Promise<void> {
		if (this.recovering) return this.recovering;
		if (this.closed || performance.now() < this.nextRecoveryAt) return Promise.resolve();
		this.recovering = (async () => {
			await this.admission?.reconcile();
			const expiredBefore = Date.now();
			for (const work of await this.queue!.inspect(root)) {
				if (work.state !== "leased" || work.expiresAt >= expiredBefore) continue;
				const child = work.worker === null ? undefined : this.incarnations.get(work.worker);
				if (child) await this.stop(child);
				await this.queue!.expire(this.lease!, work);
			}
		})().finally(() => {
			this.recovering = undefined;
			this.nextRecoveryAt = performance.now() + RECOVERY_INTERVAL_MS;
		});
		return this.recovering;
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
	async run(definition: WorkflowDefinition, inputs: ResolvedInputs, options: RunOpts): Promise<RunResult> {
		try {
			return await this.dispatch(definition, inputs, options);
		} catch (error) {
			if (this.desiredControl !== "quit" || !findWorkflowGracefulQuit(error)) await this.close();
			throw error;
		}
	}
	private async dispatch(
		definition: WorkflowDefinition,
		inputs: ResolvedInputs,
		options: RunOpts,
	): Promise<RunResult> {
		if (options.budget !== undefined) throw new Error("Local workers refuse process-bound override: budget");
		const index = this.options.definitions.findIndex((binding) => binding.definition === definition);
		if (index < 0) throw new Error(`Worker definition is not importable: ${definition.name}`);
		if (!options.parentRun || !options.durableScope)
			throw new Error("Local workers require a durable child boundary");
		this.rootBudget = options.rootBudget;
		const root = options.parentRun.rootRunId;
		this.starting ??= this.start(root);
		await this.starting;
		if (this.lease!.runId !== root) throw new Error("Local worker pool belongs to another root");
		const source = this.sources[index]!;
		if ((await definitionDigest(source.path)) !== source.digest)
			throw new Error("Worker definition compatibility error");
		await this.backend.hydrateWorkflow(root);
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
		const work = await this.queue!.enqueue(
			this.lease!,
			{
				boundaryId: options.parentRun.stageId,
				childRunId: options.runId!,
				scope: options.durableScope.scopePrefix,
				definition: `${source.path}#${source.exportName}`,
				digest: source.digest,
				inputs,
				execution,
			},
			boundary,
		);
		for (;;) {
			options.signal?.throwIfAborted();
			if (this.closed) {
				if (this.desiredControl === "quit") throw new WorkflowGracefulQuitError(root, "worker pool teardown");
				throw new Error("Local worker pool is closed");
			}
			const result = await this.queue!.result(root, work.id);
			if (result) {
				await this.backend.hydrateWorkflow(root);
				await this.handoff?.complete(work);
				return result as unknown as RunResult;
			}
			if (this.failure) throw this.failure;
			const decision = this.rootBudget?.checkpoint();
			if (decision?.kind === "exhausted" || decision?.kind === "wrap_up")
				await this.rootBudget!.stopAtBoundaryAsync(definition.name);
			await this.recoverExpired(root);
			await delay(25, undefined, { signal: options.signal });
		}
	}
	private closing?: Promise<void>;
	close(): Promise<void> {
		this.closing ??= this.dispose();
		return this.closing;
	}
	private async dispose(): Promise<void> {
		this.closed = true;
		childWorkerDispatchers.delete(this.backend);
		workflowResourceAdmission.delete(this.backend);
		await this.recovering?.catch(() => {});
		await Promise.all([...this.children].map((child) => this.stop(child)));
		await Promise.all([...this.cleanups]);
		if (this.cleanupFailure) throw this.cleanupFailure;
		await this.releaseRoutes?.();
	}
}
