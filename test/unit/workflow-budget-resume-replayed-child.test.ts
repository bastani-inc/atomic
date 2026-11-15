import assert from "node:assert/strict";
import { Type } from "typebox";
import { test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { BUDGET_WRAP_UP_PROMPT, createRunBudgetController } from "../../packages/workflows/src/engine/run-budget.js";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import { resolve_budget, type WorkflowBudget } from "../../packages/workflows/src/shared/budget.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";
import {
	type AgentSession,
	type AgentSessionAdapter,
	assistantMessageWithUsage,
	makeMockSession,
} from "./stage-runner-helpers.js";

interface BudgetOutcome {
	readonly status?: string;
	readonly dimension?: string;
	readonly reading?: number;
}

const PROMPT_TOKENS = 5;
const PROMPT_COST = 0.5;

function spendingSession(onPrompt: () => void): AgentSessionAdapter {
	return {
		async create() {
			const messages: AgentSession["messages"] = [];
			let answer = "";
			return makeMockSession({
				messages,
				async prompt(text) {
					const wrapUp = text === BUDGET_WRAP_UP_PROMPT;
					if (!wrapUp) onPrompt();
					answer = wrapUp ? "wrap-up" : "work";
					messages.push(
						assistantMessageWithUsage(answer, {
							input: wrapUp ? 0 : PROMPT_TOKENS,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							cost: wrapUp ? 0 : PROMPT_COST,
						}),
					);
				},
				getLastAssistantText: () => answer,
			}).session;
		},
	};
}

/** Run a parent that spends inside a child, stop it on budget, then resume once with a raised budget. */
async function stopAndResume(input: {
	readonly name: string;
	readonly childStages: number;
	readonly parentStages: number;
	readonly first: WorkflowBudget;
	readonly raised: WorkflowBudget;
}) {
	const backend = await createMemoryTestBackend();
	const child = workflow({
		name: `${input.name}-child`,
		description: "",
		inputs: {},
		outputs: { done: Type.String() },
		run: async (ctx) => {
			for (let index = 1; index <= input.childStages; index++)
				await ctx.stage(`child-${index}`, { model: "test/model" }).prompt("work");
			return { done: "child" };
		},
	});
	const definition = workflow({
		name: input.name,
		description: "",
		inputs: {},
		outputs: { result: Type.String() },
		run: async (ctx) => {
			await ctx.workflow(child, { stageName: "child" });
			for (let index = 1; index <= input.parentStages; index++)
				await ctx.stage(`parent-${index}`, { model: "test/model" }).prompt("work");
			return { result: "done" };
		},
	});
	let prompts = 0;
	const adapters = { agentSession: spendingSession(() => prompts++) };
	const store = createStore();
	const runId = `${input.name}-run`;
	const first = await run(definition, {}, { runId, store, durableBackend: backend, budget: input.first, adapters });
	const firstPrompts = prompts;
	const resumed = await run(definition, {}, { runId, store, durableBackend: backend, budget: input.raised, adapters });
	const snapshot = store.runs().find((candidate) => candidate.id === resumed.runId);
	return {
		first: first.result as BudgetOutcome | undefined,
		firstPrompts,
		resumed: resumed.result as BudgetOutcome | undefined,
		resumedStatus: resumed.status,
		resumedPrompts: prompts - firstPrompts,
		accounting: snapshot?.budgetState?.accounting,
	};
}

test("budget resume charges spend exactly after re-entering a child stopped mid-run (#4859)", async () => {
	const outcome = await stopAndResume({
		name: "budget-resume-replayed-child",
		childStages: 5,
		parentStages: 6,
		first: { maxTokens: 12 },
		raised: { maxTokens: 42 },
	});
	assert.equal(outcome.first?.status, "budget_exceeded");
	assert.equal(outcome.first?.reading, 15);
	assert.equal(outcome.firstPrompts, 3);
	assert.equal(outcome.resumed?.status, "budget_exceeded");
	assert.equal(outcome.resumed?.dimension, "tokens");
	assert.equal(outcome.resumed?.reading, 45);
	assert.equal(outcome.resumedPrompts, 6);
	assert.equal(outcome.accounting?.tokens, 45);
});

test("budget resume charges spend exactly when the child finished before the stop (#4859)", async () => {
	const outcome = await stopAndResume({
		name: "budget-resume-finished-child",
		childStages: 2,
		parentStages: 9,
		first: { maxTokens: 12 },
		raised: { maxTokens: 42 },
	});
	assert.equal(outcome.first?.reading, 15);
	assert.equal(outcome.firstPrompts, 3);
	assert.equal(outcome.resumed?.status, "budget_exceeded");
	assert.equal(outcome.resumed?.reading, 45);
	assert.equal(outcome.resumedPrompts, 6);
	assert.equal(outcome.accounting?.tokens, 45);
});

test("budget resume charges cost exactly after re-entering a child stopped mid-run (#4859)", async () => {
	const outcome = await stopAndResume({
		name: "budget-resume-replayed-child-cost",
		childStages: 5,
		parentStages: 6,
		first: { maxCost: 1.2 },
		raised: { maxCost: 4.2 },
	});
	assert.equal(outcome.first?.status, "budget_exceeded");
	assert.equal(outcome.first?.reading, 1.5);
	assert.equal(outcome.firstPrompts, 3);
	assert.equal(outcome.resumed?.status, "budget_exceeded");
	assert.equal(outcome.resumed?.dimension, "cost");
	assert.equal(outcome.resumed?.reading, 4.5);
	assert.equal(outcome.resumedPrompts, 6);
	assert.equal(outcome.accounting?.cost, 4.5);
});

test("budget charges a stage whose usage dips and recovers only once (#4859)", () => {
	const stage = (tokens: number): RunSnapshot["stages"][number] => ({
		id: "metered",
		name: "metered",
		status: "completed",
		parentIds: [],
		toolEvents: [],
		modelAttempts: [{ model: "test/model", success: true, usage: { input: tokens, cost: tokens / 10 } }],
	});
	const run: RunSnapshot = {
		id: "budget-dip",
		name: "budget-dip",
		inputs: {},
		status: "running",
		toolNodes: [],
		stages: [stage(6)],
		startedAt: 0,
	};
	const controller = createRunBudgetController({
		run,
		budget: resolve_budget({ run: { maxTokens: 100, maxCost: 100 } }),
		usageTree: () => ({ run }),
	});
	controller.checkpoint("metered");
	run.stages[0] = stage(2);
	controller.checkpoint("metered");
	run.stages[0] = stage(8);
	controller.checkpoint("metered");
	assert.equal(run.budgetState?.tokens?.reading, 8);
	assert.equal(run.budgetState?.cost?.reading, 0.8);
});
