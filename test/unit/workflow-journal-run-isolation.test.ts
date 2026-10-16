import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { initializeDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { MemoryRunJournal } from "../../packages/workflows/src/durable/journal/memory-run-journal.js";
import { prepareDurableResume, resumeDurableWorkflow } from "../../packages/workflows/src/durable/resume-runtime.js";
import { availableStoreDurableBackend } from "../../packages/workflows/src/durable/store-backend.js";
import {
	disposeWorkflowSummaryService,
	ensureWorkflowSummaryService,
} from "../../packages/workflows/src/extension/workflow-summary.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { quitRun } from "../../packages/workflows/src/runs/background/quit.js";
import { createWorkflowPendingStageDelivery } from "../../packages/workflows/src/runs/foreground/pending-stage-delivery.js";
import { run, workflow } from "../../packages/workflows/src/sdk-surface.js";
import { store } from "../../packages/workflows/src/shared/store.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";

test("concurrent SDK runs without stores acknowledge messages and persist summaries only in their selected journals (#3674)", async () => {
	const defaultBackend = availableStoreDurableBackend(store);
	const journals = [new MemoryRunJournal(), new MemoryRunJournal()];
	const backends = await Promise.all(journals.map((journal) => initializeDurableBackend({ journal })));
	const entered = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
	const release = Promise.withResolvers<void>();
	const ids = [crypto.randomUUID(), crypto.randomUUID()];
	const definitions = ids.map((id, index) =>
		workflow({
			name: `isolated-${index}`,
			description: "",
			inputs: {},
			outputs: {},
			async run(ctx) {
				await ctx.tool("wait", {}, async () => {
					entered[index]!.resolve();
					await release.promise;
					return id;
				});
				return {};
			},
		}),
	);
	const first = run(definitions[0]!, {}, { runId: ids[0], journal: journals[0] });
	await entered[0]!.promise;
	const second = run(definitions[1]!, {}, { runId: ids[1], journal: journals[1] });
	await entered[1]!.promise;
	const runs = [first, second];
	try {
		assert.equal(availableStoreDurableBackend(store), defaultBackend);
		for (const [index, id] of ids.entries()) {
			const backend = backends[index]!;
			const queued = await store.queueStageMessage(
				{
					runId: id,
					stageKey: "review",
					from: { id: "sender", name: "sender" },
					message: { id: `message-${index}`, timestamp: 1, content: { text: `instruction-${index}` } },
					queuedAt: "now",
				},
				undefined,
				undefined,
				backend,
			);
			assert.equal(queued?.ok, true);
			const delivery = createWorkflowPendingStageDelivery(store, id, "review", "review");
			const received: string[] = [];
			const deliver = async (_from: { id: string }, message: { id: string }) => {
				received.push(message.id);
			};
			await delivery.deliverPending(deliver);
			await delivery.deliverPending(deliver);
			assert.deepEqual(received, [`message-${index}`]);
			assert.equal(
				backend.getWorkflow(id)?.pendingStageMessages?.find((message) => message.id === `message-${index}`)?.status,
				"delivered",
			);
		}
		release.resolve();
		assert.deepEqual(
			(await Promise.all(runs)).map((result) => result.status),
			["completed", "completed"],
		);
		ensureWorkflowSummaryService(store, {
			generateWorkflowSummary: async (text) => `summary:${ids.find((id) => text.includes(id))}`,
		});
		await vi.waitFor(() => {
			for (const [index, id] of ids.entries())
				assert.equal(backends[index]!.getWorkflow(id)?.summary, `summary:${id}`);
		});
		for (const [index, journal] of journals.entries())
			assert.deepEqual(
				(await journal.listRuns()).map((header) => header.runId),
				[ids[index]],
			);
	} finally {
		disposeWorkflowSummaryService(store);
		release.resolve();
		await Promise.allSettled(runs);
		for (const id of ids) store.removeRun(id);
		for (const backend of backends) {
			assert.ok(backend instanceof JournalDurableBackend);
			await backend.close();
		}
		for (const journal of journals) await journal.close();
	}
});

test("SDK quit and resume use the root run's journal after a different journal starts (#3674)", async () => {
	const journals = [new MemoryRunJournal(), new MemoryRunJournal()];
	const entered = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
	const release = Promise.withResolvers<void>();
	const ids = [crypto.randomUUID(), crypto.randomUUID()];
	let firstCalls = 0;
	const definitions = ids.map((id, index) =>
		workflow({
			name: `resume-isolated-${index}`,
			description: "",
			inputs: {},
			outputs: {},
			async run(ctx) {
				await ctx.tool("saved", {}, async () => id);
				await ctx.tool("effect", {}, async () => {
					entered[index]!.resolve();
					if (index !== 0 || ++firstCalls === 1) await release.promise;
					return id;
				});
				return {};
			},
		}),
	);
	const first = run(definitions[0]!, {}, { runId: ids[0], journal: journals[0] });
	await entered[0]!.promise;
	const second = run(definitions[1]!, {}, { runId: ids[1], journal: journals[1] });
	await entered[1]!.promise;
	const jobs = createJobTracker();
	try {
		assert.equal((await quitRun(ids[0]!)).ok, true);
		assert.equal((await first).status, "paused");
		const deps = { registry: createRegistry().register(definitions[0]!), baseRunOpts: { store }, jobs };
		assert.deepEqual(
			(await prepareDurableResume(ids[0], deps)).map((entry) => entry.workflowId),
			[ids[0]],
		);
		const resumed = await resumeDurableWorkflow(ids[0]!, deps);
		assert.equal(resumed.ok, true, resumed.message);
		await jobs.get(ids[0]!)?.promise;
		assert.equal(availableStoreDurableBackend(store, ids[0])?.getWorkflow(ids[0]!)?.status, "completed");
		assert.equal(availableStoreDurableBackend(store, ids[1])?.getWorkflow(ids[1]!)?.status, "running");
		release.resolve();
		assert.equal((await second).status, "completed");
		for (const [index, journal] of journals.entries())
			assert.deepEqual(
				(await journal.listRuns()).map((entry) => entry.runId),
				[ids[index]],
			);
	} finally {
		release.resolve();
		await Promise.allSettled([first, second, ...jobs.runIds().map((id) => jobs.get(id)?.promise)]);
		for (const id of ids) {
			const backend = availableStoreDurableBackend(store, id);
			assert.ok(backend instanceof JournalDurableBackend);
			await backend.close();
			store.removeRun(id);
		}
		for (const journal of journals) await journal.close();
	}
});
