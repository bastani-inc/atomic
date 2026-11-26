import type { ConverseStreamCommand } from "@aws-sdk/client-bedrock-runtime";
import { describe, expect, it, vi } from "vitest";
import { getFixtureModel } from "../../../test/helpers/catalog-model-fixtures.ts";

// Include incomplete service metadata to exercise missing-count handling.
const state = vi.hoisted(() => ({ details: undefined as { ttl?: string; inputTokens?: number }[] | undefined }));

vi.mock("@aws-sdk/client-bedrock-runtime", async (importOriginal) => {
	const sdk = await importOriginal<typeof import("@aws-sdk/client-bedrock-runtime")>();
	return {
		...sdk,
		BedrockRuntimeClient: class {
			middlewareStack = { add: () => undefined };
			async send(_command: ConverseStreamCommand) {
				return {
					$metadata: { httpStatusCode: 200 },
					stream: (async function* () {
						yield { messageStart: { role: "assistant" } };
						yield {
							metadata: {
								usage: {
									inputTokens: 100,
									outputTokens: 5,
									totalTokens: 1_000_105,
									cacheWriteInputTokens: 1_000_000,
									cacheDetails: state.details,
								},
							},
						};
						yield { messageStop: { stopReason: "end_turn" } };
					})(),
				};
			}
		},
	};
});

import { stream as streamBedrock } from "../src/api/bedrock-converse-stream.ts";
import { normalizeContext } from "../src/compat.ts";

const model = getFixtureModel("amazon-bedrock", "us.anthropic.claude-opus-4-8");

describe("Bedrock 1h cache write cost", () => {
	it.each([
		{
			name: "mixed durations",
			details: [
				{ ttl: "1h", inputTokens: 150_000 },
				{ ttl: "5m", inputTokens: 600_000 },
				{ ttl: "1h", inputTokens: 250_000 },
			],
			long: 400_000,
		},
		{ name: "absent details", details: undefined, long: undefined },
		{ name: "empty details", details: [], long: 0 },
		{
			name: "missing counts and other TTLs",
			details: [{ ttl: "1h" }, { ttl: "5m", inputTokens: 900_000 }, { inputTokens: 100_000 }],
			long: 0,
		},
	])("prices $name while preserving aggregate writes", async ({ details, long }) => {
		// Regression for upstream #9457; use generated model rates, not a second price table.
		state.details = details;
		const result = await streamBedrock(
			model,
			normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] }),
			{ cacheRetention: "none" },
		).result();
		expect(result.stopReason).toBe("stop");
		expect(result.usage.cacheWrite).toBe(1_000_000);
		expect(result.usage.cacheWrite1h).toBe(long);
		const expected =
			((1_000_000 - (long ?? 0)) * model.cost.cacheWrite + (long ?? 0) * model.cost.input * 2) / 1_000_000;
		expect(result.usage.cost.cacheWrite).toBeCloseTo(expected, 10);
	});
});
