import { describe } from "vitest";
import type { WorkflowParallelFailure } from "../../packages/workflows/src/authoring.js";
import { mapParallelSteps } from "../../packages/workflows/src/runs/foreground/executor-direct-helpers.js";
import { assert, createStore, run, test, workflow } from "./executor-shared.js";

describe("ctx.parallel partial results", () => {
	test.each(["prompt", "options"])(
		"a fresh fail-fast parallel does not prepare a queued worker's %s (#5481)",
		async (field) => {
			const called: string[] = [];
			let caught: unknown;
			const def = workflow({
				name: "fresh-fail-fast",
				description: "",
				inputs: {},
				outputs: {},
				run: async (ctx) => {
					try {
						const later =
							field === "prompt"
								? { name: "later", prompt: "{task}".repeat(8192) }
								: {
										name: "later",
										get forkFromSessionId(): string {
											throw new Error("fresh worker has no source");
										},
									};
						await ctx.parallel([{ name: "first", prompt: "admitted" }, later], {
							context: "fresh",
							concurrency: 1,
							failFast: true,
							task: "a".repeat(65536),
						});
					} catch (error) {
						caught = error;
					}
					return {};
				},
			});
			const result = await run(
				def,
				{},
				{
					store: createStore(),
					adapters: {
						prompt: {
							async prompt(text) {
								called.push(text);
								throw new Error("admitted worker failure");
							},
						},
					},
				},
			);
			assert.match(String(caught), /admitted worker failure/);
			assert.deepEqual(called, ["admitted"]);
			assert.equal(result.status, "completed", result.error);
		},
	);

	test("failFast:false attaches completed step results to the AggregateError (#3809)", async () => {
		let caught: unknown;
		const def = workflow({
			name: "parallel-partial-results-wf",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				try {
					await ctx.parallel(
						[
							{ name: "ok-1", prompt: "one" },
							{ name: "ok-2", prompt: "two" },
							{ name: "boom", prompt: "explode" },
						],
						{ failFast: false },
					);
				} catch (error) {
					caught = error;
				}
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
							if (text === "explode") throw new Error("boom failed");
							return `reply:${text}`;
						},
					},
				},
				store: createStore(),
			},
		);

		assert.equal(result.status, "completed");
		assert.ok(caught instanceof AggregateError);
		const failure = caught as WorkflowParallelFailure;
		assert.equal(failure.errors.length, 1);
		assert.equal(failure.partialResults.length, 3);
		assert.equal(failure.partialResults[0]?.name, "ok-1");
		assert.equal(failure.partialResults[0]?.text, "reply:one");
		assert.equal(failure.partialResults[1]?.name, "ok-2");
		assert.equal(failure.partialResults[1]?.text, "reply:two");
		assert.equal(failure.partialResults[2], undefined);
	});

	test("failFast:false keeps step order when an earlier step fails and later steps succeed (#3809)", async () => {
		const outcomes = [new Error("first"), "second", "third"];
		const failure = await mapParallelSteps(
			outcomes.map((_, index) => ({ name: `step-${index}` })),
			2,
			false,
			async (step) => {
				const outcome = outcomes[Number(step.name.slice("step-".length))];
				if (outcome instanceof Error) throw outcome;
				return outcome;
			},
		).then(
			() => undefined,
			(error: unknown) => error as WorkflowParallelFailure<string>,
		);

		assert.ok(failure instanceof AggregateError);
		assert.deepEqual(failure.partialResults, [undefined, "second", "third"]);
	});

	test("failFast:false resolves without a partial-results error when every step succeeds (#3809)", async () => {
		const results = await mapParallelSteps(
			[{ name: "a" }, { name: "b" }],
			undefined,
			false,
			async (step) => step.name,
		);
		assert.deepEqual(results, ["a", "b"]);
	});
});
