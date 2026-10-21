/**
 * Unit tests for validateInputs — the schema validator used by slash-command
 * and programmatic SDK dispatch paths before starting a run.
 */

import assert from "node:assert/strict";
import { Type } from "typebox";
import { describe, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { resolveAndValidateInputs } from "../../packages/workflows/src/runs/foreground/executor-inputs.js";
import { validateInputs } from "../../packages/workflows/src/runs/shared/validate-inputs.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { WorkflowInputSchema } from "../../packages/workflows/src/shared/types.js";

const schema = (obj: Record<string, WorkflowInputSchema>): Readonly<Record<string, WorkflowInputSchema>> => obj;

describe("validateInputs", () => {
	test("no errors for well-formed inputs", () => {
		const errors = validateInputs(
			schema({
				prompt: Type.String(),
				count: Type.Number({ default: 3 }),
			}),
			{ prompt: "hi", count: 5 },
		);
		assert.deepEqual(errors, []);
	});

	test("rejects wrong type: number", () => {
		const errors = validateInputs(schema({ count: Type.Optional(Type.Number()) }), { count: "three" });
		assert.equal(errors.length, 1);
		assert.equal(errors[0]!.key, "count");
		assert.match(errors[0]!.reason, /number/);
	});

	test("rejects wrong type: boolean", () => {
		const errors = validateInputs(schema({ dry: Type.Optional(Type.Boolean()) }), { dry: "true" });
		assert.equal(errors.length, 1);
		assert.equal(errors[0]!.key, "dry");
		assert.match(errors[0]!.reason, /boolean/);
	});

	test("rejects wrong type: text/string", () => {
		const errors = validateInputs(schema({ prompt: Type.Optional(Type.String()) }), { prompt: 42 });
		assert.equal(errors.length, 1);
		assert.equal(errors[0]!.key, "prompt");
	});

	test("rejects select value not in choices", () => {
		const errors = validateInputs(
			schema({ mode: Type.Optional(Type.Union([Type.Literal("a"), Type.Literal("b")])) }),
			{ mode: "c" },
		);
		assert.equal(errors.length, 1);
		assert.match(errors[0]!.reason, /a/);
		assert.match(errors[0]!.reason, /b/);
	});

	test("accepts select value when in choices", () => {
		const errors = validateInputs(
			schema({ mode: Type.Optional(Type.Union([Type.Literal("a"), Type.Literal("b")])) }),
			{ mode: "a" },
		);
		assert.deepEqual(errors, []);
	});

	test("rejects unknown input keys (catches typos)", () => {
		const errors = validateInputs(schema({ prompt: Type.Optional(Type.String()) }), { prompt: "hi", propmt: "typo" });
		assert.equal(errors.length, 1);
		assert.equal(errors[0]!.key, "propmt");
		assert.match(errors[0]!.reason.toLowerCase(), /unknown/);
	});

	test("reports missing required inputs", () => {
		const errors = validateInputs(schema({ prompt: Type.String() }), {});
		assert.equal(errors.length, 1);
		assert.equal(errors[0]!.key, "prompt");
		assert.match(errors[0]!.reason.toLowerCase(), /required/);
	});

	test("does NOT report missing optional inputs", () => {
		const errors = validateInputs(schema({ count: Type.Optional(Type.Number()) }), {});
		assert.deepEqual(errors, []);
	});

	test("collects multiple errors", () => {
		const errors = validateInputs(
			schema({
				prompt: Type.String(),
				count: Type.Optional(Type.Number()),
			}),
			{ count: "x", unknown: 1 },
		);
		// missing prompt + count wrong type + unknown key = 3
		assert.equal(errors.length, 3);
	});

	test("NaN rejected as non-serializable number", () => {
		const errors = validateInputs(schema({ count: Type.Optional(Type.Number()) }), { count: Number.NaN });
		assert.equal(errors.length, 1);
		assert.equal(errors[0]!.key, "count");
		assert.match(errors[0]!.reason, /finite number/);
	});

	test("Infinity rejected as non-serializable number", () => {
		const errors = validateInputs(schema({ count: Type.Optional(Type.Number()) }), {
			count: Number.POSITIVE_INFINITY,
		});
		assert.equal(errors.length, 1);
		assert.equal(errors[0]!.key, "count");
		assert.match(errors[0]!.reason, /finite number/);
	});

	test("rejects non-plain object instances as non-serializable", () => {
		for (const value of [new Date(), new Map(), /pattern/]) {
			const errors = validateInputs(schema({ value: Type.Unknown() }), { value: value as never });
			assert.equal(errors.length, 1, `${value.constructor.name} should be rejected`);
			assert.equal(errors[0]!.key, "value");
			assert.match(errors[0]!.reason, /JSON-serializable/);
		}
	});
});

describe("numeric minimum/maximum on integer and number inputs", () => {
	const bounded = schema({ count: Type.Integer({ minimum: 1, maximum: 8 }) });
	const ratio = schema({ ratio: Type.Number({ minimum: 0.5, maximum: 2.5 }) });

	test("rejects an integer below the minimum, zero and negative (#3812)", () => {
		for (const count of [0, -3]) {
			const errors = validateInputs(bounded, { count });
			assert.equal(errors.length, 1, `count=${count}`);
			assert.equal(errors[0]!.key, "count");
			assert.match(errors[0]!.reason, /1/);
		}
	});

	test("rejects an integer above the maximum (#3812)", () => {
		const errors = validateInputs(bounded, { count: 9 });
		assert.equal(errors.length, 1);
		assert.equal(errors[0]!.key, "count");
		assert.match(errors[0]!.reason, /8/);
	});

	test("accepts integers inside the bounds, minimum and maximum inclusive (#3812)", () => {
		for (const count of [1, 4, 8]) assert.deepEqual(validateInputs(bounded, { count }), [], `count=${count}`);
	});

	test("rejects a number below the minimum or above the maximum (#3812)", () => {
		for (const value of [0.49, -1, 2.51, 100]) {
			const errors = validateInputs(ratio, { ratio: value });
			assert.equal(errors.length, 1, `ratio=${value}`);
			assert.equal(errors[0]!.key, "ratio");
		}
	});

	test("accepts numbers inside the bounds, minimum and maximum inclusive (#3812)", () => {
		for (const value of [0.5, 1.25, 2.5]) assert.deepEqual(validateInputs(ratio, { ratio: value }), []);
	});

	test("keeps the type message for a non-integer, not a bound message (#3812)", () => {
		const errors = validateInputs(bounded, { count: 2.5 });
		assert.equal(errors.length, 1);
		assert.match(errors[0]!.reason, /expected integer/);
	});

	test("rejects an out-of-range value on an optional bounded input (#3812)", () => {
		const errors = validateInputs(schema({ count: Type.Optional(Type.Integer({ minimum: 1 })) }), { count: 0 });
		assert.equal(errors.length, 1);
		assert.deepEqual(validateInputs(schema({ count: Type.Optional(Type.Integer({ minimum: 1 })) }), {}), []);
	});

	test("resolveAndValidateInputs rejects an out-of-range default-less value and names the input (#3812)", () => {
		assert.throws(() => resolveAndValidateInputs(bounded, { count: 0 }, 'workflow "bounds-demo"'), /count/);
		assert.deepEqual(resolveAndValidateInputs(bounded, { count: 1 }, 'workflow "bounds-demo"'), { count: 1 });
	});

	test("run() rejects count=0 before the workflow body runs (#3812)", async () => {
		let bodyRan = false;
		const boundsDemo = workflow({
			name: "bounds-demo",
			description: "One bounded integer input; a tracked tool node echoes the accepted value.",
			inputs: { count: Type.Integer({ minimum: 1, maximum: 8, description: "Must be 1-8." }) },
			outputs: { accepted: Type.String() },
			run: async (ctx) => {
				bodyRan = true;
				const accepted = await ctx.tool(
					"echo",
					{ count: ctx.inputs.count },
					async () => `body received count=${ctx.inputs.count}`,
				);
				return { accepted };
			},
		});
		await assert.rejects(() => run(boundsDemo, { count: 0 }, { store: createStore() }), /invalid inputs[\s\S]*count/);
		assert.equal(bodyRan, false);
		const ok = await run(boundsDemo, { count: 1 }, { store: createStore() });
		assert.equal(ok.status, "completed", ok.error);
		assert.deepEqual(ok.result, { accepted: "body received count=1" });
	});
});
