import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { test } from "vitest";
import { cloneInspectionPayload } from "../../packages/workflows/src/shared/inspection-payload.js";

const inputs: Array<{ name: string; value: object }> = [
	{
		name: "ordinary values",
		value: { text: "value", count: 7, enabled: true, nothing: null, nested: { values: [1, "two", false] } },
	},
	{
		name: "omitted fields and sparse arrays",
		value: {
			missing: undefined,
			method: () => 1,
			symbol: Symbol("hidden"),
			sparse: Object.assign(new Array<symbol | undefined | (() => number)>(4), {
				0: undefined,
				2: () => 1,
				3: Symbol("hidden"),
			}),
		},
	},
	{ name: "numeric edge values", value: { negativeZero: -0, nan: Number.NaN, infinity: Number.POSITIVE_INFINITY } },
	{
		name: "dates and binary inputs",
		value: {
			date: new Date("2026-01-01T00:00:00.000Z"),
			invalid: new Date(Number.NaN),
			bytes: Buffer.from([1, 2, 255]),
			typed: new Uint8Array([5, 6]),
		},
	},
	{
		name: "boxed values from another context",
		value: runInNewContext(
			"({ number: new Number(7), string: new String('text'), boolean: new Boolean(false) })",
		) as object,
	},
	{
		name: "custom conversions",
		value: {
			item: { toJSON: (key: string) => ({ key, value: 3 }) },
			fn: Object.assign(() => 1, { toJSON: () => "converted" }),
		},
	},
	{ name: "prototype keys", value: JSON.parse('{"__proto__":{"safe":true},"constructor":4}') as object },
	{ name: "maps and sets", value: { map: new Map([["key", 1]]), set: new Set([1]) } },
	{
		name: "opaque prototype trap",
		value: {
			input: new Proxy(
				{ key: "value" },
				{
					getPrototypeOf() {
						throw new Error("prototype must not affect data");
					},
				},
			),
		},
	},
];

for (const { name, value } of inputs) {
	test(`inspection preserves legacy JSON values for ${name} (#5234)`, () => {
		const expected = JSON.stringify(value);
		const copied = cloneInspectionPayload(value);
		assert.equal(JSON.stringify(copied), expected);
		assert.deepEqual(copied, JSON.parse(expected));
	});
}

test("inspection rejects circular and bigint inputs like the existing JSON snapshot (#5234)", () => {
	const circular: { self?: object } = {};
	circular.self = circular;
	for (const value of [circular, { value: 1n }, { value: Object(1n) }]) {
		assert.throws(() => JSON.stringify(value), TypeError);
		assert.throws(() => cloneInspectionPayload(value), TypeError);
	}
});
