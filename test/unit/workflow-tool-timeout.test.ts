import assert from "node:assert/strict";
import { Type } from "typebox";
import { describe, test, vi } from "vitest";
import { setCallbackActivityReporter } from "../../packages/coding-agent/src/core/callback-activity.ts";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { createToolPrimitive } from "../../packages/workflows/src/durable/tool-primitive.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { WorkflowToolFailure } from "../../packages/workflows/src/shared/types.js";

const TIMEOUT_MS = 20;

function runOptions(backend: InMemoryDurableBackend, signal?: AbortSignal) {
	return {
		store: createStore(),
		durableBackend: backend,
		...(signal === undefined ? {} : { signal }),
	};
}

describe("ctx.tool timeoutMs", () => {
	test("releases a signal-ignoring callback, aborts its signal, and preserves repair evidence", async () => {
		const backend = new InMemoryDurableBackend();
		const entered = Promise.withResolvers<void>();
		const repairPrompts: string[] = [];
		let callbackSignal: AbortSignal | undefined;
		let observed: WorkflowToolFailure | undefined;
		const definition = workflow({
			name: "tool-timeout-return",
			description: "",
			inputs: {},
			outputs: { repaired: Type.Boolean() },
			run: async (ctx) => {
				const outcome = await ctx.tool(
					"hang",
					{},
					async ({ signal }) => {
						callbackSignal = signal;
						entered.resolve();
						await new Promise<never>(() => {});
						return "unreachable";
					},
					{ failureMode: "return", timeoutMs: TIMEOUT_MS },
				);
				assert.equal(outcome.ok, false);
				if (outcome.ok) return { repaired: false };
				observed = outcome;
				await ctx.task("repair", { prompt: `Repair from timeout evidence: ${outcome.error.message}` });
				return { repaired: true };
			},
		});

		const pending = run(
			definition,
			{},
			{
				...runOptions(backend),
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
		await entered.promise;
		const result = await pending;

		assert.equal(result.status, "completed");
		assert.equal(callbackSignal?.aborted, true);
		assert.deepEqual(observed, {
			ok: false,
			error: {
				name: "TimeoutError",
				message: `atomic-workflows: ctx.tool hang timed out after ${TIMEOUT_MS}ms`,
			},
			attempts: 1,
			cached: false,
		});
		assert.match(repairPrompts[0] ?? "", new RegExp(`timed out after ${TIMEOUT_MS}ms`));
		const node = result.toolNodes?.[0];
		assert.equal(node?.status, "failed");
		assert.match(node?.error ?? "", new RegExp(`timed out after ${TIMEOUT_MS}ms`));
		const checkpoint = backend
			.listCheckpoints(result.runId)
			.find((entry) => entry.kind === "tool" && entry.name === "hang");
		assert.equal(checkpoint?.kind, "tool");
		if (checkpoint?.kind === "tool") {
			const persisted = checkpoint.output as WorkflowToolFailure;
			assert.equal(persisted.ok, false);
			assert.match(persisted.error.message, new RegExp(`timed out after ${TIMEOUT_MS}ms`));
		}
	});

	test.sequential("finishes callback activity when a signal-ignoring timed attempt settles", async () => {
		const activeCallbackIds = new Set<string>();
		setCallbackActivityReporter({
			started: (activity) => {
				if (activity.kind === "workflow.ctx_tool") activeCallbackIds.add(activity.id);
			},
			finished: (activityId) => activeCallbackIds.delete(activityId),
		});
		try {
			const backend = new InMemoryDurableBackend();
			const tool = createToolPrimitive({
				workflowId: "timeout-callback-activity",
				backend,
				nextCheckpointId: () => "unused",
				throwIfCancelled: () => {},
			});
			const outcome = await tool(
				"activity-hang",
				{},
				async () => {
					await new Promise<never>(() => {});
					return "unreachable";
				},
				{ failureMode: "return", timeoutMs: 10 },
			);

			assert.equal(outcome.ok, false);
			assert.equal(activeCallbackIds.size, 0);
		} finally {
			setCallbackActivityReporter(undefined);
		}
	});

	test("retries a timeout with a fresh signal and deadline for every attempt", async () => {
		const backend = new InMemoryDurableBackend();
		const signals: AbortSignal[] = [];
		let observed: WorkflowToolFailure | undefined;
		const definition = workflow({
			name: "tool-timeout-retries",
			description: "",
			inputs: {},
			outputs: { done: Type.Boolean() },
			run: async (ctx) => {
				const outcome = await ctx.tool(
					"retry-hang",
					{},
					async ({ signal }) => {
						signals.push(signal);
						await new Promise<never>(() => {});
						return "unreachable";
					},
					{
						failureMode: "return",
						timeoutMs: TIMEOUT_MS,
						retriesAllowed: true,
						maxAttempts: 2,
						intervalMs: 0,
					},
				);
				assert.equal(outcome.ok, false);
				if (!outcome.ok) observed = outcome;
				return { done: true };
			},
		});

		const result = await run(definition, {}, runOptions(backend));

		assert.equal(result.status, "completed");
		assert.equal(signals.length, 2);
		assert.notEqual(signals[0], signals[1]);
		assert.equal(signals[0]?.aborted, true);
		assert.equal(signals[1]?.aborted, true);
		assert.equal(observed?.attempts, 2);
		assert.equal(observed?.ok, false);
		assert.match(observed?.error.message ?? "", new RegExp(`timed out after ${TIMEOUT_MS}ms`));
	});

	test("default throw mode throws and records the timeout-specific failure", async () => {
		const backend = new InMemoryDurableBackend();
		const definition = workflow({
			name: "tool-timeout-throw",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.tool(
					"throwing-hang",
					{},
					async () => {
						await new Promise<never>(() => {});
						return "unreachable";
					},
					{ timeoutMs: TIMEOUT_MS },
				);
				return {};
			},
		});

		const result = await run(definition, {}, runOptions(backend));

		assert.equal(result.status, "failed");
		assert.match(result.error ?? "", new RegExp(`timed out after ${TIMEOUT_MS}ms`));
		assert.equal(result.toolNodes?.[0]?.status, "failed");
		const throwingFailure = backend
			.listCheckpoints(result.runId)
			.find((entry) => entry.kind === "tool" && entry.name === "throwing-hang" && entry.throwingFailureError);
		assert.equal(throwingFailure?.kind, "tool");
		assert.match(throwingFailure?.throwingFailureError ?? "", new RegExp(`timed out after ${TIMEOUT_MS}ms`));
	});

	test("does not alter a callback that finishes inside the bound", async () => {
		const backend = new InMemoryDurableBackend();
		let callbackSignal: AbortSignal | undefined;
		const definition = workflow({
			name: "tool-timeout-success",
			description: "",
			inputs: {},
			outputs: { value: Type.String() },
			run: async (ctx) => {
				const outcome = await ctx.tool(
					"quick",
					{},
					async ({ signal }) => {
						callbackSignal = signal;
						return "done";
					},
					{ failureMode: "return", timeoutMs: 100 },
				);
				assert.equal(outcome.ok, true);
				return { value: outcome.ok ? outcome.value : "failed" };
			},
		});

		const result = await run(definition, {}, runOptions(backend));

		assert.equal(result.status, "completed");
		assert.deepEqual(result.result, { value: "done" });
		assert.equal(callbackSignal?.aborted, false);
		assert.equal(result.toolNodes?.[0]?.status, "completed");
	});

	test("large positive finite deadlines do not overflow the host timer", async () => {
		const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
		try {
			const backend = new InMemoryDurableBackend();
			const tool = createToolPrimitive({
				workflowId: "timeout-large-finite",
				backend,
				nextCheckpointId: () => "unused",
				throwIfCancelled: () => {},
			});

			assert.equal(
				await tool(
					"quick-with-large-deadline",
					{},
					async () => {
						await new Promise<void>((resolve) => setTimeout(resolve, 25));
						return "done";
					},
					{ timeoutMs: 2_147_483_648 },
				),
				"done",
			);
			assert.equal(warning.mock.calls.length, 0);
		} finally {
			warning.mockRestore();
		}
	});

	test("operator cancellation remains cancellation rather than timeout", async () => {
		const backend = new InMemoryDurableBackend();
		const controller = new AbortController();
		const entered = Promise.withResolvers<void>();
		const definition = workflow({
			name: "tool-timeout-cancel",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.tool(
					"cancelled",
					{},
					async ({ signal }) => {
						entered.resolve();
						await new Promise<void>((resolve) => {
							signal.addEventListener("abort", () => resolve(), { once: true });
						});
						throw signal.reason instanceof Error ? signal.reason : new Error("operator cancelled");
					},
					{ timeoutMs: 1000 },
				);
				return {};
			},
		});

		const pending = run(definition, {}, runOptions(backend, controller.signal));
		await entered.promise;
		controller.abort(new Error("operator cancelled"));
		const result = await pending;

		assert.equal(result.status, "killed");
		assert.equal(result.toolNodes?.[0]?.status, "cancelled");
		assert.doesNotMatch(result.error ?? "", /timed out after/);
	});

	test("later cancellation after a timed-out attempt wins during retry backoff", async () => {
		const backend = new InMemoryDurableBackend();
		const controller = new AbortController();
		const firstTimeout = Promise.withResolvers<void>();
		let attempts = 0;
		const definition = workflow({
			name: "tool-timeout-then-cancel",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.tool(
					"timeout-then-cancel",
					{},
					async ({ signal }) => {
						attempts += 1;
						signal.addEventListener("abort", () => firstTimeout.resolve(), { once: true });
						await new Promise<never>(() => {});
						return "unreachable";
					},
					{
						failureMode: "return",
						timeoutMs: 10,
						retriesAllowed: true,
						maxAttempts: 3,
						intervalMs: 10_000,
					},
				);
				return {};
			},
		});

		const pending = run(definition, {}, runOptions(backend, controller.signal));
		await firstTimeout.promise;
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		controller.abort(new Error("operator cancelled after timeout during backoff"));
		const result = await pending;

		assert.equal(result.status, "killed");
		assert.equal(attempts, 1);
		const node = result.toolNodes?.[0];
		assert.equal(node?.status, "cancelled");
		assert.doesNotMatch(node?.error ?? "", /timed out after/);
		const toolRecords = backend
			.listCheckpoints(result.runId)
			.filter((checkpoint) => checkpoint.kind === "tool" && checkpoint.name === "timeout-then-cancel");
		assert.equal(toolRecords.length, 1);
		assert.match(toolRecords[0]?.checkpointId ?? "", /^tool-failure:/);
		assert.equal(toolRecords[0]?.kind === "tool" ? toolRecords[0].outcomeKind : "unexpected", undefined);
		assert.equal(node === undefined ? undefined : backend.getToolCheckpoint(result.runId, node.argsHash), undefined);
	});

	test("preserves timeout evidence when timeout abort handlers then cancel the run", async () => {
		const backend = new InMemoryDurableBackend();
		backend.registerWorkflow({
			workflowId: "timeout-wins-cancellation-race",
			name: "timeout-wins-cancellation-race",
			inputs: {},
			createdAt: 0,
			status: "running",
		});
		const controller = new AbortController();
		let nodeStatus: string | undefined;
		const tool = createToolPrimitive({
			workflowId: "timeout-wins-cancellation-race",
			backend,
			nextCheckpointId: () => "unused",
			throwIfCancelled: () => {},
			signal: controller.signal,
			onNodeEnd: (_nodeId, update) => {
				nodeStatus = update.status;
			},
		});

		const outcome = await tool(
			"timeout-winner",
			{},
			async ({ signal }) => {
				signal.addEventListener("abort", () => controller.abort(new Error("run cancelled after timeout fired")), {
					once: true,
				});
				await new Promise<never>(() => {});
				return "unreachable";
			},
			{ failureMode: "return", timeoutMs: 10 },
		);

		assert.equal(controller.signal.aborted, true);
		assert.equal(outcome.ok, false);
		if (outcome.ok) return;
		assert.deepEqual(outcome.error, {
			name: "TimeoutError",
			message: "atomic-workflows: ctx.tool timeout-winner timed out after 10ms",
		});
		assert.equal(nodeStatus, "failed");
		const checkpoint = backend
			.listCheckpoints("timeout-wins-cancellation-race")
			.find((entry) => entry.kind === "tool" && entry.name === "timeout-winner");
		assert.equal(checkpoint?.kind, "tool");
		if (checkpoint?.kind === "tool") {
			assert.deepEqual((checkpoint.output as WorkflowToolFailure).error, outcome.error);
		}
	});

	test("rejects invalid timeout values before invoking or checkpointing", async () => {
		for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
			const backend = new InMemoryDurableBackend();
			let callbackCalls = 0;
			const tool = createToolPrimitive({
				workflowId: `invalid-timeout-${String(timeoutMs)}`,
				backend,
				nextCheckpointId: () => "unused",
				throwIfCancelled: () => {},
			});

			await assert.rejects(
				() =>
					tool(
						"invalid-timeout",
						{},
						async () => {
							callbackCalls += 1;
							return "unexpected";
						},
						{ timeoutMs },
					),
				/timeoutMs must be a positive finite number/,
			);
			assert.equal(callbackCalls, 0);
			assert.equal(backend.listCheckpoints(`invalid-timeout-${String(timeoutMs)}`).length, 0);
		}
	});

	test("clears the deadline timer after a successful callback", async () => {
		vi.useFakeTimers();
		try {
			const backend = new InMemoryDurableBackend();
			const tool = createToolPrimitive({
				workflowId: "timeout-cleanup",
				backend,
				nextCheckpointId: () => "unused",
				throwIfCancelled: () => {},
			});
			const pending = tool("quick", {}, async () => "done", { timeoutMs: 1000 });
			await vi.advanceTimersByTimeAsync(0);
			assert.equal(await pending, "done");
			assert.equal(vi.getTimerCount(), 0);
		} finally {
			vi.useRealTimers();
		}
	});

	test("replays cached calls without starting a new deadline timer", async () => {
		vi.useFakeTimers();
		try {
			const backend = new InMemoryDurableBackend();
			backend.registerWorkflow({
				workflowId: "timeout-cached",
				name: "timeout-cached",
				inputs: {},
				createdAt: 0,
				status: "running",
			});
			const tool = createToolPrimitive({
				workflowId: "timeout-cached",
				backend,
				nextCheckpointId: () => "unused",
				throwIfCancelled: () => {},
			});
			let callbackCalls = 0;
			const first = tool(
				"cached",
				{},
				async () => {
					callbackCalls += 1;
					return "done";
				},
				{ timeoutMs: 1000 },
			);
			await vi.advanceTimersByTimeAsync(0);
			assert.equal(await first, "done");
			assert.equal(vi.getTimerCount(), 0);
			const resumedTool = createToolPrimitive({
				workflowId: "timeout-cached",
				backend,
				nextCheckpointId: () => "unused",
				throwIfCancelled: () => {},
			});
			assert.equal(
				await resumedTool(
					"cached",
					{},
					async () => {
						callbackCalls += 1;
						return "unexpected";
					},
					{ timeoutMs: 1000 },
				),
				"done",
			);
			assert.equal(callbackCalls, 1);
			assert.equal(vi.getTimerCount(), 0);
		} finally {
			vi.useRealTimers();
		}
	});
	test("omitting timeoutMs keeps the existing unbounded callback path", async () => {
		const backend = new InMemoryDurableBackend();
		let callbackSignal: AbortSignal | undefined;
		const tool = createToolPrimitive({
			workflowId: "timeout-omitted",
			backend,
			nextCheckpointId: () => "unused",
			throwIfCancelled: () => {},
		});

		assert.equal(
			await tool("untimed", {}, async ({ signal }) => {
				callbackSignal = signal;
				return "done";
			}),
			"done",
		);
		assert.equal(callbackSignal?.aborted, false);
	});
});
