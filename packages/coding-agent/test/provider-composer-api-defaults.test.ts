import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Api,
	type AssistantMessage,
	AssistantMessageEventStream,
	type Model,
	normalizeContext,
	type Provider,
} from "@bastani/pi-ai";
import { registerApiProvider, unregisterApiProviders } from "@bastani/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
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

const REGISTRY_SOURCE_ID = "provider-composer-streaming-test";
const REGISTRY_API = "composer-registry-api";

function completed(model: Model<Api>, text: string): AssistantMessageEventStream {
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
	const stream = new AssistantMessageEventStream();
	stream.push({ type: "done", reason: "stop", message });
	stream.end(message);
	return stream;
}

describe("provider composer streaming", () => {
	const anthropic = model("anthropic-default", "anthropic-messages", "https://anthropic.test");
	const completions = model("completions-default", "openai-completions", "https://completions.test/v1");
	const registered = model("registry-model", REGISTRY_API, "https://registry.test");
	const unregistered = model("unregistered-model", "composer-unregistered-api", "https://unregistered.test");
	const context = normalizeContext({ messages: [] });

	afterEach(() => unregisterApiProviders(REGISTRY_SOURCE_ID));

	function createBase(calls: string[]): Provider {
		const answer = (label: string) => (requested: Model<Api>) => {
			calls.push(`${label}:${requested.id}`);
			return completed(requested, label);
		};
		return {
			id: "mixed",
			name: "Mixed",
			auth: { apiKey: { name: "Mixed", check: async () => undefined, login: async () => undefined } },
			getModels: () => [anthropic, completions],
			stream: answer("base.stream"),
			streamSimple: answer("base.streamSimple"),
		};
	}

	async function answerOf(stream: AssistantMessageEventStream): Promise<string> {
		const result = await stream.result();
		const [block] = result.content;
		if (result.stopReason === "stop" && block?.type === "text") return block.text;
		return `${result.stopReason}: ${result.errorMessage}`;
	}

	it("streams through the base provider for an API it serves, with or without extension and options", async () => {
		const calls: string[] = [];
		const provider = composeModelProvider("mixed", createBase(calls), await ModelConfig.load(undefined), undefined);

		expect(await answerOf(provider.stream(anthropic, context))).toBe("base.stream");
		expect(await answerOf(provider.streamSimple(completions, context))).toBe("base.streamSimple");
		expect(calls).toEqual(["base.stream:anthropic-default", "base.streamSimple:completions-default"]);
	});

	it("streams through the extension only for the API it declares", async () => {
		const calls: string[] = [];
		const provider = composeModelProvider("mixed", createBase(calls), await ModelConfig.load(undefined), {
			api: "openai-completions",
			streamSimple: (requested) => {
				calls.push(`extension:${requested.id}`);
				return completed(requested, "extension");
			},
		});

		expect(await answerOf(provider.streamSimple(completions, context))).toBe("extension");
		expect(await answerOf(provider.stream(completions, context))).toBe("extension");
		expect(await answerOf(provider.streamSimple(anthropic, context))).toBe("base.streamSimple");
		expect(await answerOf(provider.stream(anthropic, context))).toBe("base.stream");
		expect(calls).toEqual([
			"extension:completions-default",
			"extension:completions-default",
			"base.streamSimple:anthropic-default",
			"base.stream:anthropic-default",
		]);
	});

	it("streams an API the base does not serve through the registered implementation", async () => {
		const calls: string[] = [];
		registerApiProvider(
			{
				api: REGISTRY_API,
				stream: (requested) => {
					calls.push(`registry.stream:${requested.id}`);
					return completed(requested, "registry.stream");
				},
				streamSimple: (requested) => {
					calls.push(`registry.streamSimple:${requested.id}`);
					return completed(requested, "registry.streamSimple");
				},
			},
			REGISTRY_SOURCE_ID,
		);
		const provider = composeModelProvider("mixed", createBase(calls), await ModelConfig.load(undefined), undefined);

		expect(await answerOf(provider.stream(registered, context))).toBe("registry.stream");
		expect(await answerOf(provider.streamSimple(registered, context))).toBe("registry.streamSimple");
		expect(calls).toEqual(["registry.stream:registry-model", "registry.streamSimple:registry-model"]);
	});

	it("reports an API with no implementation as a stream error", async () => {
		const calls: string[] = [];
		const provider = composeModelProvider("mixed", createBase(calls), await ModelConfig.load(undefined), undefined);

		expect(await answerOf(provider.streamSimple(unregistered, context))).toBe(
			"error: No API provider registered for api: composer-unregistered-api",
		);
		expect(calls).toEqual([]);
	});
});
