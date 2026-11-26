import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model, Provider } from "@bastani/atomic-ai";
import { stream } from "@bastani/atomic-ai/api/anthropic-messages";
import { test } from "vitest";
import { getFixtureModel } from "../../../test/helpers/catalog-model-fixtures.ts";
import { ModelConfig } from "../src/core/model-config.ts";
import { composeModelProvider } from "../src/core/provider-composer.ts";

const cost = { input: 7, output: 11, cacheRead: 1, cacheWrite: 9 };
const configured = [
	{ provider: "anthropic", model: "fallback-one", cost },
	{ provider: "anthropic", model: "fallback-two", cost },
];

test("models.json fallbacks replace catalog defaults, reach the HTTP request and price the serving model; [] disables", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-fallback-runtime-"));
	try {
		const generated = getFixtureModel("anthropic", "claude-fable-5-1");
		assert.ok(generated.compat?.allowedFallbackModels?.length);
		const base: Provider = {
			id: "anthropic",
			name: "Anthropic",
			auth: { apiKey: { name: "test", check: async () => undefined, login: async () => undefined } },
			getModels: () => [generated],
			stream: () => {
				throw new Error("unused");
			},
			streamSimple: () => {
				throw new Error("unused");
			},
		};
		for (const level of ["provider", "model", "override"] as const) {
			for (const fallbacks of [configured, []]) {
				const compat = { allowedFallbackModels: fallbacks };
				const settings =
					level === "provider"
						? { compat }
						: level === "model"
							? { models: [{ id: generated.id, compat }] }
							: { modelOverrides: { [generated.id]: { compat } } };
				const file = join(root, "models.json");
				writeFileSync(file, JSON.stringify({ providers: { anthropic: settings } }));
				const config = await ModelConfig.load(file);
				assert.equal(config.getError(), undefined);
				const model = composeModelProvider(
					"anthropic",
					base,
					config,
					undefined,
				).getModels()[0] as Model<"anthropic-messages">;
				assert.deepEqual(model.compat?.allowedFallbackModels, fallbacks);
				let requestCount = 0;
				const serving = fallbacks.length ? "fallback-two" : generated.id;
				const result = await stream(
					model,
					{ messages: [{ role: "user", content: "hello", timestamp: 0 }] },
					{
						apiKey: "test-key",
						fetch: async (input, init) => {
							requestCount++;
							const request = new Request(input, init);
							const body = (await request.json()) as { fallbacks?: { model: string }[] };
							assert.deepEqual(
								body.fallbacks,
								fallbacks.length ? fallbacks.map(({ model: id }) => ({ model: id })) : undefined,
							);
							assert.equal(
								request.headers.get("anthropic-beta")?.includes("server-side-fallback-2026-07-01") ?? false,
								fallbacks.length > 0,
							);
							const events = [
								{
									type: "message_start",
									message: { id: "msg_test", model: serving, usage: { input_tokens: 100, output_tokens: 0 } },
								},
								{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 10 } },
								{ type: "message_stop" },
							];
							return new Response(
								events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
								{ headers: { "content-type": "text/event-stream" } },
							);
						},
					},
				).result();
				assert.equal(requestCount, 1);
				assert.equal(result.stopReason, "stop", result.errorMessage);
				assert.equal(result.model, generated.id);
				assert.equal(result.responseModel, fallbacks.length ? serving : undefined);
				if (fallbacks.length) {
					assert.ok(Math.abs(result.usage.cost.input - (100 * cost.input) / 1_000_000) < 1e-12);
					assert.ok(Math.abs(result.usage.cost.output - (10 * cost.output) / 1_000_000) < 1e-12);
				}
			}
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
