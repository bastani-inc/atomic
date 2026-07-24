import { describe, expect, test } from "vitest";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { describeModelRegistry } from "./model-registry-fixtures.ts";

describeModelRegistry((context) => {
	describe("provider membership", () => {
		test("tracks exact provider membership independently from authentication and model materialization", () => {
			context.writeRawModelsJson({
				"configured-provider": context.providerConfig(
					"https://configured.test/v1",
					[{ id: "configured-model" }],
					"openai-completions",
				),
			});
			context.authStorage.setRuntimeApiKey("stale-auth-only", "stale-token");
			const registry = ModelRegistry.create(context.authStorage, context.modelsJsonPath);

			expect(registry.hasProvider("openai")).toBe(true);
			expect(registry.hasProvider("OpenAI")).toBe(false);
			expect(registry.hasProvider("configured-provider")).toBe(true);
			expect(registry.hasProvider("stale-auth-only")).toBe(false);

			registry.registerProvider("extension-without-models", {
				api: "openai-completions",
				streamSimple: () => {
					throw new Error("not called");
				},
			});
			expect(registry.hasProvider("extension-without-models")).toBe(true);
			registry.unregisterProvider("extension-without-models");
			expect(registry.hasProvider("extension-without-models")).toBe(false);

			const anthropic = registry.getProvider("anthropic");
			if (!anthropic) throw new Error("missing built-in provider fixture");
			registry.registerProvider({ ...anthropic, id: "native-member" });
			expect(registry.hasProvider("native-member")).toBe(true);
			registry.unregisterProvider("native-member");
			expect(registry.hasProvider("native-member")).toBe(false);
			expect(registry.hasProvider("anthropic")).toBe(true);
		});
	});
});
