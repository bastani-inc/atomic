import assert from "node:assert/strict";
import { Type } from "typebox";
import { afterEach, describe, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import {
	createToolControlRegistry,
	toolControlRegistry,
} from "../../packages/workflows/src/engine/run-tool-control-registry.js";
import type {
	ToolNodeControlResult,
	WorkflowToolResult,
} from "../../packages/workflows/src/extension/render-result.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { summarizeRunSnapshot } from "../../packages/workflows/src/extension/workflow-status-summary.js";
import { makeExecuteWorkflowTool } from "../../packages/workflows/src/extension/workflow-tool.js";
import { renderWorkflowToolContent } from "../../packages/workflows/src/extension/workflow-tool-content.js";
import { abortToolNode } from "../../packages/workflows/src/runs/background/quit-tool-node.js";
import { inspectRun, statusRuns } from "../../packages/workflows/src/runs/background/status.js";
import { expandWorkflowGraph } from "../../packages/workflows/src/shared/expanded-workflow-graph.js";
import { createStore, store as singletonStore } from "../../packages/workflows/src/shared/store.js";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.js";
import { renderNodeCard } from "../../packages/workflows/src/tui/node-card.js";
import { testRunId } from "../helpers/run-id.js";

describe("ctx.tool workflow graph execution", () => {
	test("tool-only workflow completes with its declared output and one durable side effect", async () => {
		const store = createStore();
		const backend = new InMemoryDurableBackend();
		let calls = 0;
		const definition = workflow({
			name: "tool-only-graph",
			description: "",
			inputs: {},
			outputs: { done: Type.Boolean() },
			run: async (ctx) => {
				await ctx.tool("irreversible", {}, async () => {
					calls += 1;
					return true;
				});
				return { done: true };
			},
		});

		const result = await run(definition, {}, { store, durableBackend: backend });

		assert.equal(result.status, "completed");
		assert.deepEqual(result.result, { done: true });
		assert.equal(calls, 1);
		const checkpoint = backend
			.listCheckpoints(result.runId)
			.find((entry) => entry.kind === "tool" && entry.name === "irreversible");
		assert.equal(checkpoint?.kind, "tool");
		if (checkpoint?.kind === "tool") {
			assert.equal(checkpoint.topology?.nodeId, result.toolNodes?.[0]?.id);
			assert.equal(checkpoint.topology?.order, result.toolNodes?.[0]?.executionOrder);
			assert.deepEqual(checkpoint.topology?.parentIds, []);
		}
		assert.equal(
			backend.listCheckpoints(result.runId).filter((entry) => entry.kind === "tool" && entry.name === "irreversible")
				.length,
			1,
		);
		assert.deepEqual(
			result.toolNodes?.map((node) => ({ name: node.name, status: node.status, attachable: node.attachable })),
			[{ name: "irreversible", status: "completed", attachable: false }],
		);
		const graph = expandWorkflowGraph(store.snapshot(), result.runId);
		assert.equal(graph.stages.length, 0, "stage inspection remains stage-only");
		assert.equal(graph.tools.length, 1);
		assert.equal(graph.renderStages[0]?.nodeKind, "tool");
		assert.equal(graph.renderStages[0]?.attachable, false);
		assert.equal(
			graph.targets.get(graph.renderStages[0]!.id)?.stageId,
			graph.tools[0]?.id,
			"tool nodes are abort-only control targets",
		);
		assert.equal(statusRuns({ store })[0]?.toolCount, 1);
		const inspected = inspectRun(result.runId, { store });
		assert.equal(inspected.ok, true);
		if (inspected.ok) {
			assert.equal(inspected.detail.stages.length, 0);
			assert.equal(inspected.detail.tools?.[0]?.status, "completed");
		}
	});

	test("admits a running tool node before invoking its callback and records failures", async () => {
		const store = createStore();
		const backend = new InMemoryDurableBackend();
		const observedStatuses: string[] = [];
		const unsubscribe = store.subscribe((snapshot) => {
			const status = snapshot.runs[0]?.toolNodes?.[0]?.status;
			if (status !== undefined) observedStatuses.push(status);
		});
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const definition = workflow({
			name: "tool-live-node",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.tool("fails-late", {}, async () => {
					entered.resolve();
					await release.promise;
					throw new Error("original tool failure");
				});
				return {};
			},
		});

		const pending = run(definition, {}, { store, durableBackend: backend });
		await entered.promise;
		const live = store.runs()[0]?.toolNodes?.[0];
		assert.equal(live?.status, "running");
		assert.equal(live?.name, "fails-late");
		assert.equal(live?.attachable, false);
		assert.equal(typeof live?.startedAt, "number");
		unsubscribe();
		assert.deepEqual(observedStatuses.slice(0, 2), ["pending", "running"]);
		assert.equal(live?.endedAt, undefined);
		release.resolve();

		const result = await pending;
		assert.equal(result.status, "failed");
		assert.match(result.error ?? "", /original tool failure/);
		assert.equal(store.runs()[0]?.failedStageId, undefined);
		assert.equal(result.toolNodes?.[0]?.status, "failed");
		assert.match(result.toolNodes?.[0]?.error ?? "", /original tool failure/);
		assert.equal(
			backend
				.listCheckpoints(result.runId)
				.some(
					(entry) =>
						entry.kind === "tool" &&
						entry.name === "fails-late" &&
						entry.throwingFailureError === "original tool failure",
				),
			true,
		);
		assert.equal(backend.getToolCheckpoint(result.runId, result.toolNodes![0]!.argsHash), undefined);
	});

	test("preserves tool-before, between, after, duplicate order with stage topology", async () => {
		const store = createStore();
		const definition = workflow({
			name: "mixed-tool-order",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.tool("first", {}, async () => "first");
				await ctx.stage("stage-one").prompt("one");
				await ctx.tool("middle", {}, async () => "middle");
				await ctx.stage("stage-two").prompt("two");
				await ctx.tool("last", {}, async () => "last");
				await ctx.tool("last", {}, async () => "last-again");
				return {};
			},
		});

		const result = await run(
			definition,
			{},
			{
				store,
				durableBackend: new InMemoryDurableBackend(),
				adapters: { prompt: { prompt: async (text) => text } },
			},
		);
		assert.equal(result.status, "completed");
		const snapshot = store.runs()[0]!;
		const ordered = [
			...snapshot.stages.map((stage) => ({ name: stage.name, order: stage.executionOrder })),
			...(snapshot.toolNodes ?? []).map((node) => ({ name: node.name, order: node.executionOrder })),
		].sort((left, right) => (left.order ?? 0) - (right.order ?? 0));
		assert.deepEqual(
			ordered.map((item) => item.name),
			["first", "stage-one", "middle", "stage-two", "last", "last"],
		);
		assert.equal(snapshot.toolNodes?.[2]?.ordinal, 1);
		assert.equal(snapshot.toolNodes?.[3]?.ordinal, 2);
		assert.deepEqual(snapshot.stages[0]?.parentIds, [snapshot.toolNodes?.[0]?.id]);
		assert.deepEqual(snapshot.toolNodes?.[1]?.parentIds, [snapshot.stages[0]?.id]);
	});

	test("replays a legacy tool checkpoint without rerunning and reconstructs cached topology", async () => {
		const workflowId = testRunId("legacy-tool-only");
		const backend = new InMemoryDurableBackend();
		backend.registerWorkflow({
			workflowId,
			name: testRunId("legacy-tool-only"),
			inputs: {},
			createdAt: 1,
			status: "paused",
			resumable: true,
		});
		const { durableHash } = await import("../../packages/workflows/src/durable/backend.js");
		const argsHash = durableHash({ name: "legacy", args: {}, ordinal: 1 });
		backend.recordCheckpoint({
			kind: "tool",
			workflowId,
			checkpointId: `tool:${argsHash}`,
			name: "legacy",
			argsHash,
			output: { raw: true },
			completedAt: 2,
		});
		let calls = 0;
		const definition = workflow({
			name: testRunId("legacy-tool-only"),
			description: "",
			inputs: {},
			outputs: { raw: Type.Boolean() },
			run: async (ctx) => {
				const value = await ctx.tool("legacy", {}, async () => {
					calls += 1;
					return { raw: false };
				});
				return value;
			},
		});

		const result = await run(definition, {}, { runId: workflowId, store: createStore(), durableBackend: backend });
		assert.equal(result.status, "completed");
		assert.deepEqual(result.result, { raw: true });
		assert.equal(calls, 0);
		assert.equal(result.toolNodes?.[0]?.status, "cached");
		assert.equal(result.toolNodes?.[0]?.id, `tool:${argsHash}`);
		assert.equal(result.toolNodes?.[0]?.executionOrder, 1);
	});

	test("accepts a conditional branch whose only graph execution is ctx.tool", async () => {
		const definition = workflow({
			name: "conditional-tool-only",
			description: "",
			inputs: { mutate: Type.Boolean() },
			outputs: { done: Type.Boolean() },
			run: async (ctx) => {
				if (ctx.inputs.mutate) await ctx.tool("conditional", {}, async () => true);
				return { done: true };
			},
		});
		const result = await run(
			definition,
			{ mutate: true },
			{ store: createStore(), durableBackend: new InMemoryDurableBackend() },
		);
		assert.equal(result.status, "completed");
		assert.equal(result.toolNodes?.[0]?.name, "conditional");
	});

	test("cancellation leaves a cancelled node and no completed tool checkpoint", async () => {
		const store = createStore();
		const backend = new InMemoryDurableBackend();
		const controller = new AbortController();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const definition = workflow({
			name: "cancelled-tool",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.tool("cancel-me", {}, async () => {
					entered.resolve();
					await release.promise;
					return "late";
				});
				return {};
			},
		});
		const pending = run(definition, {}, { store, durableBackend: backend, signal: controller.signal });
		await entered.promise;
		controller.abort(new Error("stop"));
		release.resolve();
		const result = await pending;
		assert.equal(result.status, "killed");
		assert.equal(result.toolNodes?.[0]?.status, "cancelled");
		assert.equal(
			backend.listCheckpoints(result.runId).some((entry) => entry.kind === "tool" && entry.name === "cancel-me"),
			false,
		);
	});
});

function abortObserved(signal: AbortSignal): Promise<void> {
	return new Promise<void>((resolve) => {
		if (signal.aborted) {
			resolve();
			return;
		}
		signal.addEventListener("abort", () => resolve(), { once: true });
	});
}

/** Narrow a control-action result to its user-visible status/message pair. */
function controlOutcome(result: WorkflowToolResult): { readonly status: string; readonly message: string } {
	if (!("status" in result) || !("message" in result)) {
		throw new Error(`expected a control result, received: ${JSON.stringify(result)}`);
	}
	return { status: String(result.status), message: String(result.message) };
}

/** Narrow a control-action result to the tool-node abort branch. */
function toolNodeControlOutcome(result: WorkflowToolResult): ToolNodeControlResult {
	if (!("workflowStatus" in result) || !("abandoned" in result)) {
		throw new Error(`expected a tool-node control result, received: ${JSON.stringify(result)}`);
	}
	return result;
}

describe("ctx.tool node cancellation controls", () => {
	afterEach(() => {
		singletonStore.clear();
		toolControlRegistry.clear();
		setDurableBackend(undefined);
	});

	test("hands the callback a live abort signal that a run abort reaches promptly", async () => {
		const store = createStore();
		const backend = new InMemoryDurableBackend();
		const controller = new AbortController();
		const entered = Promise.withResolvers<void>();
		let abortedAtEntry: boolean | undefined;
		let observedAbort = false;
		const definition = workflow({
			name: "tool-signal-run-abort",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.tool("watch-signal", {}, async ({ signal }) => {
					abortedAtEntry = signal.aborted;
					entered.resolve();
					await abortObserved(signal);
					observedAbort = true;
					return "late";
				});
				return {};
			},
		});

		const pending = run(definition, {}, { store, durableBackend: backend, signal: controller.signal });
		await entered.promise;
		assert.equal(abortedAtEntry, false, "the callback signal starts unaborted");
		controller.abort(new Error("stop"));

		const result = await pending;
		assert.equal(observedAbort, true, "a run abort must reach the callback signal");
		assert.equal(result.status, "killed");
		assert.equal(result.toolNodes?.[0]?.status, "cancelled");
		assert.equal(
			backend.listCheckpoints(result.runId).some((entry) => entry.kind === "tool"),
			false,
		);
	});

	test("quit with a tool node id aborts only that node and leaves siblings running", async () => {
		const backend = new InMemoryDurableBackend();
		setDurableBackend(backend);
		const runId = testRunId("tool-node-targeted-quit");
		const enteredTarget = Promise.withResolvers<void>();
		const enteredSibling = Promise.withResolvers<void>();
		const releaseSibling = Promise.withResolvers<void>();
		let siblingSignal: AbortSignal | undefined;
		let siblingCompleted = false;
		const definition = workflow({
			name: testRunId("tool-node-targeted-quit"),
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await Promise.allSettled([
					ctx.tool("abort-me", {}, async ({ signal }) => {
						enteredTarget.resolve();
						await abortObserved(signal);
						throw new Error("abort-me observed cancellation");
					}),
					ctx.tool("sibling", {}, async ({ signal }) => {
						siblingSignal = signal;
						enteredSibling.resolve();
						await releaseSibling.promise;
						siblingCompleted = true;
						return "sibling-done";
					}),
				]);
				return {};
			},
		});
		const execute = makeExecuteWorkflowTool(
			createExtensionRuntime({ definitions: [definition], store: singletonStore }),
			() => undefined,
			() => undefined,
		);

		const pending = run(definition, {}, { runId, store: singletonStore, durableBackend: backend });
		await Promise.all([enteredTarget.promise, enteredSibling.promise]);
		const nodes = singletonStore.runs().find((candidate) => candidate.id === runId)?.toolNodes ?? [];
		const targetNodeId = nodes.find((node) => node.name === "abort-me")?.id;
		const siblingNodeId = nodes.find((node) => node.name === "sibling")?.id;
		assert.ok(targetNodeId);
		assert.ok(siblingNodeId);

		const quit = toolNodeControlOutcome(await execute({ action: "quit", runId, stageId: targetNodeId }, {} as never));

		assert.equal(quit.action, "quit");
		assert.equal(quit.status, "cancelled", "a targeted abort cancels a node; it never pauses the run");
		assert.equal(quit.stageId, targetNodeId);
		assert.equal(quit.abandoned, false);
		assert.equal(
			quit.workflowStatus,
			singletonStore.runs().find((candidate) => candidate.id === runId)?.status,
			"workflowStatus reports the status observed when the action returned",
		);
		assert.equal(quit.workflowStatus, "running");
		assert.match(quit.message, /Cancelled ctx\.tool abort-me/);
		assert.match(quit.message, /Sibling work was not aborted/);
		assert.doesNotMatch(quit.message, /run keeps going/i);
		const liveRun = singletonStore.runs().find((candidate) => candidate.id === runId);
		assert.equal(liveRun?.toolNodes?.find((node) => node.id === targetNodeId)?.status, "cancelled");
		assert.equal(liveRun?.toolNodes?.find((node) => node.id === siblingNodeId)?.status, "running");
		assert.equal(siblingSignal?.aborted, false, "a targeted abort must not cascade to sibling nodes");
		assert.equal(liveRun?.status, "running", "the run keeps going after one node is aborted");

		releaseSibling.resolve();
		const result = await pending;
		assert.equal(siblingCompleted, true);
		assert.equal(result.status, "completed");
		assert.equal(result.toolNodes?.find((node) => node.id === siblingNodeId)?.status, "completed");
		assert.equal(result.toolNodes?.find((node) => node.id === targetNodeId)?.status, "cancelled");
		const toolCheckpoints = backend
			.listCheckpoints(runId)
			.flatMap((entry) => (entry.kind === "tool" && entry.checkpointId.startsWith("tool:") ? [entry.name] : []));
		assert.deepEqual(toolCheckpoints, ["sibling"], "only the completed sibling is replayable");
	});

	test("an uncaught awaited cancellation reports the node cancelled and the run's real status", async () => {
		const backend = new InMemoryDurableBackend();
		setDurableBackend(backend);
		const runId = testRunId("tool-node-uncaught-abort");
		const entered = Promise.withResolvers<void>();
		const definition = workflow({
			name: testRunId("tool-node-uncaught-abort"),
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				// Awaited without catching: ordinary author control flow decides the run.
				await ctx.tool("abort-me", {}, async ({ signal }) => {
					entered.resolve();
					await abortObserved(signal);
					throw new Error("abort-me observed cancellation");
				});
				return {};
			},
		});
		const execute = makeExecuteWorkflowTool(
			createExtensionRuntime({ definitions: [definition], store: singletonStore }),
			() => undefined,
			() => undefined,
		);

		const pending = run(definition, {}, { runId, store: singletonStore, durableBackend: backend });
		await entered.promise;
		const nodeId = singletonStore.runs().find((candidate) => candidate.id === runId)?.toolNodes?.[0]?.id;
		assert.ok(nodeId);

		const aborted = toolNodeControlOutcome(
			await execute({ action: "interrupt", runId, stageId: nodeId }, {} as never),
		);

		assert.equal(aborted.action, "interrupt");
		assert.equal(aborted.status, "cancelled", "the action never reports the run as paused");
		assert.equal(aborted.stageId, nodeId);
		assert.equal(aborted.abandoned, false);
		assert.equal(
			aborted.workflowStatus,
			singletonStore.runs().find((candidate) => candidate.id === runId)?.status,
			"workflowStatus is the observed status, not a prediction",
		);
		assert.match(aborted.message, /workflow code awaited this call without catching cancellation/);

		const result = await pending;
		assert.equal(result.status, "failed", "an uncaught cancellation fails the run by author semantics");
		assert.equal(result.toolNodes?.[0]?.status, "cancelled", "the node stays cancelled, not failed");
		assert.equal(
			backend
				.listCheckpoints(runId)
				.some((entry) => entry.kind === "tool" && entry.checkpointId.startsWith("tool:")),
			false,
			"an aborted call leaves nothing replayable",
		);
	});

	test("interrupt resolves a unique tool name, rejects an ambiguous one, and refuses pause", async () => {
		const backend = new InMemoryDurableBackend();
		setDurableBackend(backend);
		const runId = testRunId("tool-node-name-routing");
		const entered: Array<Promise<void>> = [];
		const enteredResolvers = [
			Promise.withResolvers<void>(),
			Promise.withResolvers<void>(),
			Promise.withResolvers<void>(),
		];
		for (const resolver of enteredResolvers) entered.push(resolver.promise);
		const releaseDuplicates = Promise.withResolvers<void>();
		const definition = workflow({
			name: testRunId("tool-node-name-routing"),
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await Promise.allSettled([
					ctx.tool("unique", {}, async ({ signal }) => {
						enteredResolvers[0]!.resolve();
						await abortObserved(signal);
						throw new Error("unique aborted");
					}),
					ctx.tool("duplicate", { slot: 1 }, async () => {
						enteredResolvers[1]!.resolve();
						await releaseDuplicates.promise;
						return "first";
					}),
					ctx.tool("duplicate", { slot: 2 }, async () => {
						enteredResolvers[2]!.resolve();
						await releaseDuplicates.promise;
						return "second";
					}),
				]);
				return {};
			},
		});
		const execute = makeExecuteWorkflowTool(
			createExtensionRuntime({ definitions: [definition], store: singletonStore }),
			() => undefined,
			() => undefined,
		);

		const pending = run(definition, {}, { runId, store: singletonStore, durableBackend: backend });
		await Promise.all(entered);

		const pauseRejected = controlOutcome(
			await execute({ action: "pause", runId, stageId: "duplicate" }, {} as never),
		);
		assert.equal(pauseRejected.status, "noop");
		assert.match(pauseRejected.message, /Ambiguous stage identifier "duplicate"/);

		const pauseTool = controlOutcome(await execute({ action: "pause", runId, stageId: "unique" }, {} as never));
		assert.equal(pauseTool.status, "noop");
		assert.match(pauseTool.message, /Tool nodes cannot be paused/);
		assert.match(pauseTool.message, /Use interrupt or quit to abort it/);

		const ambiguous = controlOutcome(
			await execute({ action: "interrupt", runId, stageId: "duplicate" }, {} as never),
		);
		assert.equal(ambiguous.status, "noop");
		assert.match(ambiguous.message, /Ambiguous stage identifier "duplicate" matches: duplicate \(tool\)/);

		const interrupted = controlOutcome(await execute({ action: "interrupt", runId, stageId: "unique" }, {} as never));
		assert.match(interrupted.message, /Cancelled ctx\.tool unique/);
		const uniqueNode = singletonStore
			.runs()
			.find((candidate) => candidate.id === runId)
			?.toolNodes?.find((node) => node.name === "unique");
		assert.equal(uniqueNode?.status, "cancelled");

		releaseDuplicates.resolve();
		assert.equal((await pending).status, "completed");
	});

	test("a cancelled tool node renders distinctly from a failed one", async () => {
		const store = createStore();
		const backend = new InMemoryDurableBackend();
		const toolControls = createToolControlRegistry();
		const entered = Promise.withResolvers<void>();
		const definition = workflow({
			name: testRunId("tool-cancelled-rendering"),
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await Promise.allSettled([
					ctx.tool("aborted-call", {}, async ({ signal }) => {
						entered.resolve();
						await abortObserved(signal);
						throw new Error("aborted-call observed cancellation");
					}),
					ctx.tool("failed-call", {}, async () => {
						throw new Error("publish rejected");
					}),
				]);
				return {};
			},
		});

		const pending = run(
			definition,
			{},
			{
				runId: testRunId("tool-cancelled-rendering"),
				store,
				durableBackend: backend,
				toolControlRegistry: toolControls,
			},
		);
		await entered.promise;
		const liveNode = store.runs()[0]?.toolNodes?.find((node) => node.name === "aborted-call");
		assert.ok(liveNode);
		await abortToolNode(testRunId("tool-cancelled-rendering"), liveNode.id, {
			store,
			toolControlRegistry: toolControls,
		});
		const result = await pending;

		const snapshot = store.runs().find((candidate) => candidate.id === result.runId)!;
		assert.deepEqual(
			snapshot.toolNodes?.map((node) => [node.name, node.status]),
			[
				["aborted-call", "cancelled"],
				["failed-call", "failed"],
			],
		);
		const summary = summarizeRunSnapshot(snapshot, Date.now());
		const statusText = renderWorkflowToolContent(
			{ action: "status", filter: "all", runs: [summary], snapshots: [snapshot] },
			{ action: "status" },
		);
		assert.match(statusText, /aborted-call \(cancelled\)/);
		assert.match(statusText, /failed-call \(failed\)/);

		const inspected = inspectRun(result.runId, { store });
		assert.equal(inspected.ok, true);
		if (inspected.ok) {
			assert.deepEqual(
				inspected.detail.tools?.map((node) => node.status),
				["cancelled", "failed"],
			);
		}

		const graph = expandWorkflowGraph(store.snapshot(), result.runId);
		const cancelledCard = graph.renderStages.find((stage) => stage.name === "aborted-call");
		const failedCard = graph.renderStages.find((stage) => stage.name === "failed-call");
		assert.equal(cancelledCard?.status, "skipped", "a cancelled tool is not projected as failed");
		assert.equal(cancelledCard?.toolStatus, "cancelled");
		assert.equal(failedCard?.status, "failed");
		const theme = deriveGraphTheme();
		const cancelledLines = renderNodeCard(cancelledCard!, { theme }).join("\n");
		const failedLines = renderNodeCard(failedCard!, { theme }).join("\n");
		assert.match(cancelledLines, /cancelled/);
		assert.doesNotMatch(cancelledLines, /failed/);
		assert.match(failedLines, /failed/);
		assert.notEqual(
			cancelledLines.replace(/cancelled/g, ""),
			failedLines.replace(/failed/g, ""),
			"cancelled and failed tool cards must not render identically",
		);
	});
});
