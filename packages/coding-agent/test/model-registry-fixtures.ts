import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Context, Model } from "@bastani/pi-ai/compat";
import { afterEach, beforeEach, describe } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { clearApiKeyCache, type ModelRegistry, type ProviderConfigInput } from "../src/core/model-registry.ts";
import { createInMemoryModelRegistry } from "./model-runtime-test-utils.ts";

export interface ModelRegistryTestContext {
	readonly tempDir: string;
	readonly modelsJsonPath: string;
	readonly authStorage: AuthStorage;
	readonly openAiModel: Model<Api>;
	/**
	 * Two distinct built-in OpenRouter chat models read from the generated catalog, so tests that
	 * override or replace built-in models do not depend on specific entries of the daily catalog.
	 */
	builtinOpenRouterModels(): Promise<[Model<Api>, Model<Api>]>;
	readonly emptyContext: Context;
	providerConfig(baseUrl: string, models: Array<{ id: string; name?: string }>, api?: string): ProviderConfigInput;
	writeModelsJson(providers: Record<string, ProviderConfigInput>): void;
	getModelsForProvider(registry: ModelRegistry, provider: string): Model<Api>[];
	toShPath(value: string): string;
	overrideConfig(
		baseUrl: string,
		headers?: Record<string, string>,
	): { baseUrl: string; headers?: Record<string, string> };
	writeRawModelsJson(providers: Record<string, unknown>): void;
}

export function describeModelRegistry(featureTests: (context: ModelRegistryTestContext) => void): void {
	describe("ModelRegistry", () => {
		let tempDir: string;
		let modelsJsonPath: string;
		let authStorage: AuthStorage;

		beforeEach(() => {
			tempDir = join(tmpdir(), `pi-test-model-registry-${Date.now()}-${Math.random().toString(36).slice(2)}`);
			mkdirSync(tempDir, { recursive: true });
			modelsJsonPath = join(tempDir, "models.json");
			authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		});

		afterEach(() => {
			if (tempDir && existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true });
			}
			clearApiKeyCache();
		});

		function providerConfig(
			baseUrl: string,
			models: Array<{ id: string; name?: string }>,
			api: string = "anthropic-messages",
		): ProviderConfigInput {
			return {
				baseUrl,
				apiKey: "test-key",
				api: api as Api,
				models: models.map((m) => ({
					id: m.id,
					name: m.name ?? m.id,
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 100000,
					maxTokens: 8000,
				})),
			};
		}

		function writeModelsJson(providers: Record<string, ProviderConfigInput>) {
			writeFileSync(modelsJsonPath, JSON.stringify({ providers }));
		}

		function getModelsForProvider(registry: ModelRegistry, provider: string) {
			return registry.getAll().filter((m) => m.provider === provider);
		}

		function toShPath(value: string): string {
			let escaped = "";
			for (const char of value.replace(/\\/g, "/")) {
				if (char === '"' || char === "\\" || char === "$" || char === "`") {
					escaped += `\\${char}`;
				} else {
					escaped += char;
				}
			}
			return escaped;
		}

		function overrideConfig(baseUrl: string, headers?: Record<string, string>) {
			return { baseUrl, ...(headers && { headers }) };
		}

		function writeRawModelsJson(providers: Record<string, unknown>) {
			writeFileSync(modelsJsonPath, JSON.stringify({ providers }));
		}

		const openAiModel: Model<Api> = {
			id: "test-openai-model",
			name: "Test OpenAI Model",
			api: "openai-completions",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
		};

		async function builtinOpenRouterModels(): Promise<[Model<Api>, Model<Api>]> {
			const registry = await createInMemoryModelRegistry(authStorage);
			// Plain chat models only: derived fast variants take overrides keyed by their exact ID.
			const [first, second] = getModelsForProvider(registry, "openrouter").filter(
				(model) => model.api === "openai-completions" && model.fastRoute === undefined,
			);
			if (!first || !second) throw new Error("Expected at least two built-in OpenRouter chat models");
			return [first, second];
		}

		const emptyContext: Context = { messages: [] };

		featureTests({
			get tempDir() {
				return tempDir;
			},
			get modelsJsonPath() {
				return modelsJsonPath;
			},
			get authStorage() {
				return authStorage;
			},
			openAiModel,
			builtinOpenRouterModels,
			emptyContext,
			providerConfig,
			writeModelsJson,
			getModelsForProvider,
			toShPath,
			overrideConfig,
			writeRawModelsJson,
		});
	});
}
