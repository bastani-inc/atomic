import { type Api, getApiProvider, registerApiProvider, unregisterApiProviders } from "@earendil-works/pi-ai/compat";
import { getOAuthProvider } from "../src/core/oauth-provider-bridge.ts";
import { describe, expect, test } from "vitest";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { describeModelRegistry } from "./model-registry-fixtures.ts";

describeModelRegistry((context) => {
	const { openAiModel, emptyContext } = context;

	describe("dynamic provider lifecycle", () => {
		describe("dynamic provider override persistence", () => {
			test("one registry cannot erase another registry's API or OAuth registrations", async () => {
				const first = ModelRegistry.create(context.authStorage, context.modelsJsonPath);
				const second = ModelRegistry.create(context.authStorage, context.modelsJsonPath);
				const api = "registry-isolation-api" as Api;
				const oauth = (name: string) => ({
					name,
					login: async () => ({ refresh: "r", access: "a", expires: 1 }),
					refreshToken: async () => ({ refresh: "r", access: "a", expires: 2 }),
					getApiKey: () => name,
				});
				first.registerProvider("registry-isolation", {
					api,
					oauth: oauth("first"),
					streamSimple: () => { throw new Error("first"); },
				});
				second.registerProvider("registry-isolation", {
					api,
					oauth: oauth("second"),
					streamSimple: () => { throw new Error("second"); },
				});
				const secondApi = getApiProvider(api);
				await first.refresh({ allowNetwork: false });
				expect(getApiProvider(api)).toBe(secondApi);
				expect(getOAuthProvider("registry-isolation")?.name).toBe("second");

				first.unregisterProvider("registry-isolation");

				expect(getApiProvider(api)).toBe(secondApi);
				expect(getOAuthProvider("registry-isolation")?.name).toBe("second");
				second.unregisterProvider("registry-isolation");
				expect(getApiProvider(api)).toBeUndefined();
			});

			test("unregistering the latest registry restores the previous API owner", () => {
				const first = ModelRegistry.create(context.authStorage, context.modelsJsonPath);
				const second = ModelRegistry.create(context.authStorage, context.modelsJsonPath);
				const api = "registry-fallback-api" as Api;
				first.registerProvider("registry-first", {
					api,
					streamSimple: () => { throw new Error("first-owner"); },
				});
				second.registerProvider("registry-second", {
					api,
					streamSimple: () => { throw new Error("second-owner"); },
				});

				second.unregisterProvider("registry-second");

				expect(() => getApiProvider(api)?.streamSimple({ ...openAiModel, api }, emptyContext)).toThrow("first-owner");
				first.unregisterProvider("registry-first");
			});

			test("unregistering an Atomic override restores an external API owner", () => {
				const registry = ModelRegistry.create(context.authStorage, context.modelsJsonPath);
				const api = "external-fallback-api" as Api;
				registerApiProvider({
					api,
					stream: () => { throw new Error("external-owner"); },
					streamSimple: () => { throw new Error("external-owner"); },
				}, "external-owner");
				registry.registerProvider("atomic-override", {
					api,
					streamSimple: () => { throw new Error("atomic-owner"); },
				});

				registry.unregisterProvider("atomic-override");

				expect(() => getApiProvider(api)?.streamSimple({ ...openAiModel, api }, emptyContext)).toThrow("external-owner");
				unregisterApiProviders(`atomic:restored-api:${api}`);
				unregisterApiProviders("external-owner");
			});
		});
	});
});
