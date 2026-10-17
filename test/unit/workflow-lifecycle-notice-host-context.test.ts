import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { join } from "node:path";
import { test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { outsideWorkflowExecutions } from "../../packages/workflows/src/durable/execution-context-boundary.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { openSqlRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import { createToolControlRegistry } from "../../packages/workflows/src/engine/run-tool-control-registry.js";
import { installWorkflowLifecycleNotifications } from "../../packages/workflows/src/extension/lifecycle-notifications.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { runDetached } from "../../packages/workflows/src/runs/background/runner.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { testRunId } from "../helpers/run-id.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

test("a turn triggered by a terminal notice can launch a new run after the notifying run retires and keeps host context", async () => {
	const hostScope = new AsyncLocalStorage<string>();
	let hostScopeAtDelivery: string | undefined;
	const directory = makeTempDirectory("notice-host-context-");
	const backend = await JournalDurableBackend.open(await openSqlRunJournal(join(directory, "journal.sqlite")));
	const store = createStore();
	const jobs = createJobTracker();
	const toolControlRegistry = createToolControlRegistry();
	const firstRunId = testRunId("notifying-run");
	const followUpRunId = testRunId("follow-up-run");
	const definition = workflow({
		name: "notice-host-context",
		description: "",
		inputs: {},
		outputs: {},
		async run(ctx) {
			await ctx.tool("effect", {}, async () => "saved");
			return {};
		},
	});
	const followUpSettled = Promise.withResolvers<string>();
	let launched = false;
	const unsubscribe = installWorkflowLifecycleNotifications({
		store,
		config: { enabled: true, notifyOn: ["completed"] },
		sendMessage: () =>
			outsideWorkflowExecutions(() => {
				hostScopeAtDelivery = hostScope.getStore();
				if (launched) return;
				launched = true;
				setTimeout(async () => {
					await jobs.get(firstRunId)?.promise;
					runDetached(
						definition,
						{},
						{
							runId: followUpRunId,
							origin: "user",
							store,
							durableBackend: backend,
							jobs,
							toolControlRegistry,
							onRawSettled: (ok, _result, error) => followUpSettled.resolve(ok ? "settled" : String(error)),
						},
					);
				}, 0);
			}),
	});
	try {
		hostScope.run("host turn", () =>
			runDetached(
				definition,
				{},
				{ runId: firstRunId, origin: "user", store, durableBackend: backend, jobs, toolControlRegistry },
			),
		);
		assert.equal(await followUpSettled.promise, "settled");
		assert.equal(hostScopeAtDelivery, "host turn");
		assert.equal(backend.getWorkflow(firstRunId)?.status, "completed");
		assert.equal(backend.getWorkflow(followUpRunId)?.status, "completed");
	} finally {
		unsubscribe();
		await backend.close();
		removeTempDirectory(directory);
	}
});
