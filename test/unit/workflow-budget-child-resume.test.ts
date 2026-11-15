import assert from "node:assert/strict";
import { Type } from "typebox";
import { describe, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { BUDGET_WRAP_UP_PROMPT } from "../../packages/workflows/src/engine/run-budget.js";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";
import {
	type AgentSession,
	type AgentSessionAdapter,
	assistantMessageWithUsage,
	makeMockSession,
} from "./stage-runner-helpers.js";

const PROMPT_TOKENS = 5;

/** Every work prompt spends 5 tokens; a budget wrap-up turn spends nothing. */
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
							cost: 0,
						}),
					);
				},
				getLastAssistantText: () => answer,
			}).session;
		},
	};
}

describe("child workflow budget across a root resume (#5053)", () => {
	test("a child's own budget keeps the spend it was charged before the root resumed (#5053)", async () => {
		const backend = await createMemoryTestBackend();
		const child = workflow({
			name: "child-budget-resume-child",
			description: "",
			inputs: {},
			outputs: { done: Type.String() },
			run: async (ctx) => {
				for (let index = 1; index <= 6; index++)
					await ctx.stage(`child-${index}`, { model: "test/model" }).prompt("work");
				return { done: "child" };
			},
		});
		const definition = workflow({
			name: "child-budget-resume",
			description: "",
			inputs: {},
			outputs: { result: Type.String() },
			run: async (ctx) => {
				await ctx.workflow(child, { stageName: "child", budget: { maxTokens: 22 } });
				await ctx.stage("parent", { model: "test/model" }).prompt("work");
				return { result: "done" };
			},
		});
		let prompts = 0;
		const adapters = { agentSession: spendingSession(() => prompts++) };
		const runId = "child-budget-resume-run";

		// The root's 12-token cap stops the run inside the child after 3 child stages (15 tokens).
		const first = await run(
			definition,
			{},
			{ runId, store: createStore(), durableBackend: backend, budget: { maxTokens: 12 }, adapters },
		);
		assert.equal((first.result as { status?: string } | undefined)?.status, "budget_exceeded");
		assert.equal(prompts, 3, "three child stages");

		// A new process resumes the root with a raised root budget. The child already spent 15 of its own 22
		// tokens, so it may run 2 more paid stages (reading 25 >= 22 stops it) — never 3 more.
		const store = createStore();
		await run(definition, {}, { runId, store, durableBackend: backend, budget: { maxTokens: 1000 }, adapters });
		assert.equal(prompts, 3 + 2 + 1, "two more child stages, then the parent stage");
		const childRun = store.runs().find((candidate) => candidate.parentRunId === runId);
		assert.equal(childRun?.budgetState?.accounting?.tokens, 25);
	});
});
