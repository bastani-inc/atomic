import assert from "node:assert/strict";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { durableHash, InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { makeExecuteWorkflowTool } from "../../packages/workflows/src/extension/workflow-tool.js";
import { jobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { quitRun } from "../../packages/workflows/src/runs/background/quit.js";
import { runDetached } from "../../packages/workflows/src/runs/background/runner.js";
import { stageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { store } from "../../packages/workflows/src/shared/store.js";
import { testRunId } from "../helpers/run-id.js";

class FailingHydrationBackend extends InMemoryDurableBackend {
	override async hydrateResumableWorkflows(): Promise<void> {
		throw new Error("durable hydration exploded");
	}
}

class TrackingHydrationBackend extends InMemoryDurableBackend {
	hydrationCalls = 0;

	override async hydrateResumableWorkflows(): Promise<void> {
		this.hydrationCalls += 1;
	}
}

beforeEach(() => {
	// Other test files may run workflows against the shared singleton store;
	// clear it so the durable-only replay assertions below start from a clean
	// slate regardless of cross-file execution order.
	store.clear();
});

afterEach(async () => {
	stageControlRegistry.clear();
	for (const runId of jobTracker.runIds()) {
		const entry = jobTracker.get(runId);
		entry?.controller.abort();
		await entry?.promise;
		jobTracker.unregister(runId);
	}
	store.clear();
	setDurableBackend(undefined);
});

describe("workflow tool durable-only checkpoint replay", () => {
	test.sequential("resume keeps the original id and does not repeat a completed ctx.tool side effect", async () => {
		const workflowId = testRunId("tool-durable-replay-original-id");
		const backend = new InMemoryDurableBackend();
		setDurableBackend(backend);
		backend.registerWorkflow({
			workflowId,
			name: "tool-durable-replay",
			inputs: {},
			createdAt: 1,
			status: "paused",
			resumable: true,
		});
		const args = { path: "artifact.txt" };
		const argsHash = durableHash({ name: "write-once", args, ordinal: 1 });
		backend.recordCheckpoint({
			kind: "tool",
			workflowId,
			checkpointId: `tool:${argsHash}`,
			name: "write-once",
			argsHash,
			output: "cached-output",
			completedAt: 2,
		});
		assert.deepEqual(store.runs(), []);

		let sideEffectCalls = 0;
		const promptStarted = Promise.withResolvers<void>();
		const releasePrompt = Promise.withResolvers<void>();
		const definition = workflow({
			name: "tool-durable-replay",
			description: "",
			inputs: {},
			outputs: { done: Type.Boolean() },
			run: async (ctx) => {
				const output = await ctx.tool("write-once", args, async () => {
					sideEffectCalls += 1;
					return "new-output";
				});
				assert.equal(output, "cached-output");
				await ctx.stage("continue").prompt("continue from checkpoint");
				return { done: true };
			},
		});
		const runtime = createExtensionRuntime({
			definitions: [definition],
			store,
			adapters: {
				prompt: {
					prompt: async () => {
						promptStarted.resolve();
						await releasePrompt.promise;
						return "continued";
					},
				},
			},
		});
		const execute = makeExecuteWorkflowTool(
			runtime,
			() => undefined,
			() => undefined,
		);

		const result = await execute({ action: "resume", runId: workflowId }, {} as never);
		await promptStarted.promise;

		assert.equal(result.action, "resume");
		assert.equal(result.status, "running");
		assert.equal(result.runId, workflowId);
		assert.equal(sideEffectCalls, 0, "replayed ctx.tool must not execute its side-effect callback");
		assert.equal(backend.listCheckpoints(workflowId).length, 1, "replay must not duplicate the checkpoint");
		const resumedJob = jobTracker.get(workflowId);
		assert.ok(resumedJob);
		releasePrompt.resolve();
		await resumedJob.promise;
		assert.equal(store.runs().find((run) => run.id === workflowId)?.status, "completed");
	});
	test.sequential("unknown resume hydrates durability while ordinary status remains local", async () => {
		const backend = new TrackingHydrationBackend();
		setDurableBackend(backend);
		const definition = workflow({ name: "lookup", description: "", inputs: {}, outputs: {}, run: () => ({}) });
		const execute = makeExecuteWorkflowTool(
			createExtensionRuntime({ definitions: [definition], store }),
			() => undefined,
			() => undefined,
		);
		const target = testRunId("durable-only-unknown-id");

		const status = await execute({ action: "status" }, {} as never);
		assert.equal(status.action, "status");
		assert.equal(backend.hydrationCalls, 0, "status must not eagerly hydrate durable history");

		const result = await execute({ action: "resume", runId: target }, {} as never);
		assert.equal(result.action, "resume");
		assert.equal(result.status, "noop");
		assert.equal(result.message, `Run not found: ${target}`);
		assert.ok(backend.hydrationCalls > 0, "not-found must follow authoritative hydration");
	});

	test.sequential("resume surfaces durable hydration failures and keeps --all unsupported", async () => {
		const backend = new FailingHydrationBackend();
		setDurableBackend(backend);
		const definition = workflow({
			name: testRunId("tool-durable-failure"),
			description: "",
			inputs: {},
			outputs: {},
			run: () => ({}),
		});
		const execute = makeExecuteWorkflowTool(
			createExtensionRuntime({ definitions: [definition], store }),
			() => undefined,
			() => undefined,
		);

		const failed = await execute({ action: "resume", runId: testRunId("durable-failure") }, {} as never);
		assert.equal(failed.action, "resume");
		assert.equal(failed.status, "noop");
		assert.match(failed.message, /durable hydration exploded/);
		assert.doesNotMatch(failed.message, /Run not found/);

		const all = await execute({ action: "resume", all: true }, {} as never);
		assert.deepEqual(all, {
			action: "resume",
			runId: "--all",
			status: "noop",
			message: "Resume does not support --all.",
		});
	});

	test.sequential("quit with an in-flight tool re-runs only that call at the same node identity", async () => {
		const workflowId = testRunId("tool-durable-replay-quit-in-flight");
		const backend = new InMemoryDurableBackend();
		setDurableBackend(backend);
		const args = { path: "artifact.txt" };
		const firstArgsHash = durableHash({ name: "write-twice", args, ordinal: 1, failureMode: "return" });
		const secondArgsHash = durableHash({ name: "write-twice", args, ordinal: 2, failureMode: "return" });
		let firstCalls = 0;
		let secondCalls = 0;
		let secondEntered = Promise.withResolvers<void>();
		const definition = workflow({
			name: "tool-durable-replay-quit",
			description: "",
			inputs: {},
			outputs: { done: Type.Boolean() },
			run: async (ctx) => {
				await ctx.tool(
					"write-twice",
					args,
					async () => {
						firstCalls += 1;
						return "first-output";
					},
					{ failureMode: "return" },
				);
				await ctx.tool(
					"write-twice",
					args,
					async ({ signal }) => {
						secondCalls += 1;
						if (secondCalls === 1) {
							secondEntered.resolve();
							await new Promise<void>((resolve) => {
								signal.addEventListener("abort", () => resolve(), { once: true });
							});
							throw new Error("second call observed cancellation");
						}
						return "second-output";
					},
					{ failureMode: "return" },
				);
				return { done: true };
			},
		});
		const runtime = createExtensionRuntime({ definitions: [definition], store });
		const execute = makeExecuteWorkflowTool(
			runtime,
			() => undefined,
			() => undefined,
		);

		runDetached(definition, {}, { runId: workflowId, store });
		await secondEntered.promise;
		const quit = await quitRun(workflowId, { store });
		assert.equal(quit.ok, true);
		if (quit.ok) {
			assert.deepEqual(
				quit.cancelledTools.map((entry) => [entry.node.name, entry.node.status, entry.node.ordinal]),
				[["write-twice", "cancelled", 2]],
			);
			assert.deepEqual(quit.abandonedTools, []);
		}
		await jobTracker.get(workflowId)?.promise;

		const pausedRun = store.runs().find((run) => run.id === workflowId);
		const cancelledNode = pausedRun?.toolNodes?.find((node) => node.ordinal === 2);
		assert.equal(cancelledNode?.status, "cancelled");
		assert.equal(cancelledNode?.argsHash, secondArgsHash);
		assert.equal(cancelledNode?.id, `tool:${secondArgsHash}`);
		assert.equal(backend.getToolCheckpoint(workflowId, secondArgsHash), undefined, "no replayable cancelled result");
		assert.equal(backend.getToolCheckpoint(workflowId, firstArgsHash)?.outcomeKind, "return_success");
		const cancelledRecords = backend
			.listCheckpoints(workflowId)
			.filter((entry) => entry.kind === "tool" && entry.argsHash === secondArgsHash);
		assert.equal(cancelledRecords.length, 1, "a cancelled return-mode call writes exactly one inspection record");
		const cancelledRecord = cancelledRecords[0]!;
		assert.match(cancelledRecord.checkpointId, /^tool-failure:/);
		assert.equal(cancelledRecord.kind, "tool");
		if (cancelledRecord.kind === "tool") {
			assert.match(cancelledRecord.throwingFailureError ?? "", /aborted by workflow quit/);
			assert.equal(cancelledRecord.outcomeKind, undefined, "inspection metadata is never a return outcome");
		}
		assert.equal(
			backend
				.listCheckpoints(workflowId)
				.some((entry) => entry.kind === "tool" && entry.outcomeKind === "return_failure"),
			false,
			"cancellation must never replay as return_failure data",
		);
		assert.equal(backend.getWorkflow(workflowId)?.status, "paused");
		assert.equal(firstCalls, 1);
		assert.equal(secondCalls, 1);

		secondEntered = Promise.withResolvers<void>();
		const resumed = await execute({ action: "resume", runId: workflowId }, {} as never);
		assert.equal(resumed.action, "resume");
		if (resumed.action === "resume") {
			assert.equal(resumed.status, "running");
			assert.equal(resumed.runId, workflowId);
		}
		await jobTracker.get(workflowId)?.promise;

		assert.equal(firstCalls, 1, "the completed sibling replays from cache");
		assert.equal(secondCalls, 2, "only the aborted call runs again");
		const resumedRun = store.runs().find((run) => run.id === workflowId);
		assert.equal(resumedRun?.status, "completed");
		assert.deepEqual(
			resumedRun?.toolNodes?.map((node) => [node.id, node.ordinal, node.status]),
			[
				[`tool:${firstArgsHash}`, 1, "cached"],
				[`tool:${secondArgsHash}`, 2, "completed"],
			],
			"resume occupies the same graph nodes it left behind",
		);
		assert.equal(backend.getToolCheckpoint(workflowId, secondArgsHash)?.outcomeKind, "return_success");
	});

	test.sequential("resume supersedes an abandoned detached job and isolates its late callback", async () => {
		const workflowId = testRunId("tool-durable-replay-abandoned-relaunch");
		const backend = new InMemoryDurableBackend();
		setDurableBackend(backend);
		const doneArgs = { path: "already-done.txt" };
		const args = { path: "abandoned.txt" };
		const doneArgsHash = durableHash({ name: "already-done", args: doneArgs, ordinal: 1 });
		const argsHash = durableHash({ name: "ignores-abort", args, ordinal: 1 });
		let doneCalls = 0;
		let calls = 0;
		const firstStarted = Promise.withResolvers<void>();
		const secondStarted = Promise.withResolvers<void>();
		const zombieRelease = Promise.withResolvers<void>();
		const freshRelease = Promise.withResolvers<void>();
		const definition = workflow({
			name: "tool-durable-abandoned-relaunch",
			description: "",
			inputs: {},
			outputs: { done: Type.Boolean() },
			run: async (ctx) => {
				// A completed call first, so the quit leaves ordinary durable progress
				// behind; the abandoned call below is what resume must re-run.
				await ctx.tool("already-done", doneArgs, async () => {
					doneCalls += 1;
					return "done-output";
				});
				await ctx.tool("ignores-abort", args, async () => {
					calls += 1;
					if (calls === 1) {
						firstStarted.resolve();
						// Deliberately ignores its abort signal: this is the callback
						// class quit must abandon rather than wait for.
						await zombieRelease.promise;
						return "zombie-output";
					}
					secondStarted.resolve();
					await freshRelease.promise;
					return "fresh-output";
				});
				return { done: true };
			},
		});
		const execute = makeExecuteWorkflowTool(
			createExtensionRuntime({ definitions: [definition], store }),
			() => undefined,
			() => undefined,
		);

		runDetached(definition, {}, { runId: workflowId, store });
		await firstStarted.promise;
		const staleJob = jobTracker.get(workflowId);
		assert.ok(staleJob);

		const quit = await quitRun(workflowId, { store });
		assert.equal(quit.ok, true);
		const nodeId = `tool:${argsHash}`;
		if (quit.ok) {
			assert.deepEqual(quit.abandonedTools, [{ runId: workflowId, nodeId }]);
			assert.deepEqual(
				quit.cancelledTools.map((entry) => [entry.runId, entry.nodeId, entry.node.status]),
				[[workflowId, nodeId, "cancelled"]],
			);
		}
		assert.equal(store.runs().find((run) => run.id === workflowId)?.status, "paused");
		assert.equal(store.runs().find((run) => run.id === workflowId)?.resumable, true);
		assert.equal(backend.getWorkflow(workflowId)?.status, "paused");
		assert.equal(
			jobTracker.has(workflowId),
			false,
			"an abandoned executor must stop counting as the active job for this run",
		);
		assert.equal(calls, 1);

		const resumed = await execute({ action: "resume", runId: workflowId }, {} as never);
		assert.equal(resumed.action, "resume");
		if (resumed.action === "resume") assert.equal(resumed.status, "running");
		await secondStarted.promise;

		assert.equal(calls, 2, "resume must re-run the abandoned callback");
		assert.equal(doneCalls, 1, "the completed sibling replays from cache");
		const replacementJob = jobTracker.get(workflowId);
		assert.ok(replacementJob);
		assert.notEqual(replacementJob, staleJob, "the replacement job replaces the stale entry");
		const liveNode = store.runs().find((run) => run.id === workflowId)?.toolNodes?.[1];
		assert.equal(liveNode?.id, nodeId, "the re-run occupies the same node identity");
		assert.equal(liveNode?.argsHash, argsHash);
		assert.equal(liveNode?.status, "running");

		// Release the zombie while the replacement is still in flight.
		zombieRelease.resolve();
		await staleJob.promise;

		assert.equal(jobTracker.get(workflowId), replacementJob, "a late zombie must not evict the replacement job");
		assert.equal(
			store.runs().find((run) => run.id === workflowId)?.toolNodes?.[1]?.status,
			"running",
			"a late zombie must not mutate the replacement run's node",
		);
		assert.equal(backend.getToolCheckpoint(workflowId, argsHash), undefined, "no zombie checkpoint is replayable");

		freshRelease.resolve();
		await replacementJob.promise;

		assert.equal(calls, 2, "only the abandoned call ran again");
		assert.equal(doneCalls, 1);
		const finalRun = store.runs().find((run) => run.id === workflowId);
		assert.equal(finalRun?.status, "completed");
		assert.deepEqual(
			finalRun?.toolNodes?.map((node) => [node.id, node.status]),
			[
				[`tool:${doneArgsHash}`, "cached"],
				[nodeId, "completed"],
			],
		);
		assert.equal(backend.getToolCheckpoint(workflowId, argsHash)?.output, "fresh-output");
	});

	test.sequential("return-mode callback that fulfills after abort writes one inspection-only record", async () => {
		const workflowId = testRunId("tool-durable-late-return-cancellation");
		const backend = new InMemoryDurableBackend();
		setDurableBackend(backend);
		const args = { path: "late-return.txt" };
		const argsHash = durableHash({ name: "late-return", args, ordinal: 1, failureMode: "return" });
		let calls = 0;
		const started = Promise.withResolvers<void>();
		const definition = workflow({
			name: "tool-durable-late-return",
			description: "",
			inputs: {},
			outputs: { done: Type.Boolean() },
			run: async (ctx) => {
				// A completed call first so the quit leaves ordinary durable progress.
				await ctx.tool("prepare", { path: "prepare.txt" }, async () => "prepared");
				await ctx.tool(
					"late-return",
					args,
					async ({ signal }) => {
						calls += 1;
						if (calls === 1) {
							started.resolve();
							// Observes the abort and *fulfills* anyway: cancellation is
							// caught by the post-callback check, after `callbackCompleted`.
							await new Promise<void>((resolve) => {
								signal.addEventListener("abort", () => resolve(), { once: true });
							});
							return "ignored-abort";
						}
						return "second-output";
					},
					{ failureMode: "return" },
				);
				return { done: true };
			},
		});
		const execute = makeExecuteWorkflowTool(
			createExtensionRuntime({ definitions: [definition], store }),
			() => undefined,
			() => undefined,
		);

		runDetached(definition, {}, { runId: workflowId, store });
		await started.promise;
		const quit = await quitRun(workflowId, { store });
		assert.equal(quit.ok, true);
		await jobTracker.get(workflowId)?.promise;

		const records = backend
			.listCheckpoints(workflowId)
			.filter((entry) => entry.kind === "tool" && entry.argsHash === argsHash);
		assert.equal(records.length, 1, "a fulfilled-then-cancelled call still records inspection metadata");
		const record = records[0]!;
		assert.match(record.checkpointId, /^tool-failure:/);
		assert.equal(record.kind, "tool");
		if (record.kind === "tool") {
			assert.equal(record.outcomeKind, undefined);
			assert.match(record.throwingFailureError ?? "", /aborted/);
		}
		assert.equal(backend.getToolCheckpoint(workflowId, argsHash), undefined);
		assert.equal(
			backend
				.listCheckpoints(workflowId)
				.some((entry) => entry.kind === "tool" && entry.outcomeKind === "return_failure"),
			false,
		);
		assert.equal(store.runs().find((run) => run.id === workflowId)?.toolNodes?.[1]?.status, "cancelled");

		const resumed = await execute({ action: "resume", runId: workflowId }, {} as never);
		assert.equal(resumed.action, "resume");
		await jobTracker.get(workflowId)?.promise;

		assert.equal(calls, 2, "resume re-runs the cancelled call at the same node identity");
		const finalRun = store.runs().find((run) => run.id === workflowId);
		assert.equal(finalRun?.status, "completed");
		assert.equal(finalRun?.toolNodes?.[1]?.id, `tool:${argsHash}`);
		assert.equal(backend.getToolCheckpoint(workflowId, argsHash)?.outcomeKind, "return_success");
	});
});
