/**
 * The worker side of #4313 against a real worker process, its coordinator played by the test: what a finished
 * attempt's heartbeats do while its stages close, what a refused heartbeat does to its attempt, what an idle worker
 * does with pushed control, and that a pushed pause holds a running attempt's tools.
 */
import assert from "node:assert/strict";
import { type ChildProcess, fork } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import type { PoolControl, PoolWork } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { serializeError } from "../../packages/workflows/src/shared/error-codec.js";
import { StaleWorkLeaseError } from "../../packages/workflows/src/shared/worker-pool-errors.js";
import { definitionDigest } from "../../packages/workflows/src/workers/definitions.js";
import { IDLE_CLAIM_FALLBACK_MS } from "../../packages/workflows/src/workers/pool-wake-ups.js";
import type { WorkerReply, WorkerRequest } from "../../packages/workflows/src/workers/protocol.js";
import { fileExists, makeTempDirectory, sleep, writeTextSync } from "../helpers/runtime.js";
import {
	type FixtureResource,
	runThenTearDown,
	tearDownWorkerFixture,
	type WorkerFixture,
	workerClosed,
} from "../helpers/worker-fixture-teardown.js";

/** The coordinator's refusal of an attempt it fenced: the worker ends the attempt by the refusal's type. */
const FENCED = new StaleWorkLeaseError({ root: "root", workId: "work", generation: 1, reason: "fenced" });

/** Structural cost: a real worker process loading the packaged worker and running one child. */
const REAL_WORKER_TEST_TIMEOUT_MS = 60_000;
const OBSERVATION_TIMEOUT_MS = 15_000;
/** Longer than the worker's one-second activity interval, to see that nothing more is published. */
const QUIET_WINDOW_MS = 2_500;
const CLOSING_HEARTBEAT_WARNING = "a heartbeat failed while an attempt's stage sessions closed";
/** How long the coordinator takes to answer the heartbeat sent as the stages close: longer than an activity tick. */
const CLOSING_ANSWER_DELAY_MS = 1_500;

type Answer = Omit<WorkerReply, "id"> | undefined;

interface WorkerScenario {
	readonly child: "pool-heartbeat-child" | "pool-ticking-child";
	readonly heartbeatMs: number;
	/** Whether the child may finish as soon as it starts. */
	readonly released?: boolean;
	/** Every claim finds no work, and its answer waits out this long idle pause, as the coordinator's does (#5230). */
	readonly idlePauseMs?: number;
	/** The test's answer to a request, now or later; undefined answers as a plain coordinator would. */
	readonly answer?: (request: WorkerRequest, requests: readonly WorkerRequest[]) => Answer | Promise<Answer>;
}

interface OpenedFixture {
	worker?: WorkerFixture["worker"];
	readonly resources: FixtureResource[];
}

/**
 * Runs `body` against a real worker, then stops the worker and waits for it to close, closes what the test opened in
 * its own process, and removes the fixture's directory, also when the setup or `body` failed (#4506).
 */
async function withRealWorker(
	scenario: WorkerScenario,
	body: (f: Awaited<ReturnType<typeof realWorker>>) => Promise<void>,
): Promise<void> {
	const workerEntry = fileURLToPath(
		new URL("../../packages/coding-agent/dist/builtin/workflows/src/local-worker-entry.mjs", import.meta.url),
	);
	assert.ok(await fileExists(workerEntry), "packaged worker missing; run npm run build first");
	const directory = makeTempDirectory("local-worker-control-");
	const opened: OpenedFixture = { resources: [] };
	await runThenTearDown(
		async () => body(await realWorker(scenario, workerEntry, directory, opened)),
		() => tearDownWorkerFixture({ ...opened, directory }),
	);
}

async function realWorker(scenario: WorkerScenario, workerEntry: string, directory: string, opened: OpenedFixture) {
	const path = join(directory, "journal.sqlite");
	const releasePath = join(directory, "release");
	if (scenario.released === true) writeTextSync(releasePath, "");
	const database = await openNodeSqliteDatabase(path);
	opened.resources.unshift({ name: "database", close: () => database.close() });
	const journal = await SqlRunJournal.open(database);
	opened.resources.unshift({ name: "journal", close: () => journal.close() });
	const backend = await JournalDurableBackend.open(journal, { ownsJournal: false });
	opened.resources.unshift({ name: "backend", close: () => backend.close() });
	await backend.commitWorkflowRegistration({
		workflowId: "root",
		name: "root",
		inputs: {},
		createdAt: 0,
		status: "running",
	});
	const definitionPath = fileURLToPath(new URL(`../fixtures/${scenario.child}.ts`, import.meta.url));
	const digest = await definitionDigest(definitionPath);
	const work: PoolWork = {
		id: "work-1",
		state: "leased",
		generation: 1,
		worker: "worker-1",
		epoch: 1,
		expiresAt: Date.now() + 60_000,
		renewedAt: Date.now(),
		boundaryId: "boundary",
		childRunId: "child",
		scope: "workflow:boundary:0",
		definition: `${definitionPath}#child`,
		digest,
		inputs: scenario.child === "pool-ticking-child" ? { releasePath } : { releasePath, tools: 1 },
		execution: { cwd: directory, parentRun: { runId: "root", stageId: "boundary", rootRunId: "root" } },
	};
	const requests: WorkerRequest[] = [];
	let control: PoolControl = { state: "running", revision: 0 };
	let claimed = false;
	const worker: ChildProcess = fork(
		workerEntry,
		[
			JSON.stringify({
				journalPath: path,
				heartbeatMs: scenario.heartbeatMs,
				root: "root",
				definitions: [{ path: definitionPath, exportName: "child", digest }],
			}),
		],
		{ stdio: ["ignore", "ignore", "pipe", "ipc"], execArgv: [] },
	);
	opened.worker = { process: worker, closed: workerClosed(worker) };
	let stderr = "";
	worker.stderr?.on("data", (chunk) => {
		stderr += String(chunk);
	});
	const exited = once(worker, "exit") as Promise<[number | null, NodeJS.Signals | null]>;
	worker.on("message", (message: WorkerRequest) => {
		requests.push(message);
		if (message.id === 0) return;
		const answered =
			scenario.idlePauseMs !== undefined && message.kind === "claim"
				? sleep(scenario.idlePauseMs).then((): Answer => ({}))
				: Promise.resolve(scenario.answer?.(message, requests));
		void answered.then((answer) => {
			if (!worker.connected) return;
			worker.send(
				answer === undefined ? { id: message.id, value: plainAnswer(message) } : { id: message.id, ...answer },
			);
		});
	});
	const plainAnswer = (message: WorkerRequest): unknown => {
		if (message.kind === "control" || message.kind === "budget" || message.kind === "heartbeat") return control;
		if (message.kind === "commit") return { seq: 1, at: Date.now() };
		if (message.kind !== "claim" || claimed) return undefined;
		claimed = true;
		return work;
	};
	const count = (kind: string) => requests.filter((request) => request.kind === kind).length;
	return {
		requests,
		count,
		exited,
		/** Hides the root's journal events, so any catch-up the worker makes fails it. */
		alive: () => worker.exitCode === null && worker.signalCode === null,
		hideEvents: () => database.exec("ALTER TABLE wf_events RENAME TO wf_events_hidden"),
		stderr: () => stderr,
		release: () => writeTextSync(releasePath, ""),
		send: (message: unknown) => worker.send(message as Parameters<ChildProcess["send"]>[0]),
		push(next: PoolControl) {
			control = next;
			worker.send({ kind: "pool-control", control: next });
		},
		/** Commits `next` without pushing it: the push was lost. */
		commitUnpushed(next: PoolControl) {
			control = next;
		},
		/** The next claim is given the child again. */
		requeue() {
			claimed = false;
		},
		acknowledged: () => requests.flatMap((request) => (request.kind === "controlled" ? [request.revision] : [])),
		async until(condition: () => boolean, what: string) {
			const deadline = Date.now() + OBSERVATION_TIMEOUT_MS;
			while (!condition() && Date.now() < deadline) await sleep(20);
			assert.ok(condition(), `${what} (requests: ${requests.map((request) => request.kind).join(", ")}): ${stderr}`);
		},
	};
}

test(
	"a finished attempt renews its lease as its stages close, then publishes nothing more (#4313)",
	async () => {
		await withRealWorker(
			{
				child: "pool-heartbeat-child",
				heartbeatMs: 600_000,
				released: true,
				// The heartbeat sent while the stages close (after the one that confirms the claim and the final one) is
				// refused: the attempt still completes, and says so once.
				answer: async (request, requests) => {
					if (request.kind !== "heartbeat" || requests.filter((sent) => sent.kind === "heartbeat").length !== 3)
						return undefined;
					await sleep(CLOSING_ANSWER_DELAY_MS);
					return { error: serializeError(new Error("journal unavailable")) };
				},
			},
			async (f) => {
				await f.until(() => f.count("complete") > 0, "the child completes");
				assert.equal(
					f.count("heartbeat"),
					3,
					"the heartbeat that confirms the claim (#5034), the final heartbeat, then one at once as the stages close",
				);
				const closing = f.requests.findIndex(
					(request, index) =>
						request.kind === "heartbeat" &&
						f.requests.slice(0, index).filter((sent) => sent.kind === "heartbeat").length === 2,
				);
				assert.deepEqual(
					f.requests.slice(closing).filter((request) => request.kind === "activity"),
					[],
					"nothing is published after the run ends, while its stages close",
				);
				assert.ok(f.stderr().includes(CLOSING_HEARTBEAT_WARNING), f.stderr());
				const published = f.count("activity");
				await sleep(QUIET_WINDOW_MS);
				assert.equal(f.count("activity"), published, "an ended attempt publishes no more activity");
			},
		);
	},
	REAL_WORKER_TEST_TIMEOUT_MS,
);

test(
	"an idle worker holds its claims while paused, and fails on a control it cannot acknowledge (#4313)",
	async () => {
		let refuseAcknowledgement = false;
		await withRealWorker(
			{
				child: "pool-heartbeat-child",
				heartbeatMs: 600_000,
				released: true,
				answer: (request) =>
					request.kind === "controlled" && refuseAcknowledgement
						? { error: serializeError(new Error("acknowledgement refused")) }
						: undefined,
			},
			async (f) => {
				await f.until(() => f.count("complete") > 0, "the child completes");
				f.push({ state: "paused", revision: 1 });
				await f.until(() => f.acknowledged().includes(1), "the idle worker acknowledges the pause");
				const claims = f.count("claim");
				await sleep(QUIET_WINDOW_MS);
				assert.ok(
					f.count("claim") <= claims + Math.ceil(QUIET_WINDOW_MS / IDLE_CLAIM_FALLBACK_MS),
					"a paused worker asks for work only once per idle bound, so the pool can still retire it (#5230)",
				);
				f.push({ state: "running", revision: 2 });
				await f.until(
					() => f.acknowledged().includes(2) && f.count("claim") > claims,
					"it claims again once resumed",
				);
				refuseAcknowledgement = true;
				f.push({ state: "paused", revision: 3 });
				const [code] = await f.exited;
				assert.notEqual(code, 0, "a control the worker could not acknowledge ends it, and the pool replaces it");
				assert.ok(f.stderr().includes("acknowledgement refused"), `it ends on that refusal: ${f.stderr()}`);
			},
		);
	},
	REAL_WORKER_TEST_TIMEOUT_MS,
);

/** How long a control pushed to an idle worker may take to be acknowledged, while its claim waits in its coordinator. */
const IDLE_CONTROL_BOUND_MS = 500;

test(
	"an idle worker only asks for work: it reads neither pool control nor the root's journal between claims (#5230)",
	async () => {
		await withRealWorker({ child: "pool-heartbeat-child", heartbeatMs: 600_000, idlePauseMs: 50 }, async (f) => {
			await f.until(() => f.count("claim") > 0, "the worker asks for work");
			await f.hideEvents();
			const claims = f.count("claim");
			await f.until(() => f.count("claim") >= claims + 10, "it keeps asking");
			assert.equal(f.count("control"), 0, "no control read");
			assert.ok(f.alive(), `no catch-up failed it: ${f.stderr()}`);
			assert.deepEqual(new Set(f.requests.map((request) => request.kind)), new Set(["ready", "claim"]));
		});
	},
	REAL_WORKER_TEST_TIMEOUT_MS,
);

test(
	"a pause and a stop pushed to an idle worker whose claim waits out its pause are acknowledged within the bound (#5230)",
	async () => {
		await withRealWorker(
			{ child: "pool-heartbeat-child", heartbeatMs: 600_000, idlePauseMs: IDLE_CLAIM_FALLBACK_MS },
			async (f) => {
				await f.until(() => f.count("claim") > 0, "the worker asks for work");
				for (const [revision, state] of [
					[1, "paused"],
					[2, "quit"],
				] as const) {
					const pushedAt = performance.now();
					f.push({ state, revision });
					await f.until(() => f.acknowledged().includes(revision), `the idle worker acknowledges ${state}`);
					const elapsed = performance.now() - pushedAt;
					assert.ok(elapsed < IDLE_CONTROL_BOUND_MS, `${state} acknowledged after ${elapsed} ms`);
				}
				const claims = f.count("claim");
				await sleep(QUIET_WINDOW_MS);
				assert.ok(
					f.count("claim") <= claims + 1,
					"a stopped worker asks for no more work than its claim in flight",
				);
			},
		);
	},
	REAL_WORKER_TEST_TIMEOUT_MS,
);

test(
	"a paused idle worker that missed the resume push reads control again and claims within the idle bound (#5230)",
	async () => {
		await withRealWorker({ child: "pool-heartbeat-child", heartbeatMs: 600_000, released: true }, async (f) => {
			await f.until(() => f.count("complete") > 0, "the child completes");
			f.push({ state: "paused", revision: 1 });
			await f.until(() => f.acknowledged().includes(1), "the idle worker acknowledges the pause");
			const resumedAt = performance.now();
			f.commitUnpushed({ state: "running", revision: 2 });
			f.requeue();
			await f.until(() => f.acknowledged().includes(2), "it reads the resume it was never pushed");
			const readAfter = performance.now() - resumedAt;
			assert.ok(
				readAfter < IDLE_CLAIM_FALLBACK_MS + IDLE_CONTROL_BOUND_MS,
				`read the resume after ${readAfter} ms, at most one idle bound late`,
			);
			await f.until(() => f.count("complete") > 1, "and runs the child queued meanwhile");
		});
	},
	REAL_WORKER_TEST_TIMEOUT_MS,
);

test(
	"a paused idle worker of the root's host is still retired by the pool within the idle bound (#5230)",
	async () => {
		let paused = false;
		await withRealWorker(
			{
				child: "pool-heartbeat-child",
				heartbeatMs: 600_000,
				released: true,
				answer: (request) => (request.kind === "claim" && paused ? { retire: true } : undefined),
			},
			async (f) => {
				await f.until(() => f.count("complete") > 0, "the child completes");
				f.push({ state: "paused", revision: 1 });
				await f.until(() => f.acknowledged().includes(1), "the idle worker acknowledges the pause");
				paused = true;
				const pausedAt = performance.now();
				const [code] = await f.exited;
				const retiredAfter = performance.now() - pausedAt;
				assert.equal(code, 0, `a retired worker ends cleanly: ${f.stderr()}`);
				assert.ok(
					retiredAfter < IDLE_CLAIM_FALLBACK_MS + IDLE_CONTROL_BOUND_MS,
					`retired after ${retiredAfter} ms`,
				);
			},
		);
	},
	REAL_WORKER_TEST_TIMEOUT_MS,
);

test(
	"a heartbeat the coordinator refuses ends the attempt it renews (#4313)",
	async () => {
		await withRealWorker(
			{
				child: "pool-ticking-child",
				heartbeatMs: 200,
				answer: (request, requests) =>
					request.kind === "heartbeat" && requests.filter((sent) => sent.kind === "heartbeat").length === 1
						? { error: serializeError(new Error("journal unavailable")) }
						: undefined,
			},
			async (f) => {
				await f.until(() => f.count("complete") > 0, "the attempt ends without its child being released");
			},
		);
	},
	REAL_WORKER_TEST_TIMEOUT_MS,
);

test(
	"a fenced attempt's refused heartbeats end it quietly, as fenced (#4313)",
	async () => {
		await withRealWorker(
			{
				child: "pool-ticking-child",
				heartbeatMs: 200,
				answer: (request) => (request.kind === "heartbeat" ? { error: serializeError(FENCED) } : undefined),
			},
			async (f) => {
				await f.until(() => f.count("fenced") > 0, "the worker reports the attempt fenced");
				assert.ok(f.count("heartbeat") >= 2, "its stages closed under a heartbeat too");
				assert.equal(f.count("complete"), 0);
				assert.ok(!f.stderr().includes(CLOSING_HEARTBEAT_WARNING), "a fenced attempt's refusals are expected");
				const published = f.count("activity");
				await sleep(QUIET_WINDOW_MS);
				assert.equal(f.count("activity"), published, "a fenced attempt publishes no more activity");
			},
		);
	},
	REAL_WORKER_TEST_TIMEOUT_MS,
);

test(
	"a pushed pause holds a running attempt's tools until a pushed resume, and stage commands are still served (#4313)",
	async () => {
		await withRealWorker({ child: "pool-ticking-child", heartbeatMs: 600_000 }, async (f) => {
			await f.until(() => f.count("commit") >= 3, "the child runs its tools");
			f.send({
				kind: "stage-command",
				commandId: 7,
				attempt: { workId: "work-1", generation: 1 },
				op: "question",
				runId: "child",
				stageId: "missing",
			});
			await f.until(
				() => f.requests.some((request) => request.kind === "stage-command-result" && request.commandId === 7),
				"a stage command is still served beside pushed control",
			);
			f.push({ state: "paused", revision: 1 });
			await f.until(() => f.acknowledged().includes(1), "the pause is acknowledged");
			const commits = f.count("commit");
			await sleep(QUIET_WINDOW_MS);
			assert.ok(f.count("commit") <= commits + 1, "no tool starts while paused; one already running may finish");
			const activity = f.count("activity");
			await f.until(() => f.count("activity") >= activity + 2, "a paused attempt still republishes its activity");
			f.push({ state: "running", revision: 2 });
			await f.until(() => f.count("commit") > commits + 3, "the resumed child runs its tools again");
			f.release();
			await f.until(() => f.count("complete") > 0, "the child completes");
		});
	},
	REAL_WORKER_TEST_TIMEOUT_MS,
);

test(
	"a control the worker cannot acknowledge ends the attempt it was pushed to (#4313)",
	async () => {
		await withRealWorker(
			{
				child: "pool-ticking-child",
				heartbeatMs: 600_000,
				answer: (request) =>
					request.kind === "controlled" && request.revision === 1
						? { error: serializeError(new Error("acknowledgement refused")) }
						: undefined,
			},
			async (f) => {
				await f.until(() => f.count("commit") >= 2, "the child runs its tools");
				f.push({ state: "paused", revision: 1 });
				await f.until(() => f.count("complete") > 0, "the attempt ends without its child being released");
			},
		);
	},
	REAL_WORKER_TEST_TIMEOUT_MS,
);

test(
	"an attempt fenced before its run starts publishes nothing afterwards (#4313)",
	async () => {
		let attemptStarts = 0;
		await withRealWorker(
			{
				child: "pool-heartbeat-child",
				heartbeatMs: 600_000,
				answer: (request, requests) => {
					if (request.kind !== "control" || !requests.some((sent) => sent.kind === "claim")) return undefined;
					attemptStarts++;
					return attemptStarts === 1 ? { error: serializeError(FENCED) } : undefined;
				},
			},
			async (f) => {
				await f.until(() => f.count("fenced") > 0, "the worker reports the attempt fenced");
				const published = f.count("activity");
				await sleep(QUIET_WINDOW_MS);
				assert.equal(f.count("activity"), published, "the fenced attempt publishes no more activity");
			},
		);
	},
	REAL_WORKER_TEST_TIMEOUT_MS,
);
