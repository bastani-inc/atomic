import assert from "node:assert/strict";
import type { Api, AssistantMessage, JsonObject, Model, SimpleStreamOptions } from "@bastani/pi-ai";
import { Type } from "typebox";
import { test, vi } from "vitest";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import { generateStructuredOutput, routeModel } from "../../packages/coding-agent/src/core/structured-output/index.js";
import { decisionMessage, decisionModel, messageStream } from "../helpers/structured-output.js";

const FORMER_FIXED_CAP = 4096;
const CHARS_PER_TOKEN = 4;
const ITEM_COUNT = 150;

const largeModel: Model<Api> = { ...decisionModel, id: "large-output", contextWindow: 200_000, maxTokens: 64_000 };

const inventorySchema = Type.Object(
	{
		items: Type.Array(
			Type.Object(
				{
					id: Type.String(),
					title: Type.String(),
					summary: Type.String(),
					owner: Type.String(),
					status: Type.Union([Type.Literal("open"), Type.Literal("done")]),
				},
				{ additionalProperties: false },
			),
			{ minItems: ITEM_COUNT, maxItems: ITEM_COUNT },
		),
	},
	{ additionalProperties: false },
);

const inventory: JsonObject = {
	items: Array.from({ length: ITEM_COUNT }, (_, index) => ({
		id: `item-${index}`,
		title: `Inventory entry ${index} for the migration plan`,
		summary: `Entry ${index} records the module, its callers, the planned change and the verification that proves it.`,
		owner: `team-${index % 7}`,
		status: index % 2 === 0 ? "open" : "done",
	})),
};

function estimatedOutputTokens(value: JsonObject): number {
	return Math.ceil(JSON.stringify(value).length / CHARS_PER_TOKEN);
}

function truncatedMessage(): AssistantMessage {
	return { ...decisionMessage(), content: [], stopReason: "length" };
}

function outputLimitedProvider(result: JsonObject) {
	return vi.fn((model: Model<Api>, _context: unknown, options?: SimpleStreamOptions) => {
		const limit = options?.maxTokens ?? model.maxTokens;
		return messageStream(estimatedOutputTokens(result) > limit ? truncatedMessage() : decisionMessage(result));
	});
}

function largeRequest(dispatch: ReturnType<typeof outputLimitedProvider>) {
	return {
		modelRegistry: { getAll: () => [largeModel], streamSimple: dispatch },
		currentModel: largeModel,
		state: { task: `List all ${ITEM_COUNT} inventory entries with every field.` },
		instructions: "Return the complete inventory. Do not omit or shorten entries.",
		schema: inventorySchema,
		retry: { enabled: false, maxRetries: 0, baseDelayMs: 1 },
	};
}

test("structured output returns a result far above the former 4096-token cap in full (#3309)", async () => {
	assert.ok(estimatedOutputTokens(inventory) > FORMER_FIXED_CAP * 1.5);
	const dispatch = outputLimitedProvider(inventory);
	const request = largeRequest(dispatch);

	const result = await generateStructuredOutput(request);

	assert.deepEqual(result.value, inventory);
	assert.equal(dispatch.mock.calls.length, 1);
	assert.equal(dispatch.mock.calls[0][2]?.maxTokens, undefined);
});

test("router decisions apply no fixed output-token cap (#3309)", async () => {
	const dispatch = outputLimitedProvider(inventory);

	const result = await routeModel({
		...largeRequest(dispatch),
		settings: SettingsManager.inMemory({ routerModel: `${largeModel.provider}/${largeModel.id}` }),
		classifier: {
			questions: {},
			decode: () => {
				throw new Error("Chat decisions do not decode Choice answers.");
			},
		},
	});

	assert.deepEqual(result.value, inventory);
	assert.equal(dispatch.mock.calls[0][2]?.maxTokens, undefined);
});

test("an explicit maxTokens override is forwarded to the provider (#3309)", async () => {
	const dispatch = outputLimitedProvider(inventory);
	const request = largeRequest(dispatch);

	await assert.rejects(generateStructuredOutput({ ...request, maxTokens: FORMER_FIXED_CAP }), /repair exhausted/);

	assert.ok(dispatch.mock.calls.length > 0);
	for (const call of dispatch.mock.calls) assert.equal(call[2]?.maxTokens, FORMER_FIXED_CAP);
});

for (const maxTokens of [0, -1, 0.5, Number.POSITIVE_INFINITY, Number.NaN, 2 ** 31]) {
	test(`structured output rejects invalid explicit maxTokens ${maxTokens} before inference (#3309)`, async () => {
		const dispatch = outputLimitedProvider(inventory);
		const request = largeRequest(dispatch);

		await assert.rejects(generateStructuredOutput({ ...request, maxTokens }), /maxTokens/);

		assert.equal(dispatch.mock.calls.length, 0);
	});
}
