import assert from "node:assert/strict";
import type { AgentSession } from "@bastani/atomic";
import { afterEach, describe, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { durableWorkflowRunSnapshots } from "../../packages/workflows/src/durable/completed-catalog.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { resumeDurableWorkflow } from "../../packages/workflows/src/durable/resume-runtime.js";
import { createToolControlRegistry } from "../../packages/workflows/src/engine/run-tool-control-registry.js";
import { createCancellationRegistry } from "../../packages/workflows/src/runs/background/cancellation-registry.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { quitRun } from "../../packages/workflows/src/runs/background/quit.js";
import { runDetached } from "../../packages/workflows/src/runs/background/runner.js";
import { pauseRun } from "../../packages/workflows/src/runs/background/status.js";
import { createStageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import type {
	StageSessionCreateOptions,
	StageSessionRuntime,
} from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { WorkflowDefinition } from "../../packages/workflows/src/shared/types.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { closeMemoryTestBackends, createMemoryTestBackend } from "../helpers/workflow-journal.js";

afterEach(async () => {
	setDurableBackend(undefined);
	await closeMemoryTestBackends();
});

/** A stage session whose every prompt finishes at once; `prompts` counts the prompts sent. */
function finishingSessions() {
	const counter = { prompts: 0 };
	const create = async (options: StageSessionCreateOptions): Promise<StageSessionRuntime> => {
		const session: StageSessionRuntime = {
			async prompt() {
				counter.prompts += 1;
			},
			async steer() {},
			async followUp() {},
			subscribe: () => () => {},
			sessionFile: undefined,
			sessionId: `stage-${crypto.randomUUID()}`,
			async setModel() {},
			setThinkingLevel() {},
			cycleModel: async () => undefined,
			cycleThinkingLevel: async () => undefined,
			agent: undefined as unknown as AgentSession["agent"],
			model: undefined,
			thinkingLevel: "medium",
			messages: [] as AgentSession["messages"],
			isStreaming: false,
			navigateTree: async () => ({ cancelled: false }),
			compact: (async () => ({})) as unknown as StageSessionRuntime["compact"],
			abortCompaction() {},
			async abort() {},
			dispose() {},
			getLastAssistantText: () => "done",
		};
		return Object.assign(session, {
			modelRuntime: {},
			state: { messages: [] },
			sessionManager: {},
			getContextUsage: () => undefined,
			orchestrationContext: options.orchestrationContext,
		});
	};
	return { create, counter };
}

function abortObserved(signal: AbortSignal): Promise<void> {
	return new Promise<void>((resolve) => {
		if (signal.aborted) resolve();
		else signal.addEventListener("abort", () => resolve(), { once: true });
	});
}

async function waitFor<T>(read: () => T | undefined, what: string): Promise<T> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		const value = read();
		if (value !== undefined) return value;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`timed out waiting for ${what}`);
}

/** Runs [stage s1, ctx.ui.confirm, ctx.tool t1] in the background until t1 is the only work in flight. */
async function startUntilToolRuns() {
	const backend = await createMemoryTestBackend();
	setDurableBackend(backend);
	const store = createStore();
	const cancellation = createCancellationRegistry();
	const jobs = createJobTracker();
	const stageControlRegistry = createStageControlRegistry();
	const toolControlRegistry = createToolControlRegistry();
	const sessions = finishingSessions();
	const toolEntered = Promise.withResolvers<void>();
	const tool = { calls: 0 };
	const definition = workflow({
		name: "pause-in-flight-tool",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.stage("s1").prompt("work");
			await ctx.ui.confirm("go on?");
			await ctx.tool("t1", {}, async ({ signal }) => {
				tool.calls += 1;
				if (tool.calls > 1) return "done";
				toolEntered.resolve();
				await abortObserved(signal);
				throw signal.reason;
			});
			return {};
		},
	}) as WorkflowDefinition;
	const adapters = { agentSession: { create: sessions.create } };
	const runOpts = { store, cancellation, jobs, stageControlRegistry, toolControlRegistry, adapters };
	const { runId } = runDetached(definition, {}, { ...runOpts, durableBackend: backend });
	const prompt = await waitFor(() => {
		const stage = store.run(runId)?.stages.find((candidate) => candidate.pendingPrompt !== undefined);
		return stage?.pendingPrompt === undefined ? undefined : { stageId: stage.id, promptId: stage.pendingPrompt.id };
	}, "the confirm prompt");
	assert.equal(store.resolveStagePendingPrompt(runId, prompt.stageId, prompt.promptId, true), true);
	await toolEntered.promise;
	assert.deepEqual(
		stageControlRegistry
			.run(runId)
			.stages()
			.filter((handle) => handle.status === "running"),
		[],
		"t1 is the only work in flight",
	);
	const settled = async (id: string) => {
		await jobs.get(id)?.promise.catch(() => {});
	};
	const durableTool = () => {
		const handle = backend.getWorkflow(runId);
		assert.ok(handle, "the run has a durable record");
		return durableWorkflowRunSnapshots(backend, handle)
			.find((snapshot) => snapshot.id === runId)
			?.toolNodes.find((node) => node.name === "t1");
	};
	const resume = async () => {
		const resumed = await resumeDurableWorkflow(runId, {
			registry: createRegistry([definition]),
			baseRunOpts: runOpts,
			durableBackend: backend,
		});
		assert.equal(resumed.ok, true, resumed.ok ? undefined : resumed.message);
		if (resumed.ok) await settled(resumed.workflowId);
		return store.run(runId);
	};
	return {
		store,
		jobs,
		stageControlRegistry,
		toolControlRegistry,
		runId,
		tool,
		sessions,
		settled,
		durableTool,
		resume,
	};
}

describe("run-level pause and quit stop an in-flight ctx.tool call (#4878)", () => {
	for (const action of ["pause", "quit"] as const) {
		test(`${action} while a ctx.tool call is the only in-flight work pauses the run, records the tool cancelled live and durably, and resume finishes it (#4878)`, async () => {
			const h = await startUntilToolRuns();
			const controls = {
				store: h.store,
				stageControlRegistry: h.stageControlRegistry,
				toolControlRegistry: h.toolControlRegistry,
				jobs: h.jobs,
			};

			const stopped = action === "pause" ? await pauseRun(h.runId, controls) : await quitRun(h.runId, controls);
			assert.equal(stopped.ok, true, JSON.stringify(stopped));
			await h.settled(h.runId);

			const paused = h.store.run(h.runId);
			assert.equal(paused?.status, "paused");
			assert.equal(paused?.resumable, true);
			assert.equal(paused?.toolNodes.find((node) => node.name === "t1")?.status, "cancelled");
			assert.equal(h.durableTool()?.status, "cancelled");

			const resumed = await h.resume();
			assert.equal(resumed?.status, "completed", resumed?.error);
			assert.equal(h.tool.calls, 2, "resume runs the cancelled call again");
			assert.equal(h.sessions.counter.prompts, 1, "resume replays the finished stage");
		});
	}
});
