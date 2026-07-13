import { test } from "bun:test";
import assert from "node:assert/strict";
import type { Api, Model, ThinkingLevel } from "@earendil-works/pi-ai/compat";
import { mapCursorCatalogToProviderModels } from "../../packages/cursor/src/model-mapper.js";
import { CursorStreamAdapter } from "../../packages/cursor/src/stream.js";
import { authenticatedFable5Model } from "./cursor-fable-test-fixture.js";
import { collectEvents, context } from "./cursor-stream-helpers.js";
import { CursorMockTransport } from "./cursor-test-helpers.js";

const cases: ReadonlyArray<{
	readonly rowId: string;
	readonly level: ThinkingLevel;
	readonly effort: string;
	readonly thinking: string;
}> = [
	{ rowId: "claude-fable-5-1m-max", level: "low", effort: "low", thinking: "false" },
	{ rowId: "claude-fable-5-1m-max", level: "max", effort: "max", thinking: "false" },
	{ rowId: "claude-fable-5-1m-max-thinking", level: "high", effort: "high", thinking: "true" },
	{ rowId: "claude-fable-5-1m-max-thinking", level: "low", effort: "low", thinking: "true" },
];

test("canonical Fable rows route only exact complete advertised tuples", async () => {
	const definitions = mapCursorCatalogToProviderModels({ source: "live", fetchedAt: 1, models: [authenticatedFable5Model()] });
	for (const [index, entry] of cases.entries()) {
		const definition = definitions.find((model) => model.id === entry.rowId);
		assert.ok(definition);
		const model = { ...definition, provider: "cursor" } as Model<Api>;
		const transport = new CursorMockTransport({ messages: [{ type: "done", reason: "stop" }] });
		const adapter = new CursorStreamAdapter({ transport, uuid: () => `fable-route-${index}` });
		await collectEvents(adapter.streamSimple(model, context(), { apiKey: "access-secret", reasoning: entry.level }));
		const request = transport.runs[0]?.request;
		assert.equal(request?.requestedModelId, "claude-fable-5");
		assert.equal(request?.requestedMaxMode, true);
		assert.deepEqual(request?.modelParameters, [
			{ id: "thinking", value: entry.thinking },
			{ id: "context", value: "1m" },
			{ id: "effort", value: entry.effort },
		]);
	}
});
