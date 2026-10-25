import assert from "node:assert/strict";
import { Value } from "typebox/value";
import { test } from "vitest";
import {
	workflowSerializableObjectSchema,
	workflowSerializableObjectValidationError,
	workflowSerializableValidationError,
	workflowSerializableValueSchema,
} from "../../packages/workflows/src/shared/serializable.js";

/** Deterministic PRNG so a failing case reproduces. */
function random(seed: number) {
	let state = seed >>> 0;
	return () => {
		state = (state * 1664525 + 1013904223) >>> 0;
		return state / 2 ** 32;
	};
}

class Widget {
	readonly size = 1;
}

function generate(next: () => number, depth: number): unknown {
	const pick = Math.floor(next() * (depth > 3 ? 9 : 14));
	switch (pick) {
		case 0:
			return "text";
		case 1:
			return Math.floor(next() * 1000) - 500;
		case 2:
			return next() < 0.5;
		case 3:
			return null;
		case 4:
			return [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, undefined][Math.floor(next() * 4)];
		case 5:
			return [new Date(0), new Map(), new Widget(), /x/][Math.floor(next() * 4)];
		case 6:
			return Symbol("s");
		case 7:
			return () => undefined;
		case 8:
			return 1n;
		case 9:
		case 10: {
			const array = Array.from({ length: Math.floor(next() * 4) }, () => generate(next, depth + 1));
			if (next() < 0.1) array.length += 2;
			return array;
		}
		default: {
			const object: Record<string | symbol, unknown> = next() < 0.15 ? Object.create(null) : {};
			for (let index = 0; index < Math.floor(next() * 4); index++) object[`k${index}`] = generate(next, depth + 1);
			if (next() < 0.05) object[Symbol("hidden")] = 1;
			if (next() < 0.05) Object.defineProperty(object, "secret", { value: 1, enumerable: false });
			return object;
		}
	}
}

test("the fast serializable check agrees with the schema on random values", () => {
	const next = random(3929);
	for (let index = 0; index < 20_000; index++) {
		const value = generate(next, 0);
		assert.equal(
			workflowSerializableValidationError(value, "value") === undefined,
			Value.Check(workflowSerializableValueSchema, value),
			`value case ${index}`,
		);
		assert.equal(
			workflowSerializableObjectValidationError(value, "object") === undefined,
			Value.Check(workflowSerializableObjectSchema, value),
			`object case ${index}`,
		);
	}
});

test("shared references are accepted and cycles are rejected exactly as the schema decides", () => {
	const shared = { a: 1 };
	const dag = { left: shared, right: shared, list: [shared, shared] };
	assert.equal(workflowSerializableObjectValidationError(dag, "dag"), undefined);
	assert.equal(Value.Check(workflowSerializableObjectSchema, dag), true);
});

test("validation errors keep their wording and location", () => {
	assert.equal(
		workflowSerializableObjectValidationError({ nested: { when: new Date(0) } }, "payload"),
		"payload at nested must be a JSON-serializable (string, finite number, boolean, null, array, or object) object, got object",
	);
	assert.equal(
		workflowSerializableValidationError([1, Number.NaN], "items"),
		"items must be JSON-serializable (string, finite number, boolean, null, array, or object), got array",
	);
});

test("a transcript-sized payload validates in a small fraction of the schema's time", () => {
	const entries = Array.from({ length: 40 }, (_, index) => ({
		type: "message",
		id: `entry-${index}`,
		message: {
			role: index % 2 === 0 ? "assistant" : "toolResult",
			content: [{ type: "text", text: "x".repeat(2_500) }],
			usage: { input: 1, output: 2, cacheRead: 3 },
			timestamp: index,
		},
	}));
	const mutation = { epoch: 1, worker: "w", mutation: { kind: "session-append", sessionId: "s", entries } };
	const time = (check: () => void) => {
		const started = performance.now();
		for (let round = 0; round < 50; round++) check();
		return performance.now() - started;
	};
	const schema = time(() => Value.Check(workflowSerializableObjectSchema, mutation));
	const fast = time(() => workflowSerializableObjectValidationError(mutation, "mutation"));
	assert.ok(fast * 10 < schema, `fast path ${fast.toFixed(1)} ms vs schema ${schema.toFixed(1)} ms`);
});
