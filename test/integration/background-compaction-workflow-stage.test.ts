import assert from "node:assert/strict";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { test } from "vitest";
import { convertToLlm } from "../../packages/coding-agent/src/core/messages.js";
import { createHarnessWithExtensions, type Harness } from "../../packages/coding-agent/test/test-harness.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { summarizeStage } from "../../packages/workflows/src/extension/workflow-stage-results.js";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import type { StageSessionRuntime } from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";

const longPrompt = Array.from({ length: 24 }, (_, index) => `context line ${index + 1}`).join("\n");

test("a workflow stage compacts in the background and its status shows the compaction state (#4330)", async () => {
	let releasePlanner!: () => void;
	const plannerReleased = new Promise<void>((resolve) => {
		releasePlanner = resolve;
	});
	const plannerCalls: boolean[] = [];
	let harness!: Harness;
	const tool = (name: string, execute: () => Promise<void>): AgentTool => ({
		name,
		label: name,
		description: `Deterministic ${name} step`,
		parameters: Type.Object({}),
		async execute() {
			await execute();
			return { content: [{ type: "text", text: `${name} done` }], details: {} };
		},
	});
	harness = await createHarnessWithExtensions({
		contextWindow: 1_000,
		settings: {
			compaction: { enabled: true, reserveTokens: 200, compression_ratio: 0.5, preserve_recent: 2 },
			retry: { enabled: false },
			sessionSummary: { enabled: false },
		},
		baseToolsOverride: {
			inspect: tool("inspect", async () => {}),
			settle: tool("settle", async () => {
				releasePlanner();
				await harness.session.awaitBackgroundCompaction();
			}),
		},
		responses: [
			{ toolCalls: [{ id: "inspect-1", name: "inspect", args: {} }], usage: { input: 760, output: 10 } },
			{ toolCalls: [{ id: "settle-1", name: "settle", args: {} }], usage: { input: 770, output: 10 } },
			{ text: "stage done", usage: { input: 400, output: 10 } },
		],
		extensionFactories: [
			(pi) => {
				pi.on("session_before_compact", async () => {
					plannerCalls.push(harness.session.isCompacting);
					await plannerReleased;
					return { compactedText: "[User]: retained" };
				});
			},
		],
	});
	harness.agent.convertToLlm = convertToLlm;
	harness.session.setActiveToolsByName(["inspect", "settle"]);
	await harness.sessionManager.appendMessage({ role: "user", content: longPrompt, timestamp: 1 });
	await harness.sessionManager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "earlier answer" }],
		api: "anthropic-messages",
		provider: "faux",
		model: "faux-1",
		usage: {
			input: 300,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 310,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 2,
	});
	harness.session.refreshContext();

	const store = createStore();
	const observed: string[] = [];
	const unsubscribe = store.subscribeInvalidation(() => {
		const state = store.runs()[0]?.stages[0]?.compaction?.state;
		if (state !== undefined && observed.at(-1) !== state) observed.push(state);
	});
	try {
		const result = await run(
			workflow({
				name: "background-compaction-stage",
				description: "A stage that crosses the soft compaction threshold",
				outputs: { text: Type.String() },
				run: async (ctx) => ({ text: (await ctx.task("compactor", { prompt: longPrompt })).text }),
			}),
			{},
			{
				cwd: harness.tempDir,
				store,
				executionMode: "non_interactive",
				config: {
					maxDepth: 2,
					defaultConcurrency: 1,
					persistRuns: false,
					statusFile: false,
					resumeInFlight: "never",
				},
				adapters: {
					agentSession: {
						async create() {
							return harness.session as unknown as StageSessionRuntime;
						},
					},
				},
			},
		);
		assert.equal(result.status, "completed", result.error);
		assert.equal(result.result?.text, "stage done");
		assert.deepEqual(plannerCalls, [false], "the stage planned once, off the turn path");
		assert.deepEqual(observed, ["running", "ready", "idle"]);
		const boundaries = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
		assert.equal(boundaries.length, 1);
		assert.ok(boundaries[0].type === "compaction" && boundaries[0].coveredThroughEntryId !== undefined);
		const stage = store.runs()[0]?.stages[0];
		assert.ok(stage);
		assert.deepEqual(stage.compaction, { state: "idle" });
		assert.deepEqual(summarizeStage(stage).compaction, { state: "idle" });
	} finally {
		unsubscribe();
		harness.cleanup();
	}
});
