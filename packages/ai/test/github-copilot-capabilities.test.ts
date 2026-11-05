import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "vitest";
import { getModel } from "../src/compat.ts";
import { parseGitHubCopilotDiscoveredModels } from "../src/providers/github-copilot.ts";
import {
	describeGitHubCopilotModel,
	type GitHubCopilotModelCapabilities,
	githubCopilotApiForSdk,
} from "../src/providers/github-copilot-capabilities.ts";
import type { Api, Model } from "../src/types.ts";

const recordedModels: unknown = JSON.parse(
	readFileSync(new URL("./fixtures/github-copilot-models.json", import.meta.url), "utf8"),
);

function discovered(id: string): Model<Api> {
	const model = parseGitHubCopilotDiscoveredModels(recordedModels, []).find((candidate) => candidate.id === id);
	if (!model) throw new Error(`Expected ${id} to be discovered`);
	return model;
}

function catalog(id: string): Model<Api> {
	const model = getModel("github-copilot", id as never) as Model<Api> | undefined;
	if (!model) throw new Error(`Expected github-copilot/${id} in the built-in catalog`);
	return model;
}

const CHAT_SURFACE = {
	toolCalls: {
		parallel: true,
		idFormat: "call-id",
		argumentDeltas: "indexed-chunks",
		emptyArguments: "empty-object",
	},
	completion: { finishSignal: "finish-reason", emptyTurn: "empty-response-error" },
	usage: { reasoningTokens: "completion-details-or-top-level" },
} as const;

const RESPONSES_SURFACE = {
	toolCalls: {
		parallel: true,
		idFormat: "call-and-item-id",
		argumentDeltas: "output-item-deltas",
		emptyArguments: "empty-object",
	},
	completion: { finishSignal: "terminal-response-event", emptyTurn: "empty-response-error" },
	usage: { reasoningTokens: "output-details" },
} as const;

function expected(
	model: Model<Api>,
	surface: typeof CHAT_SURFACE | typeof RESPONSES_SURFACE,
	values: {
		source: "catalog" | "discovered";
		levels: readonly string[];
		replay: string;
		strictSchemas: boolean;
		maxImagesPerRequest?: number;
		maxImageBytes?: number;
	},
): GitHubCopilotModelCapabilities {
	return {
		modelId: model.id,
		api: model.api as GitHubCopilotModelCapabilities["api"],
		source: values.source,
		reasoning: {
			levels: values.levels as GitHubCopilotModelCapabilities["reasoning"]["levels"],
			replay: values.replay as GitHubCopilotModelCapabilities["reasoning"]["replay"],
		},
		toolCalls: { ...surface.toolCalls, strictSchemas: values.strictSchemas },
		completion: surface.completion,
		usage: surface.usage,
		input: {
			images: true,
			maxImagesPerRequest: values.maxImagesPerRequest,
			maxImageBytes: values.maxImageBytes,
		},
		limits: { contextWindow: model.contextWindow, maxOutputTokens: model.maxTokens },
	};
}

describe("GitHub Copilot capability table from model metadata (#4324)", () => {
	it.each([
		["gemini-3.8-flash", ["low", "medium", "high"]],
		["gemini-4-argon", ["low", "medium", "high"]],
	])("describes Gemini %s on Chat Completions, replaying the reasoning field it returns", (id, levels) => {
		const model = catalog(id);
		assert.deepEqual(
			describeGitHubCopilotModel(model),
			expected(model, CHAT_SURFACE, {
				source: "catalog",
				levels,
				replay: "returned-reasoning-field",
				strictSchemas: true,
				maxImageBytes: 4_718_592,
			}),
		);
	});

	it("describes Kimi K3 on Chat Completions", () => {
		const model = catalog("kimi-k3");
		assert.deepEqual(
			describeGitHubCopilotModel(model),
			expected(model, CHAT_SURFACE, {
				source: "catalog",
				levels: ["low", "high", "max"],
				replay: "returned-reasoning-field",
				strictSchemas: true,
				maxImageBytes: 4_718_592,
			}),
		);
	});

	it.each([
		["grok-4.5", ["low", "medium", "high"]],
		["grok-4.6", ["low", "medium", "high", "xhigh"]],
		["grok-4.7", ["low", "medium", "high", "xhigh"]],
		["vendor-model-a", ["low", "medium", "high"]],
	])("describes %s on Responses with encrypted reasoning items", (id, levels) => {
		const model = id === "vendor-model-a" ? { ...catalog("grok-4.5"), id, name: "Vendor model A" } : catalog(id);
		assert.deepEqual(
			describeGitHubCopilotModel(model),
			expected(model, RESPONSES_SURFACE, {
				source: "catalog",
				levels,
				replay: "encrypted-reasoning-item",
				strictSchemas: false,
				maxImageBytes: 4_718_592,
			}),
		);
	});

	it("describes discovered models from the account's own metadata", () => {
		const chat = discovered("example-chat-model");
		assert.deepEqual(
			describeGitHubCopilotModel(chat),
			expected(chat, CHAT_SURFACE, {
				source: "discovered",
				levels: ["low", "medium", "high"],
				replay: "returned-reasoning-field",
				strictSchemas: false,
				maxImagesPerRequest: 10,
				maxImageBytes: 4_194_304,
			}),
		);
		const responses = discovered("example-reasoning-model");
		assert.deepEqual(
			describeGitHubCopilotModel(responses),
			expected(responses, RESPONSES_SURFACE, {
				source: "discovered",
				levels: ["off", "low", "medium", "high", "xhigh", "max"],
				replay: "encrypted-reasoning-item",
				strictSchemas: true,
				maxImagesPerRequest: 1,
				maxImageBytes: 4_194_304,
			}),
		);
	});

	it("describes a Messages model and models without reasoning or images", () => {
		const messages = describeGitHubCopilotModel(discovered("example-messages-model"));
		assert.equal(messages?.api, "anthropic-messages");
		assert.equal(messages?.reasoning.replay, "signed-thinking-block");
		assert.deepEqual(messages?.toolCalls, {
			parallel: true,
			strictSchemas: false,
			idFormat: "tool-use-id",
			argumentDeltas: "input-json-deltas",
			emptyArguments: "empty-object",
		});
		assert.deepEqual(messages?.completion, { finishSignal: "message-stop", emptyTurn: "accepted" });
		assert.deepEqual(messages?.usage, { reasoningTokens: "output-tokens" });
		const strictMessages = describeGitHubCopilotModel({
			...discovered("example-messages-model"),
			compat: { supportsStrictTools: true },
		} as Model<Api>);
		assert.equal(strictMessages?.toolCalls.strictSchemas, true);

		const legacy = describeGitHubCopilotModel({
			...discovered("example-legacy-model"),
			input: ["text"],
			inputLimits: { images: { maxPerRequest: 3, resize: { maxBytes: 9 } } },
		});
		assert.deepEqual(legacy?.reasoning, { levels: ["off"], replay: "none" });
		assert.deepEqual(legacy?.input, { images: false, maxImagesPerRequest: undefined, maxImageBytes: undefined });
	});

	it("reads strict tools and image limits from whatever metadata a model has", () => {
		const { compat: _messagesCompat, ...messages } = discovered("example-messages-model");
		assert.equal(describeGitHubCopilotModel(messages as Model<Api>)?.toolCalls.strictSchemas, false);
		const { compat: _chatCompat, ...chat } = discovered("example-chat-model");
		assert.equal(describeGitHubCopilotModel(chat as Model<Api>)?.toolCalls.strictSchemas, false);
		const { inputLimits: _limits, ...withoutLimits } = discovered("example-chat-model");
		const unlimited = { images: true, maxImagesPerRequest: undefined, maxImageBytes: undefined };
		assert.deepEqual(describeGitHubCopilotModel(withoutLimits as Model<Api>)?.input, unlimited);
		assert.deepEqual(
			describeGitHubCopilotModel({ ...withoutLimits, inputLimits: {} } as Model<Api>)?.input,
			unlimited,
		);
		assert.deepEqual(
			describeGitHubCopilotModel({ ...withoutLimits, inputLimits: { images: { maxPerRequest: 4 } } } as Model<Api>)
				?.input,
			{ images: true, maxImagesPerRequest: 4, maxImageBytes: undefined },
		);
	});

	it("describes only GitHub Copilot models on the APIs Atomic calls it with", () => {
		const grok = catalog("grok-4.7");
		assert.equal(describeGitHubCopilotModel({ ...grok, provider: "xai" }), undefined);
		assert.equal(describeGitHubCopilotModel({ ...grok, api: "google-generative-ai" } as Model<Api>), undefined);
		assert.equal(
			describeGitHubCopilotModel({ ...grok, api: "openai-codex-responses" } as Model<Api>)?.api,
			undefined,
		);
	});

	it.each([
		["@ai-sdk/anthropic", "anthropic-messages"],
		["@ai-sdk/openai", "openai-responses"],
		["@ai-sdk/openai-compatible", "openai-completions"],
		["@ai-sdk/google", "openai-completions"],
		[undefined, "openai-completions"],
	] as const)("routes a catalog entry whose SDK is %s to %s", (sdk, api) => {
		assert.equal(githubCopilotApiForSdk(sdk), api);
	});
});
