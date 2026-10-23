import assert from "node:assert/strict";
import { type ChildProcess, fork } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import type { PoolWork } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { definitionDigest } from "../../packages/workflows/src/workers/definitions.js";
import type { WorkerRequest } from "../../packages/workflows/src/workers/protocol.js";
import { fileExists, makeTempDirectory, removeTempDirectory, sleep, writeTextSync } from "../helpers/runtime.js";

const HEARTBEATS_WHILE_ACTIVITY_IS_HELD = 3;
const HEARTBEAT_OBSERVATION_TIMEOUT_MS = 12_000;
const RELEASE_OBSERVATION_TIMEOUT_MS = 10_000;
const LOCAL_WORKER_HEARTBEAT_TEST_TIMEOUT_MS = 60_000;
const TOOL_CALLS_WHILE_ACTIVITY_IS_HELD = 40;
const COALESCED_ACTIVITY_REQUESTS_AFTER_RELEASE = 3;

test(
	"a held activity acknowledgement does not stop renewals or control polls and coalesces later activity (#3869)",
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
			worker = fork(
				workerEntry,
				[
					JSON.stringify({
						journalPath: path,
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
			worker.on("message", (message: WorkerRequest) => {
				requests.push(message);
				if (message.kind === "activity" && !released) {
					held.push(message.id);
					return;
				}
				if (message.kind === "control" || message.kind === "budget")
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
			const renewalsBefore = count("renew");
			const controlsBefore = count("control");
			await until(
				() => count("renew") - renewalsBefore >= HEARTBEATS_WHILE_ACTIVITY_IS_HELD,
				HEARTBEAT_OBSERVATION_TIMEOUT_MS,
			);
			assert.ok(
				count("renew") - renewalsBefore >= HEARTBEATS_WHILE_ACTIVITY_IS_HELD,
				`only ${count("renew") - renewalsBefore} lease renewals while activity was held`,
			);
			assert.ok(
				count("control") - controlsBefore >= HEARTBEATS_WHILE_ACTIVITY_IS_HELD - 1,
				`only ${count("control") - controlsBefore} control polls while activity was held`,
			);
			assert.equal(held.length, 1, "repeated invalidations leave one unacknowledged activity request");
			const activityBeforeRelease = count("activity");
			released = true;
			writeTextSync(releasePath, "");
			for (const id of held) reply(id);
			await until(() => count("complete") > 0, RELEASE_OBSERVATION_TIMEOUT_MS);
			assert.ok(count("complete") > 0, "the worker completes its attempt once the held activity is acknowledged");
			assert.ok(
				count("activity") - activityBeforeRelease <= COALESCED_ACTIVITY_REQUESTS_AFTER_RELEASE,
				`${count("activity") - activityBeforeRelease} activity requests followed the release`,
			);
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
