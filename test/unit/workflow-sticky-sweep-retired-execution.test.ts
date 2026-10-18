import assert from "node:assert/strict";
import { join } from "node:path";
import { test, vi } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { openSqlRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import { bindStoreDurableBackend } from "../../packages/workflows/src/durable/store-backend.js";
import { createToolControlRegistry } from "../../packages/workflows/src/engine/run-tool-control-registry.js";
import { registerPendingStageIntercomBridge } from "../../packages/workflows/src/extension/pending-stage-intercom.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { runDetached } from "../../packages/workflows/src/runs/background/runner.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { testRunId } from "../helpers/run-id.js";
import { makeTempDirectory, removeTempDirectory, sleep } from "../helpers/runtime.js";

const SWEEP_SETTLE_DEADLINE_MS = 5_000;
const SWEEP_POLL_INTERVAL_MS = 20;

test("settles a finished run's sticky broadcast without a retired-execution sweep warning (#3745)", async () => {
	const directory = makeTempDirectory("sticky-sweep-retired-");
	const backend = await JournalDurableBackend.open(await openSqlRunJournal(join(directory, "journal.sqlite")));
	const store = createStore();
	bindStoreDurableBackend(store, backend);
	const jobs = createJobTracker();
	const runId = testRunId("sticky-sweep-retired");
	const group = `workflow:${runId}`;
	const gate = Promise.withResolvers<void>();
	const started = Promise.withResolvers<void>();
	const definition = workflow({
		name: "sticky-sweep-retired",
		description: "",
		inputs: {},
		outputs: {},
		async run(ctx) {
			await ctx.tool("wait-for-supervisor", {}, async () => {
				started.resolve();
				await gate.promise;
				return "released";
			});
			return {};
		},
	});
	const warnings: string[] = [];
	const warn = vi.spyOn(console, "warn").mockImplementation((message: string) => {
		warnings.push(message);
	});
	const disposeBridge = registerPendingStageIntercomBridge({ events: { emit() {}, on: () => undefined } }, store);
	try {
		runDetached(
			definition,
			{},
			{
				runId,
				origin: "user",
				store,
				durableBackend: backend,
				jobs,
				toolControlRegistry: createToolControlRegistry(),
			},
		);
		await started.promise;
		await store.queueStickyStageMessage(
			{
				runId,
				stageKey: `${group}/**`,
				targetPath: `${group}/**`,
				from: { id: "supervisor-session", name: "supervisor", group },
				message: { id: "scope-update", timestamp: 1_725_000_000_000, content: { text: "scope update" } },
				queuedAt: "2026-10-18T00:00:00.000Z",
			},
			group,
			group,
			backend,
		);
		const readDeliveryCount = backend.readPendingStageMessageDeliveryCount.bind(backend);
		backend.readPendingStageMessageDeliveryCount = async (...args) => {
			await jobs.get(runId)?.promise;
			await sleep(0);
			return readDeliveryCount(...args);
		};
		gate.resolve();
		await jobs.get(runId)?.promise;

		const stickyStatus = () =>
			store
				.runs()
				.find((run) => run.id === runId)
				?.pendingStageMessages?.find((entry) => entry.message.id === "scope-update")?.status;
		const deadline = Date.now() + SWEEP_SETTLE_DEADLINE_MS;
		while (stickyStatus() === "queued" && warnings.length === 0 && Date.now() < deadline)
			await sleep(SWEEP_POLL_INTERVAL_MS);

		assert.deepEqual(
			warnings.filter((message) => message.includes("pending stage delivery sweep failed")),
			[],
		);
		assert.equal(backend.getWorkflow(runId)?.status, "completed");
		assert.equal(stickyStatus(), "undeliverable");
	} finally {
		disposeBridge();
		warn.mockRestore();
		await backend.close();
		removeTempDirectory(directory);
	}
});
