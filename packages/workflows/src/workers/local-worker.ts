import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { type ResourceAdmission, withResourceAdmission } from "@bastani/atomic";
import { StorageProvider } from "@bastani/atomic/storage";
import type { DurableWorkflowBackend } from "../durable/backend.js";
import { sqlPoolStorage } from "../durable/journal/internal.js";
import { JournalDurableBackend } from "../durable/journal/journal-backend.js";
import { resolveRunJournal } from "../durable/journal/resolution.js";
import type { PoolCommitReceipt, PoolControl, PoolMutation, PoolWork } from "../durable/journal/sql-pool-queue.js";
import { run } from "../engine/run.js";
import { createToolControlRegistry } from "../engine/run-tool-control-registry.js";
import { WorkflowGracefulQuitError } from "../engine/workflow-tool-abort.js";
import { createAgentSessionAdapter } from "../extension/wiring.js";
import type { RunOpts } from "../runs/foreground/executor-types.js";
import { createStageControlRegistry } from "../runs/foreground/stage-control-registry.js";
import type { AgentSessionAdapter } from "../runs/foreground/stage-runner.js";
import { createStore } from "../shared/store.js";
import { admittedSessionAdapter } from "./admission-binding.js";
import { loadWorkerDefinition } from "./definitions.js";
import type { WorkerDeliver, WorkerReply, WorkerRequest, WorkerStageDelivery, WorkerStart } from "./protocol.js";
import { SqlResourceAdmission } from "./resource-admission.js";
import { workerSessionStore } from "./session-store.js";
import { collectWorkerUsage } from "./usage-accounting.js";

type Request = WorkerRequest extends infer T ? (T extends WorkerRequest ? Omit<T, "id"> : never) : never;

export async function runLocalWorker(start: WorkerStart): Promise<void> {
	let sequence = 0;
	const pending = new Map<
		number,
		{ resolve: (reply: WorkerReply["value"]) => void; reject: (error: Error) => void; deliver?: WorkerDeliver }
	>();
	process.on("message", (reply: WorkerReply) => {
		const receiver = pending.get(reply.id);
		if (reply.delivery) {
			const delivery = reply.delivery;
			void Promise.resolve()
				.then(() => {
					if (!receiver?.deliver) throw new Error("Worker delivery receiver is gone");
					return receiver.deliver(delivery.from, delivery.message);
				})
				.then(
					() => process.send?.({ id: 0, kind: "delivery-ack", deliveryId: delivery.id }),
					(error: Error) =>
						process.send?.({ id: 0, kind: "delivery-ack", deliveryId: delivery.id, error: error.message }),
				);
			return;
		}
		pending.delete(reply.id);
		if (reply.error) receiver?.reject(new Error(reply.error));
		else receiver?.resolve(reply.value);
	});
	process.on("disconnect", () => process.exit(1));
	const request = (message: Request, deliver?: WorkerDeliver): Promise<WorkerReply["value"]> =>
		new Promise((resolve, reject) => {
			const id = ++sequence;
			pending.set(id, { resolve, reject, deliver });
			process.send?.({ ...message, id }, (error) => {
				if (error) reject(error);
			});
		});
	const definitions = await Promise.all(start.definitions.map(loadWorkerDefinition));
	const journal = await resolveRunJournal({ journal: { path: start.journalPath } });
	const journalReads = new Set(["descriptor", "getRun", "listRuns", "read", "readKey", "leaseState", "close"]);
	const readOnlyJournal = new Proxy(journal, {
		get(target, key) {
			if (typeof key !== "string" || !journalReads.has(key))
				return () => {
					throw new Error(`Worker journal is read-only: ${String(key)}`);
				};
			const value = Reflect.get(target, key);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	const reader = await JournalDurableBackend.open(readOnlyJournal);
	const sessions = await new StorageProvider().openSessionStore(
		{ kind: "sqlite", path: start.journalPath, prefix: `${sqlPoolStorage(journal)!.tables.runs}_pool_` },
		{ agentDir: "", domain: "sessions" },
	);
	const commit = async (mutation: PoolMutation): Promise<PoolCommitReceipt> => {
		const receipt = (await request({
			kind: "commit",
			operation: randomUUID(),
			mutation,
		})) as unknown as PoolCommitReceipt;
		await reader.hydrateWorkflow(start.root);
		return receipt;
	};
	const reads = new Set([
		"getToolOutput",
		"getToolCheckpoint",
		"getUiResponse",
		"getStageOutput",
		"getStageSession",
		"listCheckpoints",
		"getWorkflow",
		"getLoadableWorkflow",
		"toMetadata",
		"isWorkflowLoadable",
		"hydrateWorkflow",
		"promptReservationScope",
	]);
	const backend = new Proxy(reader, {
		get(target, key) {
			if (
				typeof key !== "string" ||
				key === "then" ||
				/^(archive|readSettled|readPending|hasCached|hasPending|getPending)/.test(key)
			)
				return undefined;
			if (key === "persistent") return true;
			if (key === "workflowOwnership") return () => "local";
			if (key === "persistPendingStageMessages") return async () => false;
			if (key === "commitCheckpoint" || key === "commitAdditiveCheckpointBestEffort")
				return async (
					checkpoint: Parameters<DurableWorkflowBackend["commitCheckpoint"]>[0],
					options?: { readonly signal?: AbortSignal },
				) => {
					options?.signal?.throwIfAborted();
					await commit({ kind: "checkpoint", checkpoint });
					return true;
				};
			if (typeof key === "string" && reads.has(key)) {
				const value = Reflect.get(target, key);
				return typeof value === "function" ? value.bind(target) : value;
			}
			return () => {
				throw new Error(`Worker cannot mutate root state: ${String(key)}`);
			};
		},
	}) as DurableWorkflowBackend;
	try {
		let controlRevision = -1;
		let controlState: PoolControl["state"] = "running";
		let currentStore = createStore();
		let activeController: AbortController | undefined;
		const toolControls = createToolControlRegistry();
		const stageControls = createStageControlRegistry();
		const observeControl = async () => {
			const control = (await request({ kind: "control" })) as PoolControl;
			if (control.revision === controlRevision) return;
			for (const run of currentStore.runs()) {
				if (control.state === "paused") {
					await toolControls.runControl(run.id)?.pause();
					await stageControls.run(run.id).pause();
				} else if (control.state === "running") {
					await toolControls.runControl(run.id)?.resume();
					await stageControls.run(run.id).resume();
				}
			}
			controlState = control.state;
			controlRevision = control.revision;
			if (control.state === "quit" && activeController) {
				activeController.abort(
					new WorkflowGracefulQuitError(currentStore.runs()[0]?.id ?? start.root, "root worker control"),
				);
				return;
			}
			await request({ kind: "controlled", revision: controlRevision });
		};
		await request({ kind: "ready" });
		for (;;) {
			await observeControl();
			if (controlState !== "running") {
				await delay(25);
				continue;
			}
			const work = (await request({ kind: "claim" })) as PoolWork | undefined;
			if (!work) {
				await delay(25 + Math.random() * 25);
				continue;
			}
			const index = start.definitions.findIndex(
				(source) => `${source.path}#${source.exportName}` === work.definition && source.digest === work.digest,
			);
			if (index < 0) throw new Error("Worker definition compatibility error");
			await reader.hydrateWorkflow(start.root);
			const controller = new AbortController();
			activeController = controller;
			const store = createStore();
			currentStore = store;
			let publication: Promise<WorkerReply["value"]> = Promise.resolve(undefined);
			const publish = () => {
				const runs = structuredClone(store.runs());
				publication = publication.then(() => request({ kind: "activity", runs }));
				void publication.catch((error: Error) => controller.abort(error));
			};
			const unsubscribe = store.subscribeInvalidation(publish);
			const admission = start.admission
				? await SqlResourceAdmission.open(journal, {
						...start.admission,
						root: start.root,
						holder: work.worker!,
						attempt: work,
					})
				: undefined;
			const baseAdapter = createAgentSessionAdapter({ cwd: String(work.execution.cwd) });
			const adapter: AgentSessionAdapter = {
				async create(options, meta) {
					if (!meta) throw new Error("Worker stage identity is required");
					if (!options.orchestrationContext?.pendingStageDelivery) return baseAdapter.create(options, meta);
					if (options.sessionManager)
						store.recordStageSession(meta.runId, meta.stageId, {
							sessionId: options.sessionManager.getSessionId(),
						});
					await publication;
					const identity = { runId: meta.runId, stageId: meta.stageId, stageName: meta.stageName };
					const capability = await request({ kind: "route", runId: meta.runId });
					if (typeof capability !== "string") throw new Error("Worker root route is unavailable");
					const pendingStageDelivery: WorkerStageDelivery = {
						routeCapability: capability,
						async deliverPending(deliver, recipient) {
							await publication;
							await request({ kind: "delivery", ...identity, recipient }, deliver);
						},
						async ready(sessionId) {
							await publication;
							await request({ kind: "delivery-ready", ...identity, sessionId });
						},
						fail: options.orchestrationContext.pendingStageDelivery.fail,
					};
					return baseAdapter.create(
						{ ...options, orchestrationContext: { ...options.orchestrationContext, pendingStageDelivery } },
						meta,
					);
				},
			};
			const awaitAdmission = async (signal?: AbortSignal) => {
				for (;;) {
					signal?.throwIfAborted();
					const control = (await request({ kind: "budget" })) as PoolControl;
					if (control.state === "running") return;
					await delay(25, undefined, { signal });
				}
			};
			const resourceAdmission: ResourceAdmission = {
				async acquire(kind, signal, requestOptions) {
					await awaitAdmission(signal);
					return admission ? admission.acquire(kind, signal, requestOptions) : async () => {};
				},
			};
			const admitted = admittedSessionAdapter(adapter, resourceAdmission, async (signal) => {
				await awaitAdmission(signal);
				await admission?.validate(signal);
			});
			let pulse: Promise<void> | undefined;
			let controlPulse: Promise<void> | undefined;
			const heartbeat = setInterval(() => {
				pulse ??= (async () => {
					await request({ kind: "renew" });
					publish();
					await publication;
					controlPulse ??= observeControl()
						.catch((error: Error) => controller.abort(error))
						.finally(() => {
							controlPulse = undefined;
						});
					await request({ kind: "usage", reports: collectWorkerUsage(store.runs()) });
				})()
					.catch((error: Error) => {
						controller.abort(error);
						process.exitCode = 1;
					})
					.finally(() => {
						pulse = undefined;
					});
			}, 1000);
			try {
				await observeControl();
				while (((await request({ kind: "control" })) as PoolControl).state !== "running") {
					controller.signal.throwIfAborted();
					await delay(25);
				}
				const result = await withResourceAdmission(resourceAdmission, () =>
					run(definitions[index]!, work.inputs, {
						...(work.execution as RunOpts),
						runId: work.childRunId,
						durableBackend: backend,
						durableRootBackend: backend,
						durableScope: { rootWorkflowId: start.root, scopePrefix: work.scope },
						signal: controller.signal,
						store,
						toolControlRegistry: toolControls,
						stageControlRegistry: stageControls,
						adapters: {
							agentSession: admitted,
							sessionStore: workerSessionStore({
								reader: sessions,
								backend: reader,
								store,
								root: start.root,
								commit,
							}),
						},
					}),
				);
				clearInterval(heartbeat);
				await pulse;
				await controlPulse;
				await publication;
				await request({ kind: "usage", reports: collectWorkerUsage(store.runs()) });
				const finalControl = (await request({ kind: "control" })) as PoolControl;
				if (finalControl.state === "quit") {
					await request({ kind: "controlled", revision: finalControl.revision });
					return;
				}
				await request({ kind: "complete", result });
			} finally {
				clearInterval(heartbeat);
				unsubscribe();
				activeController = undefined;
			}
		}
	} finally {
		await reader.close();
		await sessions.close();
	}
}
