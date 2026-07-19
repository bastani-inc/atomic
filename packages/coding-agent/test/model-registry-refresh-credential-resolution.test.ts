import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { describeModelRegistry } from "./model-registry-fixtures.ts";

describeModelRegistry((context) => {
	describe("extension catalog credential resolution", () => {
		test("resolves configured environment-backed API keys", async () => {
			const envVarName = "ATOMIC_EXTENSION_CATALOG_KEY";
			const original = process.env[envVarName];
			process.env[envVarName] = "environment-catalog-key";
			try {
				const registry = ModelRegistry.create(context.authStorage, context.modelsJsonPath);
				let observedKey: string | undefined;
				registry.registerProvider("environment-catalog", {
					apiKey: `$${envVarName}`,
					refreshModels: async ({ credential }) => {
						observedKey = credential?.type === "api_key" ? credential.key : undefined;
						return [];
					},
				});

				await registry.refresh();
				expect(observedKey).toBe("environment-catalog-key");
			} finally {
				if (original === undefined) delete process.env[envVarName];
				else process.env[envVarName] = original;
			}
		});

		test("resolves configured command-backed API keys", async () => {
			const tokenFile = join(context.tempDir, "catalog-token");
			writeFileSync(tokenFile, "command-catalog-key");
			const registry = ModelRegistry.create(context.authStorage, context.modelsJsonPath);
			let observedKey: string | undefined;
			registry.registerProvider("command-catalog", {
				apiKey: `!sh -c 'cat "${context.toShPath(tokenFile)}"'`,
				refreshModels: async ({ credential }) => {
					observedKey = credential?.type === "api_key" ? credential.key : undefined;
					return [];
				},
			});

			await registry.refresh();
			expect(observedKey).toBe("command-catalog-key");
		});

		test("resolves stored API-key expressions", async () => {
			const envVarName = "ATOMIC_STORED_CATALOG_KEY";
			const original = process.env[envVarName];
			process.env[envVarName] = "stored-environment-key";
			const tokenFile = join(context.tempDir, "stored-catalog-token");
			writeFileSync(tokenFile, "stored-command-key");
			try {
				context.authStorage.set("stored-environment", { type: "api_key", key: `$${envVarName}` });
				context.authStorage.set("stored-command", {
					type: "api_key",
					key: `!sh -c 'cat "${context.toShPath(tokenFile)}"'`,
				});
				const registry = ModelRegistry.create(context.authStorage, context.modelsJsonPath);
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
				expect(observed).toEqual(new Map([
					["stored-environment", "stored-environment-key"],
					["stored-command", "stored-command-key"],
				]));
			} finally {
				if (original === undefined) delete process.env[envVarName];
				else process.env[envVarName] = original;
			}
		});

		test("keeps runtime over stored over configured key precedence", async () => {
			context.authStorage.set("credential-precedence", { type: "api_key", key: "stored-key" });
			context.authStorage.setRuntimeApiKey("credential-precedence", "runtime-key");
			const registry = ModelRegistry.create(context.authStorage, context.modelsJsonPath);
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
			expect(context.authStorage.get("credential-precedence")).toEqual({ type: "api_key", key: "stored-key" });
		});
	});
});
