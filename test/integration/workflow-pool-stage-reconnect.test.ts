/**
 * Per-stage pause, and reconnect with redelivery, for stages on local workers (#3996).
 *
 * Real pools run children whose agent stage streams one delta and then holds mid-turn until
 * the test sets `test_live_stage_gate.released`.
 */
import assert from "node:assert/strict";
import type { ForkOptions } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@bastani/atomic";
import { beforeAll, test, vi } from "vitest";
import { TestSqliteDatabase } from "../../packages/coding-agent/test/helpers/sqlite.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { bindStoreDurableBackend } from "../../packages/workflows/src/durable/store-backend.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { pauseRun, resumeRun } from "../../packages/workflows/src/runs/background/status.js";
import { createStageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { createStore, type Store } from "../../packages/workflows/src/shared/store.js";
import type { StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { definitionDigest, loadWorkerDefinition } from "../../packages/workflows/src/workers/definitions.js";
import { LocalWorkerPool } from "../../packages/workflows/src/workers/local-pool.js";
import { poolSessionStore } from "../../packages/workflows/src/workers/pool-session-store.js";
import type { PooledStageHandle } from "../../packages/workflows/src/workers/pooled-stage-handle.js";
import { acquirePooledStage } from "../../packages/workflows/src/workers/pooled-stage-sources.js";
import type { DeliveryOpId } from "../../packages/workflows/src/workers/stage-watch-types.js";
import { LIVE_STAGE_FIRST_DELTA } from "../fixtures/pool-live-stage-child.js";
import { testRunId } from "../helpers/run-id.js";
import { fileExists, makeTempDirectory, removeTempDirectory, sleep } from "../helpers/runtime.js";
import { untilOrRunEnds } from "../helpers/until-run.js";

/** Structural: a coordinator process, worker processes, real agent stages, and a worker replacement. */
const LOCAL_WORKER_PROCESS_TIMEOUT_MS = 180_000;
const CONDITION_TIMEOUT_MS = 90_000;
/** Short enough that a paused stage would lose its lease within the test if heartbeats stopped. */
const LEASE_MS = 2_000;

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	const { fileURLToPath } = await import("node:url");
	const sourceEntry = fileURLToPath(
		new URL("../../packages/workflows/src/workers/local-worker-entry.mjs", import.meta.url),
	);
	const packagedEntry = fileURLToPath(
		new URL("../../packages/coding-agent/dist/builtin/workflows/src/local-worker-entry.mjs", import.meta.url),
	);
	return {
		...actual,
		fork: (modulePath: string | URL, args: readonly string[], options: ForkOptions) =>
			actual.fork(modulePath === sourceEntry ? packagedEntry : modulePath, args, options),
	};
});

beforeAll(async () => {
	const workerEntry = fileURLToPath(
		new URL("../../packages/coding-agent/dist/builtin/workflows/src/local-worker-entry.mjs", import.meta.url),
	);
	assert.ok(await fileExists(workerEntry), "packaged worker missing; run npm run build first");
});

type Block = { readonly type: string; readonly text?: string };

function textOf(message: object): string {
	const content = "content" in message ? (message.content as string | readonly Block[] | undefined) : undefined;
	return typeof content === "string"
		? content
		: (content ?? []).map((block) => (block.type === "text" ? (block.text ?? "") : "")).join("");
}

function agentStages(store: Store): { readonly runId: string; readonly stage: StageSnapshot }[] {
	return store
		.runs()
		.flatMap((candidate) =>
			candidate.stages
				.filter((stage) => stage.name === "agent" && stage.workerExecution !== undefined)
				.map((stage) => ({ runId: candidate.id, stage })),
		);
}

/**
 * Waits for one step of a test on its own signal. When the step does not happen, the error
 * names the step and what the test could see, instead of a bare test timeout.
 */
async function step<T>(
	label: string,
	signal: Promise<T>,
	execution: Promise<{ readonly status: string; readonly error?: string }>,
	observe: () => string,
): Promise<T> {
	const stalled = AbortSignal.timeout(CONDITION_TIMEOUT_MS);
	const gaveUp = new Promise<never>((_resolve, reject) =>
		stalled.addEventListener("abort", () => reject(new Error(`stalled at "${label}": ${observe()}`)), {
			once: true,
		}),
	);
	const ended = execution.then((outcome): never => {
		throw new Error(
			`the run ended (${outcome.status}${outcome.error ? `: ${outcome.error}` : ""}) at "${label}": ${observe()}`,
		);
	});
	gaveUp.catch(() => {});
	ended.catch(() => {});
	return await Promise.race([signal, gaveUp, ended]);
}

function setGate(path: string, released: 0 | 1): void {
	const database = new TestSqliteDatabase(path);
	try {
		database.run(`UPDATE test_live_stage_gate SET released = ${released}`);
	} finally {
		database.close();
	}
}

async function livePool(prefix: string, workers: number, children: number) {
	const directory = makeTempDirectory(prefix);
	const path = join(directory, "journal.sqlite");
	const backend = await JournalDurableBackend.open(await resolveRunJournal({ journal: { path } }));
	const gate = new TestSqliteDatabase(path);
	gate.run("CREATE TABLE test_live_stage_gate(released INTEGER); INSERT INTO test_live_stage_gate VALUES (0)");
	gate.close();
	const childPath = fileURLToPath(new URL("../fixtures/pool-live-stage-child.ts", import.meta.url));
	const child = await loadWorkerDefinition({
		path: childPath,
		exportName: "child",
		digest: await definitionDigest(childPath),
	});
	const pool = new LocalWorkerPool(backend, {
		journalPath: path,
		workers,
		leaseMs: LEASE_MS,
		definitions: [{ definition: child, path: childPath, exportName: "child" }],
	});
	const store = createStore();
	bindStoreDurableBackend(store, backend);
	const controller = new AbortController();
	const execution = run(
		workflow({
			name: `${prefix}root`,
			description: "",
			inputs: {},
			outputs: {},
			async run(ctx) {
				await Promise.all(
					Array.from({ length: children }, () => ctx.workflow(child, { inputs: { journalPath: path } })),
				);
				return {};
			},
		}),
		{},
		{ runId: testRunId(prefix), cwd: directory, store, durableBackend: backend, signal: controller.signal },
	);
	/** Waits until every child's stage streams its held turn, through a live view of each. */
	const held = async (): Promise<void> => {
		await untilOrRunEnds(
			async () => {
				const stages = agentStages(store);
				if (stages.length < children) return false;
				for (const { runId, stage } of stages) {
					const lease = await acquirePooledStage(store, runId, stage.id);
					if (lease === undefined) return false;
					const streamed = textOf(lease.handle.streamingMessage?.() ?? {});
					lease.release();
					if (streamed !== LIVE_STAGE_FIRST_DELTA) return false;
				}
				return true;
			},
			execution,
			CONDITION_TIMEOUT_MS,
		);
	};
	const close = async () => {
		setGate(path, 1);
		// A test that failed part-way leaves the run waiting; aborting it bounds the cleanup.
		controller.abort(new Error("test cleanup"));
		await execution.catch(() => {});
		await pool.close();
		await backend.close();
		removeTempDirectory(directory);
	};
	return { path, backend, pool, store, execution, held, close };
}

test.skipIf(process.platform === "win32")(
	"pausing one pooled stage holds its turn while a sibling on another worker finishes, without losing its lease (#3996)",
	async () => {
		const live = await livePool("pool-stage-pause-", 2, 2);
		try {
			await live.held();
			const [paused, sibling] = agentStages(live.store);
			assert.ok(paused !== undefined && sibling !== undefined);
			const registry = createStageControlRegistry();
			const pausedResult = await pauseRun(paused.runId, {
				store: live.store,
				stageControlRegistry: registry,
				stageId: paused.stage.id,
			});
			assert.equal(pausedResult.ok, true, JSON.stringify(pausedResult));
			const stageOf = (runId: string) => agentStages(live.store).find((entry) => entry.runId === runId)?.stage;
			await untilOrRunEnds(
				async () => stageOf(paused.runId)?.status === "paused",
				live.execution,
				CONDITION_TIMEOUT_MS,
			);
			const pausedLease = stageOf(paused.runId)!.workerExecution!;

			// The paused stage's worker keeps renewing its lease past the expiry it had when it paused.
			await untilOrRunEnds(
				async () => (stageOf(paused.runId)?.workerExecution?.renewedAt ?? 0) > pausedLease.expiresAt,
				live.execution,
				CONDITION_TIMEOUT_MS,
			);
			assert.equal(stageOf(paused.runId)?.workerExecution?.generation, pausedLease.generation);
			assert.equal(stageOf(paused.runId)?.status, "paused");

			setGate(live.path, 1);
			await untilOrRunEnds(
				async () => stageOf(sibling.runId)?.status === "completed",
				live.execution,
				CONDITION_TIMEOUT_MS,
			);
			assert.equal(stageOf(paused.runId)?.status, "paused", "the paused stage holds while its sibling finishes");

			const resumed = await resumeRun(paused.runId, {
				store: live.store,
				stageControlRegistry: registry,
				stageId: paused.stage.id,
			});
			assert.equal(resumed.ok, true, JSON.stringify(resumed));
			const outcome = await live.execution;
			assert.equal(outcome.status, "completed", JSON.stringify(outcome));
			assert.equal(stageOf(paused.runId)?.workerExecution?.generation, pausedLease.generation, "never fenced");
		} finally {
			await live.close();
		}
	},
	LOCAL_WORKER_PROCESS_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"after its worker is killed, a watched stage reconnects, redelivers its queued messages once each, and refuses the old attempt (#3996)",
	async () => {
		const live = await livePool("pool-stage-reconnect-", 1, 1);
		try {
			await live.held();
			const [target] = agentStages(live.store);
			assert.ok(target !== undefined);
			const lease = await acquirePooledStage(live.store, target.runId, target.stage.id);
			assert.ok(lease !== undefined);
			const handle = lease.handle as PooledStageHandle;
			const observe = () =>
				JSON.stringify({
					placement: handle.placement,
					streaming: handle.isStreaming,
					workers: live.pool.workerPids.length,
					stage: agentStages(live.store).map(({ stage }) => ({
						status: stage.status,
						generation: stage.workerExecution?.generation,
					})),
				});
			const reconnected = Promise.withResolvers<number>();
			lease.onReconnected?.((count) => reconnected.resolve(count));
			assert.equal(
				await step(
					"steer while held",
					handle.sendUserMessage("steer-from-root", { deliverAs: "steer" }),
					live.execution,
					observe,
				),
				"steer",
			);
			assert.equal(
				await step(
					"follow-up while held",
					handle.sendUserMessage("follow-up-from-root", { deliverAs: "followUp" }),
					live.execution,
					observe,
				),
				"followUp",
			);
			const oldWatch = handle.watch;
			const firstGeneration = handle.placement.generation;

			const [worker] = live.pool.workerPids;
			assert.ok(worker !== undefined);
			process.kill(worker, "SIGKILL");
			const redelivered = await step(
				"reconnect and redelivery after the kill",
				reconnected.promise,
				live.execution,
				observe,
			);
			assert.equal(redelivered, 2, "both queued messages were lost with the worker and sent again");
			// Each came back in its original mode, mid-turn: the steer joins the held turn, the follow-up waits.
			const modes = () => {
				const queued = handle.queuedUserMessages();
				return queued.steering.includes("steer-from-root") && queued.followUp.includes("follow-up-from-root");
			};
			const preserved = Promise.withResolvers<void>();
			const unsubscribe = handle.subscribe(() => {
				if (modes()) preserved.resolve();
			});
			if (modes()) preserved.resolve();
			await step(
				"redelivered steer queued as a steer, follow-up as a follow-up",
				preserved.promise,
				live.execution,
				() => JSON.stringify({ queued: handle.queuedUserMessages(), streaming: handle.isStreaming }),
			);
			unsubscribe();
			assert.ok(handle.placement.generation > firstGeneration);
			assert.equal(handle.placement.reconnecting, undefined);

			// The old attempt's watch is fenced: nothing reaches the session through it.
			const stale = await step(
				"delivery through the fenced watch",
				live.pool.deliverToPooledStage({
					watch: oldWatch,
					op: "stale-op" as DeliveryOpId,
					text: "stale-from-root",
					intent: "steer",
				}),
				live.execution,
				observe,
			);
			assert.deepEqual(stale, { ok: false, refusal: "StaleAttempt" });
			lease.release();

			setGate(live.path, 1);
			const outcome = await step(
				"run completion after release",
				live.execution,
				new Promise<never>(() => {}),
				observe,
			);
			assert.equal(outcome.status, "completed", JSON.stringify(outcome));
			const finished = agentStages(live.store)[0]!.stage;
			const sessions = await poolSessionStore(live.backend);
			assert.ok(sessions !== undefined);
			const users = (await SessionManager.open(sessions, finished.sessionId!))
				.buildSessionContext()
				.messages.filter((message) => message.role === "user")
				.map(textOf);
			await sessions.close();
			assert.deepEqual(
				users.filter((text) => text.endsWith("-from-root")),
				["steer-from-root", "follow-up-from-root"],
				"each message reached the replacement attempt exactly once, in send order",
			);
		} finally {
			await live.close();
		}
	},
	LOCAL_WORKER_PROCESS_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"text pending when the chat closes and the worker dies reaches the replacement once, and the reopened chat shows it (#3996)",
	async () => {
		const live = await livePool("pool-stage-detached-redelivery-", 1, 1);
		try {
			await live.held();
			const [target] = agentStages(live.store);
			assert.ok(target !== undefined);
			const lease = await acquirePooledStage(live.store, target.runId, target.stage.id);
			assert.ok(lease !== undefined);
			const observe = () =>
				JSON.stringify(
					agentStages(live.store).map(({ stage }) => ({
						status: stage.status,
						generation: stage.workerExecution?.generation,
						queued: stage.queuedUserMessageCount,
					})),
				);
			assert.equal(
				await step(
					"steer",
					lease.handle.sendUserMessage!("detached-steer", { deliverAs: "steer" }),
					live.execution,
					observe,
				),
				"steer",
			);
			assert.equal(
				await step(
					"follow-up",
					lease.handle.sendUserMessage!("detached-follow-up", { deliverAs: "followUp" }),
					live.execution,
					observe,
				),
				"followUp",
			);
			// The chat closes before the worker dies: no chat is open to reconnect.
			lease.release();
			const [worker] = live.pool.workerPids;
			assert.ok(worker !== undefined);
			process.kill(worker, "SIGKILL");

			// The replacement gets both from the stage's outbox, each in its mode, while its turn is held.
			const reopened = await step(
				"reopen on the replacement with the text queued again",
				(async () => {
					for (;;) {
						const stage = agentStages(live.store)[0]?.stage;
						if ((stage?.workerExecution?.generation ?? 0) > 1) {
							const view = await acquirePooledStage(live.store, target.runId, target.stage.id);
							if (view !== undefined) {
								const queued = view.handle.queuedUserMessages?.();
								if (
									queued?.steering.includes("detached-steer") === true &&
									queued.followUp.includes("detached-follow-up")
								)
									return view;
								view.release();
							}
						}
						await sleep(25);
					}
				})(),
				live.execution,
				observe,
			);
			reopened.release();

			setGate(live.path, 1);
			const outcome = await step(
				"run completion after release",
				live.execution,
				new Promise<never>(() => {}),
				observe,
			);
			assert.equal(outcome.status, "completed", JSON.stringify(outcome));
			const finished = agentStages(live.store)[0]!.stage;
			const sessions = await poolSessionStore(live.backend);
			assert.ok(sessions !== undefined);
			const users = (await SessionManager.open(sessions, finished.sessionId!))
				.buildSessionContext()
				.messages.filter((message) => message.role === "user")
				.map(textOf);
			await sessions.close();
			assert.deepEqual(
				users.filter((text) => text.startsWith("detached-")),
				["detached-steer", "detached-follow-up"],
				"each reached the replacement exactly once, in send order",
			);
		} finally {
			await live.close();
		}
	},
	LOCAL_WORKER_PROCESS_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"a run that fails while its watched stage reconnects ends the reconnect and reports the undelivered text (#3996)",
	async () => {
		const live = await livePool("pool-stage-reconnect-failed-", 1, 1);
		try {
			await live.held();
			const [target] = agentStages(live.store);
			assert.ok(target !== undefined);
			const lease = await acquirePooledStage(live.store, target.runId, target.stage.id);
			assert.ok(lease !== undefined);
			const handle = lease.handle as PooledStageHandle;
			const observe = () =>
				JSON.stringify({
					placement: handle.placement,
					ended: handle.endReason,
					generation: agentStages(live.store)[0]?.stage.workerExecution?.generation,
				});
			await step("steer", handle.steer("never-arrives"), live.execution, observe);
			// Kill every attempt the pool starts until it gives up on the child.
			const failed = (async () => {
				for (let killed = 0; ; ) {
					const generation = agentStages(live.store)[0]?.stage.workerExecution?.generation ?? 0;
					const [worker] = live.pool.workerPids;
					if (generation > killed && worker !== undefined) {
						process.kill(worker, "SIGKILL");
						killed = generation;
					}
					await sleep(25);
				}
			})();
			failed.catch(() => {});
			const outcome = await step("run failure", live.execution, new Promise<never>(() => {}), observe);
			assert.equal(outcome.status, "failed", JSON.stringify(outcome));
			await step(
				"the view ends",
				(async () => {
					while (handle.endReason === undefined) await sleep(25);
				})(),
				new Promise<never>(() => {}),
				observe,
			);
			assert.equal(handle.isReconnecting, false);
			assert.equal(handle.placement.reconnecting, undefined);
			assert.ok((handle.placement.undelivered ?? 0) >= 1, observe());
			lease.release();
		} finally {
			await live.close();
		}
	},
	LOCAL_WORKER_PROCESS_TIMEOUT_MS,
);
