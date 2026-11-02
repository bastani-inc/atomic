import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, vi } from "vitest";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { createToolControlRegistry } from "../../packages/workflows/src/engine/run-tool-control-registry.js";
import { run } from "../../packages/workflows/src/runs/foreground/sdk-run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { loadWorkerWorkflow } from "../../packages/workflows/src/workers/definitions.js";
import { PoolStageHandoff } from "../../packages/workflows/src/workers/stage-handoff.js";
import { IntercomBrokerFixture } from "../helpers/intercom-broker-fixture.js";
import { testRunId } from "../helpers/run-id.js";
import { fileExists, makeTempDirectory, readText, removeTempDirectory } from "../helpers/runtime.js";
import { untilOrRunEnds } from "../helpers/until-run.js";

/** A real 2-worker pool, broker and Intercom client; also covers the root's late drain once it catches up. */
const POOLED_STICKY_TIMEOUT_MS = 120_000;
const BROKER_STARTUP_TIMEOUT_MS = 60_000;
const CONDITION_TIMEOUT_MS = 60_000;
/**
 * Far below the 60 s pending-stage stall bound. A pooled stage whose startup waits on the starved root's drain
 * misses it; one that delivers its queued messages itself starts within it on a loaded host.
 */
const STARTUP_BUDGET_MS = 20_000;
const MARKER = "sticky-root-instruction";
const SENDER = "sticky-sender";

/** Waits for `condition`, naming the expectation that did not hold in time. */
async function expectWithin(
	expectation: string,
	condition: () => Promise<boolean>,
	execution: Promise<{ readonly status: string; readonly error?: string }>,
	timeoutMs: number,
): Promise<void> {
	try {
		await untilOrRunEnds(condition, execution, timeoutMs);
	} catch (error) {
		assert.fail(`${expectation} within ${timeoutMs} ms: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function agentStages(store: ReturnType<typeof createStore>, root: string): RunSnapshot["stages"] {
	return store
		.runs()
		.filter((entry) => entry.parentRunId === root)
		.flatMap((entry) => entry.stages.filter((stage) => stage.name === "agent"));
}

test.skipIf(process.platform === "win32")(
	"pooled stages that start after a sticky broadcast get it before their first turn while the root is starved",
	async () => {
		const directory = makeTempDirectory("pool-sticky-prestart-");
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
		const childPath = fileURLToPath(new URL("../fixtures/pool-intercom-starved-child.ts", import.meta.url));
		const child = await loadWorkerWorkflow(childPath, "child");
		const store = createStore();
		const root = testRunId("pool-sticky-prestart");
		const controller = new AbortController();
		const client = new IntercomClient();
		client.on("error", () => {});
		const warnings: string[] = [];
		const warn = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
			warnings.push(args.map(String).join(" "));
		});
		// The root's handling of pooled delivery requests is held, as on a root too busy to reach them.
		const starved = Promise.withResolvers<void>();
		const deliver = PoolStageHandoff.prototype.deliver;
		const hold = vi.spyOn(PoolStageHandoff.prototype, "deliver").mockImplementation(async function (
			this: PoolStageHandoff,
			...args: Parameters<PoolStageHandoff["deliver"]>
		) {
			await starved.promise;
			return deliver.apply(this, args);
		});
		let execution: ReturnType<typeof run> | undefined;
		try {
			broker.trackBroker(
				spawn(process.execPath, [getJitiCliPath(intercomPath), join(intercomPath, "broker/broker.ts")], {
					env: process.env,
					stdio: "ignore",
				}),
			);
			await broker.holdSession(getBrokerSocketPath(), BROKER_STARTUP_TIMEOUT_MS);
			await client.connect({
				name: SENDER,
				cwd: directory,
				model: "fixture",
				pid: process.pid,
				startedAt: Date.now(),
				lastActivity: Date.now(),
				group: `workflow:${root}`,
			});
			execution = run(
				workflow({
					name: "pool-sticky-prestart-root",
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
					toolControlRegistry: createToolControlRegistry(),
					localWorkers: { count: 2, definitions: [{ path: childPath, exportName: "child" }] },
				},
			);
			// The broker lists both pending stages once the root's route announced them.
			await untilOrRunEnds(
				async () =>
					(await client.listDirectory()).workflowStages.filter((stage) => stage.stageName === "agent").length ===
					2,
				execution,
				CONDITION_TIMEOUT_MS,
			);
			const sticky = await client.send(`workflow:${root}/**`, { text: MARKER });
			assert.equal(sticky.queued, true);

			// Both stages start after the broadcast, while the root answers no delivery request.
			await database.run("UPDATE test_pool_gate SET released = 1");
			// The fixture writes each stage's first-turn context beside the journal.
			const contexts = ["first", "second"].map((label) => join(directory, `context-${label}.json`));
			await expectWithin(
				"pooled stages reach their first turn while the root is starved",
				async () => (await Promise.all(contexts.map(fileExists))).every(Boolean),
				execution,
				STARTUP_BUDGET_MS,
			);
			for (const context of contexts) {
				const text = await readText(context);
				assert.equal(text.split(MARKER).length - 1, 1, text);
				assert.match(text, /Messages received before you started/);
				assert.ok(text.includes(SENDER), text);
			}

			// Once the root catches up, it records each running stage's delivery.
			starved.resolve();
			const receipted = () => {
				const entry = store
					.runs()
					.find((candidate) => candidate.id === root)
					?.pendingStageMessages?.find((candidate) => candidate.sticky === true);
				return agentStages(store, root).every((stage) =>
					entry?.deliveries?.some(
						(delivery) =>
							delivery.stageId === stage.id &&
							delivery.sessionId === stage.sessionId &&
							delivery.admission === "context",
					),
				);
			};
			await expectWithin(
				"the root records each stage's delivery",
				async () => receipted(),
				execution,
				CONDITION_TIMEOUT_MS,
			);

			await database.run("UPDATE test_pool_gate SET released = 2");
			const result = await execution;
			assert.equal(result.status, "completed", result.error);
			for (const stage of agentStages(store, root)) assert.equal(String(stage.result).split(MARKER).length - 1, 1);
			assert.deepEqual(
				warnings.filter((line) => line.includes("Intercom")),
				[],
			);
		} finally {
			starved.resolve();
			hold.mockRestore();
			warn.mockRestore();
			controller.abort();
			await database.run("UPDATE test_pool_gate SET released = 2");
			await execution;
			await client.disconnect();
			await backend.close();
			await journal.close();
			await database.close();
			await broker.cleanup();
			removeTempDirectory(directory);
		}
	},
	POOLED_STICKY_TIMEOUT_MS,
);
