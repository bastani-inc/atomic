import assert from "node:assert/strict";
import { afterEach, describe, test, vi } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { DbosDurableBackend } from "../../packages/workflows/src/durable/dbos-backend.js";
import { priorRunElapsedMs } from "../../packages/workflows/src/durable/run-timing.js";
import type { DurableCheckpoint, DurableStageCheckpoint } from "../../packages/workflows/src/durable/types.js";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import { createStageSessionHeartbeat } from "../../packages/workflows/src/runs/foreground/stage-session-heartbeat.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { testRunId } from "../helpers/run-id.js";
import { createMockSdk } from "./durable-dbos-backend-helpers.js";
import { mockSession, type StageSessionRuntime } from "./executor-shared.js";

const HEARTBEAT_MS = 30_000;
const SERIAL_CONFIG = {
	defaultConcurrency: 1,
	maxDepth: 10,
	persistRuns: false,
	statusFile: false,
	resumeInFlight: "never" as const,
};

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

test("uses fixed heartbeat deadlines without overlap and unreferences each timer", async () => {
	vi.useFakeTimers();
	vi.setSystemTime(0);
	const starts: number[] = [];
	const heartbeat = createStageSessionHeartbeat(async () => {
		starts.push(Date.now());
		await new Promise<void>((resolve) => setTimeout(resolve, 100));
	}, 50);

	heartbeat.start();
	await vi.advanceTimersByTimeAsync(260);
	heartbeat.stop();

	assert.equal(starts[0], 50);
	assert.equal(starts.length, 3);
	assert.ok(starts.slice(1).every((start, index) => start - starts[index]! <= 101));
	const stoppedStarts = [...starts];
	await vi.advanceTimersByTimeAsync(200);
	assert.deepEqual(starts, stoppedStarts);
	assert.equal(vi.getTimerCount(), 0);
});

test("drains an in-flight checkpoint at shutdown and surfaces its late rejection", async () => {
	vi.useFakeTimers();
	vi.setSystemTime(0);
	const unhandled: unknown[] = [];
	const captureUnhandled = (reason: unknown): void => {
		unhandled.push(reason);
	};
	process.on("unhandledRejection", captureUnhandled);
	try {
		const checkpointStarted = Promise.withResolvers<void>();
		const releaseCheckpoint = Promise.withResolvers<void>();
		let checkpoints = 0;
		const heartbeat = createStageSessionHeartbeat(async () => {
			checkpoints += 1;
			checkpointStarted.resolve();
			await releaseCheckpoint.promise;
			throw new Error("late checkpoint failure");
		}, 50);

		heartbeat.start();
		await vi.advanceTimersByTimeAsync(50);
		await checkpointStarted.promise;
		// Model work wins the race while that checkpoint is still in flight.
		assert.equal(await heartbeat.race(Promise.resolve("model-result")), "model-result");

		const drained = heartbeat.drain();
		releaseCheckpoint.resolve();
		await assert.rejects(drained, /late checkpoint failure/);
		// The recorded failure keeps surfacing rather than being dropped once drained.
		await assert.rejects(heartbeat.drain(), /late checkpoint failure/);
		assert.equal(checkpoints, 1);
		assert.equal(vi.getTimerCount(), 0);

		vi.useRealTimers();
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.deepEqual(unhandled, []);
	} finally {
		process.off("unhandledRejection", captureUnhandled);
	}
});

describe("active workflow stage session durability", () => {
	test("persists identity after stage start, refreshes every 30 seconds, and stops on completion", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000_000);
		const store = createStore();
		const runId = testRunId("stage-heartbeat-order");
		const observedStatuses: string[] = [];
		class ObservingBackend extends InMemoryDurableBackend {
			override async recordCheckpointAsync(checkpoint: DurableCheckpoint): Promise<void> {
				if (checkpoint.kind === "stage" && checkpoint.sessionFile !== undefined) {
					observedStatuses.push(
						store.runs().find((candidate) => candidate.id === runId)?.stages[0]?.status ?? "missing",
					);
				}
				await super.recordCheckpointAsync(checkpoint);
			}
		}
		const backend = new ObservingBackend();
		const release = Promise.withResolvers<string>();
		const session: StageSessionRuntime = {
			...mockSession(),
			sessionId: "active-session",
			sessionFile: "/tmp/retained-active-session.jsonl",
			async prompt() {
				return await release.promise;
			},
		};
		const definition = workflow({
			name: "stage-heartbeat-order",
			description: "",
			inputs: {},
			outputs: {},
			async run(ctx) {
				await ctx.stage("long-turn").prompt("work");
				return {};
			},
		});

		const execution = run(
			definition,
			{},
			{
				runId,
				store,
				durableBackend: backend,
				adapters: { agentSession: { create: async () => session } },
			},
		);
		await vi.advanceTimersByTimeAsync(0);

		assert.deepEqual(observedStatuses, ["running"]);
		assert.equal(
			backend.listCheckpoints(runId).filter((checkpoint) => checkpoint.kind === "stage" && checkpoint.sessionFile)
				.length,
			1,
		);
		const firstUpdatedAt = backend.getWorkflow(runId)?.updatedAt;
		await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
		assert.equal(
			backend.listCheckpoints(runId).filter((checkpoint) => checkpoint.kind === "stage" && checkpoint.sessionFile)
				.length,
			2,
		);
		assert.ok((backend.getWorkflow(runId)?.updatedAt ?? 0) > (firstUpdatedAt ?? 0));

		release.resolve("done");
		await vi.advanceTimersByTimeAsync(0);
		assert.equal((await execution).status, "completed");
		const checkpointCount = backend.listCheckpoints(runId).length;
		await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 2);
		assert.equal(backend.listCheckpoints(runId).length, checkpointCount);
		assert.equal(vi.getTimerCount(), 0);
	});

	test("refreshes the durable root from a nested scoped workflow stage", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(2_000_000);
		const store = createStore();
		const sdk = createMockSdk();
		const backend = new DbosDurableBackend(sdk, { executorId: "nested-heartbeat-owner" });
		const rootId = testRunId("nested-stage-heartbeat");
		const release = Promise.withResolvers<string>();
		const session: StageSessionRuntime = {
			...mockSession(),
			sessionFile: "/tmp/retained-nested.jsonl",
			async prompt() {
				return await release.promise;
			},
		};
		const child = workflow({
			name: "heartbeat-child",
			description: "",
			inputs: {},
			outputs: {},
			async run(ctx) {
				await ctx.stage("nested-long-turn").prompt("work");
				return {};
			},
		});
		const parent = workflow({
			name: "heartbeat-parent",
			description: "",
			inputs: {},
			outputs: {},
			async run(ctx) {
				await ctx.workflow(child);
				return {};
			},
		});

		const execution = run(
			parent,
			{},
			{
				runId: rootId,
				store,
				durableBackend: backend,
				adapters: { agentSession: { create: async () => session } },
			},
		);
		await vi.advanceTimersByTimeAsync(0);
		const initial = backend
			.listCheckpoints(rootId)
			.filter(
				(checkpoint): checkpoint is DurableStageCheckpoint =>
					checkpoint.kind === "stage" && checkpoint.sessionFile === session.sessionFile,
			);
		const metadataWritesBeforeHeartbeat = [...sdk.state.steps.keys()].filter((key) =>
			key.includes(":checkpoint:__atomic_metadata:"),
		).length;
		assert.equal(initial.length, 1);
		assert.notEqual(initial[0]?.topology?.run?.runId, rootId);
		assert.equal(initial[0]?.workflowId, rootId);
		const firstUpdatedAt = backend.getWorkflow(rootId)?.updatedAt;

		await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
		assert.ok(
			[...sdk.state.steps.keys()].filter((key) => key.includes(":checkpoint:__atomic_metadata:")).length >
				metadataWritesBeforeHeartbeat,
		);
		assert.equal(
			backend
				.listCheckpoints(rootId)
				.filter((checkpoint) => checkpoint.kind === "stage" && checkpoint.sessionFile === session.sessionFile)
				.length,
			2,
		);
		assert.ok((backend.getWorkflow(rootId)?.updatedAt ?? 0) > (firstUpdatedAt ?? 0));

		release.resolve("done");
		await vi.advanceTimersByTimeAsync(0);
		assert.equal((await execution).status, "completed");
		assert.equal(vi.getTimerCount(), 0);
	});

	test("refreshes root timing during a long session-less prompt adapter turn", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(2_500_000);
		const store = createStore();
		const backend = new InMemoryDurableBackend();
		const runId = testRunId("sessionless-stage-heartbeat");
		const release = Promise.withResolvers<string>();
		const definition = workflow({
			name: "sessionless-stage-heartbeat",
			description: "",
			inputs: {},
			outputs: {},
			async run(ctx) {
				await ctx.tool("seed-progress", {}, async () => true);
				await ctx.stage("adapter-turn").prompt("work");
				return {};
			},
		});
		const execution = run(
			definition,
			{},
			{
				runId,
				store,
				durableBackend: backend,
				adapters: { prompt: { prompt: async () => await release.promise } },
			},
		);
		await vi.advanceTimersByTimeAsync(0);
		assert.equal(priorRunElapsedMs(backend, runId), undefined);

		await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
		assert.equal(priorRunElapsedMs(backend, runId), HEARTBEAT_MS);

		release.resolve("done");
		await vi.advanceTimersByTimeAsync(0);
		assert.equal((await execution).status, "completed");
		assert.equal(vi.getTimerCount(), 0);
	});

	test("does not start a lazy model turn until its session identity is durable", async () => {
		const store = createStore();
		const runId = testRunId("lazy-stage-identity-order");
		const identityWriteStarted = Promise.withResolvers<void>();
		const releaseIdentityWrite = Promise.withResolvers<void>();
		let identityPersisted = false;
		let modelTurnStarted = false;
		class BlockingIdentityBackend extends InMemoryDurableBackend {
			override async recordCheckpointAsync(checkpoint: DurableCheckpoint): Promise<void> {
				if (checkpoint.kind === "stage" && checkpoint.sessionFile !== undefined && !identityPersisted) {
					identityWriteStarted.resolve();
					await releaseIdentityWrite.promise;
					identityPersisted = true;
				}
				await super.recordCheckpointAsync(checkpoint);
			}
		}
		const session: StageSessionRuntime = {
			...mockSession(),
			sessionFile: "/tmp/retained-lazy-identity.jsonl",
			async prompt() {
				modelTurnStarted = true;
			},
		};
		const definition = workflow({
			name: "lazy-stage-identity-order",
			description: "",
			inputs: {},
			outputs: {},
			async run(ctx) {
				await ctx.stage("lazy-model").complete("work");
				return {};
			},
		});

		const execution = run(
			definition,
			{},
			{
				runId,
				store,
				durableBackend: new BlockingIdentityBackend(),
				adapters: { agentSession: { create: async () => session } },
			},
		);
		await identityWriteStarted.promise;
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		const startedBeforePersistence = modelTurnStarted;
		releaseIdentityWrite.resolve();

		assert.equal((await execution).status, "completed");
		assert.equal(startedBeforePersistence, false);
		assert.equal(modelTurnStarted, true);
	});

	test("finalizes a stage and releases admission when its first identity write fails", async () => {
		vi.useFakeTimers();
		const store = createStore();
		const runId = testRunId("initial-identity-failure-cleanup");
		class FailingIdentityBackend extends InMemoryDurableBackend {
			public override readonly persistent = true;
			override async recordCheckpointAsync(checkpoint: DurableCheckpoint): Promise<void> {
				if (checkpoint.kind === "stage" && checkpoint.name === "first" && checkpoint.sessionFile !== undefined) {
					throw new Error("initial identity persistence failed");
				}
				await super.recordCheckpointAsync(checkpoint);
			}
		}
		let secondPromptCalled = false;
		const definition = workflow({
			name: "initial-identity-failure-cleanup",
			description: "",
			inputs: {},
			outputs: {},
			async run(ctx) {
				await assert.rejects(ctx.stage("first").prompt("first"), /initial identity persistence failed/);
				await Promise.race([
					ctx.stage("second").prompt("second"),
					new Promise<never>((_resolve, reject) =>
						setTimeout(() => reject(new Error("stage limiter was not released")), 100),
					),
				]);
				return {};
			},
		});
		const execution = run(
			definition,
			{},
			{
				runId,
				store,
				durableBackend: new FailingIdentityBackend(),
				config: SERIAL_CONFIG,
				adapters: {
					agentSession: {
						create: async (_options, meta) => ({
							...mockSession(),
							sessionFile: `/tmp/retained-${meta?.stageName}.jsonl`,
							async prompt() {
								if (meta?.stageName === "second") secondPromptCalled = true;
							},
						}),
					},
				},
			},
		);
		await vi.runAllTimersAsync();
		const result = await execution;

		assert.equal(result.status, "completed");
		assert.equal(secondPromptCalled, true);
		const first = store
			.runs()
			.find((candidate) => candidate.id === runId)
			?.stages.find((stage) => stage.name === "first");
		assert.equal(first?.status, "failed");
		assert.notEqual(first?.attachable, true);
		assert.equal(vi.getTimerCount(), 0);
	});

	test("cleans up stage admission when MCP scope setup throws", async () => {
		vi.useFakeTimers();
		const store = createStore();
		let secondPromptCalled = false;
		let scopeActive = false;
		let clearCalls = 0;
		const definition = workflow({
			name: "mcp-setup-failure-cleanup",
			description: "",
			inputs: {},
			outputs: {},
			async run(ctx) {
				await assert.rejects(
					ctx.stage("first", { mcp: { allow: ["broken"] } }).prompt("first"),
					/MCP scope setup failed/,
				);
				await Promise.race([
					ctx.stage("second").prompt("second"),
					new Promise<never>((_resolve, reject) =>
						setTimeout(() => reject(new Error("stage limiter was not released")), 100),
					),
				]);
				return {};
			},
		});
		const execution = run(
			definition,
			{},
			{
				store,
				durableBackend: new InMemoryDurableBackend(),
				config: SERIAL_CONFIG,
				mcp: {
					setScope() {
						scopeActive = true;
						throw new Error("MCP scope setup failed");
					},
					clearScope() {
						scopeActive = false;
						clearCalls += 1;
					},
				},
				adapters: {
					prompt: {
						async prompt() {
							secondPromptCalled = true;
							return "done";
						},
					},
				},
			},
		);
		await vi.runAllTimersAsync();
		const result = await execution;

		assert.equal(result.status, "completed");
		assert.equal(secondPromptCalled, true);
		assert.equal(result.stages.find((stage) => stage.name === "first")?.status, "failed");
		assert.equal(scopeActive, false);
		assert.equal(clearCalls, 1);
		assert.equal(vi.getTimerCount(), 0);
	});

	test("continues stage cleanup when MCP scope clearing throws", async () => {
		vi.useFakeTimers();
		const store = createStore();
		let secondPromptCalled = false;
		const definition = workflow({
			name: "mcp-clear-failure-cleanup",
			description: "",
			inputs: {},
			outputs: {},
			async run(ctx) {
				await assert.rejects(
					ctx.stage("first", { mcp: { allow: ["broken"] } }).prompt("first"),
					/MCP scope cleanup failed/,
				);
				await Promise.race([
					ctx.stage("second").prompt("second"),
					new Promise<never>((_resolve, reject) =>
						setTimeout(() => reject(new Error("stage limiter was not released")), 100),
					),
				]);
				return {};
			},
		});
		const execution = run(
			definition,
			{},
			{
				store,
				durableBackend: new InMemoryDurableBackend(),
				config: SERIAL_CONFIG,
				mcp: {
					setScope() {},
					clearScope() {
						throw new Error("MCP scope cleanup failed");
					},
				},
				adapters: {
					prompt: {
						async prompt(_text, meta) {
							if (meta?.stageName === "second") secondPromptCalled = true;
							return "done";
						},
					},
				},
			},
		);
		await vi.runAllTimersAsync();
		const result = await execution;

		assert.equal(result.status, "completed");
		assert.equal(secondPromptCalled, true);
		const first = result.stages.find((stage) => stage.name === "first");
		assert.notEqual(first?.status, "running");
		assert.notEqual(first?.attachable, true);
		assert.equal(vi.getTimerCount(), 0);
	});

	test("surfaces a DBOS sessionless heartbeat failure before the active turn can finish", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(2_750_000);
		const sdk = createMockSdk();
		const originalRecordStepOutput = sdk.recordStepOutput.bind(sdk);
		const failingSdk = {
			...sdk,
			async recordStepOutput(...args: Parameters<typeof sdk.recordStepOutput>) {
				const [workflowId, stepName, output] = args;
				if (stepName.startsWith("run-timing:")) throw new Error("sessionless timing persistence failed");
				await originalRecordStepOutput(workflowId, stepName, output);
			},
		};
		const store = createStore();
		const runId = testRunId("sessionless-heartbeat-failure");
		let failedBeforeFlush = false;
		class InspectingFlushBackend extends DbosDurableBackend {
			override async flush(): Promise<void> {
				failedBeforeFlush =
					store.runs().find((candidate) => candidate.id === runId)?.stages[0]?.status === "failed";
				await super.flush();
			}
		}
		const backend = new InspectingFlushBackend(failingSdk, { executorId: "sessionless-heartbeat-owner" });
		const never = Promise.withResolvers<string>();
		const promptStarted = Promise.withResolvers<void>();
		const definition = workflow({
			name: "sessionless-heartbeat-failure",
			description: "",
			inputs: {},
			outputs: {},
			async run(ctx) {
				await ctx.tool("seed-progress", {}, async () => true);
				await ctx.stage("adapter-turn").prompt("work");
				return {};
			},
		});
		const execution = run(
			definition,
			{},
			{
				runId,
				store,
				durableBackend: backend,
				adapters: {
					prompt: {
						prompt: async () => {
							promptStarted.resolve();
							return await never.promise;
						},
					},
				},
			},
		);
		await vi.advanceTimersByTimeAsync(0);
		const executionFailure = assert.rejects(execution, /sessionless timing persistence failed/);
		await promptStarted.promise;
		await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
		await executionFailure;

		const activeStage = store.runs().find((candidate) => candidate.id === runId)?.stages[0];
		assert.equal(activeStage?.status, "failed");
		assert.match(activeStage?.error ?? "", /sessionless timing persistence failed/);
		assert.equal(failedBeforeFlush, true);
		assert.equal(vi.getTimerCount(), 0);
	});

	test("surfaces a persistent heartbeat failure instead of leaving a long turn running", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(3_000_000);
		const store = createStore();
		const runId = testRunId("stage-heartbeat-failure");
		class FailingHeartbeatBackend extends InMemoryDurableBackend {
			public override readonly persistent = true;
			private sessionWrites = 0;
			override async recordCheckpointAsync(checkpoint: DurableCheckpoint): Promise<void> {
				if (checkpoint.kind === "stage" && checkpoint.sessionFile !== undefined && ++this.sessionWrites > 1) {
					throw new Error("durable heartbeat write failed");
				}
				await super.recordCheckpointAsync(checkpoint);
			}
		}
		const backend = new FailingHeartbeatBackend();
		const never = Promise.withResolvers<string>();
		const session: StageSessionRuntime = {
			...mockSession(),
			sessionFile: "/tmp/retained-failing.jsonl",
			async prompt() {
				return await never.promise;
			},
		};
		const definition = workflow({
			name: "stage-heartbeat-failure",
			description: "",
			inputs: {},
			outputs: {},
			async run(ctx) {
				await ctx.stage("long-turn").prompt("work");
				return {};
			},
		});
		const execution = run(
			definition,
			{},
			{
				runId,
				store,
				durableBackend: backend,
				adapters: { agentSession: { create: async () => session } },
			},
		);
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
		const result = await execution;

		assert.equal(result.status, "failed");
		assert.match(result.error ?? "", /durable heartbeat write failed/);
		assert.equal(vi.getTimerCount(), 0);
	});

	test("records a failed terminal stage when the final durable checkpoint rejects", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(4_000_000);
		const store = createStore();
		const runId = testRunId("final-checkpoint-failure");
		let turnResolved = false;
		let durableCapturesAfterTurn = 0;
		let secondPromptCalled = false;
		const definition = workflow({
			name: "final-checkpoint-failure",
			description: "",
			inputs: {},
			outputs: {},
			async run(ctx) {
				await assert.rejects(ctx.stage("first").prompt("first"), /final durable checkpoint failed/);
				await Promise.race([
					ctx.stage("second").prompt("second"),
					new Promise<never>((_resolve, reject) =>
						setTimeout(() => reject(new Error("stage limiter was not released")), 100),
					),
				]);
				return {};
			},
		});
		const execution = run(
			definition,
			{},
			{
				runId,
				store,
				durableBackend: new InMemoryDurableBackend(),
				config: SERIAL_CONFIG,
				onStageSession(_stageRunId, snapshot, options) {
					if (snapshot.name !== "first" || options?.awaitDurable !== true || !turnResolved) return;
					// The capture that follows the turn succeeds; the finalization one fails.
					durableCapturesAfterTurn += 1;
					if (durableCapturesAfterTurn > 1) throw new Error("final durable checkpoint failed");
				},
				adapters: {
					agentSession: {
						create: async (_options, meta) => ({
							...mockSession(),
							sessionFile: `/tmp/retained-${meta?.stageName}.jsonl`,
							async prompt() {
								if (meta?.stageName === "second") {
									secondPromptCalled = true;
									return;
								}
								turnResolved = true;
							},
						}),
					},
				},
			},
		);
		await vi.runAllTimersAsync();
		const result = await execution;

		assert.equal(result.status, "completed");
		assert.equal(secondPromptCalled, true);
		assert.equal(durableCapturesAfterTurn, 2);
		const first = store
			.runs()
			.find((candidate) => candidate.id === runId)
			?.stages.find((stage) => stage.name === "first");
		assert.notEqual(first?.status, "completed");
		assert.equal(first?.status, "failed");
		assert.match(first?.error ?? "", /final durable checkpoint failed/);
		assert.equal(vi.getTimerCount(), 0);
	});

	test("fails a stage when an in-flight heartbeat checkpoint rejects after the turn resolves", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(5_000_000);
		const store = createStore();
		const runId = testRunId("heartbeat-drain-failure");
		const checkpointStarted = Promise.withResolvers<void>();
		const releaseCheckpoint = Promise.withResolvers<void>();
		const turn = Promise.withResolvers<void>();
		let armHeartbeatFailure = false;
		let secondPromptCalled = false;
		const definition = workflow({
			name: "heartbeat-drain-failure",
			description: "",
			inputs: {},
			outputs: {},
			async run(ctx) {
				await assert.rejects(ctx.stage("long-turn").prompt("work"), /late heartbeat checkpoint failed/);
				await Promise.race([
					ctx.stage("second").prompt("second"),
					new Promise<never>((_resolve, reject) =>
						setTimeout(() => reject(new Error("stage limiter was not released")), 100),
					),
				]);
				return {};
			},
		});
		const execution = run(
			definition,
			{},
			{
				runId,
				store,
				durableBackend: new InMemoryDurableBackend(),
				config: SERIAL_CONFIG,
				async onStageSession(_stageRunId, snapshot, options) {
					if (snapshot.name !== "long-turn" || options?.awaitDurable !== true || !armHeartbeatFailure) return;
					armHeartbeatFailure = false;
					checkpointStarted.resolve();
					await releaseCheckpoint.promise;
					throw new Error("late heartbeat checkpoint failed");
				},
				adapters: {
					agentSession: {
						create: async (_options, meta) => ({
							...mockSession(),
							sessionFile: `/tmp/retained-${meta?.stageName}.jsonl`,
							async prompt() {
								if (meta?.stageName === "second") {
									secondPromptCalled = true;
									return;
								}
								await turn.promise;
							},
						}),
					},
				},
			},
		);
		await vi.advanceTimersByTimeAsync(0);
		// Arm the next heartbeat tick, then park that checkpoint in flight.
		armHeartbeatFailure = true;
		await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
		await checkpointStarted.promise;
		// The model turn wins the race while the checkpoint is still in flight.
		turn.resolve();
		await vi.advanceTimersByTimeAsync(0);
		releaseCheckpoint.resolve();
		await vi.runAllTimersAsync();
		const result = await execution;

		assert.equal(result.status, "completed");
		assert.equal(secondPromptCalled, true);
		const longTurn = store
			.runs()
			.find((candidate) => candidate.id === runId)
			?.stages.find((stage) => stage.name === "long-turn");
		assert.notEqual(longTurn?.status, "completed");
		assert.equal(longTurn?.status, "failed");
		assert.match(longTurn?.error ?? "", /late heartbeat checkpoint failed/);
		assert.equal(vi.getTimerCount(), 0);
	});
});
