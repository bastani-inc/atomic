import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { ModelConfig } from "../src/core/model-config.js";
import { describeModelRegistry } from "./model-registry-fixtures.js";
import { createInMemoryModelRegistry, createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.js";

describeModelRegistry((context) => {
	describe("extension catalog credential resolution", () => {
		test("resolves configured environment-backed API keys", async () => {
			const envVarName = "ATOMIC_EXTENSION_CATALOG_KEY";
			const original = process.env[envVarName];
			process.env[envVarName] = "environment-catalog-key";
			try {
				const registry = await createModelRegistry(context.authStorage, context.modelsJsonPath);
				let observedKey: string | undefined;
				registry.registerProvider("environment-catalog", {
					apiKey: `$${envVarName}`,
					refreshModels: async ({ credential }) => {
						if (credential?.type === "api_key") observedKey = credential.key;
						return [];
					},
				});

				let result = await registry.refresh();
				// registerProvider starts a cache-only refresh in the background. Under full-suite
				// contention it can supersede the first explicit pass before its network phase;
				// retry the caller-owned operation once in that case.
				if (observedKey === undefined) result = await registry.refresh();
				expect(result.errors.size).toBe(0);
				expect(observedKey).toBe("environment-catalog-key");
			} finally {
				if (original === undefined) delete process.env[envVarName];
				else process.env[envVarName] = original;
			}
		});

		test("resolves configured command-backed API keys", async () => {
			const tokenFile = join(context.tempDir, "catalog-token");
			writeFileSync(tokenFile, "command-catalog-key");
			const registry = await createModelRegistry(context.authStorage, context.modelsJsonPath);
			let observedKey: string | undefined;
			registry.registerProvider("command-catalog", {
				apiKey: `!sh -c 'cat "${context.toShPath(tokenFile)}"'`,
				refreshModels: async ({ credential }) => {
					if (credential?.type === "api_key") observedKey = credential.key;
					return [];
				},
			});

			let result = await registry.refresh();
			// registerProvider starts a cache-only refresh in the background. Under full-suite
			// contention it can supersede the first explicit pass before its network phase;
			// retry the caller-owned operation once in that case.
			if (observedKey === undefined) result = await registry.refresh();
			expect(result.errors.size).toBe(0);
			expect(observedKey).toBe("command-catalog-key");
		});

		test("does not let a delayed registration refresh erase a newer resolved key", async () => {
			const registry = await createInMemoryModelRegistry(context.authStorage);
			const registrationConfig = await ModelConfig.load(undefined);
			let releaseRegistrationLoad: () => void = () => {};
			const registrationLoad = new Promise<typeof registrationConfig>((resolve) => {
				releaseRegistrationLoad = () => resolve(registrationConfig);
			});
			const originalLoad = ModelConfig.load;
			let loadCount = 0;
			const load = vi.spyOn(ModelConfig, "load").mockImplementation((modelsJsonPath) => {
				loadCount += 1;
				return loadCount === 1 ? registrationLoad : originalLoad(modelsJsonPath);
			});
			let refreshCalls = 0;
			let observedKey: string | undefined;
			try {
				registry.registerProvider("delayed-catalog", {
					apiKey: "configured-catalog-key",
					refreshModels: async ({ credential }) => {
						refreshCalls += 1;
						observedKey = credential?.type === "api_key" ? credential.key : undefined;
						return [];
					},
				});

				await registry.refresh();
				const callsAfterForegroundRefresh = refreshCalls;
				expect(observedKey).toBe("configured-catalog-key");

				releaseRegistrationLoad();
				await new Promise<void>((resolve) => setImmediate(resolve));
				expect(refreshCalls).toBe(callsAfterForegroundRefresh);
				expect(observedKey).toBe("configured-catalog-key");
			} finally {
				releaseRegistrationLoad();
				load.mockRestore();
			}
		});

		test("resolves stored API-key expressions", async () => {
			const envVarName = "ATOMIC_STORED_CATALOG_KEY";
			const original = process.env[envVarName];
			process.env[envVarName] = "stored-environment-key";
			const tokenFile = join(context.tempDir, "stored-catalog-token");
			writeFileSync(tokenFile, "stored-command-key");
			try {
				await context.authStorage.modify("stored-environment", async () => ({
					type: "api_key",
					key: `$${envVarName}`,
				}));
				await context.authStorage.modify("stored-command", async () => ({
					type: "api_key",
					key: `!sh -c 'cat "${context.toShPath(tokenFile)}"'`,
				}));
				const registry = await createModelRegistry(context.authStorage, context.modelsJsonPath);
				const observed = new Map<string, string | undefined>();
				for (const providerId of ["stored-environment", "stored-command"]) {
					registry.registerProvider(providerId, {
						refreshModels: async ({ credential }) => {
							observed.set(providerId, credential?.type === "api_key" ? credential.key : undefined);
							return [];
						},
					});
				}

				await registry.refresh();
				expect(observed).toEqual(
					new Map([
						["stored-environment", "stored-environment-key"],
						["stored-command", "stored-command-key"],
					]),
				);
			} finally {
				if (original === undefined) delete process.env[envVarName];
				else process.env[envVarName] = original;
			}
		});

		test("keeps runtime over stored over configured key precedence", async () => {
			await context.authStorage.modify("credential-precedence", async () => ({
				type: "api_key",
				key: "stored-key",
			}));
			const registry = await createModelRegistry(context.authStorage, context.modelsJsonPath);
			await getModelRuntime(registry).setRuntimeApiKey("credential-precedence", "runtime-key", {});
			let observedKey: string | undefined;
			registry.registerProvider("credential-precedence", {
				apiKey: "configured-key",
				refreshModels: async ({ credential }) => {
					observedKey = credential?.type === "api_key" ? credential.key : undefined;
					return [];
				},
			});

			await registry.refresh();
			expect(observedKey).toBe("runtime-key");
			expect(await context.authStorage.read("credential-precedence")).toEqual({
				type: "api_key",
				key: "stored-key",
			});
		});

		test("does not pass unresolved stored API-key expressions literally", async () => {
			await context.authStorage.modify("missing-expression", async () => ({
				type: "api_key",
				key: "$ATOMIC_MISSING_CATALOG_KEY",
			}));
			delete process.env.ATOMIC_MISSING_CATALOG_KEY;
			const registry = await createModelRegistry(context.authStorage, context.modelsJsonPath);
			let observedKey: string | undefined;
			registry.registerProvider("missing-expression", {
				refreshModels: async ({ credential }) => {
					observedKey = credential?.type === "api_key" ? credential.key : undefined;
					return [];
				},
			});

			await registry.refresh();
			expect(observedKey).toBeUndefined();
		});
	});
});
