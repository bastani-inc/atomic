import type { Api, Model } from "@earendil-works/pi-ai";
import { expect, test } from "vitest";
import { InMemoryCodingAgentModelsStore } from "../src/core/models-store.ts";

const model = {
	id: "seed",
	name: "Seed",
	api: "openai-completions",
	provider: "snapshot-provider",
	baseUrl: "https://example.test/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 4096,
	maxTokens: 1024,
} as Model<Api>;

test("in-memory model store reads return isolated snapshots", async () => {
	const store = new InMemoryCodingAgentModelsStore();
	await store.write("snapshot-provider", { models: [model], checkedAt: 1 });
	const snapshot = await store.read("snapshot-provider");
	(snapshot as { checkedAt?: number }).checkedAt = 2;
	(snapshot!.models[0] as { id: string }).id = "mutated-without-write";

	const persisted = await store.read("snapshot-provider");
	expect(persisted?.checkedAt).toBe(1);
	expect(persisted?.models[0]?.id).toBe("seed");
});
