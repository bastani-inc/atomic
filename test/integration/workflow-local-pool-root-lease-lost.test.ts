import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, vi } from "vitest";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { isStaleLeaseError } from "../../packages/workflows/src/durable/journal/types.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { rehydrateError, type SerializedError } from "../../packages/workflows/src/shared/error-codec.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { definitionDigest, loadWorkerDefinition } from "../../packages/workflows/src/workers/definitions.js";
import { LocalWorkerPool } from "../../packages/workflows/src/workers/local-pool.js";
import { poolTestBudgetMs } from "../helpers/pool-budget.js";
import { makeTempDirectory, removeTempDirectory, sleep, writeFileEnsuringDir } from "../helpers/runtime.js";

const WORKERS = 2;
const childPath = fileURLToPath(new URL("../fixtures/pool-resume-child.ts", import.meta.url));
/** One pool cold start, the child's work, and the wait for its workers to meet the released lease. */
const BUDGET = poolTestBudgetMs(3);

function startedChildren(directory: string): number {
	return readdirSync(directory).filter((name) => name.startsWith("started-")).length;
}

async function waitUntil(predicate: () => boolean, what: string, budget: AbortSignal): Promise<void> {
	while (!predicate()) {
		if (budget.aborted) throw new Error(`Timed out waiting for ${what}`);
		await sleep(20);
	}
}

test.skipIf(process.platform === "win32")(
	"idle workers that meet the root's released lease end cleanly despite late IPC errors (#3979, #4768)",
	async () => {
		const directory = makeTempDirectory("pool-root-lease-lost-");
		const path = join(directory, "journal.sqlite");
		const exportName = "resumedChild";
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName,
			digest: await definitionDigest(childPath),
		});
		const parent = workflow({
			name: "pool-root-lease-lost-root",
			description: "Root over one pooled child",
			inputs: {},
			outputs: {},
			async run(ctx) {
				const result = await ctx.workflow(child, { inputs: { directory, index: 0 } });
				assert.equal(result.status, "completed");
				return {};
			},
		});
		const database = await openNodeSqliteDatabase(path);
		const journal = await SqlRunJournal.open(database);
		const backend = await JournalDurableBackend.open(journal, { ownsJournal: false });
		const pool = new LocalWorkerPool(backend, {
			journalPath: path,
			workers: WORKERS,
			definitions: [{ definition: child, path: childPath, exportName }],
			coordinator: "in-process",
		});
		// The in-process coordinator forks the workers from this process, so their spawns and exit codes are observable.
		const exits: {
			readonly pid: number | undefined;
			readonly code: number | null;
			readonly signal: NodeJS.Signals | null;
		}[] = [];
		let spawns = 0;
		// Workers whose request the coordinator refused because the root's lease is gone: its claim or its control
		// request, whichever the worker sent first after the release (both check the root's lease).
		const leaseLostReplies = new Set<number>();
		const lateSendErrors = new Set<number>();
		const emit = ChildProcess.prototype.emit as (
			this: ChildProcess,
			event: string | symbol,
			...args: unknown[]
		) => boolean;
		vi.spyOn(ChildProcess.prototype, "emit").mockImplementation(function (
			this: ChildProcess,
			event: string | symbol,
			...args: unknown[]
		) {
			if (event === "spawn") {
				spawns += 1;
				// Each forked worker has its own IPC `send`; record the replies that tell it the root's lease is gone.
				const send = this.send.bind(this) as (message: object, ...rest: unknown[]) => boolean;
				const pid = this.pid;
				this.send = ((message: object, ...rest: unknown[]) => {
					// The refusal itself says the root's lease is gone: a stale root lease, typed across the IPC.
					const refusal = (message as { readonly error?: SerializedError }).error;
					if (refusal !== undefined && isStaleLeaseError(rehydrateError(refusal)) && pid !== undefined) {
						const firstForWorker = !leaseLostReplies.has(pid);
						leaseLostReplies.add(pid);
						const callback =
							typeof rest.at(-1) === "function" ? (rest.at(-1) as (error: Error | null) => void) : undefined;
						if (firstForWorker && callback !== undefined) {
							this.once("disconnect", () => {
								lateSendErrors.add(pid);
								callback(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
							});
							return send(message, () => {});
						}
					}
					return send(message, ...rest);
				}) as typeof this.send;
			}
			if (event === "exit")
				exits.push({
					pid: this.pid,
					code: args[0] as number | null,
					signal: (args[1] as NodeJS.Signals | null) ?? null,
				});
			return emit.call(this, event, ...args);
		});
		// Every wait shares the test's budget.
		const budget = AbortSignal.timeout(BUDGET.waitMs);
		try {
			const running = run(
				parent,
				{},
				{
					runId: randomUUID(),
					cwd: directory,
					store: createStore(),
					durableBackend: backend,
					signal: budget,
				},
			);
			await waitUntil(() => startedChildren(directory) === 1, "the child to start", budget);
			await writeFileEnsuringDir(join(directory, "release"), "");
			const result = await running;
			assert.equal(result.status, "completed", JSON.stringify(result));
			// The root released its lease, but the pool is still open: its idle workers keep asking for work.
			const workers = [...pool.workerPids];
			assert.equal(workers.length, WORKERS);
			const spawnedBefore = spawns;
			await waitUntil(
				() => workers.every((pid) => exits.some((exit) => exit.pid === pid)),
				"every worker to end after the root lease is gone",
				budget,
			);
			assert.ok(
				[...leaseLostReplies].some((pid) => workers.includes(pid)),
				"the coordinator told a worker the root's lease is gone",
			);
			assert.ok(
				[...lateSendErrors].some((pid) => workers.includes(pid)),
				"a worker's disconnect raced with a send completion callback",
			);
			for (const pid of workers) {
				const exit = exits.find((candidate) => candidate.pid === pid);
				assert.equal(
					exit?.code,
					0,
					`worker ${pid} crashed on the released lease (signal=${exit?.signal ?? "none"})`,
				);
			}
			assert.equal(spawns, spawnedBefore, "no replacement was spawned for a worker that ended on a released lease");
			await pool.close();
		} finally {
			vi.restoreAllMocks();
			await pool.close().catch(() => {});
			await backend.close();
			await journal.close();
			await database.close();
			removeTempDirectory(directory);
		}
	},
	BUDGET.timeoutMs,
);

test.skipIf(process.platform === "win32")(
	"recycled and retired workers end cleanly when reply or control sends fail after disconnect (#3979, #4768)",
	async () => {
		const directory = makeTempDirectory("pool-worker-clean-exit-");
		const path = join(directory, "journal.sqlite");
		const donePath = join(directory, "done");
		const exportName = "resumedChild";
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName,
			digest: await definitionDigest(childPath),
		});
		const parent = workflow({
			name: "pool-worker-clean-exit-root",
			description: "Root keeping its lease while a recycled worker and a retired worker exit",
			inputs: {},
			outputs: {},
			async run(ctx) {
				const result = await ctx.workflow(child, { inputs: { directory, index: 0 } });
				assert.equal(result.status, "completed");
				await ctx.tool("hold-root-lease", {}, async (toolContext) => {
					while (!existsSync(donePath)) {
						toolContext?.signal?.throwIfAborted();
						await sleep(20);
					}
					return {};
				});
				return {};
			},
		});
		const database = await openNodeSqliteDatabase(path);
		const journal = await SqlRunJournal.open(database);
		const backend = await JournalDurableBackend.open(journal, { ownsJournal: false });
		const pool = new LocalWorkerPool(backend, {
			journalPath: path,
			workers: 1,
			maxWorkerRssBytes: 1,
			definitions: [{ definition: child, path: childPath, exportName }],
			coordinator: "in-process",
		});
		const spawned: ChildProcess[] = [];
		const exits: {
			readonly pid: number | undefined;
			readonly code: number | null;
			readonly signal: NodeJS.Signals | null;
		}[] = [];
		const recycleRequestIds = new Map<number, Set<number>>();
		const recycleSendErrors = new Set<number>();
		const retireSendErrors = new Set<number>();
		const controlSendErrors = new Set<number>();
		const emit = ChildProcess.prototype.emit as (
			this: ChildProcess,
			event: string | symbol,
			...args: unknown[]
		) => boolean;
		vi.spyOn(ChildProcess.prototype, "emit").mockImplementation(function (
			this: ChildProcess,
			event: string | symbol,
			...args: unknown[]
		) {
			if (event === "spawn") {
				spawned.push(this);
				const send = this.send.bind(this) as (message: object, ...rest: unknown[]) => boolean;
				const pid = this.pid;
				this.send = ((message: object, ...rest: unknown[]) => {
					const callback =
						typeof rest.at(-1) === "function" ? (rest.at(-1) as (error: Error | null) => void) : undefined;
					if (pid !== undefined && callback !== undefined) {
						const kind = (message as { readonly kind?: string }).kind;
						const control = (message as { readonly control?: { readonly revision?: number } }).control;
						if (kind === "pool-control" && (control?.revision ?? 0) >= 2 && !controlSendErrors.has(pid)) {
							this.once("disconnect", () => {
								controlSendErrors.add(pid);
								callback(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
							});
							return send(message, () => {});
						}
						const replyId = (message as { readonly id?: number }).id;
						if (replyId !== undefined && recycleRequestIds.get(pid)?.has(replyId)) {
							this.once("disconnect", () => {
								recycleSendErrors.add(pid);
								callback(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
							});
							return send(message, () => {});
						}
						if ((message as { readonly retire?: boolean }).retire === true) {
							this.once("disconnect", () => {
								retireSendErrors.add(pid);
								callback(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
							});
							return send(message, () => {});
						}
					}
					return send(message, ...rest);
				}) as typeof this.send;
			}
			if (event === "message" && this.pid !== undefined) {
				const request = args[0] as { readonly id?: number; readonly kind?: string } | undefined;
				if (request?.kind === "recycle" && typeof request.id === "number") {
					let ids = recycleRequestIds.get(this.pid);
					if (!ids) {
						ids = new Set();
						recycleRequestIds.set(this.pid, ids);
					}
					ids.add(request.id);
				}
			}
			if (event === "exit")
				exits.push({
					pid: this.pid,
					code: args[0] as number | null,
					signal: (args[1] as NodeJS.Signals | null) ?? null,
				});
			return emit.call(this, event, ...args);
		});
		const budget = AbortSignal.timeout(BUDGET.waitMs);
		try {
			const running = run(
				parent,
				{},
				{
					runId: randomUUID(),
					cwd: directory,
					store: createStore(),
					durableBackend: backend,
					signal: budget,
				},
			);
			await waitUntil(() => startedChildren(directory) === 1, "the child to start", budget);
			const firstWorker = spawned[0];
			assert.ok(firstWorker?.pid !== undefined, "the first worker is running");
			await pool.control("paused");
			await pool.control("running");
			firstWorker.emit("message", { id: 999_999, kind: "place", op: "release" });
			await waitUntil(() => pool.workerPids.length === 2, "the waiting reserve worker to start", budget);
			await writeFileEnsuringDir(join(directory, "release"), "");
			await waitUntil(
				() =>
					recycleSendErrors.size >= 1 &&
					controlSendErrors.size >= 1 &&
					retireSendErrors.size >= 1 &&
					[...recycleSendErrors, ...retireSendErrors].every((pid) => exits.some((exit) => exit.pid === pid)),
				"both the recycled worker and the retired worker to exit after late send errors",
				budget,
			);
			for (const pid of [...recycleSendErrors, ...controlSendErrors, ...retireSendErrors]) {
				const exit = exits.find((candidate) => candidate.pid === pid);
				assert.equal(
					exit?.code,
					0,
					`worker ${pid} did not exit cleanly (code=${exit?.code ?? "null"}, signal=${exit?.signal ?? "none"})`,
				);
				assert.equal(exit?.signal, null, `worker ${pid} was killed by signal ${exit?.signal}`);
			}
			await writeFileEnsuringDir(donePath, "");
			const result = await running;
			assert.equal(result.status, "completed", JSON.stringify(result));
			await pool.close();
		} finally {
			vi.restoreAllMocks();
			await pool.close().catch(() => {});
			await backend.close();
			await journal.close();
			await database.close();
			removeTempDirectory(directory);
		}
	},
	BUDGET.timeoutMs,
);
