import assert from "node:assert/strict";
import type { ProgramStatus, Terminal } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { WorkflowActivityHub } from "../../packages/coding-agent/src/core/extensions/workflow-activity-hub.js";
import { ProgramStatusReporter } from "../../packages/coding-agent/src/modes/interactive/program-status-reporter.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createWorkflowObservation } from "../../packages/workflows/src/extension/workflow-observation.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { sleep } from "../helpers/runtime.js";

const STEP_MS = 15;

type Definition = Parameters<typeof run>[0];

/**
 * Drive a real workflow run through the production observation bridge into the status reporter and
 * return every distinct state the terminal was told, in order.
 */
async function reportedStates(
	definition: Definition,
	complete?: (prompt: string) => Promise<string>,
): Promise<ProgramStatus["state"][]> {
	const states: ProgramStatus["state"][] = [];
	const terminal = {
		setProgramStatus: (status: ProgramStatus) => {
			states.push(status.state);
		},
	} as Terminal;
	const reporter = new ProgramStatusReporter(
		() => terminal,
		() => undefined,
	);
	const store = createStore();
	const hub = new WorkflowActivityHub();
	const observation = createWorkflowObservation(store, hub.registerWorkflowActivityPublisher(), "owner");
	const subscription = hub.observeWorkflowActivity((frame) => reporter.handleWorkflowActivity(frame));
	try {
		await sleep(STEP_MS);
		await run(
			definition,
			{},
			{
				store,
				durableBackend: new InMemoryDurableBackend(),
				...(complete ? { adapters: { complete: { complete } } } : {}),
			},
		);
		await sleep(STEP_MS * 2);
		return states;
	} finally {
		subscription.dispose();
		observation.dispose();
	}
}

const step = (name: string) => async () => {
	await sleep(STEP_MS);
	return name;
};

const failingStep = async () => {
	await sleep(STEP_MS);
	throw new Error("boom");
};

/** A stage model call that fails for prompts starting with "fail", the way a provider error would. */
const completeUnlessFail =
	(rateLimited = false) =>
	async (prompt: string) => {
		await sleep(STEP_MS);
		if (prompt.startsWith("fail")) {
			throw rateLimited
				? Object.assign(new Error("429 rate limit exceeded, retry later"), { status: 429 })
				: new Error("boom");
		}
		return prompt;
	};

const define = (name: string, body: Parameters<typeof workflow>[0]["run"]) =>
	workflow({ name, description: "", inputs: {}, outputs: {}, run: body });

test("a run with sequential tool steps stays working until it completes (#3556)", async () => {
	const states = await reportedStates(
		workflow({
			name: "sequential-tools",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.tool("one", {}, step("one"));
				await ctx.tool("two", {}, step("two"));
				await ctx.tool("three", {}, step("three"));
				return {};
			},
		}),
	);
	assert.deepEqual(states, ["idle", "working", "done"]);
});

test("a run ending with ctx.exit failed reports error without an earlier done (#3556)", async () => {
	const states = await reportedStates(
		workflow({
			name: "exit-failed",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.tool("one", {}, step("one"));
				await ctx.tool("two", {}, step("two"));
				return ctx.exit({ status: "failed", reason: "probe" });
			},
		}),
	);
	assert.deepEqual(states, ["idle", "working", "error"]);
});

test("a run whose tool throws reports error without an earlier done (#3556)", async () => {
	const states = await reportedStates(
		workflow({
			name: "tool-throws",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.tool("one", {}, step("one"));
				await ctx.tool("bad", {}, async () => {
					await sleep(STEP_MS);
					throw new Error("boom");
				});
				return {};
			},
		}),
	);
	assert.deepEqual(states, ["idle", "working", "error"]);
});

test("a run with a nested workflow stays working across the child's boundaries (#3556)", async () => {
	const child = workflow({
		name: "child",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.tool("inner", {}, step("inner"));
			return {};
		},
	});
	const states = await reportedStates(
		workflow({
			name: "parent",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.tool("before", {}, step("before"));
				await ctx.workflow(child);
				await ctx.tool("after", {}, step("after"));
				return {};
			},
		}),
	);
	assert.deepEqual(states, ["idle", "working", "done"]);
});

test("a run whose stage fails reports error without an earlier done (#3556)", async () => {
	const states = await reportedStates(
		define("stage-fails", async (ctx) => {
			await ctx.stage("first").complete("first");
			await ctx.stage("second").complete("fail");
			return {};
		}),
		completeUnlessFail(),
	);
	assert.deepEqual(states, ["idle", "working", "error"]);
});

test("a run that catches a stage failure and carries on stays working until it completes (#3556)", async () => {
	const states = await reportedStates(
		define("stage-failure-caught", async (ctx) => {
			try {
				await ctx.stage("first").complete("fail");
			} catch {
				// the author handles the failure and continues
			}
			await ctx.stage("second").complete("second");
			await ctx.tool("after", {}, step("after"));
			return {};
		}),
		completeUnlessFail(),
	);
	assert.deepEqual(states, ["idle", "working", "done"]);
});

test("a run that catches a tool failure and carries on reports error without an earlier done (#3556)", async () => {
	const states = await reportedStates(
		define("tool-failure-caught", async (ctx) => {
			try {
				await ctx.tool("bad", {}, failingStep);
			} catch {
				// the author handles the failure and continues
			}
			await ctx.tool("after", {}, step("after"));
			await ctx.stage("last").complete("last");
			return {};
		}),
		completeUnlessFail(),
	);
	assert.deepEqual(states, ["idle", "working", "error"]);
});

test("a run whose parallel tool fails while another still runs reports error without an earlier done (#3556)", async () => {
	const states = await reportedStates(
		define("parallel-tool-fails", async (ctx) => {
			await Promise.all([
				ctx.tool("bad", {}, async () => {
					await sleep(STEP_MS / 3);
					throw new Error("boom");
				}),
				ctx.tool("slow", {}, async () => {
					await sleep(STEP_MS * 4);
					return "slow";
				}),
			]);
			return {};
		}),
	);
	assert.deepEqual(states, ["idle", "working", "error"]);
});

test("a run whose stage fails recoverably is blocked without an earlier done (#3556)", async () => {
	const states = await reportedStates(
		define("stage-fails-recoverably", async (ctx) => {
			await ctx.stage("first").complete("first");
			await ctx.stage("second").complete("fail");
			return {};
		}),
		completeUnlessFail(true),
	);
	assert.deepEqual(states, ["idle", "working", "blocked"]);
});
