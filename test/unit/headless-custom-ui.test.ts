/**
 * Regression tests for bastani-inc/atomic#1339 — headless/background (async)
 * workflow runs must not hard-crash with a raw
 * `TypeError: ctx.ui.custom is not a function` when a workflow stage calls
 * `await ctx.ui.custom(...)` (or any other interactive ctx.ui method).
 *
 * Required behavior:
 *   - non-interactive (headless) runs fail the interactive call with a clear,
 *     actionable error ("… unavailable in headless …"), never a raw TypeError;
 *   - interactive background runs route ctx.ui.custom through the stage UI
 *     broker (stage shows awaiting_input and stays answerable);
 *   - earlier completed stages remain completed;
 *   - incomplete UI adapters are rejected with a typed boundary error.
 */

import assert from "node:assert/strict";
import { Type } from "typebox";
import { describe, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { createCancellationRegistry } from "../../packages/workflows/src/runs/background/cancellation-registry.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { runDetached } from "../../packages/workflows/src/runs/background/runner.js";
import {
	normalizeUIContext,
	WorkflowUIAdapterError,
} from "../../packages/workflows/src/runs/foreground/executor-hil.js";
import type { StageCustomUiRequest } from "../../packages/workflows/src/shared/stage-ui-broker.js";
import { stageUiBroker } from "../../packages/workflows/src/shared/stage-ui-broker.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";

type TestStore = ReturnType<typeof createStore>;

async function waitForRunEnded(store: TestStore, runId: string, timeoutMs = 2000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const run = store.runs().find((r) => r.id === runId);
		if (run !== undefined && run.status !== "running" && run.status !== "pending") return run;
		await new Promise((r) => setTimeout(r, 5));
	}
	throw new Error(`run ${runId} did not end within ${timeoutMs}ms`);
}

async function waitForAwaitingCustomStage(store: TestStore, runId: string, timeoutMs = 2000): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const run = store.runs().find((r) => r.id === runId);
		const stage = run?.stages.find((s) => s.name === "custom" && s.status === "awaiting_input");
		if (stage !== undefined) return stage.id;
		await new Promise((r) => setTimeout(r, 5));
	}
	throw new Error(`no awaiting_input custom stage appeared on run ${runId}`);
}

/** Two-stage workflow: a normal prompt stage, then a ctx.ui.custom call. */
function customAfterStageWorkflow() {
	return workflow({
		name: "headless-custom-ui",
		description: "",
		inputs: {},
		outputs: {
			picked: Type.Optional(Type.Any()),
		},
		run: async (ctx) => {
			await ctx.stage("warmup").prompt("complete the warmup stage");
			const picked = await ctx.ui.custom<string>(async (_tui, _theme, _kb, done) => ({
				render: () => ["pick something"],
				handleInput: () => done("picked"),
				invalidate: () => {},
			}));
			return { picked };
		},
	});
}

const promptAdapters = {
	prompt: { prompt: async (text: string) => `done: ${text}` },
};

describe("headless ctx.ui.custom (#1339)", () => {
	test("non-interactive detached run fails with a clear headless error, not a TypeError", async () => {
		const store = createStore();
		const accepted = runDetached(
			customAfterStageWorkflow(),
			{},
			{
				store,
				cancellation: createCancellationRegistry(),
				jobs: createJobTracker(),
				adapters: promptAdapters,
				executionMode: "non_interactive",
			},
		);

		const run = await waitForRunEnded(store, accepted.runId);
		assert.equal(run.status, "failed");
		assert.ok(run.error !== undefined, "run must record an error");
		assert.doesNotMatch(run.error, /is not a function/);
		assert.doesNotMatch(run.error, /TypeError/);
		assert.match(run.error, /ctx\.ui\.custom/);
		assert.match(run.error, /headless/i);

		// Earlier completed stage must remain completed.
		const warmup = run.stages.find((s) => s.name === "warmup");
		assert.equal(warmup?.status, "completed");
	});

	test("all interactive ctx.ui methods get the headless treatment in non-interactive mode", async () => {
		for (const method of ["input", "confirm", "select", "editor"] as const) {
			const store = createStore();
			const def = workflow({
				name: `headless-${method}`,
				description: "",
				inputs: {},
				outputs: {
					value: Type.Optional(Type.Any()),
				},
				run: async (ctx) => {
					const value =
						method === "input"
							? await ctx.ui.input("q?")
							: method === "confirm"
								? await ctx.ui.confirm("ok?")
								: method === "select"
									? await ctx.ui.select("pick", ["a", "b"])
									: await ctx.ui.editor("seed");
					return { value };
				},
			});
			const accepted = runDetached(
				def,
				{},
				{
					store,
					cancellation: createCancellationRegistry(),
					jobs: createJobTracker(),
					executionMode: "non_interactive",
				},
			);
			const run = await waitForRunEnded(store, accepted.runId);
			assert.equal(run.status, "failed", `${method} should fail the run`);
			assert.doesNotMatch(run.error ?? "", /is not a function/);
			assert.match(run.error ?? "", new RegExp(`ctx\\.ui\\.${method}`));
			assert.match(run.error ?? "", /headless/i);
		}
	});

	test("interactive background run brokers ctx.ui.custom as awaiting_input and stays answerable", async () => {
		const store = createStore();
		const accepted = runDetached(
			customAfterStageWorkflow(),
			{},
			{
				store,
				cancellation: createCancellationRegistry(),
				jobs: createJobTracker(),
				adapters: promptAdapters,
			},
		);

		const stageId = await waitForAwaitingCustomStage(store, accepted.runId);

		// Answer the brokered request the way an attaching host would.
		const unregister = stageUiBroker.registerHost(accepted.runId, stageId, {
			showCustomUi(request: StageCustomUiRequest) {
				stageUiBroker.resolve(request as StageCustomUiRequest<string>, "picked-by-host");
			},
		});
		try {
			const run = await waitForRunEnded(store, accepted.runId);
			assert.equal(run.status, "completed");
			assert.deepEqual(run.result, { picked: "picked-by-host" });
			assert.equal(run.stages.find((s) => s.name === "warmup")?.status, "completed");
			assert.equal(run.stages.find((s) => s.name === "custom")?.status, "completed");
		} finally {
			unregister();
		}
	});

	test("rejects incomplete UI adapters with a typed missing-method error", () => {
		assert.throws(
			() => {
				// @ts-expect-error Incomplete adapters are not part of the current contract.
				normalizeUIContext({});
			},
			(error: Error) => {
				assert.ok(error instanceof WorkflowUIAdapterError);
				assert.equal(error.method, "input");
				return true;
			},
		);
	});
});
