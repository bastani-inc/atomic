import assert from "node:assert/strict";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { afterEach, test } from "vitest";
import type { ExtensionFactory } from "../../packages/coding-agent/src/core/extensions/index.js";
import { convertToLlm } from "../../packages/coding-agent/src/core/messages.js";
import {
	createHarnessWithExtensions,
	type FauxResponseInput,
	type Harness,
} from "../../packages/coding-agent/test/test-harness.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { summarizeStage } from "../../packages/workflows/src/extension/workflow-stage-results.js";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import type { StageSessionRuntime } from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import { createStore, type Store } from "../../packages/workflows/src/shared/store.js";

const longPrompt = Array.from({ length: 24 }, (_, index) => `context line ${index + 1}`).join("\n");

const SETTINGS = {
	compaction: { enabled: true, reserveTokens: 200, compression_ratio: 0.5, preserve_recent: 2 },
	retry: { enabled: false },
	sessionSummary: { enabled: false },
};

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

function tool(name: string, execute: () => Promise<void> = async () => {}): AgentTool {
	return {
		name,
		label: name,
		description: `Deterministic ${name} step`,
		parameters: Type.Object({}),
		async execute() {
			await execute();
			return { content: [{ type: "text", text: `${name} done` }], details: {} };
		},
	};
}

async function stageHarness(
	responses: FauxResponseInput[],
	tools: Record<string, AgentTool>,
	planner: ExtensionFactory,
): Promise<Harness> {
	const harness = await createHarnessWithExtensions({
		contextWindow: 1_000,
		settings: SETTINGS,
		baseToolsOverride: tools,
		responses,
		extensionFactories: [planner],
	});
	harnesses.push(harness);
	harness.agent.convertToLlm = convertToLlm;
	harness.session.setActiveToolsByName(Object.keys(tools));
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
	return harness;
}

/** Run one stage on `session` and record each distinct compaction state its status showed. */
async function runStage(
	harness: Harness,
	session: object = harness.session,
): Promise<{ store: Store; observed: string[]; text: string | undefined }> {
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
							return session as unknown as StageSessionRuntime;
						},
					},
				},
			},
		);
		assert.equal(result.status, "completed", result.error);
		return { store, observed, text: result.result?.text };
	} finally {
		unsubscribe();
	}
}

function finalStageCompaction(store: Store) {
	const stage = store.runs()[0]?.stages[0];
	assert.ok(stage);
	return { stored: stage.compaction, summarized: summarizeStage(stage).compaction };
}

test("a workflow stage compacts in the background and its status shows the compaction state (#4330)", async () => {
	let releasePlanner!: () => void;
	const plannerReleased = new Promise<void>((resolve) => {
		releasePlanner = resolve;
	});
	const plannerCalls: boolean[] = [];
	let harness!: Harness;
	harness = await stageHarness(
		[
			{ toolCalls: [{ id: "inspect-1", name: "inspect", args: {} }], usage: { input: 760, output: 10 } },
			{ toolCalls: [{ id: "settle-1", name: "settle", args: {} }], usage: { input: 770, output: 10 } },
			{ text: "stage done", usage: { input: 400, output: 10 } },
		],
		{
			inspect: tool("inspect"),
			settle: tool("settle", async () => {
				releasePlanner();
				await harness.session.awaitBackgroundCompaction();
			}),
		},
		(pi) => {
			pi.on("session_before_compact", async () => {
				plannerCalls.push(harness.session.isCompacting);
				await plannerReleased;
				return { compactedText: "[User]: retained" };
			});
		},
	);
	const { store, observed, text } = await runStage(harness);
	assert.equal(text, "stage done");
	assert.deepEqual(plannerCalls, [false], "the stage planned once, off the turn path");
	assert.deepEqual(observed, ["running", "ready", "idle"]);
	const boundaries = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
	assert.equal(boundaries.length, 1);
	assert.ok(boundaries[0].type === "compaction" && boundaries[0].coveredThroughEntryId !== undefined);
	assert.deepEqual(finalStageCompaction(store), { stored: { state: "idle" }, summarized: { state: "idle" } });
});

test("a stage that ends while its background task still plans reports where the task ended, not running (#4330)", async () => {
	const harness = await stageHarness(
		[
			{ toolCalls: [{ id: "inspect-1", name: "inspect", args: {} }], usage: { input: 760, output: 10 } },
			{ text: "stage done", usage: { input: 770, output: 10 } },
		],
		{ inspect: tool("inspect") },
		(pi) => {
			pi.on("session_before_compact", async (event) => {
				await new Promise<void>((_resolve, reject) => {
					event.signal.addEventListener("abort", () => reject(new Error("Compaction cancelled")), { once: true });
				});
				return { compactedText: "[User]: never" };
			});
		},
	);
	const { store, observed, text } = await runStage(harness);
	assert.equal(text, "stage done");
	assert.deepEqual(observed, ["running", "idle"]);
	assert.equal(harness.session.compaction.state, "idle");
	assert.deepEqual(finalStageCompaction(store), { stored: { state: "idle" }, summarized: { state: "idle" } });
});

test("a stage whose session already holds a saved result shows it as soon as the session attaches (#4330)", async () => {
	const harness = await stageHarness(
		[
			{ text: "earlier work", usage: { input: 760, output: 10 } },
			{ text: "stage done", usage: { input: 400, output: 10 } },
		],
		{},
		(pi) => {
			pi.on("session_before_compact", async () => ({ compactedText: "[User]: retained" }));
		},
	);
	await harness.session.prompt("earlier work");
	assert.equal((await harness.session.awaitBackgroundCompaction()).state, "ready");

	const { store, observed, text } = await runStage(harness);
	assert.equal(text, "stage done");
	assert.deepEqual(observed, ["ready", "idle"], "the saved result is reported from the start, then applied");
	assert.deepEqual(finalStageCompaction(store), { stored: { state: "idle" }, summarized: { state: "idle" } });
});

test("a stage on a custom session runtime without background compaction shows no compaction state (#4330)", async () => {
	const harness = await stageHarness([{ text: "stage done", usage: { input: 400, output: 10 } }], {}, () => {});
	const withoutCompaction = new Proxy(harness.session, {
		get(target, property) {
			if (property === "compaction") return undefined;
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	const { store, observed, text } = await runStage(harness, withoutCompaction);
	assert.equal(text, "stage done");
	assert.deepEqual(observed, []);
	assert.deepEqual(finalStageCompaction(store), { stored: undefined, summarized: undefined });
});
