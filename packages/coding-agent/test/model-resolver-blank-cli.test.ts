import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { expect, test } from "vitest";
import type { ModelRegistry } from "../src/core/model-registry.ts";
import { resolveCliModel } from "../src/core/model-resolver.ts";

const blankCursor = {
	provider: "cursor",
	id: "",
	name: "Blank Cursor route",
	api: "cursor-agent",
	baseUrl: "https://api2.cursor.sh",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 64_000,
	compat: { cursorRouting: { "": { modelId: "", maxMode: false, supportsImages: false, catalogOccurrence: 0 } } },
} as Model<Api>;

test("resolveCliModel preserves an explicit blank model id for an exact provider", () => {
	const result = resolveCliModel({
		cliProvider: "cursor",
		cliModel: "",
		modelRegistry: { getAll: () => [blankCursor] } as ModelRegistry,
	});
	expect(result.error).toBeUndefined();
	expect(result.model).toBe(blankCursor);
});
