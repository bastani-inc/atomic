import assert from "node:assert/strict";
import { Type } from "typebox";
import { describe, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { completedWorkflowRunSnapshots } from "../../packages/workflows/src/durable/completed-catalog.js";
import { createToolPrimitive } from "../../packages/workflows/src/durable/tool-primitive.js";
import type { DurableCheckpoint } from "../../packages/workflows/src/durable/types.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import {
	createWorkflowLifecycleNotificationState,
	installWorkflowLifecycleNotifications,
	type WorkflowLifecycleNoticeDetails,
} from "../../packages/workflows/src/extension/lifecycle-notifications.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { WorkflowToolFailure } from "../../packages/workflows/src/shared/types.js";

describe("ctx.tool recoverable failures", () => {
	test("returns a typed failure after retries while the workflow continues", async () => {
		let attempts = 0;
		let observed: object | undefined;
		const definition = workflow({
			name: "recoverable-tool-failure",
			description: "",
			inputs: {},
			outputs: { repaired: Type.Boolean() },
			run: async (ctx) => {
				const outcome = await ctx.tool(
					"check",
					{},
					async () => {
						attempts += 1;
						const error = new Error("tests failed") as Error & {
							exitCode: number;
							stdout: string;
							stderr: string;
						};
						error.exitCode = 7;
						error.stdout = "partial output";
						error.stderr = "assertion failed";
						throw error;
					},
					{
						failureMode: "return",
						retriesAllowed: true,
						maxAttempts: 2,
						intervalMs: 0,
					},
				);
				observed = outcome;
				return { repaired: !outcome.ok };
			},
		});

		const result = await run(
			definition,
			{},
			{
				store: createStore(),
				durableBackend: new InMemoryDurableBackend(),
			},
		);

		assert.equal(result.status, "completed");
		assert.equal(attempts, 2);
		assert.deepEqual(observed, {
			ok: false,
			error: {
				name: "Error",
				message: "tests failed",
				exitCode: 7,
				stdout: "partial output",
				stderr: "assertion failed",
			},
			attempts: 2,
			cached: false,
		});
		assert.equal(result.toolNodes?.[0]?.status, "failed");
		assert.equal(result.failedToolNodeId, undefined);
	});

	test("replays the durable failed outcome without rerunning the callback", async () => {
		const backend = new InMemoryDurableBackend();
		const runId = "recoverable-tool-replay";
		const outcomes: object[] = [];
		let callbackCalls = 0;
		const definition = workflow({
			name: "recoverable-tool-replay",
			description: "",
			inputs: {},
			outputs: { done: Type.Boolean() },
			run: async (ctx) => {
				const outcome = await ctx.tool(
					"check",
					{ suite: "unit" },
					async () => {
						callbackCalls += 1;
						throw Object.assign(new Error("still red"), { exitCode: 1, stderr: "failed test" });
					},
					{ failureMode: "return" },
				);
				outcomes.push(outcome);
				return { done: true };
			},
		});

		const first = await run(definition, {}, { runId, store: createStore(), durableBackend: backend });
		const replay = await run(definition, {}, { runId, store: createStore(), durableBackend: backend });

		assert.equal(first.status, "completed");
		assert.equal(replay.status, "completed");
		assert.equal(callbackCalls, 1);
		assert.deepEqual(
			outcomes.map((outcome) => ({ ...outcome })),
			[
				{
					ok: false,
					error: { name: "Error", message: "still red", exitCode: 1, stderr: "failed test" },
					attempts: 1,
					cached: false,
				},
				{
					ok: false,
					error: { name: "Error", message: "still red", exitCode: 1, stderr: "failed test" },
					attempts: 1,
					cached: true,
				},
			],
		);
		assert.equal(replay.toolNodes?.[0]?.status, "failed");
		assert.equal(replay.toolNodes?.[0]?.replayed, true);
	});

	test("keeps a recoverable failure node failed in completed durable inspection", async () => {
		const backend = new InMemoryDurableBackend();
		const runId = "recoverable-tool-completed-inspection";
		const definition = workflow({
			name: "recoverable-tool-completed-inspection",
			description: "",
			inputs: {},
			outputs: { done: Type.Boolean() },
			run: async (ctx) => {
				await ctx.tool(
					"red-check",
					{},
					async () => {
						throw new Error("inspection evidence");
					},
					{ failureMode: "return" },
				);
				return { done: true };
			},
		});

		await run(definition, {}, { runId, store: createStore(), durableBackend: backend });
		const entry = backend.listCompletedWorkflows().find((candidate) => candidate.workflowId === runId)!;
		const restored = completedWorkflowRunSnapshots(backend, entry).find((candidate) => candidate.id === runId)!;

		assert.equal(restored.status, "completed");
		assert.equal(restored.toolNodes?.[0]?.status, "failed");
		assert.equal(restored.toolNodes?.[0]?.error, "inspection evidence");
	});

	test("keeps cancellation throwing in return mode", async () => {
		const backend = new InMemoryDurableBackend();
		const controller = new AbortController();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const definition = workflow({
			name: "recoverable-tool-cancel",
			description: "",
			inputs: {},
			outputs: { done: Type.Boolean() },
			run: async (ctx) => {
				await ctx.tool(
					"cancelled-check",
					{},
					async () => {
						entered.resolve();
						await release.promise;
						throw Object.assign(new Error("ordinary failure must not win"), {
							code: "CANCELLED",
							exitCode: 1,
							stderr: "late command failure",
						});
					},
					{ failureMode: "return" },
				);
				return { done: true };
			},
		});

		const pending = run(
			definition,
			{},
			{
				store: createStore(),
				durableBackend: backend,
				signal: controller.signal,
			},
		);
		await entered.promise;
		controller.abort(new Error("stop workflow"));
		release.resolve();
		const result = await pending;

		assert.equal(result.status, "killed");
		assert.equal(result.toolNodes?.[0]?.status, "cancelled");
		// Return-mode cancellation keeps one inspection-only record and nothing
		// replayable, so a resume re-runs the call instead of replaying the
		// cancellation as data.
		const toolRecords = backend
			.listCheckpoints(result.runId)
			.filter((entry) => entry.kind === "tool" && entry.name === "cancelled-check");
		assert.equal(toolRecords.length, 1);
		assert.match(toolRecords[0]!.checkpointId, /^tool-failure:/);
		assert.equal(toolRecords[0]!.kind === "tool" ? toolRecords[0]!.outcomeKind : "unexpected", undefined);
		assert.equal(backend.getToolCheckpoint(result.runId, result.toolNodes![0]!.argsHash), undefined);
	});

	test("fails and notifies for a nested callback-origin AbortError without a run abort", async () => {
		const backend = new InMemoryDurableBackend();
		const store = createStore();
		const notices: WorkflowLifecycleNoticeDetails[] = [];
		const unsubscribe = installWorkflowLifecycleNotifications({
			store,
			config: { enabled: true, notifyOn: ["failed"] },
			state: createWorkflowLifecycleNotificationState(),
			seedExisting: false,
			sendMessage(message) {
				notices.push((message as { details: WorkflowLifecycleNoticeDetails }).details);
			},
		});
		let downstreamRan = false;
		let callbackCalls = 0;
		const definition = workflow({
			name: "recoverable-tool-callback-abort",
			description: "",
			inputs: {},
			outputs: { done: Type.Boolean() },
			run: async (ctx) => {
				await ctx.tool(
					"callback-abort",
					{},
					async () => {
						callbackCalls += 1;
						throw { message: "callback wrapper", error: new DOMException("operator aborted", "AbortError") };
					},
					{ failureMode: "return", retriesAllowed: true, maxAttempts: 3, intervalMs: 0 },
				);
				downstreamRan = true;
				return { done: true };
			},
		});

		const result = await run(definition, {}, { store, durableBackend: backend });
		unsubscribe();

		const snapshot = store.runs()[0];
		assert.equal(result.status, "failed");
		assert.equal(snapshot?.failureKind, "unknown");
		assert.equal(snapshot?.failureCode, "unknown");
		assert.equal(snapshot?.failureDisposition, "terminal_failed");
		assert.equal(downstreamRan, false);
		assert.equal(callbackCalls, 1);
		assert.equal(result.toolNodes?.[0]?.status, "failed");
		assert.equal(notices.length, 1);
		assert.equal(notices[0]?.kind, "failed");
		assert.match(notices[0]?.error ?? "", /operator aborted/);
		assert.equal(
			backend
				.listCheckpoints(result.runId)
				.some(
					(entry) =>
						entry.kind === "tool" && entry.name === "callback-abort" && entry.throwingFailureError !== undefined,
				),
			true,
		);
		assert.equal(backend.getToolCheckpoint(result.runId, result.toolNodes![0]!.argsHash), undefined);
	});

	test("retries process errors whose message contains cancellation words", async () => {
		const backend = new InMemoryDurableBackend();
		let callbackCalls = 0;
		let observed: WorkflowToolFailure | undefined;
		const definition = workflow({
			name: "recoverable-tool-cancelled-command-text",
			description: "",
			inputs: {},
			outputs: { done: Type.Boolean() },
			run: async (ctx) => {
				const outcome = await ctx.tool(
					"cancelled-command-text",
					{},
					async () => {
						callbackCalls += 1;
						throw Object.assign(new Error("Command failed: 2 tests cancelled after worker crash"), {
							name: "AbortError",
							stopReason: "aborted",
							code: "CANCELLED",
							exitCode: 1,
							stderr: "worker crashed",
						});
					},
					{ failureMode: "return", retriesAllowed: true, maxAttempts: 3, intervalMs: 0 },
				);
				if (!outcome.ok) observed = outcome;
				return { done: true };
			},
		});

		const result = await run(
			definition,
			{},
			{
				store: createStore(),
				durableBackend: backend,
			},
		);

		assert.equal(result.status, "completed");
		assert.equal(callbackCalls, 3);
		assert.deepEqual(observed, {
			ok: false,
			error: {
				name: "AbortError",
				message: "Command failed: 2 tests cancelled after worker crash",
				exitCode: 1,
				stderr: "worker crashed",
			},
			attempts: 3,
			cached: false,
		});
		assert.equal(result.toolNodes?.[0]?.status, "failed");
		assert.equal(
			backend
				.listCheckpoints(result.runId)
				.some((entry) => entry.kind === "tool" && entry.name === "cancelled-command-text"),
			true,
		);
	});

	for (const maxAttempts of [0, -1, 1.5]) {
		test(`rejects invalid maxAttempts ${maxAttempts} without invoking or checkpointing`, async () => {
			const backend = new InMemoryDurableBackend();
			let callbackCalls = 0;
			let downstreamRan = false;
			const definition = workflow({
				name: `recoverable-tool-invalid-attempts-${maxAttempts}`,
				description: "",
				inputs: {},
				outputs: {},
				run: async (ctx) => {
					await ctx.tool(
						"invalid-attempts",
						{},
						async () => {
							callbackCalls += 1;
							throw new Error("callback must not run");
						},
						{ failureMode: "return", retriesAllowed: true, maxAttempts, intervalMs: 0 },
					);
					downstreamRan = true;
					return {};
				},
			});

			const result = await run(
				definition,
				{},
				{
					store: createStore(),
					durableBackend: backend,
				},
			);

			assert.equal(result.status, "failed");
			assert.match(result.error ?? "", /maxAttempts.*positive integer/);
			assert.equal(callbackCalls, 0);
			assert.equal(downstreamRan, false);
			assert.equal(
				backend.listCheckpoints(result.runId).some((entry) => entry.kind === "tool"),
				false,
			);
		});
	}

	test("supports explicit repair evidence and a bounded rerun", async () => {
		const store = createStore();
		const repairPrompts: string[] = [];
		let checks = 0;
		const definition = workflow({
			name: "recoverable-tool-repair-loop",
			description: "",
			inputs: {},
			outputs: { passed: Type.Boolean() },
			run: async (ctx) => {
				for (let iteration = 1; iteration <= 2; iteration += 1) {
					const outcome = await ctx.tool(
						"run-check",
						{ iteration },
						async () => {
							checks += 1;
							if (iteration === 1) {
								throw Object.assign(new Error("check failed"), { stderr: "one failed assertion" });
							}
							return "green";
						},
						{ failureMode: "return" },
					);
					if (outcome.ok) return { passed: outcome.value === "green" };
					await ctx.task("repair", { prompt: `Repair from explicit evidence: ${outcome.error.stderr}` });
				}
				return { passed: false };
			},
		});

		const result = await run(
			definition,
			{},
			{
				store,
				durableBackend: new InMemoryDurableBackend(),
				adapters: {
					prompt: {
						prompt: async (text) => {
							repairPrompts.push(text);
							return "repaired";
						},
					},
				},
			},
		);

		assert.equal(result.status, "completed");
		assert.deepEqual(result.result, { passed: true });
		assert.equal(checks, 2);
		assert.deepEqual(repairPrompts, ["Repair from explicit evidence: one failed assertion"]);
		assert.deepEqual(
			result.toolNodes?.map((node) => node.status),
			["failed", "completed"],
		);
		assert.deepEqual(result.stages[0]?.parentIds, [result.toolNodes?.[0]?.id]);
		assert.deepEqual(result.toolNodes?.[1]?.parentIds, [result.stages[0]?.id]);
	});

	test("redacts and UTF-8 byte-bounds persisted process output", async () => {
		let capturedStderr = "";
		let capturedMessage = "";
		let capturedStdout = "";
		const backend = new InMemoryDurableBackend();
		const definition = workflow({
			name: "recoverable-tool-safe-output",
			description: "",
			inputs: {},
			outputs: { done: Type.Boolean() },
			run: async (ctx) => {
				const outcome = await ctx.tool(
					"safe-check",
					{},
					async () => {
						const error = Object.assign(new Error("token=message-secret-value"), {
							stdout: new TextEncoder().encode("Authorization: Bearer stdout-secret-value"),
							stderr: `${"終".repeat(10_000)} api_key=stderr-secret-value`,
						});
						throw error;
					},
					{ failureMode: "return" },
				);
				assert.equal(outcome.ok, false);
				if (!outcome.ok) {
					capturedMessage = outcome.error.message;
					capturedStdout = outcome.error.stdout ?? "";
					capturedStderr = outcome.error.stderr ?? "";
				}
				return { done: true };
			},
		});

		const result = await run(
			definition,
			{},
			{
				store: createStore(),
				durableBackend: backend,
			},
		);

		assert.equal(result.status, "completed");
		assert.equal(new TextEncoder().encode(capturedStderr).byteLength <= 16_384, true);
		assert.match(capturedStderr, /^\[workflow tool output truncated/);
		assert.match(`${capturedMessage}\n${capturedStdout}\n${capturedStderr}`, /\[redacted\]/);
		assert.doesNotMatch(`${capturedMessage}\n${capturedStdout}\n${capturedStderr}`, /secret-value/);
		const checkpoint = backend
			.listCheckpoints(result.runId)
			.find((entry) => entry.kind === "tool" && entry.name === "safe-check");
		assert.equal(checkpoint?.kind, "tool");
		const persisted = checkpoint?.kind === "tool" ? (checkpoint.output as WorkflowToolFailure) : undefined;
		assert.equal(persisted?.ok, false);
		assert.equal(persisted?.error.stderr, capturedStderr);
		assert.doesNotMatch(JSON.stringify(persisted), /secret-value/);
	});

	test("preserves fields from a non-Error callback rejection after retries", async () => {
		let captured: WorkflowToolFailure | undefined;
		const definition = workflow({
			name: "recoverable-tool-structured-rejection",
			description: "",
			inputs: {},
			outputs: { done: Type.Boolean() },
			run: async (ctx) => {
				const outcome = await ctx.tool(
					"structured-check",
					{},
					async () => {
						throw {
							name: "CommandFailure",
							message: "command rejected",
							exitCode: 9,
							stdout: "build output",
							stderr: "build error",
						};
					},
					{ failureMode: "return", retriesAllowed: true, maxAttempts: 2, intervalMs: 0 },
				);
				if (!outcome.ok) captured = outcome;
				return { done: true };
			},
		});

		await run(
			definition,
			{},
			{
				store: createStore(),
				durableBackend: new InMemoryDurableBackend(),
			},
		);

		assert.deepEqual(captured?.error, {
			name: "CommandFailure",
			message: "command rejected",
			exitCode: 9,
			stdout: "build output",
			stderr: "build error",
		});
		assert.equal(captured?.attempts, 2);
	});

	test("keeps durable storage failures throwing in return mode", async () => {
		class RejectingBackend extends InMemoryDurableBackend {
			override async recordCheckpointAsync(_checkpoint: DurableCheckpoint): Promise<void> {
				throw new Error("checkpoint storage unavailable");
			}
		}
		const backend = new RejectingBackend();
		backend.registerWorkflow({
			workflowId: "recoverable-storage-failure",
			name: "recoverable-storage-failure",
			inputs: {},
			createdAt: 1,
			status: "running",
		});
		const tool = createToolPrimitive({
			workflowId: "recoverable-storage-failure",
			backend,
			nextCheckpointId: () => "unused",
			throwIfCancelled: () => {},
		});

		await assert.rejects(
			() =>
				tool(
					"check",
					{},
					async () => {
						throw new Error("expected check failure");
					},
					{ failureMode: "return" },
				),
			/checkpoint storage unavailable/,
		);
	});
});
