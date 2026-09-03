import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model, Provider } from "@bastani/pi-ai";
import { describe, expect, it } from "vitest";
import { ModelConfig } from "../src/core/model-config.ts";
import { composeModelProvider } from "../src/core/provider-composer.ts";

function model(id: string, api: Api, baseUrl: string): Model<Api> {
	return {
		id,
		name: id,
		api,
		provider: "mixed",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
}

describe("provider composer API-specific defaults", () => {
	it("uses defaults from the requested API for a custom model", async () => {
		const anthropic = model("anthropic-default", "anthropic-messages", "https://anthropic.test");
		const completions = model("completions-default", "openai-completions", "https://completions.test/v1");
		const base: Provider = {
			id: "mixed",
			name: "Mixed",
			auth: { apiKey: { name: "Mixed", check: async () => undefined, login: async () => undefined } },
			getModels: () => [anthropic, completions],
			stream: () => {
				throw new Error("unused");
			},
			streamSimple: () => {
				throw new Error("unused");
			},
		};
		const provider = composeModelProvider("mixed", base, await ModelConfig.load(undefined), {
			models: [{ id: "custom", api: "openai-completions" }],
		});

		expect(provider.getModels()).toEqual([
			expect.objectContaining({ id: "custom", api: "openai-completions", baseUrl: "https://completions.test/v1" }),
		]);
	});

	it("accepts both per-turn effort and Atomic binding compatibility flags", async () => {
		const root = mkdtempSync(join(tmpdir(), "atomic-model-config-"));
		const path = join(root, "models.json");
		try {
			writeFileSync(
				path,
				JSON.stringify({
					providers: {
						custom: {
							baseUrl: "https://custom.test",
							apiKey: "key",
							api: "anthropic-messages",
							compat: { supportsMidConvoEffort: true, enforcesPreservedThinkingBinding: true },
						},
					},
				}),
			);
			const config = await ModelConfig.load(path);
			expect(config.getError()).toBeUndefined();
			expect(config.getProvider("custom")?.compat).toEqual({
				supportsMidConvoEffort: true,
				enforcesPreservedThinkingBinding: true,
			});
		} finally {
			rmSync(root, { force: true, recursive: true });
		}
	});
});
