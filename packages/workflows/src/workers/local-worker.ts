import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
	applyProviderRateLimitObservation,
	observeProviderRateLimits,
	type ResourceAdmission,
	withResourceAdmission,
} from "@bastani/atomic";
import { StorageProvider } from "@bastani/atomic/storage";
import type { DurableWorkflowBackend } from "../durable/backend.js";
import { sqlPoolStorage } from "../durable/journal/internal.js";
import { JournalDurableBackend } from "../durable/journal/journal-backend.js";
import { resolveRunJournal } from "../durable/journal/resolution.js";
import { PromptReservationState, type PromptReservationToken } from "../durable/prompt-reservation-state.js";
import "../durable/journal/workflows-host-module.js";
import type { PoolCommitReceipt, PoolControl, PoolWork } from "../durable/journal/sql-pool-queue.js";
import { run } from "../engine/run.js";
import { createToolControlRegistry } from "../engine/run-tool-control-registry.js";
import { WorkflowGracefulQuitError } from "../engine/workflow-tool-abort.js";
import type { PiCustomOverlayFactory, PiCustomOverlayOptions } from "../extension/wiring.js";
import { createAgentSessionAdapter } from "../extension/wiring.js";
import type { StageQuestionnaireInput } from "../extension/workflow-human-input.js";
import type { RunOpts } from "../runs/foreground/executor-types.js";
import {
	createStageControlRegistry,
	type StageControlHandle,
	type StageControlRegistry,
} from "../runs/foreground/stage-control-registry.js";
import { stageQueuedUserMessageCount } from "../runs/foreground/stage-queued-user-messages.js";
import type { AgentSessionAdapter } from "../runs/foreground/stage-runner.js";
import { StageUiBroker } from "../shared/stage-ui-broker.js";
import { createStore, type Store } from "../shared/store.js";
import type { RunSnapshot } from "../shared/store-types.js";
import { admittedSessionAdapter } from "./admission-binding.js";
import { POOL_COORDINATOR_ROLE, type PoolCoordinatorStart } from "./coordinator-protocol.js";
import { loadWorkerDefinition } from "./definitions.js";
import { poolWorkerCommit } from "./pool-commit.js";
import { POOLED_CUSTOM_PROMPT_UNAVAILABLE } from "./pooled-prompt-limits.js";
import { configurePooledWatchTrace } from "./pooled-watch-trace.js";
import {
	WORKER_HEARTBEAT_INTERVAL_MS,
	type WorkerDeliver,
	type WorkerInbound,
	type WorkerReply,
	type WorkerRequest,
	type WorkerStageDelivery,
	type WorkerStart,
} from "./protocol.js";
import { RateLimitObservationOutbox } from "./rate-limit-sharing.js";
import { SqlResourceAdmission } from "./resource-admission.js";
import { workerSessionStore } from "./session-store.js";
import { type WorkerStagePrompts, WorkerStageWatches } from "./stage-watch.js";
import { collectWorkerUsage } from "./usage-accounting.js";

/** Stamps each published stage with its handle's queued message count, for the root's graph. */
function withQueuedCounts(runs: readonly RunSnapshot[], stageControls: StageControlRegistry): readonly RunSnapshot[] {
	for (const run of runs)
		for (const stage of run.stages) {
			const count = stageQueuedUserMessageCount(stageControls.peek(run.id, stage.id)?.queuedUserMessages?.());
			if (count > 0) stage.queuedUserMessageCount = count;
		}
	return runs;
}

/** A reply fenced the worker's attempt: another attempt owns the work, or none does. Not a worker fault. */
class WorkAttemptFencedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorkAttemptFencedError";
	}
}

/** The registry, with each registered stage's first turn in this process recorded in `started`. */
function trackTurnStarts(registry: StageControlRegistry, started: WeakSet<StageControlHandle>): StageControlRegistry {
	return new Proxy(registry, {
		get(target, key) {
			if (key === "register")
				return (handle: StageControlHandle) => {
					const unsubscribe = handle.subscribe((event) => {
						if (
							event.type !== "agent_start" &&
							!(event.type === "message_start" && event.message.role === "assistant")
						)
							return;
						started.add(handle);
						unsubscribe();
					});
					const unregister = target.register(handle);
					return () => {
						unsubscribe();
						unregister();
					};
				};
			const value = Reflect.get(target, key);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

/**
 * A worker's stage UI broker. A stage's brokered question (`ask_user_question`) waits here for the
 * root's answer; a `ctx.ui.custom` prompt node fails at once, since its component cannot be shown
 * outside this process (#3996).
 */
class WorkerStageUiBroker extends StageUiBroker {
	constructor(private readonly workerStore: Store) {
		super(workerStore);
	}
	override requestCustomUi<T>(
		runId: string,
		stageId: string,
		factory: PiCustomOverlayFactory<T>,
		options?: PiCustomOverlayOptions,
		signal?: AbortSignal,
		sessionId?: string,
		humanInput?: StageQuestionnaireInput,
	): Promise<T> {
		const stage = this.workerStore
			.runs()
			.find((run) => run.id === runId)
			?.stages.find((candidate) => candidate.id === stageId);
		if (stage?.promptFootprint?.kind === "custom") return Promise.reject(new Error(POOLED_CUSTOM_PROMPT_UNAVAILABLE));
		return super.requestCustomUi<T>(runId, stageId, factory, options, signal, sessionId, humanInput);
	}
}

/**
 * Lets the root fail a pending `ctx.ui` prompt of this attempt (#3996): its waiter rejects with
 * the root's error, so the prompt fails in the child as an in-process `ui` rejection would.
 */
function failablePrompts(store: Store): WorkerStagePrompts["fail"] {
	const failures = new Map<string, (error: Error) => void>();
	const awaitPrompt = store.awaitStagePendingPrompt.bind(store);
	store.awaitStagePendingPrompt = (runId, stageId, promptId) => {
		const failed = Promise.withResolvers<never>();
		const key = JSON.stringify([runId, stageId, promptId]);
		failures.set(key, failed.reject);
		return Promise.race([awaitPrompt(runId, stageId, promptId), failed.promise]).finally(() => failures.delete(key));
	};
	return (runId, stageId, promptId, error) => {
		const fail = failures.get(JSON.stringify([runId, stageId, promptId]));
		if (fail === undefined) return false;
		fail(error);
		// Clear the prompt without an answer; the waiter already failed.
		store.resolveStagePendingPrompt(runId, stageId, promptId, undefined, { recordAnswer: false });
		return true;
	};
}

type Request = WorkerRequest extends infer T ? (T extends WorkerRequest ? Omit<T, "id"> : never) : never;

/** Entry of every local worker process; the same module also runs a pool's coordinator. */
export async function runLocalWorker(start: WorkerStart | PoolCoordinatorStart): Promise<void> {
	if ("role" in start && start.role === POOL_COORDINATOR_ROLE) {
		const { runPoolCoordinator } = await import("./pool-coordinator.js");
		runPoolCoordinator();
		return;
	}
	await runWorker(start as WorkerStart);
}

async function runWorker(start: WorkerStart): Promise<void> {
	let sequence = 0;
	/** Set once any reply fences the current attempt; the attempt then ends without failing the worker (#3979). */
	let attemptFenced = false;
	/** Set once a reply reports the root's lease gone; the worker then ends cleanly instead of crashing (#3979). */
	let rootLeaseLost = false;
	const pending = new Map<
		number,
		{ resolve: (reply: WorkerReply["value"]) => void; reject: (error: Error) => void; deliver?: WorkerDeliver }
	>();
	let stageWatches: WorkerStageWatches | undefined;
	// #4023: limits this worker records reach the rest of the pool, and theirs reach it, through the coordinator.
	const rateLimitOutbox = new RateLimitObservationOutbox((observations) =>
		process.send?.({ id: 0, kind: "rate-limits", observations } satisfies WorkerRequest, () => {}),
	);
	observeProviderRateLimits((observation) => rateLimitOutbox.offer(observation));
	process.on("message", (message: WorkerInbound) => {
		if ("kind" in message && message.kind === "rate-limits") {
			for (const observation of message.observations) applyProviderRateLimitObservation(observation);
			return;
		}
		if ("kind" in message) {
			stageWatches?.serve(message);
			return;
		}
		const reply = message;
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
		if (reply.error && reply.rootLeaseLost) {
			rootLeaseLost = true;
			attemptFenced = true;
			receiver?.reject(new WorkAttemptFencedError(reply.error));
		} else if (reply.error && reply.fenced) {
			attemptFenced = true;
			receiver?.reject(new WorkAttemptFencedError(reply.error));
		} else if (reply.error) receiver?.reject(new Error(reply.error));
		else receiver?.resolve(reply.value);
	});
	process.on("disconnect", () => process.exit(rootLeaseLost ? 0 : 1));
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
	const reader = await JournalDurableBackend.open(readOnlyJournal, { runs: [] });
	configurePooledWatchTrace(start.journalPath, `worker:${process.pid}`);
	const sessions = await new StorageProvider().openSessionStore(
		{ kind: "sqlite", path: start.journalPath, prefix: `${sqlPoolStorage(journal)!.tables.runs}_pool_` },
		{ agentDir: "", domain: "sessions" },
	);
	const commit = poolWorkerCommit({
		send: async (mutation) =>
			(await request({ kind: "commit", operation: randomUUID(), mutation })) as unknown as PoolCommitReceipt,
		catchUp: () => reader.catchUpWorkflow(start.root),
	});
	const reads = new Set([
		"getToolOutput",
		"getToolCheckpoint",
		"getUiResponse",
		"getStageOutput",
		"getStageSession",
		"listCheckpoints",
		"nestedSnapshotVersion",
		"getWorkflow",
		"getLoadableWorkflow",
		"toMetadata",
		"isWorkflowLoadable",
		"hydrateWorkflow",
		"promptReservationScope",
	]);
	// Pending-prompt reservations of pooled children live in this process: a prompt left pending
	// when the worker dies is asked again by the replay, and an answered one replays from the UI
	// response checkpoint this worker committed (#3996).
	const reservations = new Map<string, PromptReservationState>();
	const reservationsOf = (workflowId: string): PromptReservationState => {
		let state = reservations.get(workflowId);
		if (state === undefined) {
			state = new PromptReservationState(0);
			reservations.set(workflowId, state);
		}
		return state;
	};
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
			if (key === "reservePendingPrompt")
				return async (workflowId: string, reservationId: string) =>
					reservationsOf(workflowId).reserve(reservationId);
			if (key === "pendingPromptToken")
				return async (workflowId: string, reservationId: string) => reservationsOf(workflowId).claim(reservationId);
			if (key === "releasePendingPrompt")
				return async (workflowId: string, reservationId: string, token: PromptReservationToken) =>
					reservationsOf(workflowId).release(reservationId, token);
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
		// Whether each stage started a turn in this attempt: a reconnecting root view redelivers
		// only after the replay's own prompt, so the replay is not preceded by redelivered text (#3996).
		const turnStarted = new WeakSet<StageControlHandle>();
		const stageControls = trackTurnStarts(createStageControlRegistry(), turnStarted);
		let heldAttempt: PoolWork | undefined;
		let prompts: WorkerStagePrompts | undefined;
		stageWatches = new WorkerStageWatches(
			stageControls,
			() => (heldAttempt === undefined ? undefined : { workId: heldAttempt.id, generation: heldAttempt.generation }),
			(message) => process.send?.({ ...message, id: 0 }),
			() => controlState,
			{
				entries: async (sessionId) => (await sessions.load(sessionId)).entries,
				turnStarted: (handle) => turnStarted.has(handle),
				prompts: () => prompts,
			},
		);
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
			await reader.catchUpWorkflow(start.root);
			const work = (await request({ kind: "claim" })) as PoolWork | undefined;
			attemptFenced = false;
			if (!work) {
				await delay(25 + Math.random() * 25);
				continue;
			}
			const index = start.definitions.findIndex(
				(source) => `${source.path}#${source.exportName}` === work.definition && source.digest === work.digest,
			);
			if (index < 0) throw new Error("Worker definition compatibility error");
			await reader.catchUpWorkflow(start.root);
			const controller = new AbortController();
			activeController = controller;
			heldAttempt = work;
			const store = createStore();
			currentStore = store;
			// Stages of this attempt raise human input here; the root answers through the airlock (#3996).
			const stageUiBroker = new WorkerStageUiBroker(store);
			prompts = { store, broker: stageUiBroker, fail: failablePrompts(store) };
			let publication: Promise<void> | undefined;
			let activityDirty = false;
			const publish = () => {
				activityDirty = true;
				if (publication !== undefined) return;
				const current = (async () => {
					while (activityDirty) {
						activityDirty = false;
						await request({
							kind: "activity",
							runs: withQueuedCounts(structuredClone(store.runs()), stageControls),
						});
					}
				})();
				publication = current;
				const settle = () => {
					if (publication === current) publication = undefined;
				};
				current.then(settle, (error: Error) => {
					settle();
					controller.abort(error);
				});
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
			// A stage's questions (ask_user_question) wait in this attempt's broker, where the root reads them (#3996).
			const baseAdapter = createAgentSessionAdapter({ cwd: String(work.execution.cwd) }, stageUiBroker);
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
			let renewal: Promise<void> | undefined;
			let report: Promise<void> | undefined;
			let controlPulse: Promise<void> | undefined;
			const failPulse = (error: Error) => {
				controller.abort(error);
				if (!(error instanceof WorkAttemptFencedError)) process.exitCode = 1;
			};
			const heartbeat = setInterval(() => {
				stageWatches?.sweep();
				renewal ??= request({ kind: "renew" })
					.then(() => {})
					.catch(failPulse)
					.finally(() => {
						renewal = undefined;
					});
				controlPulse ??= observeControl()
					.catch((error: Error) => controller.abort(error))
					.finally(() => {
						controlPulse = undefined;
					});
				report ??= (async () => {
					publish();
					await publication;
					await request({ kind: "usage", reports: collectWorkerUsage(store.runs()) });
				})()
					.catch(failPulse)
					.finally(() => {
						report = undefined;
					});
			}, WORKER_HEARTBEAT_INTERVAL_MS);
			try {
				await observeControl();
				while (((await request({ kind: "control" })) as PoolControl).state !== "running") {
					controller.signal.throwIfAborted();
					await delay(25);
				}
				const result = await withResourceAdmission(resourceAdmission, () =>
					run(definitions[index]!, work.inputs, {
						...(work.execution as RunOpts),
						...(start.promptNodes === true ? { usePromptNodesForUi: true } : {}),
						runId: work.childRunId,
						durableBackend: backend,
						durableRootBackend: backend,
						durableScope: { rootWorkflowId: start.root, scopePrefix: work.scope },
						signal: controller.signal,
						store,
						toolControlRegistry: toolControls,
						stageControlRegistry: stageControls,
						stageUiBroker,
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
				// Watched events reach the coordinator before the attempt's end does.
				stageWatches?.clear();
				await renewal;
				await report;
				await controlPulse;
				await publication;
				await request({ kind: "usage", reports: collectWorkerUsage(store.runs()) });
				const finalControl = (await request({ kind: "control" })) as PoolControl;
				if (finalControl.state === "quit") {
					await request({ kind: "controlled", revision: finalControl.revision });
					return;
				}
				await request({ kind: "complete", result });
			} catch (error) {
				if (!attemptFenced) throw error;
				// Its new owner, if any, replays the child; this worker ends the attempt and serves the next one.
				controller.abort(error);
			} finally {
				clearInterval(heartbeat);
				unsubscribe();
				stageWatches?.clear();
				heldAttempt = undefined;
				prompts = undefined;
				activeController = undefined;
			}
			if (attemptFenced && !rootLeaseLost) {
				await renewal;
				await report;
				await controlPulse;
				await request({ kind: "fenced" });
			}
			if (rootLeaseLost) break;
		}
	} catch (error) {
		// The root released its lease (teardown) or lost it to another incarnation: nothing is left to serve, and
		// this is not a worker fault, so the worker ends cleanly instead of crashing (#3979).
		if (!rootLeaseLost) throw error;
	} finally {
		await reader.close();
		await sessions.close();
	}
	// Closing the channel ends the process (exit code 0) instead of waiting for the pool to disconnect it.
	if (rootLeaseLost) process.disconnect?.();
}
