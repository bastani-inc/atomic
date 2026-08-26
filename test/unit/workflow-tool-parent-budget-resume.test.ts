import assert from "node:assert/strict";
import type { AgentSession } from "@bastani/atomic";
import { Type } from "typebox";
import { afterEach, beforeEach, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import {
	createCheckpointIdGenerator,
	createToolPrimitive,
} from "../../packages/workflows/src/durable/tool-primitive.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { BUDGET_WRAP_UP_PROMPT } from "../../packages/workflows/src/engine/run-budget.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { workflowResumeAction } from "../../packages/workflows/src/extension/workflow-tool-control.js";
import { stageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { createStore, store } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { INTERACTIVE_WORKFLOW_POLICY, type StageExecutionMeta } from "../../packages/workflows/src/shared/types.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { TEST_TIMEOUT_MS } from "../helpers/test-timeout.js";
import { assistantMessageWithUsage, makeMockSession } from "./stage-runner-helpers.js";

const ZERO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } as const;
const TRIP_USAGE = { input: 5, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } as const;
const RUN_STATE_POLL_MS = 10;
const RUN_STATE_WAIT_MS = Math.floor(TEST_TIMEOUT_MS / 2);

beforeEach(() => {
	store.clear();
	stageControlRegistry.clear();
});
afterEach(() => {
	setDurableBackend(undefined);
	store.clear();
	stageControlRegistry.clear();
});

const sleep = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitForRun(
	activeStore: { runs(): readonly RunSnapshot[] },
	predicate: (candidate: RunSnapshot) => boolean,
): Promise<RunSnapshot> {
	const deadline = Date.now() + RUN_STATE_WAIT_MS;
	while (Date.now() < deadline) {
		const snapshot = activeStore.runs().find(predicate);
		if (snapshot !== undefined) return snapshot;
		await sleep(RUN_STATE_POLL_MS);
	}
	throw new Error(
		`workflow run did not reach the expected state: ${JSON.stringify(
			activeStore.runs().map((runSnapshot) => ({
				id: runSnapshot.id,
				status: runSnapshot.status,
				result: runSnapshot.result,
				stages: runSnapshot.stages.map((stage) => ({ name: stage.name, status: stage.status })),
			})),
		)}`,
	);
}

async function waitForSignal(signal: Promise<void>, message: string): Promise<void> {
	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			signal,
			new Promise<never>((_, reject) => {
				timeoutId = setTimeout(() => reject(new Error(message)), RUN_STATE_WAIT_MS);
			}),
		]);
	} finally {
		if (timeoutId !== undefined) clearTimeout(timeoutId);
	}
}

test("raised-budget continuation replays tool-parented parallel tasks", async () => {
	const backend = new InMemoryDurableBackend();
	setDurableBackend(backend);
	const completedTaskNames = ["completed-1", "completed-2", "completed-3"] as const;
	const taskNames = [...completedTaskNames, "incomplete"] as const;
	const incompleteStarted = Promise.withResolvers<void>();
	const completed1Prompted = Promise.withResolvers<void>();
	const completed2Prompted = Promise.withResolvers<void>();
	const incompleteSourceGate = Promise.withResolvers<void>();
	const incompleteSourceSettled = Promise.withResolvers<void>();
	let rejectIncompleteSource: ((reason: Error) => void) | undefined;
	const taskCalls = new Map<string, number>();
	let toolCalls = 0;
	const definition = workflow({
		name: "budget-tool-parent-resume",
		description: "",
		inputs: {},
		outputs: { result: Type.String() },
		run: async (ctx) => {
			const preflight = await ctx.tool("preflight", { target: "shared" }, async () => {
				toolCalls += 1;
				return "ready";
			});
			const results = await Promise.all(
				taskNames.map((name) =>
					ctx.task(name, { prompt: `${preflight}:${name}`, model: "test/model", context: "fresh" }),
				),
			);
			const synthesis = await ctx.task("synthesis", {
				prompt: `synthesis:${results.map((result) => result.text).join(",")}`,
				model: "test/model",
				context: "fresh",
			});
			return { result: synthesis.text };
		},
	});
	const runtime = createExtensionRuntime({
		adapters: {
			agentSession: {
				async create(_options, meta: StageExecutionMeta) {
					const messages: AgentSession["messages"] = [];
					let lastText: string | undefined;
					return makeMockSession({
						messages,
						async prompt(text) {
							if (text === BUDGET_WRAP_UP_PROMPT) {
								lastText = "budget wrap-up";
								messages.push(assistantMessageWithUsage(lastText, ZERO_USAGE));
								return;
							}
							const name = meta.stageName;
							const calls = (taskCalls.get(name) ?? 0) + 1;
							taskCalls.set(name, calls);
							if (name === "incomplete" && calls === 1) {
								incompleteStarted.resolve();
								try {
									await new Promise<void>((resolve, reject) => {
										rejectIncompleteSource = reject;
										void incompleteSourceGate.promise.then(resolve, reject);
									});
								} finally {
									incompleteSourceSettled.resolve();
								}
							} else if (name === "completed-3" && calls === 1) {
								await waitForSignal(
									incompleteStarted.promise,
									"incomplete sibling did not start before completed-3 waited",
								);
								await waitForSignal(
									completed1Prompted.promise,
									"completed-1 did not prompt before completed-3 tripped the budget",
								);
								await waitForSignal(
									completed2Prompted.promise,
									"completed-2 did not prompt before completed-3 tripped the budget",
								);
								await waitForRun(
									store,
									(candidate) =>
										candidate.name === definition.name &&
										candidate.stages.find((stage) => stage.name === "completed-1")?.status === "completed" &&
										candidate.stages.find((stage) => stage.name === "completed-2")?.status === "completed",
								);
							}
							lastText = `${text}:done`;
							messages.push(
								assistantMessageWithUsage(
									lastText,
									name === "completed-3" && calls === 1 ? TRIP_USAGE : ZERO_USAGE,
								),
							);
							if (name === "completed-1" && calls === 1) completed1Prompted.resolve();
							if (name === "completed-2" && calls === 1) completed2Prompted.resolve();
						},
						async abort() {
							rejectIncompleteSource?.(new Error("AbortError"));
						},
						getLastAssistantText: () => lastText,
					}).session;
				},
			},
		},
		store,
		registry: createRegistry([definition]),
	});

	const launched = await runtime.dispatch({
		action: "run",
		workflow: definition.name,
		inputs: {},
		budget: { maxTokens: 1 },
	});
	assert.equal(launched.action, "run");
	if (launched.action !== "run") return;
	assert.equal(launched.status, "running", launched.error);
	try {
		const source = await waitForRun(
			store,
			(candidate) => candidate.name === definition.name && candidate.result?.status === "budget_exceeded",
		);
		assert.equal(source.stages.filter((stage) => stage.status === "completed").length, completedTaskNames.length);
		for (const name of completedTaskNames) {
			assert.equal(source.stages.find((stage) => stage.name === name)?.status, "completed");
		}
		assert.equal(source.stages.find((stage) => stage.name === "incomplete")?.status, "running");
		assert.equal(
			source.stages.some((stage) => stage.name === "synthesis"),
			false,
		);

		const resumed = await workflowResumeAction(
			{ action: "resume", runId: source.id, budget: { maxTokens: 100 } },
			{
				getRuntime: () => runtime,
				policy: INTERACTIVE_WORKFLOW_POLICY,
				ensureWorkflowResourcesLoaded: async () => {},
			},
		);
		assert.equal(resumed.action, "resume");
		if (resumed.action !== "resume") return;
		assert.equal(resumed.status, "running", resumed.message);
		assert.notEqual(resumed.runId, source.id);
		const continuation = await waitForRun(
			store,
			(candidate) => candidate.resumedFromRunId === source.id && candidate.status === "completed",
		);

		assert.equal(toolCalls, 1);
		for (const name of completedTaskNames) {
			assert.equal(taskCalls.get(name), 1);
			const replayed = continuation.stages.find((stage) => stage.name === name);
			assert.ok(replayed, `expected replayed stage ${name}`);
			assert.equal(replayed.replayed, true);
		}
		const incomplete = continuation.stages.find((stage) => stage.name === "incomplete");
		assert.ok(incomplete, "expected the incomplete stage to exist on the continuation");
		assert.equal(taskCalls.get("incomplete"), 2);
		assert.notEqual(incomplete.replayed, true);
		const synthesis = continuation.stages.find((stage) => stage.name === "synthesis");
		assert.ok(synthesis, "expected synthesis after the parallel fan-out");
		assert.equal(taskCalls.get("synthesis"), 1);
		assert.notEqual(synthesis.replayed, true);
		const [toolNode] = continuation.toolNodes ?? [];
		assert.ok(toolNode);
		assert.equal(toolNode.replayed, true);
		assert.equal(toolNode.status, "cached");
		for (const name of taskNames) {
			const mapping = continuation.stages.find((stage) => stage.name === name);
			assert.ok(mapping);
			assert.ok(mapping.parentIds.includes(toolNode.id));
			assert.ok(synthesis.parentIds.includes(mapping.id), `synthesis should depend on ${name}`);
		}
	} finally {
		incompleteSourceGate.resolve();
	}
	await incompleteSourceSettled.promise;
});

test("chained continuation replays a topology-less source tool once", async () => {
	const backend = new InMemoryDurableBackend();
	let toolCalls = 0;
	let childAttempts = 0;
	const definition = workflow({
		name: "topology-less-chained-resume",
		description: "",
		inputs: {},
		outputs: { result: Type.String() },
		run: async (ctx) => {
			const ready = await ctx.tool("preflight", { target: "shared" }, async () => {
				toolCalls += 1;
				return "ready";
			});
			const child = await ctx.stage("child").prompt(`child:${ready}`);
			return { result: child };
		},
	});
	const prompt = {
		prompt: async (text: string) => {
			if (text.startsWith("child:")) {
				childAttempts += 1;
				if (childAttempts < 3) throw new Error("child still blocked");
			}
			return text;
		},
	};
	const firstStore = createStore();
	const first = await run(definition, {}, { store: firstStore, durableBackend: backend, adapters: { prompt } });
	assert.equal(first.status, "failed");
	assert.equal(toolCalls, 1);
	const live = firstStore.runs().find((candidate) => candidate.id === first.runId);
	assert.ok(live);
	const seeded = backend
		.listCheckpoints(live.id)
		.find((checkpoint) => checkpoint.kind === "tool" && checkpoint.throwingFailureError === undefined);
	assert.ok(seeded);
	assert.equal(seeded.kind, "tool");
	backend.recordCheckpoint({
		kind: "tool",
		workflowId: live.id,
		checkpointId: "tool:legacy-stripped",
		name: seeded.name,
		argsHash: seeded.argsHash,
		output: seeded.output,
		completedAt: seeded.completedAt + 1,
	});
	assert.equal(backend.getToolCheckpoint(live.id, seeded.argsHash)?.checkpointId, "tool:legacy-stripped");
	const midStore = createStore();
	const mid = await run(
		definition,
		{},
		{
			store: midStore,
			durableBackend: backend,
			continuation: { source: { ...live, toolNodes: [] }, resumeFromStageId: live.failedStageId },
			adapters: { prompt },
		},
	);
	assert.equal(mid.status, "failed", mid.error);
	assert.match(mid.error ?? "", /child still blocked/);
	assert.doesNotMatch(mid.error ?? "", /insufficient_state/);
	assert.equal(toolCalls, 1);
	const midSnap = midStore.runs().find((candidate) => candidate.id === mid.runId);
	assert.ok(midSnap);
	assert.equal(midSnap.toolNodes?.[0]?.topologyState, "unavailable");
	const last = await run(
		definition,
		{},
		{
			store: createStore(),
			durableBackend: backend,
			continuation: { source: midSnap, resumeFromStageId: midSnap.failedStageId },
			adapters: { prompt },
		},
	);
	assert.equal(last.status, "completed", last.error);
	assert.equal(toolCalls, 1);
	assert.equal(last.toolNodes?.[0]?.replayed, true);
});

test("continuation does not invent topology for an own topology-less cache hit", async () => {
	const backend = new InMemoryDurableBackend();
	backend.registerWorkflow({ workflowId: "src", name: "own-hit", inputs: {}, createdAt: 1, status: "running" });
	backend.registerWorkflow({ workflowId: "cont", name: "own-hit", inputs: {}, createdAt: 1, status: "running" });
	const srcTool = createToolPrimitive({
		workflowId: "src",
		backend,
		nextCheckpointId: createCheckpointIdGenerator(),
		throwIfCancelled: () => {},
	});
	assert.equal(await srcTool("preflight", { target: "shared" }, async () => "ready"), "ready");
	const seeded = backend.listCheckpoints("src").find((checkpoint) => checkpoint.kind === "tool");
	assert.ok(seeded);
	assert.equal(seeded.kind, "tool");
	backend.recordCheckpoint({
		kind: "tool",
		workflowId: "cont",
		checkpointId: "tool:own-legacy",
		name: seeded.name,
		argsHash: seeded.argsHash,
		output: seeded.output,
		completedAt: Date.now(),
	});
	let calls = 0;
	const contTool = createToolPrimitive({
		workflowId: "cont",
		checkpointSourceWorkflowId: "src",
		backend,
		nextCheckpointId: createCheckpointIdGenerator(),
		throwIfCancelled: () => {},
		runTopology: { runId: "cont", runName: "own-hit" },
	});
	assert.equal(
		await contTool("preflight", { target: "shared" }, async () => {
			calls += 1;
			return "ready";
		}),
		"ready",
	);
	assert.equal(calls, 0);
	assert.equal(
		backend
			.listCheckpoints("cont")
			.some((checkpoint) => checkpoint.kind === "tool" && checkpoint.checkpointId.startsWith("tool-replay-meta:")),
		false,
	);
});

test("fresh-id continuation replays a return-mode tool failure instead of rerunning it", async () => {
	const backend = new InMemoryDurableBackend();
	let toolCalls = 0;
	const definition = workflow({
		name: "return-failure-fresh-id",
		description: "",
		inputs: {},
		outputs: { result: Type.String() },
		run: async (ctx) => {
			const outcome = await ctx.tool(
				"probe",
				{ suite: "unit" },
				async () => {
					toolCalls += 1;
					throw Object.assign(new Error("still red"), { exitCode: 1 });
				},
				{ failureMode: "return" },
			);
			const message = outcome.ok ? "ok" : outcome.error.message;
			await ctx.stage("after").prompt(`after:${message}`);
			return { result: message };
		},
	});
	const sourceStore = createStore();
	const first = await run(
		definition,
		{},
		{
			store: sourceStore,
			durableBackend: backend,
			adapters: {
				prompt: {
					prompt: async (text) => {
						if (text.startsWith("after:")) throw new Error("source after failed");
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
	const continued = await run(
		definition,
		{},
		{
			store: createStore(),
			durableBackend: backend,
			continuation: { source, resumeFromStageId: source.failedStageId },
			adapters: { prompt: { prompt: async (text) => text } },
		},
	);
	assert.equal(continued.status, "completed", continued.error);
	assert.equal(toolCalls, 1);
	assert.equal(continued.result?.result, "still red");
	const [toolNode] = continued.toolNodes ?? [];
	assert.ok(toolNode);
	assert.equal(toolNode.replayed, true);
	assert.equal(toolNode.status, "failed");

	const fresh = await run(
		definition,
		{},
		{
			store: createStore(),
			durableBackend: backend,
			adapters: { prompt: { prompt: async (text) => text } },
		},
	);
	assert.equal(fresh.status, "completed", fresh.error);
	assert.equal(toolCalls, 2);
	assert.equal(fresh.result?.result, "still red");
});
