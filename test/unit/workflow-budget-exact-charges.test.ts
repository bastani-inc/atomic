import assert from "node:assert/strict";
import { Type } from "typebox";
import { describe, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { BUDGET_WRAP_UP_PROMPT, createRunBudgetController } from "../../packages/workflows/src/engine/run-budget.js";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import { resolve_budget } from "../../packages/workflows/src/shared/budget.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";
import {
	type AgentSession,
	type AgentSessionAdapter,
	assistantMessageWithUsage,
	makeMockSession,
} from "./stage-runner-helpers.js";

const PROMPT_TOKENS = 5;
const WRAP_TOKENS = 7;

/** Every prompt spends 5 tokens; the budget wrap-up turn spends 7. */
function spendingSession(onPrompt: (wrapUp: boolean) => void): AgentSessionAdapter {
	return {
		async create() {
			const messages: AgentSession["messages"] = [];
			let answer = "";
			return makeMockSession({
				messages,
				async prompt(text) {
					const wrapUp = text === BUDGET_WRAP_UP_PROMPT;
					onPrompt(wrapUp);
					answer = wrapUp ? "wrap-up" : "work";
					messages.push(
						assistantMessageWithUsage(answer, {
							input: wrapUp ? WRAP_TOKENS : PROMPT_TOKENS,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							cost: 0,
						}),
					);
				},
				getLastAssistantText: () => answer,
			}).session;
		},
	};
}

const pricedStage = (id: string, cost: number): RunSnapshot["stages"][number] => ({
	id,
	name: id,
	status: "completed",
	parentIds: [],
	toolEvents: [],
	modelAttempts: [{ model: "m", success: true, usage: { input: 1, cost } }],
});

describe("workflow budget charges (#5053)", () => {
	test("a budget wrap-up turn's spend is charged once, before and after a resume (#5053)", async () => {
		const backend = await createMemoryTestBackend();
		const child = workflow({
			name: "wrap-charge-child",
			description: "",
			inputs: {},
			outputs: { done: Type.String() },
			run: async (ctx) => {
				await ctx.stage("child-1", { model: "test/model" }).prompt("work");
				return { done: "child" };
			},
		});
		const definition = workflow({
			name: "wrap-charge",
			description: "",
			inputs: {},
			outputs: { result: Type.String() },
			run: async (ctx) => {
				await ctx.workflow(child, { stageName: "child" });
				for (let index = 1; index <= 6; index++)
					await ctx.stage(`parent-${index}`, { model: "test/model" }).prompt("work");
				return { result: "done" };
			},
		});
		let prompts = 0;
		let wraps = 0;
		const adapters = { agentSession: spendingSession((wrapUp) => (wrapUp ? wraps++ : prompts++)) };
		const store = createStore();
		const runId = "wrap-charge-run";
		const accounting = () => store.runs().find((candidate) => candidate.id === runId)?.budgetState?.accounting;

		await run(definition, {}, { runId, store, durableBackend: backend, budget: { maxTokens: 12 }, adapters });
		assert.equal(wraps, 1, "the first execution delivered one wrap-up turn");
		assert.equal(accounting()?.tokens, prompts * PROMPT_TOKENS + WRAP_TOKENS, "the stopped run charged its wrap-up");
		assert.equal(accounting()?.tokens, 22);

		const resumed = await run(
			definition,
			{},
			{ runId, store, durableBackend: backend, budget: { maxTokens: 100 }, adapters },
		);
		assert.equal(resumed.status, "completed");
		assert.equal(accounting()?.tokens, prompts * PROMPT_TOKENS + wraps * WRAP_TOKENS, "nothing is charged twice");
		assert.equal(accounting()?.tokens, 42);
	});

	test("ten 0.10 stages reach a 1.00 cost cap and eight reach its 80% warning (#5053)", () => {
		const snapshot: RunSnapshot = {
			id: "r",
			name: "r",
			inputs: {},
			status: "running",
			toolNodes: [],
			stages: [],
			startedAt: Date.now(),
		};
		const controller = createRunBudgetController({
			run: snapshot,
			budget: resolve_budget({ run: { maxCost: 1, warnAtPercent: 80 } }),
			usageTree: () => ({ run: snapshot }),
		});
		const kinds: string[] = [];
		for (let index = 1; index <= 10; index++) {
			snapshot.stages.push(pricedStage(`s${index}`, 0.1));
			kinds.push(controller.checkpoint(`s${index}`).kind);
		}

		assert.deepEqual(kinds, [
			"continue",
			"continue",
			"continue",
			"continue",
			"continue",
			"continue",
			"continue",
			"warn",
			"continue",
			"wrap_up",
		]);
		assert.equal(snapshot.budgetState?.accounting?.cost, 1);
	});

	test("a 0.29 stage reaches a 29% cost warning of a 1.00 cap (#5053)", () => {
		const snapshot: RunSnapshot = {
			id: "r",
			name: "r",
			inputs: {},
			status: "running",
			toolNodes: [],
			stages: [pricedStage("s1", 0.29)],
			startedAt: Date.now(),
		};
		const controller = createRunBudgetController({
			run: snapshot,
			budget: resolve_budget({ run: { maxCost: 1, warnAtPercent: 29 } }),
			usageTree: () => ({ run: snapshot }),
		});

		// 0.29 * 100 is 28.999999999999996 in floating point.
		assert.equal(controller.checkpoint("s1").kind, "warn");
	});

	test("pending usage exhausts a budget once it reaches the cap, its root's included (#5053)", () => {
		const snapshot = (id: string): RunSnapshot => ({
			id,
			name: id,
			inputs: {},
			status: "running",
			toolNodes: [],
			stages: [pricedStage(`${id}-stage`, 0)],
			startedAt: Date.now(),
		});
		const rootRun = snapshot("root");
		const root = createRunBudgetController({
			run: rootRun,
			budget: resolve_budget({ run: { maxTokens: 10 } }),
			usageTree: () => ({ run: rootRun }),
		});
		const childRun = snapshot("child");
		const child = createRunBudgetController({
			run: childRun,
			budget: resolve_budget({ run: { maxTokens: 100 } }),
			usageTree: () => ({ run: childRun }),
			rootBudget: root,
		});
		const durationOnly = createRunBudgetController({
			run: snapshot("timed"),
			budget: resolve_budget({ run: { maxDurationMs: 60_000 } }),
		});

		// Each stage already holds 1 input token.
		assert.equal(root.exhaustedWith({ input: 8 }), false, "9 of 10 tokens");
		assert.equal(root.exhaustedWith({ input: 9 }), true, "10 of 10 tokens");
		assert.equal(
			child.exhaustedWith({ input: 9 }),
			true,
			"the child's own 100 tokens are left, but its root's are not",
		);
		assert.equal(child.exhaustedWith({ input: 8 }), false);
		assert.equal(durationOnly.exhaustedWith({ input: 1_000_000, cost: 1_000 }), false, "no usage cap to reach");
		const costRun = snapshot("priced");
		const costCapped = createRunBudgetController({
			run: costRun,
			budget: resolve_budget({ run: { maxCost: 1, maxTokens: 1_000 } }),
			usageTree: () => ({ run: costRun }),
		});
		assert.equal(root.exhaustedWith({ input: 4, output: 5 }), true, "output tokens count toward the cap");
		assert.equal(costCapped.exhaustedWith({ cost: 0.9 }), false);
		assert.equal(costCapped.exhaustedWith({ cost: 0.1 * 10 }), true, "pending cost reaches the cost cap");
	});
});
