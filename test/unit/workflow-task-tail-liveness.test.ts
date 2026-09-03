import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { afterEach, describe, test, vi } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { isLiveRunningWorkflow } from "../../packages/workflows/src/durable/resume-eligibility.js";
import {
	createDurableTaskPrimitive,
	TASK_RESULT_CHECKPOINT_CONTROL_PREFIX,
} from "../../packages/workflows/src/durable/stage-primitive.js";
import type { DurableCheckpoint } from "../../packages/workflows/src/durable/types.js";
import { createRunBudgetController } from "../../packages/workflows/src/engine/run-budget.js";
import {
	IMPOSSIBLE_ROOT_LIVENESS_MESSAGE,
	isImpossibleRootLiveness,
} from "../../packages/workflows/src/engine/run-liveness.js";
import { createToolControlRegistry } from "../../packages/workflows/src/engine/run-tool-control-registry.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { summarizeRunSnapshot } from "../../packages/workflows/src/extension/workflow-status-summary.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { quitRun } from "../../packages/workflows/src/runs/background/quit.js";
import { inspectRun, interruptAllRuns, interruptRun } from "../../packages/workflows/src/runs/background/status.js";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import { createStageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { runGitChecked } from "../../packages/workflows/src/runs/shared/worktree-git.js";
import { resolve_budget } from "../../packages/workflows/src/shared/budget.js";
import { effectiveRunStatus } from "../../packages/workflows/src/shared/returned-run-status.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import type { WorkflowTaskResult } from "../../packages/workflows/src/shared/types.js";
import { structuredOutputMockSession } from "./executor-shared.js";
import { assistantMessageWithUsage } from "./stage-runner-helpers.js";

afterEach(() => {
	vi.useRealTimers();
	setDurableBackend(undefined);
});

function budgetOutcome(value: object | undefined):
	| {
			readonly status?: string;
			readonly dimension?: string;
			readonly reading?: number;
			readonly ceiling?: number;
			readonly frontierStage?: string;
	  }
	| undefined {
	return value as
		| {
				readonly status?: string;
				readonly dimension?: string;
				readonly reading?: number;
				readonly ceiling?: number;
				readonly frontierStage?: string;
		  }
		| undefined;
}

class Gate {
	release!: () => void;
	readonly barrier = new Promise<void>((resolve) => {
		this.release = resolve;
	});
}

class DelayedTaskCheckpointBackend extends InMemoryDurableBackend {
	readonly gate = new Gate();
	failTaskCheckpoint = false;
	taskCheckpoints = 0;
	override async recordCheckpointAsync(checkpoint: DurableCheckpoint): Promise<void> {
		if (checkpoint.kind === "stage" && checkpoint.checkpointId.startsWith("task:")) {
			this.taskCheckpoints += 1;
			await this.gate.barrier;
			if (this.failTaskCheckpoint) throw new Error("task-result checkpoint failed");
		}
		await super.recordCheckpointAsync(checkpoint);
	}
}

class PostTaskUsageCheckpointBackend extends InMemoryDurableBackend {
	readonly gate = new Gate();
	readonly taskResults: Extract<DurableCheckpoint, { readonly kind: "stage" }>[] = [];
	onAllTaskResultsPersisted: () => void = () => {};
	override async recordCheckpointAsync(checkpoint: DurableCheckpoint): Promise<void> {
		await super.recordCheckpointAsync(checkpoint);
		if (checkpoint.kind !== "stage" || !checkpoint.checkpointId.startsWith("task:")) return;
		this.taskResults.push(checkpoint);
		if (this.taskResults.length === 2) {
			try {
				this.onAllTaskResultsPersisted();
			} finally {
				this.gate.release();
			}
		}
		await this.gate.barrier;
	}
}

class DropTaskResultBackend extends InMemoryDurableBackend {
	override async recordCheckpointAsync(checkpoint: DurableCheckpoint): Promise<void> {
		if (checkpoint.kind === "stage" && checkpoint.checkpointId.startsWith("task:")) {
			throw new Error("task-result checkpoint failed");
		}
		await super.recordCheckpointAsync(checkpoint);
	}
}

async function replayAfterDroppedTaskPersist(
	name: string,
	taskOptions: { prompt: string; maxOutput?: { lines: number }; worktree?: boolean },
	prompt: (meta?: { stageOptions?: { cwd?: string } }) => unknown,
	runOpts?: { cwd?: string },
): Promise<{
	readonly firstFailed: boolean;
	readonly replayed: Awaited<ReturnType<typeof run>>;
	readonly prompts: number;
}> {
	const backend = new DropTaskResultBackend();
	const runId = `wf-live-${name}`;
	const def = workflow({
		name,
		description: "",
		inputs: {},
		outputs: { result: Type.String() },
		run: async (ctx) => {
			const review = await ctx.task("review", taskOptions);
			return {
				result: JSON.stringify({
					text: review.text,
					structured: review.structured,
					artifacts: review.artifacts,
				}),
			};
		},
	});
	const first = await run(
		def,
		{},
		{
			runId,
			store: createStore(),
			durableBackend: backend,
			...(runOpts?.cwd !== undefined ? { cwd: runOpts.cwd } : {}),
			adapters: { prompt: { prompt: async (_text, meta) => prompt(meta) as never } },
		},
	);
	let prompts = 0;
	const replayed = await run(
		def,
		{},
		{
			runId,
			store: createStore(),
			durableBackend: backend,
			...(runOpts?.cwd !== undefined ? { cwd: runOpts.cwd } : {}),
			adapters: {
				prompt: {
					prompt: async () => {
						prompts += 1;
						return "must not rerun";
					},
				},
			},
		},
	);
	return { firstFailed: first.status === "failed", replayed, prompts };
}

function replayedStringResult(replayed: Awaited<ReturnType<typeof run>>): string {
	const result = replayed.result?.result;
	if (typeof result !== "string") throw new TypeError("Expected replayed workflow output to be a string");
	return result;
}

const taskThenTool = workflow({
	name: "task-then-tool",
	description: "",
	inputs: {},
	outputs: { result: Type.String() },
	run: async (ctx) => {
		const review = await ctx.task("review", { prompt: "review the change" });
		const verified = await ctx.tool("verify", { from: review.text }, async () => "verified");
		return { result: verified };
	},
});

describe("ctx.task tail liveness", () => {
	test("delayed task-result checkpoint past the duration ceiling becomes budget_exceeded", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const backend = new DelayedTaskCheckpointBackend();
		const store = createStore();
		const pending = run(
			taskThenTool,
			{},
			{
				store,
				durableBackend: backend,
				budget: { maxDurationMs: 10 },
				adapters: { prompt: { prompt: async () => "review done" } },
			},
		);
		await vi.advanceTimersByTimeAsync(0);
		const snapshotAfterTask = store.runs().find((candidate) => candidate.name === taskThenTool.name);
		assert.equal(
			snapshotAfterTask?.stages.some((stage) => stage.name === "review" && stage.status === "completed"),
			true,
		);
		assert.equal(snapshotAfterTask?.status, "running");
		assert.equal((snapshotAfterTask?.toolNodes ?? []).length, 0);

		await vi.advanceTimersByTimeAsync(20);
		backend.gate.release();
		const result = await pending;
		const snapshot = store.runs().find((candidate) => candidate.id === result.runId);
		assert.equal(budgetOutcome(result.result)?.status, "budget_exceeded");
		assert.equal(effectiveRunStatus(snapshot!), "blocked");
		assert.equal(isImpossibleRootLiveness(snapshot!), false);
		assert.equal(
			(snapshot?.toolNodes ?? []).some((tool) => tool.name === "verify"),
			false,
		);
	});

	test("parallel post-task budget stops remain structured, deterministic, and resumable", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const backend = new DelayedTaskCheckpointBackend();
		setDurableBackend(backend);
		const store = createStore();
		const jobs = createJobTracker();
		let taskExecutions = 0;
		let reducerExecutions = 0;
		const Report = Type.Object(
			{ approved: Type.Boolean(), reviewer: Type.String() },
			{ additionalProperties: false },
		);
		const definition = workflow({
			name: "parallel-post-task-budget",
			description: "",
			inputs: {},
			outputs: { count: Type.Number() },
			run: async (ctx) => {
				const reviews = await ctx.parallel(
					[
						{ name: "review-a", prompt: "review A", schema: Report },
						{ name: "review-b", prompt: "review B", schema: Report },
					],
					{ failFast: false },
				);
				reducerExecutions += 1;
				return { count: reviews.length };
			},
		});
		const adapters = {
			agentSession: {
				create(options: Parameters<typeof structuredOutputMockSession>[0]) {
					taskExecutions += 1;
					const reviewer = taskExecutions === 1 ? "a" : "b";
					return Promise.resolve(structuredOutputMockSession(options, { approved: true, reviewer }));
				},
			},
		};

		const pending = run(
			definition,
			{},
			{
				store,
				durableBackend: backend,
				budget: { maxDurationMs: 10 },
				adapters,
			},
		);
		await vi.advanceTimersByTimeAsync(0);
		assert.equal(backend.taskCheckpoints, 2);
		await vi.advanceTimersByTimeAsync(20);
		backend.gate.release();

		const first = await pending;
		const source = store.runs().find((candidate) => candidate.id === first.runId)!;
		const taskCheckpoints = backend
			.listCheckpoints(first.runId)
			.filter(
				(checkpoint): checkpoint is Extract<DurableCheckpoint, { readonly kind: "stage" }> =>
					checkpoint.kind === "stage" && checkpoint.checkpointId.startsWith("task:"),
			);
		const persistedResults = taskCheckpoints.map((checkpoint) => checkpoint.output as Partial<WorkflowTaskResult>);

		assert.equal(taskCheckpoints.length, 2);
		assert.deepEqual(
			persistedResults
				.map((result) => ({ name: result.name, stageName: result.stageName, structured: result.structured }))
				.sort((left, right) => String(left.name).localeCompare(String(right.name))),
			[
				{ name: "review-a", stageName: "review-a", structured: { approved: true, reviewer: "a" } },
				{ name: "review-b", stageName: "review-b", structured: { approved: true, reviewer: "b" } },
			],
		);
		const budgetResult = budgetOutcome(first.result);
		assert.equal(budgetResult?.status, "budget_exceeded");
		assert.equal(budgetResult?.dimension, "duration");
		assert.equal(budgetResult?.reading, 20);
		assert.equal(budgetResult?.ceiling, 10);
		assert.equal(budgetResult?.frontierStage, "review-a");
		assert.equal(source.failureDisposition, "active_blocked");
		assert.equal(source.failureRecoverability, "recoverable");
		assert.equal(source.budgetState?.systemOwnedStop, true);
		assert.equal(source.budgetState?.duration?.reading, 20);
		assert.equal(source.budgetState?.duration?.ceiling, 10);
		assert.equal(source.budgetState?.wrapUpDelivered, undefined);
		assert.equal(source.budgetState?.wrapUpCompleted, undefined);
		assert.deepEqual(
			source.stages.map((stage) => stage.status),
			["completed", "completed"],
		);
		assert.equal(source.stages.find((stage) => stage.id === source.failedStageId)?.name, "review-a");
		assert.equal(source.stages.find((stage) => stage.id === source.failedStageId)?.status, "completed");
		vi.useRealTimers();
		assert.equal(reducerExecutions, 0);

		const executionsBeforeReplay = taskExecutions;
		const runtime = createExtensionRuntime({ definitions: [definition], store, jobs, adapters });
		const resumed = await runtime.resumeFailedRun(first.runId, undefined, { budget: { maxDurationMs: 100 } });
		assert.equal(resumed.ok, true, resumed.ok ? undefined : resumed.message);
		if (!resumed.ok) return;
		await jobs.get(resumed.runId)?.promise;
		const continuation = store.runs().find((candidate) => candidate.id === resumed.runId);
		assert.equal(continuation?.status, "completed", continuation?.error);
		assert.deepEqual(continuation?.result, { count: 2 });
		assert.equal(taskExecutions, executionsBeforeReplay, "completed tasks must replay without another adapter call");
		assert.equal(reducerExecutions, 1, "the downstream reducer must run exactly once after replay");
	});

	test("parallel budget selection requires every authored step to complete", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const backend = new DelayedTaskCheckpointBackend();
		setDurableBackend(backend);
		const store = createStore();
		const jobs = createJobTracker();
		let taskExecutions = 0;
		let reducerExecutions = 0;
		const Report = Type.Object({ approved: Type.Boolean() }, { additionalProperties: false });
		const definition = workflow({
			name: "partial-parallel-post-task-budget",
			description: "",
			inputs: {},
			outputs: { count: Type.Number() },
			run: async (ctx) => {
				const reviews = await ctx.parallel(
					[
						{ name: "review-a", prompt: "review A", schema: Report },
						{ name: "review-b", prompt: "review B", schema: Report },
						{ name: "review-c", prompt: "review C", schema: Report },
					],
					{ failFast: false, concurrency: 2 },
				);
				reducerExecutions += 1;
				return { count: reviews.length };
			},
		});
		const adapters = {
			agentSession: {
				create(options: Parameters<typeof structuredOutputMockSession>[0]) {
					taskExecutions += 1;
					return Promise.resolve(structuredOutputMockSession(options, { approved: true }));
				},
			},
		};

		const pending = run(
			definition,
			{},
			{
				store,
				durableBackend: backend,
				budget: { maxDurationMs: 10 },
				adapters,
			},
		);
		await vi.advanceTimersByTimeAsync(0);
		assert.equal(backend.taskCheckpoints, 2);
		await vi.advanceTimersByTimeAsync(20);
		backend.gate.release();

		const first = await pending;
		const source = store.runs().find((candidate) => candidate.id === first.runId)!;
		const taskCheckpoints = backend
			.listCheckpoints(first.runId)
			.filter((checkpoint) => checkpoint.kind === "stage" && checkpoint.checkpointId.startsWith("task:"));
		assert.equal(taskCheckpoints.length, 2);
		assert.equal(taskExecutions, 2);
		assert.equal(reducerExecutions, 0);
		assert.equal(first.status, "failed");
		assert.equal(budgetOutcome(first.result)?.status, undefined);
		assert.match(first.error ?? "", /atomic-workflows: 3 parallel steps failed/);
		assert.equal(source.failureDisposition, "terminal_failed");
		assert.notEqual(source.status, "killed");
		assert.notEqual(source.resumable, false);

		vi.useRealTimers();
		const runtime = createExtensionRuntime({ definitions: [definition], store, jobs, adapters });
		const resumed = await runtime.resumeFailedRun(first.runId, undefined, { budget: { maxDurationMs: 10_000 } });
		assert.equal(resumed.ok, false);
		if (resumed.ok) return;
		assert.equal(resumed.reason, "insufficient_state");
		assert.match(resumed.message, /does not identify a failed stage/);
		assert.equal(source.status, "failed");
		assert.notEqual(source.resumable, false);
	});

	test("parallel post-task token budget stops replay completed structured results", async () => {
		const backend = new PostTaskUsageCheckpointBackend();
		setDurableBackend(backend);
		const store = createStore();
		const jobs = createJobTracker();
		let taskExecutions = 0;
		let reducerExecutions = 0;
		// Keep both stage-boundary readings below the ceiling, then make the
		// production-shaped late usage visible only after both complete task
		// checkpoints are durable. This isolates the post-task budget boundary.
		backend.onAllTaskResultsPersisted = () => {
			const source = store.runs().find((candidate) => candidate.name === "parallel-post-task-token-budget");
			assert.ok(source);
			for (const stage of source.stages) {
				const [attempt, ...remainingAttempts] = stage.modelAttempts ?? [];
				assert.ok(attempt);
				stage.modelAttempts = [
					{
						...attempt,
						usage: { ...attempt.usage, output: (attempt.usage?.output ?? 0) + 1 },
					},
					...remainingAttempts,
				];
			}
		};
		const Report = Type.Object(
			{ approved: Type.Boolean(), reviewer: Type.String() },
			{ additionalProperties: false },
		);
		const definition = workflow({
			name: "parallel-post-task-token-budget",
			description: "",
			inputs: {},
			outputs: { count: Type.Number() },
			run: async (ctx) => {
				const reviews = await ctx.parallel(
					[
						{ name: "token-review-a", prompt: "review A", schema: Report },
						{ name: "token-review-b", prompt: "review B", schema: Report },
					],
					{ failFast: false },
				);
				reducerExecutions += 1;
				return { count: reviews.length };
			},
		});
		const adapters = {
			agentSession: {
				create(options: Parameters<typeof structuredOutputMockSession>[0]) {
					taskExecutions += 1;
					const reviewer = taskExecutions === 1 ? "a" : "b";
					const session = structuredOutputMockSession(options, { approved: true, reviewer });
					const prompt = session.prompt.bind(session);
					return Promise.resolve({
						...session,
						async prompt(...args: Parameters<typeof session.prompt>) {
							await prompt(...args);
							session.messages.push(
								assistantMessageWithUsage("", {
									input: 2,
									output: 3,
									cacheRead: 0,
									cacheWrite: 0,
									cost: 0.25,
								}),
							);
							return undefined;
						},
					});
				},
			},
		};

		const first = await run(
			definition,
			{},
			{
				store,
				durableBackend: backend,
				budget: { maxTokens: 11 },
				adapters,
			},
		);
		const source = store.runs().find((candidate) => candidate.id === first.runId)!;
		const taskCheckpoints = backend
			.listCheckpoints(first.runId)
			.filter(
				(checkpoint): checkpoint is Extract<DurableCheckpoint, { readonly kind: "stage" }> =>
					checkpoint.kind === "stage" && checkpoint.checkpointId.startsWith("task:"),
			);

		assert.equal(taskCheckpoints.length, 2);
		assert.deepEqual(
			taskCheckpoints
				.map((checkpoint) => checkpoint.output as Partial<WorkflowTaskResult>)
				.map((result) => ({ name: result.name, stageName: result.stageName, structured: result.structured }))
				.sort((left, right) => String(left.name).localeCompare(String(right.name))),
			[
				{
					name: "token-review-a",
					stageName: "token-review-a",
					structured: { approved: true, reviewer: "a" },
				},
				{
					name: "token-review-b",
					stageName: "token-review-b",
					structured: { approved: true, reviewer: "b" },
				},
			],
		);
		const budgetResult = budgetOutcome(first.result);
		assert.equal(budgetResult?.status, "budget_exceeded");
		assert.equal(budgetResult?.dimension, "tokens");
		assert.equal(budgetResult?.reading, 12);
		assert.equal(budgetResult?.ceiling, 11);
		assert.equal(budgetResult?.frontierStage, "token-review-a");
		assert.equal(source.failureDisposition, "active_blocked");
		assert.equal(source.failureRecoverability, "recoverable");
		assert.equal(source.budgetState?.systemOwnedStop, true);
		assert.equal(source.budgetState?.tokens?.reading, 12);
		assert.equal(source.budgetState?.tokens?.ceiling, 11);
		assert.deepEqual(
			source.stages.map((stage) => stage.status),
			["completed", "completed"],
		);
		assert.equal(source.stages.find((stage) => stage.id === source.failedStageId)?.name, "token-review-a");
		assert.equal(source.stages.find((stage) => stage.id === source.failedStageId)?.status, "completed");
		assert.equal(reducerExecutions, 0);

		const executionsBeforeReplay = taskExecutions;
		const runtime = createExtensionRuntime({ definitions: [definition], store, jobs, adapters });
		const resumed = await runtime.resumeFailedRun(first.runId, undefined, { budget: { maxTokens: 100 } });
		assert.equal(resumed.ok, true, resumed.ok ? undefined : resumed.message);
		if (!resumed.ok) return;
		await jobs.get(resumed.runId)?.promise;
		const continuation = store.runs().find((candidate) => candidate.id === resumed.runId);
		assert.equal(continuation?.status, "completed", continuation?.error);
		assert.deepEqual(continuation?.result, { count: 2 });
		assert.equal(taskExecutions, executionsBeforeReplay, "completed tasks must replay without another adapter call");
		assert.equal(reducerExecutions, 1, "the downstream reducer must run exactly once after replay");
	});
	test("an ordinary failure still wins over a concurrent post-task budget stop", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const backend = new DelayedTaskCheckpointBackend();
		const store = createStore();
		let taskExecutions = 0;
		const Report = Type.Object({ approved: Type.Boolean() }, { additionalProperties: false });
		const definition = workflow({
			name: "parallel-mixed-post-task-budget",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.parallel(
					[
						{ name: "review-a", prompt: "review A", schema: Report },
						{ name: "review-b", prompt: "review B", schema: Report },
					],
					{ failFast: false },
				);
				return {};
			},
		});
		const pending = run(
			definition,
			{},
			{
				store,
				durableBackend: backend,
				budget: { maxDurationMs: 10 },
				adapters: {
					agentSession: {
						create(options: Parameters<typeof structuredOutputMockSession>[0]) {
							taskExecutions += 1;
							const session = structuredOutputMockSession(options, { approved: true });
							if (taskExecutions === 1) return Promise.resolve(session);
							return Promise.resolve({
								...session,
								async prompt() {
									throw new Error("ordinary verifier failure");
								},
							});
						},
					},
				},
			},
		);
		await vi.advanceTimersByTimeAsync(0);
		assert.equal(backend.taskCheckpoints, 1);
		await vi.advanceTimersByTimeAsync(20);
		backend.gate.release();

		const result = await pending;
		const snapshot = store.runs().find((candidate) => candidate.id === result.runId)!;
		assert.equal(result.status, "failed");
		assert.equal(result.result, undefined);
		assert.match(result.error ?? "", /atomic-workflows: 2 parallel steps failed/);
		assert.equal(snapshot.failureDisposition, "terminal_failed");
		assert.equal(snapshot.budgetState?.systemOwnedStop, true);
		assert.equal(snapshot.stages.find((stage) => stage.name === "review-a")?.status, "completed");
		assert.equal(snapshot.stages.find((stage) => stage.name === "review-b")?.status, "failed");
	});

	test("task-result checkpoint failure rejects the root instead of leaving it pending", async () => {
		const backend = new DelayedTaskCheckpointBackend();
		backend.failTaskCheckpoint = true;
		const store = createStore();
		const pending = run(
			taskThenTool,
			{},
			{
				store,
				durableBackend: backend,
				adapters: { prompt: { prompt: async () => "review done" } },
			},
		);
		await Promise.resolve();
		backend.gate.release();
		const result = await pending;
		const snapshot = store.runs().find((candidate) => candidate.id === result.runId);
		assert.equal(result.status, "failed");
		assert.equal(snapshot?.status, "failed");
		assert.match(result.error ?? "", /task-result checkpoint failed/);
		assert.equal(snapshot?.endedAt !== undefined, true);
	});

	test("resumed replay reuses the completed task checkpoint without rerunning it", async () => {
		const backend = new InMemoryDurableBackend();
		backend.registerWorkflow({
			workflowId: "wf-task-tail-replay",
			name: "task-replay-only",
			inputs: {},
			createdAt: 1,
			status: "running",
		});
		backend.recordCheckpoint({
			kind: "stage",
			workflowId: "wf-task-tail-replay",
			checkpointId: "task:stage:task:review:1",
			name: "review",
			replayKey: "stage:task:review:1",
			output: { name: "review", stageName: "review", text: "cached review" },
			completedAt: 2,
		});
		let prompts = 0;
		const replayOnly = workflow({
			name: "task-replay-only",
			description: "",
			inputs: {},
			outputs: { result: Type.String() },
			run: async (ctx) => ({ result: (await ctx.task("review", { prompt: "ignored" })).text }),
		});
		const replayed = await run(
			replayOnly,
			{},
			{
				runId: "wf-task-tail-replay",
				store: createStore(),
				durableBackend: backend,
				adapters: {
					prompt: {
						prompt: async () => {
							prompts += 1;
							return "must not rerun";
						},
					},
				},
			},
		);
		assert.equal(replayed.status, "completed");
		assert.equal(replayed.result?.result, "cached review");
		assert.equal(prompts, 0);
	});

	test("terminal-only stage checkpoint replays a completed task without rerunning it", async () => {
		const backend = new InMemoryDurableBackend();
		backend.registerWorkflow({
			workflowId: "wf-task-terminal-only",
			name: "task-terminal-only",
			inputs: {},
			createdAt: 1,
			status: "running",
		});
		backend.recordCheckpoint({
			kind: "stage",
			workflowId: "wf-task-terminal-only",
			checkpointId: "stage:stage:task:review:1",
			name: "review",
			replayKey: "stage:task:review:1",
			output: "terminal review text",
			completedAt: 2,
			sessionId: "sess-review",
			sessionFile: "/tmp/review.jsonl",
			model: "openai/gpt-test",
			structured: { approved: true, score: 4 },
			artifacts: [{ kind: "diff", path: "/tmp/review.diff", taskName: "review" }],
			warnings: ["used fallback model"],
		});
		let prompts = 0;
		const replayOnly = workflow({
			name: "task-terminal-only",
			description: "",
			inputs: {},
			outputs: { result: Type.String() },
			run: async (ctx) => {
				const review = await ctx.task("review", { prompt: "ignored" });
				return {
					result: JSON.stringify({
						text: review.text,
						structured: review.structured,
						artifacts: review.artifacts,
						warnings: review.warnings,
						sessionId: review.sessionId,
						sessionFile: review.sessionFile,
						model: review.model,
					}),
				};
			},
		});
		const replayed = await run(
			replayOnly,
			{},
			{
				runId: "wf-task-terminal-only",
				store: createStore(),
				durableBackend: backend,
				adapters: {
					prompt: {
						prompt: async () => {
							prompts += 1;
							return "must not rerun";
						},
					},
				},
			},
		);
		assert.equal(replayed.status, "completed");
		assert.deepEqual(JSON.parse(replayed.result?.result ?? ""), {
			text: "terminal review text",
			structured: { approved: true, score: 4 },
			artifacts: [{ kind: "diff", path: "/tmp/review.diff", taskName: "review" }],
			warnings: ["used fallback model"],
			sessionId: "sess-review",
			sessionFile: "/tmp/review.jsonl",
			model: "openai/gpt-test",
		});
		assert.equal(prompts, 0);
	});

	test("terminal-only stage checkpoint preserves fallback metadata without rerunning the task", async () => {
		const backend = new InMemoryDurableBackend();
		const attemptedModels = ["openai/gpt-primary", "anthropic/claude-fallback", "openai/gpt-primary"];
		const modelAttempts = [
			{
				model: "openai/gpt-primary",
				success: false,
				reasoningLevel: "high" as const,
				error: "rate limited",
				usage: { input: 11, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.25, turns: 1 },
			},
			{
				model: "anthropic/claude-fallback",
				success: true,
				reasoningLevel: "medium" as const,
				usage: { input: 17, output: 9, cacheRead: 5, cacheWrite: 6, cost: 0.75, turns: 2 },
			},
		];
		backend.registerWorkflow({
			workflowId: "wf-task-terminal-only",
			name: "task-terminal-only",
			inputs: {},
			createdAt: 1,
			status: "running",
		});
		backend.recordCheckpoint({
			kind: "stage",
			workflowId: "wf-task-terminal-only",
			checkpointId: "stage:stage:task:review:1",
			name: "review",
			replayKey: "stage:task:review:1",
			output: "terminal review text",
			completedAt: 2,
			sessionId: "sess-review",
			sessionFile: "/tmp/review.jsonl",
			model: "openai/gpt-test",
			attemptedModels,
			modelAttempts,
			structured: { approved: true, score: 4 },
			artifacts: [{ kind: "diff", path: "/tmp/review.diff", taskName: "review" }],
			warnings: ["used fallback model"],
		});
		let prompts = 0;
		const replayOnly = workflow({
			name: "task-terminal-only",
			description: "",
			inputs: {},
			outputs: { result: Type.String() },
			run: async (ctx) => {
				const review = await ctx.task("review", { prompt: "ignored" });
				return {
					result: JSON.stringify({
						text: review.text,
						structured: review.structured,
						artifacts: review.artifacts,
						warnings: review.warnings,
						sessionId: review.sessionId,
						sessionFile: review.sessionFile,
						model: review.model,
						attemptedModels: review.attemptedModels,
						modelAttempts: review.modelAttempts,
					}),
				};
			},
		});
		const replayed = await run(
			replayOnly,
			{},
			{
				runId: "wf-task-terminal-only",
				store: createStore(),
				durableBackend: backend,
				adapters: {
					prompt: {
						prompt: async () => {
							prompts += 1;
							return "must not rerun";
						},
					},
				},
			},
		);
		assert.equal(replayed.status, "completed");
		assert.deepEqual(JSON.parse(replayed.result?.result ?? ""), {
			text: "terminal review text",
			structured: { approved: true, score: 4 },
			artifacts: [{ kind: "diff", path: "/tmp/review.diff", taskName: "review" }],
			warnings: ["used fallback model"],
			sessionId: "sess-review",
			sessionFile: "/tmp/review.jsonl",
			model: "openai/gpt-test",
			attemptedModels,
			modelAttempts,
		});
		assert.equal(prompts, 0);
	});

	test("terminal-only replay returns structured artifacts and warnings without rerunning", async () => {
		const backend = new InMemoryDurableBackend();
		const replayKey = "stage:task:review:1";
		backend.registerWorkflow({
			workflowId: "wf-task-terminal-fields",
			name: "task-terminal-fields",
			inputs: {},
			createdAt: 1,
			status: "running",
		});
		backend.recordCheckpoint({
			kind: "stage",
			workflowId: "wf-task-terminal-fields",
			checkpointId: `stage:${replayKey}`,
			name: "review",
			replayKey,
			output: "terminal review text",
			completedAt: 2,
			sessionFile: "/tmp/review.jsonl",
			structured: { approved: false },
			artifacts: [{ kind: "patch", path: "/tmp/review.patch" }],
			warnings: ["rate limited once"],
		});
		const task = createDurableTaskPrimitive({
			workflowId: "wf-task-terminal-fields",
			backend,
			nextReplayKey: () => replayKey,
			task: async () => {
				throw new Error("live task should not run");
			},
		});
		assert.deepEqual(await task("review", { prompt: "ignored" }), {
			name: "review",
			stageName: "review",
			text: "terminal review text",
			structured: { approved: false },
			sessionFile: "/tmp/review.jsonl",
			artifacts: [{ kind: "patch", path: "/tmp/review.patch" }],
			warnings: ["rate limited once"],
		});
	});

	test("terminal-only replay preserves schema task text", async () => {
		const backend = new InMemoryDurableBackend();
		const replayKey = "stage:task:review:1";
		backend.registerWorkflow({
			workflowId: "wf-schema-receipt",
			name: "schema-receipt",
			inputs: {},
			createdAt: 1,
			status: "running",
		});
		backend.recordCheckpoint({
			kind: "stage",
			workflowId: "wf-schema-receipt",
			checkpointId: `stage:${replayKey}`,
			name: "review",
			replayKey,
			output: JSON.stringify({ approved: true, findings: ["ok"] }, null, 2),
			completedAt: 2,
			result: JSON.stringify({ approved: true, findings: ["ok"] }, null, 2),
			structured: { approved: true, findings: ["ok"] },
		});
		let prompts = 0;
		const replayed = await run(
			workflow({
				name: "schema-receipt",
				description: "",
				inputs: {},
				outputs: { result: Type.String() },
				run: async (ctx) => {
					const review = await ctx.task("review", { prompt: "ignored" });
					return { result: review.text };
				},
			}),
			{},
			{
				runId: "wf-schema-receipt",
				store: createStore(),
				durableBackend: backend,
				adapters: {
					prompt: {
						prompt: async () => {
							prompts += 1;
							return "must not rerun";
						},
					},
				},
			},
		);
		assert.equal(replayed.status, "completed");
		assert.equal(replayed.result?.result, JSON.stringify({ approved: true, findings: ["ok"] }, null, 2));
		assert.equal(prompts, 0);
	});

	test("terminal-only schema maxOutput replay keeps the truncated text", async () => {
		const backend = new InMemoryDurableBackend();
		const replayKey = "stage:task:review:1";
		const structured = { approved: true, notes: "line1\nline2\nline3" };
		const truncated = `{\n\n[workflow output truncated; limits: 204800 bytes, 1 lines]`;
		backend.registerWorkflow({
			workflowId: "wf-schema-max-output",
			name: "schema-max-output",
			inputs: {},
			createdAt: 1,
			status: "running",
		});
		backend.recordCheckpoint({
			kind: "stage",
			workflowId: "wf-schema-max-output",
			checkpointId: `stage:${replayKey}`,
			name: "review",
			replayKey,
			output: truncated,
			completedAt: 2,
			result: truncated,
			structured,
		});
		let prompts = 0;
		const replayed = await run(
			workflow({
				name: "schema-max-output",
				description: "",
				inputs: {},
				outputs: { result: Type.String() },
				run: async (ctx) => {
					const review = await ctx.task("review", { prompt: "ignored", maxOutput: { lines: 1 } });
					return {
						result: JSON.stringify({ text: review.text, structured: review.structured }),
					};
				},
			}),
			{},
			{
				runId: "wf-schema-max-output",
				store: createStore(),
				durableBackend: backend,
				adapters: {
					prompt: {
						prompt: async () => {
							prompts += 1;
							return "must not rerun";
						},
					},
				},
			},
		);
		assert.equal(replayed.status, "completed");
		assert.deepEqual(JSON.parse(replayed.result?.result ?? ""), { text: truncated, structured });
		assert.equal(prompts, 0);
		assert.notEqual(truncated, JSON.stringify(structured, null, 2));
	});

	test("direct nested task-tail control settles the aggregate root", async () => {
		const store = createStore();
		const toolControls = createToolControlRegistry();
		store.recordRunStart({
			id: "parent",
			name: "parent",
			inputs: {},
			status: "running",
			stages: [
				{
					id: "boundary",
					name: "child-wf",
					status: "running",
					parentIds: [],
					toolEvents: [],
					workflowChildRun: { alias: "child", workflow: "child-wf", runId: "child" },
					workflowGraphTarget: { runId: "child", stageId: "review", runName: "child-wf", depth: 1 },
				} as RunSnapshot["stages"][number],
			],
			startedAt: 0,
		});
		store.recordRunStart({
			id: "child",
			name: "child-wf",
			inputs: {},
			status: "running",
			parentRunId: "parent",
			parentStageId: "boundary",
			rootRunId: "parent",
			stages: [
				{
					id: "review",
					name: "review",
					status: "completed",
					parentIds: [],
					toolEvents: [],
				},
			],
			startedAt: 0,
		});
		toolControls.register({
			runId: "child",
			nodeId: `${TASK_RESULT_CHECKPOINT_CONTROL_PREFIX}stage:task:review:1`,
			name: "review",
			controller: new AbortController(),
			settled: new Promise(() => {}),
		});
		const interrupted = await interruptRun("child", { store, toolControlRegistry: toolControls });
		assert.equal(interrupted.ok, true);
		assert.equal(interrupted.runId, "parent");
		assert.equal(store.runs().find((run) => run.id === "parent")?.status, "paused");
		assert.equal(store.runs().find((run) => run.id === "child")?.status, "paused");
	});

	test("direct nested task-tail quit settles the aggregate root", async () => {
		const backend = new InMemoryDurableBackend();
		setDurableBackend(backend);
		backend.registerWorkflow({
			workflowId: "parent",
			name: "parent",
			inputs: {},
			createdAt: 1,
			status: "running",
		});
		backend.recordCheckpoint({
			kind: "stage",
			workflowId: "parent",
			checkpointId: "task:stage:task:review:1",
			name: "review",
			replayKey: "stage:task:review:1",
			output: { name: "review", stageName: "review", text: "cached review" },
			completedAt: 2,
		});
		const store = createStore();
		const toolControls = createToolControlRegistry();
		store.recordRunStart({
			id: "parent",
			name: "parent",
			inputs: {},
			status: "running",
			stages: [
				{
					id: "boundary",
					name: "child-wf",
					status: "running",
					parentIds: [],
					toolEvents: [],
					workflowChildRun: { alias: "child", workflow: "child-wf", runId: "child" },
					workflowGraphTarget: { runId: "child", stageId: "review", runName: "child-wf", depth: 1 },
				} as RunSnapshot["stages"][number],
			],
			startedAt: 0,
		});
		store.recordRunStart({
			id: "child",
			name: "child-wf",
			inputs: {},
			status: "running",
			parentRunId: "parent",
			parentStageId: "boundary",
			rootRunId: "parent",
			stages: [
				{
					id: "review",
					name: "review",
					status: "completed",
					parentIds: [],
					toolEvents: [],
				},
			],
			startedAt: 0,
		});
		toolControls.register({
			runId: "child",
			nodeId: `${TASK_RESULT_CHECKPOINT_CONTROL_PREFIX}stage:task:review:1`,
			name: "review",
			controller: new AbortController(),
			settled: new Promise(() => {}),
		});
		const quit = await quitRun("child", { store, toolControlRegistry: toolControls });
		assert.equal(quit.ok, true);
		assert.equal(quit.runId, "parent");
		assert.equal(store.runs().find((run) => run.id === "parent")?.status, "paused");
		assert.equal(store.runs().find((run) => run.id === "child")?.status, "paused");
		assert.equal(backend.getWorkflow("parent")?.status, "paused");
		assert.equal(backend.getWorkflow("parent")?.resumable, true);
		let prompts = 0;
		const replayed = await run(
			workflow({
				name: "parent",
				description: "",
				inputs: {},
				outputs: { result: Type.String() },
				run: async (ctx) => ({ result: (await ctx.task("review", { prompt: "ignored" })).text }),
			}),
			{},
			{
				runId: "parent",
				store: createStore(),
				durableBackend: backend,
				adapters: {
					prompt: {
						prompt: async () => {
							prompts += 1;
							return "must not rerun";
						},
					},
				},
			},
		);
		assert.equal(replayed.status, "completed");
		assert.equal(replayed.result?.result, "cached review");
		assert.equal(prompts, 0);
	});
	test("live null structured survives after the task-result persist is dropped", async () => {
		const { firstFailed, replayed, prompts } = await replayAfterDroppedTaskPersist(
			"live-null-structured",
			{ prompt: "review" },
			() => null,
		);
		assert.equal(firstFailed, true);
		assert.equal(replayed.status, "completed");
		assert.deepEqual(JSON.parse(replayedStringResult(replayed)), {
			text: "null",
			structured: null,
		});
		assert.equal(prompts, 0);
	});

	test("live maxOutput text survives after the task-result persist is dropped", async () => {
		const { firstFailed, replayed, prompts } = await replayAfterDroppedTaskPersist(
			"live-max-output",
			{ prompt: "review", maxOutput: { lines: 1 } },
			() => "alpha\nbeta\ngamma",
		);
		assert.equal(firstFailed, true);
		assert.equal(replayed.status, "completed");
		const payload = JSON.parse(replayedStringResult(replayed)) as { text?: string };
		assert.match(payload.text ?? "", /^alpha\n\n\[workflow output truncated/);
		assert.equal(prompts, 0);
	});

	test("live worktree artifacts survive after the task-result persist is dropped", async () => {
		const repo = mkdtempSync(join(tmpdir(), "atomic-task-artifacts-"));
		runGitChecked(repo, ["init", "-b", "main"]);
		runGitChecked(repo, ["config", "user.name", "Atomic Test"]);
		runGitChecked(repo, ["config", "user.email", "atomic@example.com"]);
		writeFileSync(join(repo, "tracked.txt"), "base\n");
		runGitChecked(repo, ["add", "."]);
		runGitChecked(repo, ["commit", "--no-gpg-sign", "-m", "initial"]);
		const { firstFailed, replayed, prompts } = await replayAfterDroppedTaskPersist(
			"live-worktree-artifacts",
			{ prompt: "review", worktree: true },
			(meta) => {
				const cwd = meta?.stageOptions?.cwd ?? repo;
				mkdirSync(cwd, { recursive: true });
				writeFileSync(join(cwd, "changed.txt"), "from-task\n");
				return "reviewed";
			},
			{ cwd: repo },
		);
		assert.equal(firstFailed, true);
		assert.equal(replayed.status, "completed");
		const payload = JSON.parse(replayedStringResult(replayed)) as {
			text?: string;
			artifacts?: readonly { path?: string; kind?: string }[];
		};
		assert.equal(payload.text, "reviewed");
		assert.equal(payload.artifacts?.[0]?.kind, "diff");
		assert.ok((payload.artifacts?.[0]?.path ?? "").length > 0);
		assert.equal(prompts, 0);
	});

	test("quit and interrupt terminate a root awaiting a never-settling task-result checkpoint", async () => {
		const backend = new DelayedTaskCheckpointBackend();
		setDurableBackend(backend);
		const store = createStore();
		const registry = createStageControlRegistry();
		const toolControls = createToolControlRegistry();
		const pending = run(
			taskThenTool,
			{},
			{
				store,
				durableBackend: backend,
				stageControlRegistry: registry,
				toolControlRegistry: toolControls,
				adapters: { prompt: { prompt: async () => "review done" } },
			},
		);
		const deadline = Date.now() + 2_000;
		let runId = "";
		while (Date.now() < deadline) {
			runId = store.runs().find((candidate) => candidate.name === taskThenTool.name)?.id ?? "";
			if (runId !== "" && toolControls.active(runId).some((handle) => handle.nodeId.startsWith("task-checkpoint:")))
				break;
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		assert.ok(runId.length > 0);
		assert.equal(registry.run(runId).stages().length, 0);
		const interrupted = await interruptRun(runId, {
			store,
			stageControlRegistry: registry,
			toolControlRegistry: toolControls,
		});
		assert.equal(interrupted.ok, true);
		const finished = await pending;
		assert.equal(finished.status, "paused");
		assert.equal(store.runs().find((candidate) => candidate.id === runId)?.status, "paused");
		assert.equal(store.runs().find((candidate) => candidate.id === runId)?.exitReason, "quit");
		assert.equal(backend.getWorkflow(runId)?.status, "paused");
	});

	test("a caught task-tail quit still pauses instead of completing", async () => {
		const backend = new DelayedTaskCheckpointBackend();
		setDurableBackend(backend);
		const store = createStore();
		const registry = createStageControlRegistry();
		const toolControls = createToolControlRegistry();
		const catching = workflow({
			name: "catch-task-tail-quit",
			description: "",
			inputs: {},
			outputs: { result: Type.String() },
			run: async (ctx) => {
				try {
					await ctx.task("review", { prompt: "review the change" });
				} catch {
					return { result: "caught" };
				}
				return { result: "ok" };
			},
		});
		const pending = run(
			catching,
			{},
			{
				store,
				durableBackend: backend,
				stageControlRegistry: registry,
				toolControlRegistry: toolControls,
				adapters: { prompt: { prompt: async () => "review done" } },
			},
		);
		const deadline = Date.now() + 2_000;
		let runId = "";
		while (Date.now() < deadline) {
			runId = store.runs().find((candidate) => candidate.name === catching.name)?.id ?? "";
			if (runId !== "" && toolControls.active(runId).some((handle) => handle.nodeId.startsWith("task-checkpoint:")))
				break;
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		assert.ok(runId.length > 0);
		const interrupted = await interruptRun(runId, {
			store,
			stageControlRegistry: registry,
			toolControlRegistry: toolControls,
		});
		assert.equal(interrupted.ok, true);
		const finished = await pending;
		assert.equal(finished.status, "paused");
		assert.equal(finished.result?.result, undefined);
		assert.equal(store.runs().find((candidate) => candidate.id === runId)?.status, "paused");
		assert.equal(store.runs().find((candidate) => candidate.id === runId)?.exitReason, "quit");
		assert.equal(backend.getWorkflow(runId)?.status, "paused");
	});

	test("a checkpoint created after its signal is already aborted does not become an unhandled rejection", async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", onUnhandled);
		try {
			const backend = new InMemoryDurableBackend();
			const controller = new AbortController();
			const reason = new Error("cancelled before checkpoint");
			const task = createDurableTaskPrimitive({
				workflowId: "wf-preabort-checkpoint",
				backend,
				nextReplayKey: () => "stage:task:review:1",
				signal: controller.signal,
				task: async () => {
					controller.abort(reason);
					return { name: "review", stageName: "review", text: "done" };
				},
			});
			await assert.rejects(
				() => task("review", { prompt: "review the change" }),
				(error) => error === reason,
			);
			await Promise.resolve();
			await new Promise((resolve) => setTimeout(resolve, 15));
			assert.deepEqual(unhandled, []);
			assert.equal(backend.getStageOutput("wf-preabort-checkpoint", "stage:task:review:1"), undefined);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	test("an active task-checkpoint control is not diagnosed as a stranded root", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const backend = new DelayedTaskCheckpointBackend();
		const store = createStore();
		const toolControls = createToolControlRegistry();
		const pending = run(
			taskThenTool,
			{},
			{
				store,
				durableBackend: backend,
				toolControlRegistry: toolControls,
				budget: { maxDurationMs: 10 },
				adapters: { prompt: { prompt: async () => "review done" } },
			},
		);
		await vi.advanceTimersByTimeAsync(0);
		const snapshotAfterTask = store.runs().find((candidate) => candidate.name === taskThenTool.name);
		assert.ok(snapshotAfterTask);
		assert.equal(
			toolControls
				.active(snapshotAfterTask.id)
				.some((handle) => handle.nodeId.startsWith(TASK_RESULT_CHECKPOINT_CONTROL_PREFIX)),
			true,
		);
		await vi.advanceTimersByTimeAsync(20);
		const live = store.runs().find((candidate) => candidate.id === snapshotAfterTask.id);
		assert.ok(live);
		assert.equal(live.status, "running");
		assert.equal(isImpossibleRootLiveness(live, 20), true);
		assert.equal(isImpossibleRootLiveness(live, 20, { hasActiveControlNode: true }), false);
		assert.equal(summarizeRunSnapshot(live, 20, { toolControlRegistry: toolControls }).strandedRoot, undefined);
		assert.equal(summarizeRunSnapshot(live, 20, { toolControlRegistry: toolControls }).error, undefined);
		backend.gate.release();
		const result = await pending;
		assert.equal(budgetOutcome(result.result)?.status, "budget_exceeded");
	});

	test("an expanded child task-checkpoint control is not diagnosed as a stranded root", () => {
		const toolControls = createToolControlRegistry();
		toolControls.register({
			runId: "child",
			nodeId: `${TASK_RESULT_CHECKPOINT_CONTROL_PREFIX}stage:task:review:1`,
			name: "review",
			controller: new AbortController(),
			settled: new Promise(() => {}),
		});
		const parent: RunSnapshot = {
			id: "parent",
			name: "parent",
			inputs: {},
			status: "running",
			stages: [
				{
					id: "review",
					name: "review",
					status: "completed",
					parentIds: [],
					toolEvents: [],
					workflowGraphTarget: { runId: "child", stageId: "review", runName: "child-wf", depth: 1 },
				} as RunSnapshot["stages"][number],
			],
			toolNodes: [],
			startedAt: 0,
			budget: { maxDurationMs: 10, warnAtPercent: 80 },
		};
		assert.equal(isImpossibleRootLiveness(parent, 20), true);
		assert.equal(summarizeRunSnapshot(parent, 20, { toolControlRegistry: toolControls }).strandedRoot, undefined);
		assert.equal(summarizeRunSnapshot(parent, 20, { toolControlRegistry: toolControls }).error, undefined);
	});

	test("interruptAllRuns forwards an injected tool-control registry to a task tail", async () => {
		const backend = new DelayedTaskCheckpointBackend();
		setDurableBackend(backend);
		const store = createStore();
		const registry = createStageControlRegistry();
		const toolControls = createToolControlRegistry();
		const pending = run(
			taskThenTool,
			{},
			{
				store,
				durableBackend: backend,
				stageControlRegistry: registry,
				toolControlRegistry: toolControls,
				adapters: { prompt: { prompt: async () => "review done" } },
			},
		);
		const deadline = Date.now() + 2_000;
		let runId = "";
		while (Date.now() < deadline) {
			runId = store.runs().find((candidate) => candidate.name === taskThenTool.name)?.id ?? "";
			if (runId !== "" && toolControls.active(runId).some((handle) => handle.nodeId.startsWith("task-checkpoint:")))
				break;
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		assert.ok(runId.length > 0);
		const interrupted = await interruptAllRuns({
			store,
			stageControlRegistry: registry,
			toolControlRegistry: toolControls,
		});
		assert.equal(interrupted.length, 1);
		assert.equal(interrupted[0]?.ok, true);
		const finished = await pending;
		assert.equal(finished.status, "paused");
		assert.equal(store.runs().find((candidate) => candidate.id === runId)?.exitReason, "quit");
	});

	test("status reports a stranded completed frontier that is still raw-running over budget", () => {
		const runSnapshot: RunSnapshot = {
			id: "stranded",
			name: "stranded",
			inputs: {},
			status: "running",
			stages: [
				{
					id: "review",
					name: "review",
					status: "completed",
					parentIds: [],
					toolEvents: [],
				},
			],
			toolNodes: [],
			startedAt: 0,
			budget: { maxDurationMs: 10, warnAtPercent: 80 },
		};
		assert.equal(isImpossibleRootLiveness(runSnapshot, 20), true);
		const summary = summarizeRunSnapshot(runSnapshot, 20);
		assert.equal(summary.strandedRoot, true);
		assert.equal(summary.error, IMPOSSIBLE_ROOT_LIVENESS_MESSAGE);
		assert.equal(summary.status, "running");
		const store = createStore();
		store.recordRunStart(runSnapshot);
		const inspected = inspectRun("stranded", { store, now: 20 });
		assert.equal(inspected.ok, true);
		if (inspected.ok) {
			assert.equal(inspected.detail.strandedRoot, true);
			assert.equal(inspected.detail.error, IMPOSSIBLE_ROOT_LIVENESS_MESSAGE);
		}
		const toolControls = createToolControlRegistry();
		toolControls.register({
			runId: "stranded",
			nodeId: `${TASK_RESULT_CHECKPOINT_CONTROL_PREFIX}stage:task:review:1`,
			name: "review",
			controller: new AbortController(),
			settled: new Promise(() => {}),
		});
		const liveInspected = inspectRun("stranded", { store, now: 20, toolControlRegistry: toolControls });
		assert.equal(liveInspected.ok, true);
		if (liveInspected.ok) {
			assert.equal(liveInspected.detail.strandedRoot, undefined);
			assert.equal(liveInspected.detail.error, undefined);
		}
	});

	test("stale running handles remain crashed rather than live", () => {
		assert.equal(isLiveRunningWorkflow({ status: "running", updatedAt: 1 }, 200_000), false);
	});

	test("stopAtBoundaryAsync does not await a stale wrap-up after the stage control is gone", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const runSnapshot: RunSnapshot = {
			id: "stale-wrap",
			name: "stale-wrap",
			inputs: {},
			status: "running",
			stages: [],
			startedAt: 0,
		};
		const controller = createRunBudgetController({
			run: runSnapshot,
			budget: resolve_budget({ run: { maxDurationMs: 1 } }),
		});
		const hung = controller.registerWrapUp("review", () => new Promise<never>(() => {}));
		void controller.deliverWrapUp("review").catch(() => undefined);
		hung();
		vi.setSystemTime(10);
		await assert.rejects(() => controller.stopAtBoundaryAsync("review"), /budget exceeded/);
	});
});
