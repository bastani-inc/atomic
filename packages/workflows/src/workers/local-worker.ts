import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { type ResourceAdmission, withResourceAdmission } from "@bastani/atomic";
import { StorageProvider } from "@bastani/atomic/storage";
import type { DurableWorkflowBackend } from "../durable/backend.js";
import { sqlPoolStorage } from "../durable/journal/internal.js";
import { JournalDurableBackend } from "../durable/journal/journal-backend.js";
import { resolveRunJournal } from "../durable/journal/resolution.js";
import type { PoolCommitReceipt, PoolMutation, PoolWork } from "../durable/journal/sql-pool-queue.js";
import { run } from "../engine/run.js";
import { createAgentSessionAdapter } from "../extension/wiring.js";
import type { RunOpts } from "../runs/foreground/executor-types.js";
import { createStore } from "../shared/store.js";
import { admittedSessionAdapter } from "./admission-binding.js";
import { loadWorkerDefinition } from "./definitions.js";
import type { WorkerReply, WorkerRequest, WorkerStart } from "./protocol.js";
import { SqlResourceAdmission } from "./resource-admission.js";
import { workerSessionStore } from "./session-store.js";
import { collectWorkerUsage } from "./usage-accounting.js";

type Request = WorkerRequest extends infer T ? (T extends WorkerRequest ? Omit<T, "id"> : never) : never;

export async function runLocalWorker(start: WorkerStart): Promise<void> {
	let sequence = 0;
	const pending = new Map<
		number,
		{ resolve: (reply: WorkerReply["value"]) => void; reject: (error: Error) => void }
	>();
	process.on("message", (reply: WorkerReply) => {
		const receiver = pending.get(reply.id);
		pending.delete(reply.id);
		if (reply.error) receiver?.reject(new Error(reply.error));
		else receiver?.resolve(reply.value);
	});
	process.on("disconnect", () => process.exit(1));
	const request = (message: Request): Promise<WorkerReply["value"]> =>
		new Promise((resolve, reject) => {
			const id = ++sequence;
			pending.set(id, { resolve, reject });
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
		await request({ kind: "ready" });
		for (;;) {
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
			const store = createStore();
			const admission = start.admission
				? await SqlResourceAdmission.open(journal, {
						...start.admission,
						root: start.root,
						holder: work.worker!,
						attempt: work,
					})
				: undefined;
			const adapter = createAgentSessionAdapter({ cwd: String(work.execution.cwd) });
			const resourceAdmission: ResourceAdmission = {
				async acquire(kind, signal, requestOptions) {
					await request({ kind: "budget" });
					return admission ? admission.acquire(kind, signal, requestOptions) : async () => {};
				},
			};
			const admitted = admittedSessionAdapter(adapter, resourceAdmission, async (signal) => {
				await request({ kind: "budget" });
				await admission?.validate(signal);
			});
			let pulse: Promise<void> | undefined;
			const heartbeat = setInterval(() => {
				pulse ??= (async () => {
					await request({ kind: "renew" });
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
				const result = await withResourceAdmission(resourceAdmission, () =>
					run(definitions[index]!, work.inputs, {
						...(work.execution as RunOpts),
						runId: work.childRunId,
						durableBackend: backend,
						durableRootBackend: backend,
						durableScope: { rootWorkflowId: start.root, scopePrefix: work.scope },
						signal: controller.signal,
						store,
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
				await request({ kind: "usage", reports: collectWorkerUsage(store.runs()) });
				await request({ kind: "complete", result });
			} finally {
				clearInterval(heartbeat);
			}
		}
	} finally {
		await reader.close();
		await sessions.close();
	}
}
