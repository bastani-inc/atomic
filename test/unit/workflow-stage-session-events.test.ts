import assert from "node:assert/strict";
import type { AgentSessionEvent } from "@bastani/atomic";
import { describe, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import type { AgentSessionAdapter } from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { makeMockSession } from "./stage-runner-helpers.js";

interface ObservedEvent {
	readonly runId: string;
	readonly stageId: string;
	readonly type: string;
	readonly toolCallId?: string;
}

function observe(target: ObservedEvent[]) {
	return (runId: string, stageId: string, event: AgentSessionEvent): void => {
		target.push({
			runId,
			stageId,
			type: event.type,
			...("toolCallId" in event ? { toolCallId: event.toolCallId } : {}),
		});
	};
}

function modelName(model: unknown): string {
	if (model === undefined) return "default";
	if (typeof model === "string") return model;
	const ref = model as { provider?: string; id?: string };
	return `${String(ref.provider)}/${String(ref.id)}`;
}

/** Each session emits one tool start tagged with its model, then answers or fails. */
function emittingAdapter(failingModel?: string): AgentSessionAdapter {
	return {
		async create(options) {
			const model = modelName(options.model);
			const mock = makeMockSession({
				async prompt() {
					mock.emit({ type: "tool_execution_start", toolCallId: model, toolName: "read", args: {} });
					if (model === failingModel) throw new Error("429 rate limit exceeded");
				},
				getLastAssistantText: () => "done",
			});
			return mock.session;
		},
	};
}

describe("RunOpts.onStageSessionEvent", () => {
	test("forwards stage session events tagged with runId and stageId (#3474)", async () => {
		const observed: ObservedEvent[] = [];
		const def = workflow({
			name: "stage-session-events",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.stage("worker").prompt("go");
				return {};
			},
		});

		const result = await run(
			def,
			{},
			{
				adapters: { agentSession: emittingAdapter() },
				store: createStore(),
				onStageSessionEvent: observe(observed),
			},
		);

		assert.equal(result.status, "completed");
		const stageId = result.stages[0]?.id;
		assert.ok(stageId);
		assert.deepEqual(
			observed.filter((event) => event.type === "tool_execution_start"),
			[{ runId: result.runId, stageId, type: "tool_execution_start", toolCallId: "default" }],
		);
	});

	test("a throwing listener does not break the stage (#3474)", async () => {
		let calls = 0;
		const def = workflow({
			name: "stage-session-events-throwing",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.stage("worker").prompt("go");
				return {};
			},
		});

		const result = await run(
			def,
			{},
			{
				adapters: { agentSession: emittingAdapter() },
				store: createStore(),
				onStageSessionEvent: () => {
					calls += 1;
					throw new Error("listener failure");
				},
			},
		);

		assert.equal(result.status, "completed");
		assert.ok(calls > 0);
	});

	test("an async listener rejection does not escape as an unhandled rejection (#3474)", async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown): void => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", onUnhandled);
		try {
			const def = workflow({
				name: "stage-session-events-async-rejection",
				description: "",
				inputs: {},
				outputs: {},
				run: async (ctx) => {
					await ctx.stage("worker").prompt("go");
					return {};
				},
			});

			const result = await run(
				def,
				{},
				{
					adapters: { agentSession: emittingAdapter() },
					store: createStore(),
					onStageSessionEvent: async () => {
						throw new Error("async listener failure");
					},
				},
			);
			await new Promise((resolve) => setTimeout(resolve, 0));

			assert.equal(result.status, "completed");
			assert.deepEqual(unhandled, []);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	test("continues the stream across a fallback-model replacement session (#3474)", async () => {
		const observed: ObservedEvent[] = [];
		const def = workflow({
			name: "stage-session-events-fallback",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.stage("worker", { model: "anthropic/primary", fallbackModels: ["openai/fallback"] }).prompt("go");
				return {};
			},
		});

		const result = await run(
			def,
			{},
			{
				adapters: { agentSession: emittingAdapter("anthropic/primary") },
				store: createStore(),
				onStageSessionEvent: observe(observed),
			},
		);

		assert.equal(result.status, "completed");
		const stageId = result.stages[0]?.id;
		assert.ok(stageId);
		assert.deepEqual(
			observed.filter((event) => event.type === "tool_execution_start"),
			[
				{ runId: result.runId, stageId, type: "tool_execution_start", toolCallId: "anthropic/primary" },
				{ runId: result.runId, stageId, type: "tool_execution_start", toolCallId: "openai/fallback" },
			],
		);
	});

	test("forwards nested child workflow stage events under the child run (#3474)", async () => {
		const observed: ObservedEvent[] = [];
		const startedStages: Array<{ runId: string; stageId: string }> = [];
		const child = workflow({
			name: "stage-session-events-child",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.stage("child-worker").prompt("go");
				return {};
			},
		});
		const parent = workflow({
			name: "stage-session-events-parent",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.workflow(child, {});
				return {};
			},
		});

		const result = await run(
			parent,
			{},
			{
				adapters: { agentSession: emittingAdapter() },
				store: createStore(),
				onStageStart: (runId, snapshot) => {
					if (snapshot.name === "child-worker") startedStages.push({ runId, stageId: snapshot.id });
				},
				onStageSessionEvent: observe(observed),
			},
		);

		assert.equal(result.status, "completed");
		assert.equal(startedStages.length, 1);
		const childStage = startedStages[0]!;
		assert.notEqual(childStage.runId, result.runId);
		assert.deepEqual(
			observed.filter((event) => event.type === "tool_execution_start"),
			[{ ...childStage, type: "tool_execution_start", toolCallId: "default" }],
		);
	});
});
