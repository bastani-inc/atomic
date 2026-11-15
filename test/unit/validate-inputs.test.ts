/**
 * Unit tests for validateInputs — the schema validator used by slash-command
 * and programmatic SDK dispatch paths before starting a run.
 */

import assert from "node:assert/strict";
import { Type } from "typebox";
import { Value } from "typebox/value";
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

describe("text inputs are checked against their schema (#4849)", () => {
	const rejected: ReadonlyArray<{
		readonly name: string;
		readonly def: WorkflowInputSchema;
		readonly value: string;
		readonly accepted: string;
		readonly reason: RegExp;
	}> = [
		{ name: "literal", def: Type.Literal("fast"), value: "slow", accepted: "fast", reason: /must equal "fast"/ },
		{
			name: "optional literal",
			def: Type.Optional(Type.Literal("fast")),
			value: "slow",
			accepted: "fast",
			reason: /must equal "fast"/,
		},
		{
			name: "minLength",
			def: Type.String({ minLength: 3 }),
			value: "a",
			accepted: "abc",
			reason: /fewer than 3 characters \(minLength 3\)/,
		},
		{
			name: "maxLength",
			def: Type.String({ maxLength: 4 }),
			value: "too long",
			accepted: "tiny",
			reason: /more than 4 characters \(maxLength 4\)/,
		},
		{
			name: "pattern",
			def: Type.String({ pattern: "^[a-z]+$" }),
			value: "NOT LOWER",
			accepted: "lower",
			reason: /must match pattern "\^\[a-z\]\+\$"/,
		},
		{
			name: "format",
			def: Type.String({ format: "email" }),
			value: "not-an-email",
			accepted: "dev@example.com",
			reason: /must match format "email"/,
		},
	];

	for (const testCase of rejected) {
		test(`rejects a ${testCase.name} violation and names the constraint (#4849)`, () => {
			const errors = validateInputs(schema({ mode: testCase.def }), { mode: testCase.value });
			assert.equal(errors.length, 1);
			assert.equal(errors[0]!.key, "mode");
			assert.match(errors[0]!.reason, testCase.reason);
			assert.deepEqual(validateInputs(schema({ mode: testCase.def }), { mode: testCase.accepted }), []);
		});
	}

	test("keeps the type message for a non-string literal input (#4849)", () => {
		assert.deepEqual(validateInputs(schema({ mode: Type.Literal("fast") }), { mode: 3 }), [
			{ key: "mode", reason: "expected string, got number" },
		]);
	});

	test("resolveAndValidateInputs names the input and the constraint (#4849)", () => {
		assert.throws(
			() => resolveAndValidateInputs(schema({ slug: Type.String({ minLength: 3 }) }), { slug: "a" }, 'workflow "w"'),
			/invalid inputs for workflow "w":\n {2}- slug: must not have fewer than 3 characters \(minLength 3\)/,
		);
	});

	test("agrees with Value.Check for random strings against random string schemas (#4849)", () => {
		let seed = 4849;
		const next = (): number => {
			seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
			return seed / 2_147_483_648;
		};
		const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
		const alphabet = ["a", "b", "Z", "0", "9", " ", "-", "@", ".", "é", "😀"];
		const randomString = (): string => {
			const length = Math.floor(next() * 8);
			let text = "";
			for (let index = 0; index < length; index++) text += pick(alphabet);
			return text;
		};
		const randomSchema = (): WorkflowInputSchema => {
			if (next() < 0.2) return Type.Literal(randomString());
			const options: { minLength?: number; maxLength?: number; pattern?: string; format?: string } = {};
			if (next() < 0.5) options.minLength = Math.floor(next() * 5);
			if (next() < 0.5) options.maxLength = Math.floor(next() * 6);
			if (next() < 0.4) options.pattern = pick(["^[a-z]+$", "\\d", "^$", "^[^ ]*$", "Z"]);
			if (next() < 0.2) options.format = pick(["email", "uuid", "date"]);
			return Type.String(options);
		};
		let accepted = 0;
		let rejectedCount = 0;
		for (let iteration = 0; iteration < 2_000; iteration++) {
			const def = randomSchema();
			const value = randomString();
			const errors = validateInputs(schema({ field: def }), { field: value });
			const expected = Value.Check(def, value);
			assert.equal(errors.length === 0, expected, `${JSON.stringify(def)} vs ${JSON.stringify(value)}`);
			if (expected) accepted++;
			else rejectedCount++;
		}
		assert.ok(accepted > 100 && rejectedCount > 100, `accepted=${accepted} rejected=${rejectedCount}`);
	});

	const literalWorkflow = (onRun: () => void) =>
		workflow({
			name: "literal-demo",
			description: "",
			inputs: { mode: Type.Literal("fast"), slug: Type.String({ pattern: "^[a-z]+$" }) },
			outputs: {},
			run: async (ctx) => {
				onRun();
				await ctx.tool("echo", { mode: ctx.inputs.mode }, async () => ctx.inputs.slug);
				return {};
			},
		});

	test("run() rejects a literal or pattern violation before the body runs (#4849)", async () => {
		let bodyRan = false;
		const def = literalWorkflow(() => {
			bodyRan = true;
		});
		await assert.rejects(
			() => run(def, { mode: "slow", slug: "NOT LOWER" }, { store: createStore() }),
			/invalid inputs for workflow "literal-demo":\n {2}- mode: must equal "fast"\n {2}- slug: must match pattern/,
		);
		assert.equal(bodyRan, false);
		const ok = await run(def, { mode: "fast", slug: "ok" }, { store: createStore() });
		assert.equal(ok.status, "completed", ok.error);
		assert.equal(bodyRan, true);
	});

	test("a child workflow call rejects a maxLength violation before the child runs (#4849)", async () => {
		let childRan = false;
		const child = workflow({
			name: "short-child",
			description: "",
			inputs: { tag: Type.String({ maxLength: 4 }) },
			outputs: {},
			run: async (ctx) => {
				childRan = true;
				await ctx.tool("echo", {}, async () => ctx.inputs.tag);
				return {};
			},
		});
		const parent = workflow({
			name: "short-parent",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.workflow(child, { inputs: { tag: "too long" } });
				return {};
			},
		});
		const result = await run(parent, {}, { store: createStore() });
		assert.equal(result.status, "failed");
		assert.match(
			result.error ?? "",
			/invalid inputs for child workflow "short-child"[\s\S]*tag: must not have more than 4 characters \(maxLength 4\)/,
		);
		assert.equal(childRan, false);
	});
});

describe("inherited and prototype input keys are rejected (#4849)", () => {
	const optionalCount = schema({ count: Type.Optional(Type.Number()) });
	const unknownKey = "unknown input key (not declared by this workflow)";

	for (const key of ["constructor", "toString", "hasOwnProperty"]) {
		test(`rejects the inherited name "${key}" as an undeclared key (#4849)`, () => {
			assert.deepEqual(validateInputs(optionalCount, JSON.parse(`{"${key}":"x"}`)), [{ key, reason: unknownKey }]);
		});
	}

	test("rejects an own __proto__ key instead of letting it supply a declared input (#4849)", () => {
		const inputs = JSON.parse('{"__proto__":{"count":3}}');
		assert.deepEqual(validateInputs(optionalCount, inputs), [{ key: "__proto__", reason: unknownKey }]);
		assert.throws(
			() => resolveAndValidateInputs(optionalCount, inputs, 'workflow "w"'),
			/invalid inputs for workflow "w":\n {2}- __proto__: unknown input key/,
		);
	});

	test("rejects an own __proto__ key that carries an undeclared input (#4849)", () => {
		assert.throws(
			() => resolveAndValidateInputs(optionalCount, JSON.parse('{"__proto__":{"undeclared":"v"}}'), 'workflow "w"'),
			/- __proto__: unknown input key/,
		);
	});

	test("resolved inputs hold exactly the own keys a run reads and persists (#4849)", () => {
		const resolved = resolveAndValidateInputs(
			schema({ count: Type.Number({ default: 1 }) }),
			JSON.parse('{"count":2}'),
			'workflow "w"',
		);
		assert.deepEqual(resolved, { count: 2 });
		assert.deepEqual(JSON.parse(JSON.stringify(resolved)), resolved);
	});

	test("run() rejects a __proto__ input before the body runs (#4849)", async () => {
		let bodyRan = false;
		const def = workflow({
			name: "proto-demo",
			description: "",
			inputs: { count: Type.Optional(Type.Number()) },
			outputs: {},
			run: async (ctx) => {
				bodyRan = true;
				await ctx.tool("echo", {}, async () => String(ctx.inputs.count));
				return {};
			},
		});
		await assert.rejects(
			() => run(def, JSON.parse('{"__proto__":{"count":3}}'), { store: createStore() }),
			/invalid inputs for workflow "proto-demo":\n {2}- __proto__: unknown input key/,
		);
		assert.equal(bodyRan, false);
	});
});

describe("declared output defaults fill omitted outputs (#4849)", () => {
	const defaultedChild = workflow({
		name: "defaulted-output-child",
		description: "",
		inputs: {},
		outputs: { report: Type.String({ default: "fallback" }), note: Type.Optional(Type.String()) },
		run: async (ctx) => {
			await ctx.tool("noop", {}, async () => "done");
			return {} as { report: string };
		},
	});

	test("a run that omits a defaulted output completes with the default (#4849)", async () => {
		const result = await run(defaultedChild, {}, { store: createStore() });
		assert.equal(result.status, "completed", result.error);
		assert.deepEqual(result.result, { report: "fallback" });
	});

	const returning = (name: string, outputs: Record<string, WorkflowInputSchema>, value: object | undefined) =>
		workflow({
			name,
			description: "",
			inputs: {},
			outputs,
			run: async (ctx) => {
				await ctx.tool("noop", {}, async () => "done");
				return value as never;
			},
		});

	test("defaults fill a run that returns nothing, and a run without defaults keeps its own return (#4849)", async () => {
		const cases: ReadonlyArray<{
			readonly outputs: Record<string, WorkflowInputSchema>;
			readonly value: object | undefined;
			readonly expected: object | undefined;
		}> = [
			{
				outputs: { report: Type.String({ default: "fallback" }) },
				value: undefined,
				expected: { report: "fallback" },
			},
			{ outputs: { note: Type.Optional(Type.String()) }, value: undefined, expected: undefined },
			{ outputs: { note: Type.Optional(Type.String()) }, value: {}, expected: {} },
			{
				outputs: { report: Type.String({ default: "fallback" }) },
				value: { report: "own" },
				expected: { report: "own" },
			},
		];
		for (const [index, testCase] of cases.entries()) {
			const result = await run(
				returning(`defaults-case-${index}`, testCase.outputs, testCase.value),
				{},
				{
					store: createStore(),
				},
			);
			assert.equal(result.status, "completed", result.error);
			assert.deepEqual(result.result, testCase.expected, `case ${index}`);
		}
	});

	test("a parent receives the default of an output its child omitted (#4849)", async () => {
		const seen: unknown[] = [];
		const parent = workflow({
			name: "defaulted-output-parent",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				const child = await ctx.workflow(defaultedChild);
				seen.push(child.exited, child.outputs);
				return {};
			},
		});
		const result = await run(parent, {}, { store: createStore() });
		assert.equal(result.status, "completed", result.error);
		assert.deepEqual(seen, [false, { report: "fallback" }]);
	});
});
