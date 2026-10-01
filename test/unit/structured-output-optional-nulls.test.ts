import assert from "node:assert/strict";
import type { JsonObject } from "@bastani/pi-ai";
import { type TSchema, Type } from "typebox";
import { test, vi } from "vitest";
import { generateStructuredOutput } from "../../packages/coding-agent/src/core/structured-output/index.js";
import { decisionMessage, decisionModel, messageStream } from "../helpers/structured-output.js";

const REPAIR_ATTEMPTS = 4;

function deepFreeze<T>(value: T): T {
	if (typeof value === "object" && value !== null) {
		for (const child of Object.values(value)) deepFreeze(child);
		Object.freeze(value);
	}
	return value;
}

function requestFor<T extends TSchema>(schema: T, response: JsonObject) {
	const streamSimple = vi.fn(() => messageStream(decisionMessage(response)));
	return {
		streamSimple,
		request: {
			model: "decision-test/chat",
			modelRegistry: { getAll: () => [decisionModel], streamSimple },
			schema,
			state: { task: "Report the stage result" },
			instructions: "Report the stage result.",
		},
	};
}

const stageSchema = Type.Object(
	{
		status: Type.Union([Type.Literal("succeeded"), Type.Literal("blocked")]),
		summary: Type.String(),
		base_sha: Type.Optional(Type.String({ pattern: "^[0-9a-f]{40}$" })),
	},
	{ additionalProperties: false },
);

test("strict-provider null placeholder for an omitted optional property is dropped from the accepted value", async () => {
	const response = { status: "blocked", summary: "Held for CI.", base_sha: null };
	const { request, streamSimple } = requestFor(deepFreeze(structuredClone(stageSchema)), response);

	const result = await generateStructuredOutput(request);

	assert.deepEqual(result.value, { status: "blocked", summary: "Held for CI." });
	assert.equal(Object.hasOwn(result.value, "base_sha"), false);
	assert.equal(streamSimple.mock.calls.length, 1);
	assert.deepEqual(response, { status: "blocked", summary: "Held for CI.", base_sha: null });
});

test("optional property that explicitly allows null keeps its null", async () => {
	const schema = Type.Object(
		{
			summary: Type.String(),
			base_sha: Type.Optional(Type.Union([Type.String(), Type.Null()])),
			note: Type.Optional(Type.Null()),
		},
		{ additionalProperties: false },
	);
	const { request } = requestFor(schema, { summary: "Held.", base_sha: null, note: null });

	const result = await generateStructuredOutput(request);

	assert.deepEqual(result.value, { summary: "Held.", base_sha: null, note: null });
});

test("required nullable property keeps its null", async () => {
	const schema = Type.Object({ base_sha: Type.Union([Type.String(), Type.Null()]) });
	const { request } = requestFor(schema, { base_sha: null });

	const result = await generateStructuredOutput(request);

	assert.deepEqual(result.value, { base_sha: null });
});

test("required non-nullable property returned as null still fails after repairs", async () => {
	const { request, streamSimple } = requestFor(stageSchema, { status: "blocked", summary: null, base_sha: null });

	await assert.rejects(generateStructuredOutput(request), /does not match the decision schema/);

	assert.equal(streamSimple.mock.calls.length, REPAIR_ATTEMPTS);
});

test("optional property returned as a value of the wrong type still fails", async () => {
	const { request } = requestFor(stageSchema, { status: "blocked", summary: "Held.", base_sha: "not-a-sha" });

	await assert.rejects(generateStructuredOutput(request), /does not match the decision schema/);
});

test("null placeholders are dropped from nested objects and array item objects", async () => {
	const schema = Type.Object(
		{
			verdict: Type.Object({
				label: Type.String(),
				detail: Type.Optional(Type.String()),
				meta: Type.Optional(Type.Object({ id: Type.String() })),
			}),
			findings: Type.Array(
				Type.Object({
					file: Type.String(),
					line: Type.Optional(Type.Integer()),
					suggestion: Type.Optional(Type.Union([Type.String(), Type.Null()])),
				}),
			),
			extra: Type.Optional(Type.Array(Type.String())),
		},
		{ additionalProperties: false },
	);
	const { request } = requestFor(schema, {
		verdict: { label: "ok", detail: null, meta: null },
		findings: [
			{ file: "a.ts", line: null, suggestion: null },
			{ file: "b.ts", line: 4, suggestion: "rename" },
		],
		extra: null,
	});

	const result = await generateStructuredOutput(request);

	assert.deepEqual(result.value, {
		verdict: { label: "ok" },
		findings: [
			{ file: "a.ts", suggestion: null },
			{ file: "b.ts", line: 4, suggestion: "rename" },
		],
	});
});

test("optional property with a scalar union drops its null placeholder", async () => {
	const schema = Type.Object({ limit: Type.Optional(Type.Union([Type.String(), Type.Number()])) });
	const { request } = requestFor(schema, { limit: null });

	const result = await generateStructuredOutput(request);

	assert.deepEqual(result.value, {});
});

test("nulls that no optional property authorizes are not normalized away", async () => {
	const cases: Array<{ name: string; schema: TSchema; response: JsonObject }> = [
		{
			name: "null array item of a non-nullable item schema",
			schema: Type.Object({ tags: Type.Array(Type.String()) }),
			response: { tags: ["a", null] },
		},
		{
			name: "null value under schema-valued additionalProperties",
			schema: Type.Object({}, { additionalProperties: Type.String() }),
			response: { extra: null },
		},
		{
			name: "null in a required property nested next to an optional null placeholder",
			schema: Type.Object({
				items: Type.Array(Type.Object({ name: Type.String(), note: Type.Optional(Type.String()) })),
			}),
			response: { items: [{ name: null, note: null }] },
		},
		{
			name: "null in an undeclared property of a closed object",
			schema: Type.Object({ ok: Type.Boolean() }, { additionalProperties: false }),
			response: { ok: true, extra: null },
		},
	];
	for (const { name, schema, response } of cases) {
		const { request } = requestFor(schema, response);
		await assert.rejects(generateStructuredOutput(request), /does not match the decision schema/, name);
	}
});

test("nulls in properties outside the declared object properties are left untouched", async () => {
	const schema = Type.Union([
		Type.Object({ kind: Type.Literal("a"), x: Type.Optional(Type.String()) }),
		Type.Object({ kind: Type.Literal("b"), y: Type.Optional(Type.String()) }),
	]);
	const { request } = requestFor(schema, { kind: "a", y: null });

	const result = await generateStructuredOutput(request);

	assert.deepEqual(result.value, { kind: "a", y: null });
});
