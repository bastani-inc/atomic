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
import { definitionDigest } from "../../packages/workflows/src/workers/definitions.js";
import type { WorkerRequest } from "../../packages/workflows/src/workers/protocol.js";
import { fileExists, makeTempDirectory, removeTempDirectory, sleep, writeTextSync } from "../helpers/runtime.js";

const HEARTBEATS_WHILE_ACTIVITY_IS_HELD = 3;
/** The worker's heartbeat interval in this test: short, so several heartbeats fit while activity is held. */
const TEST_HEARTBEAT_MS = 250;
const HEARTBEAT_OBSERVATION_TIMEOUT_MS = 12_000;
const RELEASE_OBSERVATION_TIMEOUT_MS = 10_000;
const LOCAL_WORKER_HEARTBEAT_TEST_TIMEOUT_MS = 60_000;
const TOOL_CALLS_WHILE_ACTIVITY_IS_HELD = 40;
const COALESCED_CATCHUP_ACTIVITY_REQUESTS = 1;

test(
	"a held activity acknowledgement does not stop coalesced heartbeats and coalesces later activity (#3869, #4313, #4537)",
	async () => {
		// Exercise the shipped worker, not a cold jiti transpilation of the entire source graph.
		const workerEntry = fileURLToPath(
			new URL("../../packages/coding-agent/dist/builtin/workflows/src/local-worker-entry.mjs", import.meta.url),
		);
		assert.ok(await fileExists(workerEntry), "packaged worker missing; run npm run build first");
		const directory = makeTempDirectory("local-worker-heartbeat-");
		const path = join(directory, "journal.sqlite");
		const releasePath = join(directory, "release");
		const database = await openNodeSqliteDatabase(path);
		const journal = await SqlRunJournal.open(database);
		const backend = await JournalDurableBackend.open(journal, { ownsJournal: false });
		const definitionPath = fileURLToPath(new URL("../fixtures/pool-heartbeat-child.ts", import.meta.url));
		let worker: ChildProcess | undefined;
		try {
			await backend.commitWorkflowRegistration({
				workflowId: "root",
				name: "root",
				inputs: {},
				createdAt: 0,
				status: "running",
			});
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
				inputs: { releasePath, tools: TOOL_CALLS_WHILE_ACTIVITY_IS_HELD },
				execution: { cwd: directory, parentRun: { runId: "root", stageId: "boundary", rootRunId: "root" } },
			};
			const requests: WorkerRequest[] = [];
			const held: number[] = [];
			let claimed = false;
			let released = false;
			let activityDrained = false;
			worker = fork(
				workerEntry,
				[
					JSON.stringify({
						journalPath: path,
						heartbeatMs: TEST_HEARTBEAT_MS,
						root: "root",
						definitions: [{ path: definitionPath, exportName: "child", digest }],
					}),
				],
				{
					stdio: ["ignore", "ignore", "pipe", "ipc"],
					execArgv: [
						"--import",
						new URL("../fixtures/pool-heartbeat-publication-probe.mjs", import.meta.url).href,
					],
				},
			);
			let stderr = "";
			worker.stderr?.on("data", (chunk) => {
				stderr += String(chunk);
			});
			const reply = (id: number, value?: unknown) => worker?.connected && worker.send({ id, value });
			worker.on("message", (message: WorkerRequest | { kind: "activity-drained" }) => {
				if (message.kind === "activity-drained") {
					activityDrained = true;
					return;
				}
				requests.push(message);
				if (message.kind === "activity" && !released) {
					held.push(message.id);
					return;
				}
				if (message.kind === "control" || message.kind === "budget" || message.kind === "heartbeat")
					return reply(message.id, { state: "running", revision: 0 });
				if (message.kind === "claim") {
					if (claimed) return reply(message.id, undefined);
					claimed = true;
					return reply(message.id, work);
				}
				if (message.kind === "commit") return reply(message.id, { seq: 1, at: Date.now() });
				reply(message.id, undefined);
			});
			const count = (kind: WorkerRequest["kind"]) => requests.filter((request) => request.kind === kind).length;
			const until = async (condition: () => boolean, timeoutMs: number) => {
				const deadline = Date.now() + timeoutMs;
				while (!condition() && Date.now() < deadline) await sleep(20);
			};
			await until(
				() => count("commit") >= TOOL_CALLS_WHILE_ACTIVITY_IS_HELD && held.length > 0,
				HEARTBEAT_OBSERVATION_TIMEOUT_MS,
			);
			assert.ok(
				held.length > 0,
				`the worker published no activity (requests: ${requests.map((request) => request.kind).join(", ")}; exit: ${worker.exitCode}): ${stderr}`,
			);
			assert.ok(count("commit") >= TOOL_CALLS_WHILE_ACTIVITY_IS_HELD, "tool calls continue while activity is held");
			const heartbeatsBefore = count("heartbeat");
			const controlsBefore = count("control");
			await until(
				() => count("heartbeat") - heartbeatsBefore >= HEARTBEATS_WHILE_ACTIVITY_IS_HELD,
				HEARTBEAT_OBSERVATION_TIMEOUT_MS,
			);
			assert.ok(
				count("heartbeat") - heartbeatsBefore >= HEARTBEATS_WHILE_ACTIVITY_IS_HELD,
				`only ${count("heartbeat") - heartbeatsBefore} heartbeats while activity was held`,
			);
			// The heartbeat carries the lease renewal, the usage report and the control read: none goes separately.
			assert.equal(count("control"), controlsBefore, "heartbeats read pool control without separate control polls");
			assert.deepEqual(
				requests.filter((request) => (request.kind as string) === "renew" || (request.kind as string) === "usage"),
				[],
			);
			assert.ok(
				requests.every((request) => request.kind !== "heartbeat" || Array.isArray(request.reports)),
				"each heartbeat carries the attempt's usage reports",
			);
			assert.equal(held.length, 1, "repeated invalidations leave one unacknowledged activity request");
			const activityBeforeRelease = count("activity");
			// Acknowledge the entire queue, but keep the fixture blocked: recordRunEnd/finishRun cannot invalidate
			// the store yet. The preload gates the independent activity timer and observes the child IPC drain.
			// With every tool already recorded, the dirty boolean must yield exactly one catch-up, not a serial queue.
			activityDrained = false;
			released = true;
			for (const id of held.splice(0)) reply(id);
			await until(() => activityDrained, RELEASE_OBSERVATION_TIMEOUT_MS);
			assert.ok(activityDrained, "the worker drains every catch-up acknowledgement before the fixture finishes");
			assert.equal(
				count("activity") - activityBeforeRelease,
				COALESCED_CATCHUP_ACTIVITY_REQUESTS,
				"the entire held batch produces exactly one catch-up activity request",
			);
			const catchupActivity = requests.filter((request) => request.kind === "activity").at(-1);
			assert.equal(
				catchupActivity?.kind === "activity"
					? catchupActivity.runs.find((run) => run.id === "child")?.toolNodes.length
					: undefined,
				TOOL_CALLS_WHILE_ACTIVITY_IS_HELD,
				"the coalesced snapshot carries every held tool call before the fixture finishes",
			);
			writeTextSync(releasePath, "");
			await until(() => count("complete") > 0, RELEASE_OBSERVATION_TIMEOUT_MS);
			assert.ok(count("complete") > 0, "the worker completes its attempt once the held activity is acknowledged");
			const finalActivity = requests.filter((request) => request.kind === "activity").at(-1);
			assert.equal(
				finalActivity?.kind === "activity"
					? finalActivity.runs.find((run) => run.id === "child")?.toolNodes.length
					: undefined,
				TOOL_CALLS_WHILE_ACTIVITY_IS_HELD,
				"the last published snapshot carries every tool call",
			);
		} finally {
			if (worker !== undefined && worker.exitCode === null && worker.signalCode === null) {
				const exited = once(worker, "exit");
				worker.kill("SIGKILL");
				await exited;
			}
			await backend.close();
			await journal.close();
			await database.close();
			removeTempDirectory(directory);
		}
	},
	LOCAL_WORKER_HEARTBEAT_TEST_TIMEOUT_MS,
);

/** Far beyond the test's run time: every control change the worker applies in it came by push, not by heartbeat. */
const PUSH_TEST_HEARTBEAT_MS = 600_000;
const PUSH_OBSERVATION_TIMEOUT_MS = 15_000;

test(
	"pushed pause, resume and quit reach a running attempt without a heartbeat, and a stale revision is ignored (#4313)",
	async () => {
		const workerEntry = fileURLToPath(
			new URL("../../packages/coding-agent/dist/builtin/workflows/src/local-worker-entry.mjs", import.meta.url),
		);
		assert.ok(await fileExists(workerEntry), "packaged worker missing; run npm run build first");
		const directory = makeTempDirectory("local-worker-control-push-");
		const path = join(directory, "journal.sqlite");
		const releasePath = join(directory, "release");
		const database = await openNodeSqliteDatabase(path);
		const journal = await SqlRunJournal.open(database);
		const backend = await JournalDurableBackend.open(journal, { ownsJournal: false });
		const definitionPath = fileURLToPath(new URL("../fixtures/pool-heartbeat-child.ts", import.meta.url));
		let worker: ChildProcess | undefined;
		try {
			await backend.commitWorkflowRegistration({
				workflowId: "root",
				name: "root",
				inputs: {},
				createdAt: 0,
				status: "running",
			});
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
				inputs: { releasePath, tools: 1 },
				execution: { cwd: directory, parentRun: { runId: "root", stageId: "boundary", rootRunId: "root" } },
			};
			const requests: WorkerRequest[] = [];
			let control: PoolControl = { state: "running", revision: 0 };
			let claimed = false;
			worker = fork(
				workerEntry,
				[
					JSON.stringify({
						journalPath: path,
						heartbeatMs: PUSH_TEST_HEARTBEAT_MS,
						root: "root",
						definitions: [{ path: definitionPath, exportName: "child", digest }],
					}),
				],
				{ stdio: ["ignore", "ignore", "pipe", "ipc"], execArgv: [] },
			);
			let stderr = "";
			worker.stderr?.on("data", (chunk) => {
				stderr += String(chunk);
			});
			const reply = (id: number, value?: unknown) => worker?.connected && worker.send({ id, value });
			const push = (next: PoolControl) => worker?.send({ kind: "pool-control", control: next });
			worker.on("message", (message: WorkerRequest) => {
				requests.push(message);
				if (message.kind === "control" || message.kind === "budget" || message.kind === "heartbeat")
					return reply(message.id, control);
				if (message.kind === "claim") {
					if (claimed) return reply(message.id, undefined);
					claimed = true;
					return reply(message.id, work);
				}
				if (message.kind === "commit") return reply(message.id, { seq: 1, at: Date.now() });
				reply(message.id, undefined);
			});
			const acknowledged = () =>
				requests.flatMap((request) => (request.kind === "controlled" ? [request.revision] : []));
			const until = async (condition: () => boolean) => {
				const deadline = Date.now() + PUSH_OBSERVATION_TIMEOUT_MS;
				while (!condition() && Date.now() < deadline) await sleep(20);
				assert.ok(
					condition(),
					`condition not reached (requests: ${requests.map((request) => request.kind).join(", ")}): ${stderr}`,
				);
			};
			await until(() => requests.some((request) => request.kind === "activity"));

			control = { state: "paused", revision: 1 };
			push(control);
			await until(() => acknowledged().includes(1));
			// A reply that predates the pause arrives after it; the worker keeps the newer revision.
			push({ state: "running", revision: 0 });
			control = { state: "running", revision: 2 };
			push(control);
			await until(() => acknowledged().includes(2));
			assert.deepEqual(acknowledged(), [0, 1, 2], "the stale revision 0 was neither applied nor acknowledged again");

			control = { state: "quit", revision: 3 };
			push(control);
			writeTextSync(releasePath, "");
			await until(() => acknowledged().includes(3));
			assert.equal(
				requests.filter((request) => request.kind === "heartbeat").length,
				1,
				"only the attempt's final heartbeat ran: pause, resume and quit arrived by push",
			);
			assert.ok(
				requests.findIndex((request) => request.kind === "heartbeat") <
					requests.findIndex((request) => request.kind === "controlled" && request.revision === 3),
				"a quit attempt records its final usage before it acknowledges the quit",
			);
			assert.equal(
				requests.some((request) => request.kind === "complete"),
				false,
				"a quit attempt stays resumable instead of completing",
			);
		} finally {
			if (worker !== undefined && worker.exitCode === null && worker.signalCode === null) {
				const exited = once(worker, "exit");
				worker.kill("SIGKILL");
				await exited;
			}
			await backend.close();
			await journal.close();
			await database.close();
			removeTempDirectory(directory);
		}
	},
	LOCAL_WORKER_HEARTBEAT_TEST_TIMEOUT_MS,
);
