import assert from "node:assert/strict";
import { Type } from "typebox";
import { describe, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { GraphFrontierTracker } from "../../packages/workflows/src/engine/graph-inference.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createToolNodeLifecycle } from "../../packages/workflows/src/engine/run-tool-node-lifecycle.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import {
	claimActiveBlockedResume,
	finalizeActiveBlockedSourceAfterContinuation,
	finalizeResumedActiveBlockedSourceRun,
} from "../../packages/workflows/src/extension/runtime-active-block-claim.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { createContinuationReplayIndex } from "../../packages/workflows/src/runs/foreground/executor-continuation.js";
import { type SessionEntry, scanInFlightRuns } from "../../packages/workflows/src/shared/persistence-restore.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot, StageSnapshot, ToolNodeSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { waitForExecutorStagePendingPrompt } from "./executor-shared.js";

function toolNode(id: string, status: ToolNodeSnapshot["status"] = "completed"): ToolNodeSnapshot {
	return {
		kind: "tool",
		id,
		name: "preflight",
		argsHash: "preflight-hash",
		ordinal: 1,
		parentIds: [],
		status,
		attachable: false,
	};
}

function stage(input: {
	readonly id: string;
	readonly name: string;
	readonly status: StageSnapshot["status"];
	readonly parentIds: readonly string[];
}): StageSnapshot {
	return {
		id: input.id,
		name: input.name,
		status: input.status,
		parentIds: input.parentIds,
		toolEvents: [],
		replayKey: `stage:task:${input.name}:1`,
	};
}

function sourceRun(stages: StageSnapshot[], toolNodes: ToolNodeSnapshot[] = []): RunSnapshot {
	return {
		id: "source-run",
		name: "tool-parent-continuation",
		inputs: {},
		status: "failed",
		stages,
		toolNodes,
		startedAt: 1,
		failedStageId: stages.find((candidate) => candidate.status !== "completed")?.id,
	};
}

describe("continuation tool-parent identity map", () => {
	test("translates a pre-seeded tool parent and replays the completed child", () => {
		const toolId = "tool:preflight";
		const completed = stage({
			id: "source-completed",
			name: "mapping 1",
			status: "completed",
			parentIds: [toolId],
		});
		const incomplete = stage({
			id: "source-incomplete",
			name: "mapping 2",
			status: "running",
			parentIds: [toolId],
		});
		const identities = new Map<string, string>([[toolId, toolId]]);
		const index = createContinuationReplayIndex(
			{
				source: sourceRun([completed, incomplete]),
				resumeFromStageId: incomplete.id,
			},
			identities,
		);

		const replayed = index.decide({
			displayName: completed.name,
			replayKey: completed.replayKey!,
			parentIds: [toolId],
			stageId: "continuation-completed",
			kind: "stage",
		});
		assert.equal(replayed.kind, "replay");
		assert.deepEqual(replayed.parentIds, [toolId]);
		assert.equal(identities.get(completed.id), "continuation-completed");

		const executed = index.decide({
			displayName: incomplete.name,
			replayKey: incomplete.replayKey!,
			parentIds: [toolId],
			stageId: "continuation-incomplete",
			kind: "stage",
		});
		assert.equal(executed.kind, "execute");
		assert.deepEqual(executed.parentIds, [toolId]);
	});

	test("does not translate a snapshot tool parent that was never admitted", () => {
		const toolId = "tool:preflight";
		const completed = stage({
			id: "source-completed",
			name: "mapping 1",
			status: "completed",
			parentIds: [toolId],
		});
		const index = createContinuationReplayIndex(
			{
				source: sourceRun([completed], [toolNode(toolId)]),
				resumeFromStageId: completed.id,
			},
			new Map(),
		);

		assert.throws(
			() =>
				index.decide({
					displayName: completed.name,
					replayKey: completed.replayKey!,
					parentIds: [toolId],
					stageId: "continuation-completed",
					kind: "stage",
				}),
			/insufficient_state: replay topology mismatch/,
		);
	});

	test("rejects a completed child whose tool parent is absent from the identity map", () => {
		const completed = stage({
			id: "source-completed",
			name: "mapping 1",
			status: "completed",
			parentIds: ["tool:missing"],
		});
		const index = createContinuationReplayIndex(
			{
				source: sourceRun([completed], []),
				resumeFromStageId: completed.id,
			},
			new Map(),
		);

		assert.throws(
			() =>
				index.decide({
					displayName: completed.name,
					replayKey: completed.replayKey!,
					parentIds: ["tool:missing"],
					stageId: "continuation-completed",
					kind: "stage",
				}),
			/insufficient_state: replay topology mismatch/,
		);
	});

	test("still rejects a genuine parent change after tool identities are translated", () => {
		const toolId = "tool:preflight";
		const completed = stage({
			id: "source-completed",
			name: "mapping 1",
			status: "completed",
			parentIds: [toolId],
		});
		const index = createContinuationReplayIndex(
			{
				source: sourceRun([completed]),
				resumeFromStageId: completed.id,
			},
			new Map([[toolId, toolId]]),
		);

		assert.throws(
			() =>
				index.decide({
					displayName: completed.name,
					replayKey: completed.replayKey!,
					parentIds: ["stage:inserted-parent"],
					stageId: "continuation-completed",
					kind: "stage",
				}),
			/insufficient_state: replay topology mismatch/,
		);
	});

	test("fresh-id continuation rejects a changed tool graph instead of keeping stale parents", async () => {
		const backend = new InMemoryDurableBackend();
		let toolCalls = 0;
		const sourceDef = workflow({
			name: "changed-tool-graph",
			description: "",
			inputs: {},
			outputs: { result: Type.String() },
			run: async (ctx) => {
				await ctx.tool("root", { n: 1 }, async () => {
					toolCalls += 1;
					return "ready";
				});
				await ctx.stage("after").prompt("after");
				return { result: "done" };
			},
		});
		const sourceStore = createStore();
		const first = await run(
			sourceDef,
			{},
			{
				store: sourceStore,
				durableBackend: backend,
				adapters: {
					prompt: {
						prompt: async (text) => {
							if (text === "after") throw new Error("source after failed");
							return text;
						},
					},
				},
			},
		);
		assert.equal(first.status, "failed");
		assert.equal(toolCalls, 1);
		const source = sourceStore.runs().find((candidate) => candidate.id === first.runId);
		assert.ok(source);
		const changedDef = workflow({
			name: "changed-tool-graph",
			description: "",
			inputs: {},
			outputs: { result: Type.String() },
			run: async (ctx) => {
				await ctx.stage("inserted").prompt("inserted");
				await ctx.tool("root", { n: 1 }, async () => {
					toolCalls += 1;
					return "ready";
				});
				return { result: "done" };
			},
		});
		const continued = await run(
			changedDef,
			{},
			{
				store: createStore(),
				durableBackend: backend,
				continuation: { source, resumeFromStageId: source.failedStageId },
				adapters: { prompt: { prompt: async (text) => text } },
			},
		);
		assert.equal(continued.status, "failed");
		assert.match(continued.error ?? "", /insufficient_state: replay topology mismatch/);
		assert.equal(toolCalls, 1);
		assert.equal(continued.result?.result, undefined);
	});

	test("fresh-id continuation rejects an inserted parent before a parented tool", async () => {
		const backend = new InMemoryDurableBackend();
		let toolCalls = 0;
		const sourceDef = workflow({
			name: "parented-tool-insert",
			description: "",
			inputs: {},
			outputs: { result: Type.String() },
			run: async (ctx) => {
				await ctx.stage("a").prompt("a");
				await ctx.tool("t", { n: 1 }, async () => {
					toolCalls += 1;
					return "t";
				});
				await ctx.stage("b").prompt("b");
				return { result: "done" };
			},
		});
		const sourceStore = createStore();
		const first = await run(
			sourceDef,
			{},
			{
				store: sourceStore,
				durableBackend: backend,
				adapters: {
					prompt: {
						prompt: async (text) => {
							if (text === "b") throw new Error("source b failed");
							return text;
						},
					},
				},
			},
		);
		assert.equal(first.status, "failed");
		assert.equal(toolCalls, 1);
		const source = sourceStore.runs().find((candidate) => candidate.id === first.runId);
		assert.ok(source);
		const changedDef = workflow({
			name: "parented-tool-insert",
			description: "",
			inputs: {},
			outputs: { result: Type.String() },
			run: async (ctx) => {
				await ctx.stage("a").prompt("a");
				await ctx.stage("inserted").prompt("inserted");
				await ctx.tool("t", { n: 1 }, async () => {
					toolCalls += 1;
					return "t";
				});
				return { result: "done" };
			},
		});
		const continued = await run(
			changedDef,
			{},
			{
				store: createStore(),
				durableBackend: backend,
				continuation: { source, resumeFromStageId: source.failedStageId },
				adapters: { prompt: { prompt: async (text) => text } },
			},
		);
		assert.equal(continued.status, "failed");
		assert.match(continued.error ?? "", /insufficient_state: replay topology mismatch/);
		assert.equal(toolCalls, 1);
	});

	test("fresh-id continuation rejects a tool whose restored parents cannot be translated", async () => {
		const backend = new InMemoryDurableBackend();
		let toolCalls = 0;
		const sourceDef = workflow({
			name: "untranslated-tool-parent",
			description: "",
			inputs: {},
			outputs: { result: Type.String() },
			run: async (ctx) => {
				await ctx.stage("a").prompt("a");
				await ctx.tool("t", { n: 1 }, async () => {
					toolCalls += 1;
					return "t";
				});
				await ctx.stage("after").prompt("after");
				return { result: "done" };
			},
		});
		const sourceStore = createStore();
		const first = await run(
			sourceDef,
			{},
			{
				store: sourceStore,
				durableBackend: backend,
				adapters: {
					prompt: {
						prompt: async (text) => {
							if (text === "after") throw new Error("source after failed");
							return text;
						},
					},
				},
			},
		);
		assert.equal(first.status, "failed");
		assert.equal(toolCalls, 1);
		const source = sourceStore.runs().find((candidate) => candidate.id === first.runId);
		assert.ok(source);
		const changedDef = workflow({
			name: "untranslated-tool-parent",
			description: "",
			inputs: {},
			outputs: { result: Type.String() },
			run: async (ctx) => {
				await ctx.stage("z").prompt("z");
				await ctx.tool("t", { n: 1 }, async () => {
					toolCalls += 1;
					return "t";
				});
				return { result: "done" };
			},
		});
		const continued = await run(
			changedDef,
			{},
			{
				store: createStore(),
				durableBackend: backend,
				continuation: { source, resumeFromStageId: source.failedStageId },
				adapters: { prompt: { prompt: async (text) => text } },
			},
		);
		assert.equal(continued.status, "failed");
		assert.match(continued.error ?? "", /insufficient_state: replay topology mismatch/);
		assert.equal(toolCalls, 1);
	});

	test("fresh-id continuation keeps a tool parented by a when a replayed sibling stage settles first", async () => {
		const backend = new InMemoryDurableBackend();
		let toolCalls = 0;
		let failAfter = true;
		const definition = workflow({
			name: "tool-after-live-stage",
			description: "",
			inputs: {},
			outputs: { result: Type.String() },
			run: async (ctx) => {
				await ctx.stage("a").prompt("a");
				const b = ctx.stage("b").prompt("b");
				await ctx.tool("t", { n: 1 }, async () => {
					toolCalls += 1;
					return "t";
				});
				await b;
				await ctx.stage("c").prompt("c");
				return { result: "done" };
			},
		});
		const adapters = {
			prompt: {
				prompt: async (text: string) => {
					if (failAfter && text === "c") throw new Error("source c failed");
					return text;
				},
			},
		};
		const sourceStore = createStore();
		const first = await run(definition, {}, { store: sourceStore, durableBackend: backend, adapters });
		assert.equal(first.status, "failed");
		assert.equal(toolCalls, 1);
		const source = sourceStore.runs().find((candidate) => candidate.id === first.runId);
		assert.ok(source);
		failAfter = false;
		const continued = await run(
			definition,
			{},
			{
				store: createStore(),
				durableBackend: backend,
				budget: { maxTokens: 10_000 },
				continuation: { source, resumeFromStageId: source.failedStageId },
				adapters,
			},
		);
		assert.equal(continued.status, "completed", continued.error);
		assert.equal(toolCalls, 1);
		const seed = continued.stages.find((stage) => stage.name === "a");
		const tool = continued.toolNodes?.[0];
		assert.ok(seed);
		assert.ok(tool);
		assert.deepEqual(tool.parentIds, [seed.id]);
	});

	test("fresh-id continuation keeps cached tool siblings parented by the shared seed", async () => {
		const backend = new InMemoryDurableBackend();
		let toolCalls = 0;
		let failAfter = true;
		const definition = workflow({
			name: "sibling-tool-continuation",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.stage("seed").prompt("seed");
				const left = ctx.tool("left", {}, async () => {
					toolCalls += 1;
					return "left";
				});
				await Promise.resolve();
				const right = ctx.tool("right", {}, async () => {
					toolCalls += 1;
					return "right";
				});
				await Promise.all([left, right]);
				await ctx.stage("after").prompt("after");
				return {};
			},
		});
		const adapters = {
			prompt: {
				prompt: async (text: string) => {
					if (failAfter && text === "after") throw new Error("source after failed");
					return text;
				},
			},
		};
		const sourceStore = createStore();
		const first = await run(definition, {}, { store: sourceStore, durableBackend: backend, adapters });
		assert.equal(first.status, "failed");
		assert.equal(toolCalls, 2);
		const source = sourceStore.runs().find((candidate) => candidate.id === first.runId);
		assert.ok(source);
		failAfter = false;
		const continued = await run(
			definition,
			{},
			{
				store: createStore(),
				durableBackend: backend,
				continuation: { source, resumeFromStageId: source.failedStageId },
				adapters,
			},
		);
		assert.equal(continued.status, "completed", continued.error);
		assert.equal(toolCalls, 2);
		const seed = continued.stages.find((stage) => stage.name === "seed");
		assert.ok(seed);
		const tools = continued.toolNodes ?? [];
		assert.equal(tools.length, 2);
		assert.deepEqual(
			tools.map((tool) => tool.parentIds),
			[[seed.id], [seed.id]],
		);
	});

	test("fresh-id continuation keeps cached seedless tool siblings at the root", async () => {
		const backend = new InMemoryDurableBackend();
		let toolCalls = 0;
		let failAfter = true;
		let insertParent = false;
		let releaseLeft: (() => void) | undefined;
		const definition = workflow({
			name: "seedless-sibling-tool-continuation",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				const left = ctx.tool("left", {}, async () => {
					toolCalls += 1;
					await new Promise<void>((resolve) => {
						releaseLeft = resolve;
					});
					return "left";
				});
				if (failAfter) await Promise.resolve();
				else await left;
				if (insertParent) await ctx.stage("inserted").prompt("inserted");
				const right = ctx.tool("right", {}, async () => {
					toolCalls += 1;
					releaseLeft?.();
					return "right";
				});
				await Promise.all([left, right]);
				await ctx.stage("after").prompt("after");
				return {};
			},
		});
		const adapters = {
			prompt: {
				prompt: async (text: string) => {
					if (failAfter) throw new Error("source after failed");
					return text;
				},
			},
		};
		const sourceStore = createStore();
		const first = await run(definition, {}, { store: sourceStore, durableBackend: backend, adapters });
		assert.equal(first.status, "failed");
		assert.equal(toolCalls, 2);
		const source = sourceStore.runs().find((candidate) => candidate.id === first.runId);
		assert.ok(source);
		failAfter = false;
		const continued = await run(
			definition,
			{},
			{
				store: createStore(),
				durableBackend: backend,
				continuation: { source, resumeFromStageId: source.failedStageId },
				adapters,
			},
		);
		assert.equal(continued.status, "completed", continued.error);
		assert.equal(toolCalls, 2);
		assert.equal(continued.toolNodes?.length, 2);

		assert.deepEqual(
			continued.toolNodes?.map((tool) => tool.parentIds),
			[[], []],
		);
		insertParent = true;
		const changed = await run(
			definition,
			{},
			{
				store: createStore(),
				durableBackend: backend,
				continuation: { source, resumeFromStageId: source.failedStageId },
				adapters,
			},
		);
		assert.equal(changed.status, "failed");
		assert.match(changed.error ?? "", /insufficient_state: replay topology mismatch/);
		assert.equal(toolCalls, 2);
	});

	test("seedless replay rejects a sibling whose replayed parent moved deeper", () => {
		const store = createStore();
		const resumed: RunSnapshot = {
			id: "continued",
			name: "deeper-replayed-parent",
			inputs: {},
			status: "running",
			stages: [],
			startedAt: 1,
			resumedFromRunId: "source",
		};
		store.recordRunStart(resumed);
		const tracker = new GraphFrontierTracker();
		tracker.onSpawn("seed", "seed");
		tracker.onSettle("seed");
		const lifecycle = createToolNodeLifecycle({
			store,
			tracker,
			run: resumed,
			sourceToContinuationNodeIds: new Map([["source-seed", "seed"]]),
		});
		lifecycle.onNodeStart?.({
			...toolNode("tool:left"),
			parentIds: ["source-seed"],
			replayed: true,
		});
		lifecycle.onNodeSettle?.("tool:left");
		assert.throws(
			() => lifecycle.onNodeStart?.({ ...toolNode("tool:right"), replayed: true }),
			/insufficient_state: replay topology mismatch/,
		);
	});

	test("active-blocked resume stays retryable after a fail-closed tool-graph mismatch", async () => {
		const backend = new InMemoryDurableBackend();
		setDurableBackend(backend);
		let insertParent = false;
		let toolCalls = 0;
		const definition = workflow({
			name: "retry-after-mismatch",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.stage("a").prompt("a");
				if (insertParent) await ctx.stage("inserted").prompt("inserted");
				await ctx.tool("t", { n: 1 }, async () => {
					toolCalls += 1;
					return "t";
				});
				await ctx.stage("b").prompt("b");
				return {};
			},
		});
		const store = createStore();
		const first = await run(
			definition,
			{},
			{
				store,
				durableBackend: backend,
				adapters: {
					prompt: {
						prompt: async (text) => {
							if (text === "b") throw new Error("HTTP 429 quota exceeded");
							return text;
						},
					},
				},
			},
		);
		assert.equal(first.status, "running");
		assert.equal(toolCalls, 1);
		const source = store.runs().find((candidate) => candidate.id === first.runId);
		assert.ok(source);
		assert.equal(source.resumable, true);
		assert.equal(source.endedAt, undefined);
		assert.equal(source.failureRecoverability, "recoverable");
		backend.registerWorkflow({
			workflowId: source.id,
			name: definition.name,
			inputs: {},
			createdAt: 1,
			status: "blocked",
			resumable: true,
		});
		const jobs = createJobTracker();
		const runtime = createExtensionRuntime({
			registry: createRegistry([definition]),
			store,
			jobs,
			adapters: { prompt: { prompt: async (text) => text } },
		});
		insertParent = true;
		const mismatched = await runtime.resumeFailedRun(source.id);
		assert.equal(mismatched.ok, true);
		if (!mismatched.ok) return;
		assert.equal(
			store.runs().filter((run) => run.endedAt === undefined).length,
			1,
			"claimed source must not stay a second active local entry",
		);
		assert.equal(store.runs().find((run) => run.endedAt === undefined)?.id, mismatched.runId);
		await jobs.get(mismatched.runId)?.promise;
		assert.match(store.runs().find((run) => run.id === mismatched.runId)?.error ?? "", /replay topology mismatch/);
		const blocked = store.runs().find((run) => run.id === source.id);
		assert.ok(blocked);
		assert.notEqual(blocked.status, "killed");
		assert.equal(blocked.resumable, true);
		assert.equal(blocked.endedAt, undefined);
		insertParent = false;
		const retried = await runtime.resumeFailedRun(source.id);
		assert.equal(retried.ok, true, retried.ok ? undefined : retried.message);
		if (!retried.ok) return;
		await jobs.get(retried.runId)?.promise;
		assert.equal(store.runs().find((run) => run.id === retried.runId)?.status, "completed");
		assert.equal(toolCalls, 1);
		assert.equal(store.runs().find((run) => run.id === source.id)?.status, "killed");
		setDurableBackend(undefined);
	});

	test("active-blocked resume stays retryable after ambiguous duplicate-name replay topology", async () => {
		const backend = new InMemoryDurableBackend();
		setDurableBackend(backend);
		let collapseDuplicates = false;
		let failAfterDuplicates = true;
		const definition = workflow({
			name: "retry-after-ambiguous-topology",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				if (collapseDuplicates) {
					await ctx.stage("duplicate").prompt("one-of-two-roots");
				} else {
					await ctx.parallel(
						[
							{ name: "duplicate", prompt: "one" },
							{ name: "duplicate", prompt: "two" },
						],
						{ concurrency: 2, failFast: false },
					);
				}
				await ctx.stage("after-duplicates").prompt("after");
				return {};
			},
		});
		const store = createStore();
		const first = await run(
			definition,
			{},
			{
				store,
				durableBackend: backend,
				adapters: {
					prompt: {
						prompt: async (text) => {
							if (failAfterDuplicates && text === "after") throw new Error("HTTP 429 quota exceeded");
							return text;
						},
					},
				},
			},
		);
		assert.equal(first.status, "running");
		const source = store.runs().find((candidate) => candidate.id === first.runId);
		assert.ok(source);
		assert.equal(source.resumable, true);
		backend.registerWorkflow({
			workflowId: source.id,
			name: definition.name,
			inputs: {},
			createdAt: 1,
			status: "blocked",
			resumable: true,
		});
		const jobs = createJobTracker();
		const runtime = createExtensionRuntime({
			registry: createRegistry([definition]),
			store,
			jobs,
			adapters: { prompt: { prompt: async (text) => text } },
		});
		collapseDuplicates = true;
		const ambiguous = await runtime.resumeFailedRun(source.id);
		assert.equal(ambiguous.ok, true);
		if (!ambiguous.ok) return;
		await jobs.get(ambiguous.runId)?.promise;
		assert.match(
			store.runs().find((run) => run.id === ambiguous.runId)?.error ?? "",
			/insufficient_state: replay topology ambiguous/,
		);
		const blocked = store.runs().find((run) => run.id === source.id);
		assert.ok(blocked);
		assert.notEqual(blocked.status, "killed");
		assert.equal(blocked.resumable, true);
		assert.equal(blocked.endedAt, undefined);

		collapseDuplicates = false;
		failAfterDuplicates = false;
		const retried = await runtime.resumeFailedRun(source.id);
		assert.equal(retried.ok, true, retried.ok ? undefined : retried.message);
		if (!retried.ok) return;
		await jobs.get(retried.runId)?.promise;
		assert.equal(store.runs().find((run) => run.id === retried.runId)?.status, "completed");
		assert.equal(store.runs().find((run) => run.id === source.id)?.status, "killed");
		setDurableBackend(undefined);
	});

	test("retry after fail-closed mismatch does not re-ask a recorded prompt answer", async () => {
		const backend = new InMemoryDurableBackend();
		setDurableBackend(backend);
		let insertParent = false;
		let toolCalls = 0;
		const definition = workflow({
			name: "retry-keeps-prompt-answer",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				const ok = await ctx.ui.confirm("proceed?");
				if (!ok) return {};
				if (insertParent) await ctx.stage("inserted").prompt("inserted");
				await ctx.tool("t", { n: 1 }, async () => {
					toolCalls += 1;
					return "t";
				});
				await ctx.stage("b").prompt("b");
				return {};
			},
		});
		const store = createStore();
		const firstPromise = run(
			definition,
			{},
			{
				store,
				durableBackend: backend,
				usePromptNodesForUi: true,
				adapters: {
					prompt: {
						prompt: async (text) => {
							if (text === "b") throw new Error("HTTP 429 quota exceeded");
							return text;
						},
					},
				},
			},
		);
		const pending = await waitForExecutorStagePendingPrompt(store);
		assert.equal(store.resolveStagePendingPrompt(pending.runId, pending.stageId, pending.promptId, true), true);
		const first = await firstPromise;
		assert.equal(first.status, "running");
		assert.equal(toolCalls, 1);
		const source = store.runs().find((candidate) => candidate.id === first.runId);
		assert.ok(source);
		assert.equal(store.getStagePromptAnswer(source.id, pending.stageId)?.value, true);
		store.recordNotice({
			id: `blocked:${source.id}`,
			runId: source.id,
			level: "warning",
			message: "WORKFLOW BLOCKED",
			createdAt: Date.now(),
		});
		backend.registerWorkflow({
			workflowId: source.id,
			name: definition.name,
			inputs: {},
			createdAt: 1,
			status: "blocked",
			resumable: true,
		});
		const jobs = createJobTracker();
		const runtime = createExtensionRuntime({
			registry: createRegistry([definition]),
			store,
			jobs,
			adapters: { prompt: { prompt: async (text) => text } },
		});
		insertParent = true;
		const mismatched = await runtime.resumeFailedRun(source.id);
		assert.equal(mismatched.ok, true);
		if (!mismatched.ok) return;
		await jobs.get(mismatched.runId)?.promise;
		assert.equal(store.getStagePromptAnswer(source.id, pending.stageId)?.value, true);
		assert.equal(
			store.notices().some((notice) => notice.runId === source.id && notice.message === "WORKFLOW BLOCKED"),
			true,
		);
		insertParent = false;
		const retried = await runtime.resumeFailedRun(source.id);
		assert.equal(retried.ok, true, retried.ok ? undefined : retried.message);
		if (!retried.ok) return;
		await jobs.get(retried.runId)?.promise;
		assert.equal(store.runs().find((run) => run.id === retried.runId)?.status, "completed");
		assert.equal(toolCalls, 1);
		assert.equal(store.getStagePromptAnswer(source.id, pending.stageId)?.value, true);
		setDurableBackend(undefined);
	});

	test("settlement ordering persists successes once and keeps mismatches reload-recoverable", () => {
		const store = createStore();
		const entries: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const persistence = {
			appendEntry(type: string, payload: Record<string, unknown>): string {
				entries.push({ type, payload });
				return `entry-${entries.length}`;
			},
		};
		const blocked = (id: string): RunSnapshot => ({
			id,
			name: "retry-order",
			inputs: {},
			status: "running",
			stages: [],
			startedAt: 1,
			resumable: true,
			failureDisposition: "active_blocked",
			failureRecoverability: "recoverable",
			error: "blocked",
		});
		const exercise = (id: string, settleFirst: boolean, mismatch: boolean): void => {
			const source = blocked(id);
			store.recordRunStart(source);
			persistence.appendEntry("workflow.run.start", { runId: id, name: source.name, inputs: {}, ts: 1 });
			const claim = claimActiveBlockedResume(store, id);
			assert.ok(claim);
			const settle = () =>
				finalizeActiveBlockedSourceAfterContinuation({
					claim,
					source,
					continuationRunId: `c-${id}`,
					persistence,
					...(mismatch
						? { result: { error: "atomic-workflows: insufficient_state: replay topology mismatch for tool t" } }
						: {}),
				});
			if (settleFirst) settle();
			finalizeResumedActiveBlockedSourceRun(claim, source, `c-${id}`);
			if (!settleFirst) settle();
			settle();
			const live = store.runs().find((run) => run.id === id);
			const terminalEntries = entries.filter(
				(entry) => entry.type === "workflow.run.end" && entry.payload.runId === id,
			);
			assert.equal(terminalEntries.length, mismatch ? 0 : 1);
			assert.equal(live?.status, mismatch ? "running" : "killed");
			assert.equal(live?.resumable, mismatch);
			if (mismatch) assert.equal(live?.endedAt, undefined);
		};

		exercise("success-settle-first", true, false);
		exercise("success-kill-first", false, false);
		exercise("mismatch-settle-first", true, true);
		exercise("mismatch-kill-first", false, true);

		const sessionEntries: SessionEntry[] = entries.map((entry, index) => ({
			id: `entry-${index + 1}`,
			type: entry.type,
			payload: {
				runId: String(entry.payload.runId ?? ""),
				name: String(entry.payload.name ?? ""),
				inputs: {},
				ts: typeof entry.payload.ts === "number" ? entry.payload.ts : 1,
			},
		}));
		assert.deepEqual(
			scanInFlightRuns(sessionEntries).map((run) => run.runId),
			["mismatch-settle-first", "mismatch-kill-first"],
		);

		for (const status of ["completed", "killed"] as const) {
			const terminal = blocked(`external-${status}`);
			store.recordRunStart(terminal);
			assert.equal(
				store.recordRunEnd(
					terminal.id,
					status,
					status === "completed" ? {} : undefined,
					undefined,
					status === "killed" ? { failureDisposition: "terminal_killed" } : {},
				),
				true,
			);
			const claim = claimActiveBlockedResume(store, terminal.id);
			assert.ok(claim);
			finalizeActiveBlockedSourceAfterContinuation({
				claim,
				source: terminal,
				continuationRunId: `c-${terminal.id}`,
				result: { error: "atomic-workflows: insufficient_state: replay topology mismatch for tool t" },
			});
			assert.equal(store.runs().find((run) => run.id === terminal.id)?.status, status);
		}
	});
});
