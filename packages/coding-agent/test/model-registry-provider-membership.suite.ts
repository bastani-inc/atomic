import { describe, expect, test } from "vitest";
import { describeModelRegistry } from "./model-registry-fixtures.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";

describeModelRegistry((context) => {
	describe("provider membership", () => {
		test("tracks exact provider membership independently from authentication and model materialization", async () => {
			context.writeRawModelsJson({
				"configured-provider": context.providerConfig(
					"https://configured.test/v1",
					[{ id: "configured-model" }],
					"openai-completions",
				),
			});
			await context.authStorage.modify("stale-auth-only", async () => ({ type: "api_key", key: "stale-token" }));
			const registry = await createModelRegistry(context.authStorage, context.modelsJsonPath);
			const runtime = getModelRuntime(registry);

			expect(runtime.getProvider("openai") !== undefined).toBe(true);
			expect(runtime.getProvider("OpenAI") !== undefined).toBe(false);
			expect(runtime.getProvider("configured-provider") !== undefined).toBe(true);
			expect(runtime.getProvider("stale-auth-only") !== undefined).toBe(false);

			registry.registerProvider("extension-without-models", {
				api: "openai-completions",
				streamSimple: () => {
					throw new Error("not called");
				},
			});
			expect(runtime.getProvider("extension-without-models") !== undefined).toBe(true);
			registry.unregisterProvider("extension-without-models");
			expect(runtime.getProvider("extension-without-models") !== undefined).toBe(false);

			const anthropic = registry.getProvider("anthropic");
			if (!anthropic) throw new Error("missing built-in provider fixture");
			registry.registerProvider({ ...anthropic, id: "native-member" });
			expect(runtime.getProvider("native-member") !== undefined).toBe(true);
			registry.unregisterProvider("native-member");
			expect(runtime.getProvider("native-member") !== undefined).toBe(false);
			expect(runtime.getProvider("anthropic") !== undefined).toBe(true);
		});
	});
});
