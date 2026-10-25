import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { openSqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { createToolControlRegistry } from "../../packages/workflows/src/engine/run-tool-control-registry.js";
import {
	workflowStageResult,
	workflowStagesResult,
} from "../../packages/workflows/src/extension/workflow-tool-inspection.js";
import { statusRuns } from "../../packages/workflows/src/runs/background/status.js";
import { run } from "../../packages/workflows/src/runs/foreground/sdk-run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { loadWorkerWorkflow } from "../../packages/workflows/src/workers/definitions.js";
import { IntercomBrokerFixture } from "../helpers/intercom-broker-fixture.js";
import { testRunId } from "../helpers/run-id.js";
import { makeTempDirectory, removeTempDirectory, sleep } from "../helpers/runtime.js";

const WORKER_INTERCOM_TIMEOUT_MS = 120_000;
const BROKER_STARTUP_TIMEOUT_MS = 60_000;
async function until(condition: () => Promise<boolean>) {
	const signal = AbortSignal.timeout(60_000);
	while (!(await condition())) {
		signal.throwIfAborted();
		await sleep(25);
	}
}

test.skipIf(process.platform === "win32")(
	"public SDK root delivers direct and sticky steering after worker replacement and pause (#3869)",
	async () => {
		const directory = makeTempDirectory("pool-intercom-");
		const broker = new IntercomBrokerFixture(join(directory, "agent"));
		broker.overrideAgentDir();
		const { IntercomClient } = await import("../../packages/intercom/broker/client.js");
		const { getJitiCliPath } = await import("../../packages/intercom/broker/spawn.js");
		const { getBrokerSocketPath } = await import("../../packages/intercom/broker/paths.js");
		const intercomPath = fileURLToPath(new URL("../../packages/intercom", import.meta.url));
		const path = join(directory, "journal.sqlite");
		const database = await openNodeSqliteDatabase(path);
		const journal = await SqlRunJournal.open(database);
		const backend = await JournalDurableBackend.open(journal, { ownsJournal: false });
		await database.exec("CREATE TABLE test_pool_gate(released INTEGER); INSERT INTO test_pool_gate VALUES (0)");
		const childPath = fileURLToPath(new URL("../fixtures/pool-intercom-child.ts", import.meta.url));
		const child = await loadWorkerWorkflow(childPath, "child");
		const controls = createToolControlRegistry();
		const store = createStore();
		const root = testRunId("pool-intercom");
		const controller = new AbortController();
		const client = new IntercomClient();
		client.on("error", () => {});
		let execution: ReturnType<typeof run> | undefined;
		try {
			broker.trackBroker(
				spawn(process.execPath, [getJitiCliPath(intercomPath), join(intercomPath, "broker/broker.ts")], {
					env: process.env,
					stdio: "ignore",
				}),
			);
			// The broker retires after an idle window with no session; hold one from the moment it answers.
			await broker.holdSession(getBrokerSocketPath(), BROKER_STARTUP_TIMEOUT_MS);
			await client.connect({
				cwd: directory,
				model: "fixture",
				pid: process.pid,
				startedAt: Date.now(),
				lastActivity: Date.now(),
				group: `workflow:${root}`,
			});
			execution = run(
				workflow({
					name: "pool-intercom-root",
					description: "",
					inputs: {},
					outputs: {},
					async run(ctx) {
						await Promise.all(
							["first", "second"].map((label) => ctx.workflow(child, { inputs: { label, journalPath: path } })),
						);
						return {};
					},
				}),
				{},
				{
					runId: root,
					cwd: directory,
					store,
					durableBackend: backend,
					signal: controller.signal,
					toolControlRegistry: controls,
					localWorkers: { count: 2, definitions: [{ path: childPath, exportName: "child" }] },
				},
			);
			await until(
				async () =>
					(await client.listDirectory()).workflowStages.filter((stage) => stage.stageName === "agent").length ===
					2,
			);
			await controls.runControl(root)!.pause();
			assert.equal((await journal.getRun(root))!.status, "paused");
			await controls.runControl(root)!.resume();
			const stages = (await client.listDirectory()).workflowStages.filter((stage) => stage.stageName === "agent");
			const target = stages[0]!;
			const direct = await client.send(`workflow:${root}/${target.runId}/${target.stageId}`, {
				text: "direct-worker-instruction",
			});
			assert.equal(direct.queued, true);
			const sticky = await client.send(`workflow:${root}/**`, { text: "sticky-root-instruction" });
			assert.equal(sticky.queued, true);
			const queue = await openSqlPoolQueue(journal);
			const work = (await queue.inspect(root)).find((entry) => entry.childRunId === target.runId)!;
			await backend.hydrateWorkflow(root);
			const pid = backend
				.listCheckpoints(root)
				.find(
					(entry) => entry.kind === "tool" && entry.name === "pid" && entry.topology?.run?.runId === target.runId,
				);
			assert.ok(pid?.kind === "tool");
			process.kill(Number(pid.output), "SIGKILL");
			await until(async () =>
				(await queue.inspect(root)).some((entry) => entry.id === work.id && entry.generation > work.generation),
			);
			await database.run("UPDATE test_pool_gate SET released = 1");
			assert.equal((await execution).status, "completed");
			const children = store.runs().filter((entry) => entry.parentRunId === root);
			assert.equal(children.length, 2);
			assert.deepEqual(
				statusRuns({ store }).map((entry) => entry.runId),
				[root],
			);
			const listing = workflowStagesResult({ action: "stages", runId: root }, { store });
			assert.equal(listing.action, "stages");
			if (listing.action !== "stages") assert.fail("wrong inspection result");
			const agents = listing.stages.filter((stage) => stage.name === "agent");
			assert.equal(agents.length, 2);
			assert.equal(new Set(agents.map((stage) => stage.workerExecution?.worker)).size, 2);
			const recoveredStage = agents.find((stage) => stage.workerExecution?.generation === work.generation + 1)!;
			const detail = workflowStageResult({ action: "stage", runId: root, stageId: recoveredStage.id }, { store });
			assert.equal(detail.action, "stage");
			if (detail.action !== "stage") assert.fail("wrong stage result");
			assert.equal(detail.stage?.workerExecution?.generation, work.generation + 1);
			for (const entry of children) {
				const stage = entry.stages.find((candidate) => candidate.name === "agent")!;
				assert.match(String(stage.result), /sticky-root-instruction/);
				if (entry.id === target.runId) assert.match(String(stage.result), /direct-worker-instruction/);
			}
			assert.equal((await journal.listRuns()).length, 1);
		} finally {
			controller.abort();
			await database.run("UPDATE test_pool_gate SET released = 1");
			await execution;
			await client.disconnect();
			await backend.close();
			await journal.close();
			await database.close();
			await broker.cleanup();
			removeTempDirectory(directory);
		}
	},
	WORKER_INTERCOM_TIMEOUT_MS,
);
