import { describe } from "vitest";
import { assert, createStore, run, Type, test, workflow } from "./executor-shared.js";

// Every special replacement pattern String.prototype.replace interprets in a string replacement.
const DOLLAR_TEXT = "kill $$; echo [$&] before:$` after:$'";

describe("workflow prompt substitution", () => {
	test("ctx.chain inserts task text and the previous step's output verbatim (#4887)", async () => {
		const seenPrompts: string[] = [];
		const def = workflow({
			name: "verbatim-chain-wf",
			description: "",
			inputs: {},
			outputs: { final: Type.Optional(Type.Any()) },
			run: async (ctx) => {
				const results = await ctx.chain(
					[
						{ name: "writer", task: "write: {task}" },
						{ name: "reviewer", task: "review: {previous}" },
					],
					{ task: DOLLAR_TEXT },
				);
				return { final: results.at(-1)?.text };
			},
		});
		const result = await run(
			def,
			{},
			{
				adapters: {
					prompt: {
						prompt: async (text) => {
							seenPrompts.push(text);
							return seenPrompts.length === 1 ? `step output ${DOLLAR_TEXT}` : "done";
						},
					},
				},
				store: createStore(),
			},
		);
		assert.equal(result.status, "completed");
		assert.deepEqual(seenPrompts, [`write: ${DOLLAR_TEXT}`, `review: step output ${DOLLAR_TEXT}`]);
	});

	test("ctx.parallel inserts shared task text verbatim (#4887)", async () => {
		const seenPrompts: string[] = [];
		const def = workflow({
			name: "verbatim-parallel-wf",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.parallel(
					[
						{ name: "frontend", task: "frontend: {task}" },
						{ name: "backend", task: "backend: {task}" },
					],
					{ task: DOLLAR_TEXT },
				);
				return {};
			},
		});
		const result = await run(
			def,
			{},
			{
				adapters: {
					prompt: {
						prompt: async (text) => {
							seenPrompts.push(text);
							return "done";
						},
					},
				},
				store: createStore(),
			},
		);
		assert.equal(result.status, "completed");
		assert.deepEqual(seenPrompts.sort(), [`backend: ${DOLLAR_TEXT}`, `frontend: ${DOLLAR_TEXT}`]);
	});

	test("ctx.task inserts previous text verbatim (#4887)", async () => {
		const seenPrompts: string[] = [];
		const def = workflow({
			name: "verbatim-task-wf",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.task("reviewer", { prompt: "review: {previous}", previous: DOLLAR_TEXT });
				return {};
			},
		});
		const result = await run(
			def,
			{},
			{
				adapters: {
					prompt: {
						prompt: async (text) => {
							seenPrompts.push(text);
							return "done";
						},
					},
				},
				store: createStore(),
			},
		);
		assert.equal(result.status, "completed");
		assert.deepEqual(seenPrompts, [`review: ${DOLLAR_TEXT}`]);
	});
});
