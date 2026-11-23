import assert from "node:assert/strict";
import { beforeEach, describe, it, vi } from "vitest";
import type { OAuthAuth } from "../src/auth/types.ts";
import type { Api, AssistantMessage, Model, ProviderStreams } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const bedrockModel: Model<"bedrock-converse-stream"> = {
	id: "fixture",
	name: "fixture",
	api: "bedrock-converse-stream",
	provider: "amazon-bedrock",
	baseUrl: "https://bedrock.example",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
};
const context = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 1 }] });

function reply(model: Model<Api>, text: string): AssistantMessageEventStream {
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
		timestamp: 1,
	};
	const stream = new AssistantMessageEventStream();
	stream.push({ type: "done", reason: "stop", message });
	stream.end(message);
	return stream;
}

/** Streams that answer with their label and record which implementation served each request. */
function recordingStreams(label: string, served: string[]): ProviderStreams {
	const answer = (model: Model<Api>) => {
		served.push(label);
		return reply(model, label);
	};
	return { stream: answer, streamSimple: answer };
}

function replyText(message: AssistantMessage): string {
	return message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

/**
 * Fresh module instances, so the module-level Bedrock registration starts empty. The Bedrock
 * implementation file is replaced by streams labelled "implementation": requests that reach it
 * through either the default variable-specifier import or the registrar's literal import report it.
 */
async function freshBedrock(served: string[]) {
	vi.resetModules();
	vi.doMock("../src/api/bedrock-converse-stream.ts", () => recordingStreams("implementation", served));
	const lazy = await import("../src/api/bedrock-converse-stream.lazy.ts");
	const { registerLazyBedrockProvider } = await import("../src/lazy-bedrock-provider.ts");
	return { ...lazy, registerLazyBedrockProvider };
}

describe("lazy Bedrock provider loading", () => {
	beforeEach(() => {
		vi.doUnmock("../src/api/bedrock-converse-stream.ts");
	});

	it("serves requests from the Bedrock implementation file when nothing is registered", async () => {
		const served: string[] = [];
		const { bedrockConverseStreamApi } = await freshBedrock(served);

		const message = await bedrockConverseStreamApi().stream(bedrockModel, context).result();

		assert.deepEqual(served, ["implementation"]);
		assert.equal(message.stopReason, "stop");
		assert.equal(replyText(message), "implementation");
	});

	it("calls a registered loader on the first request, not when it is registered", async () => {
		const served: string[] = [];
		const { bedrockConverseStreamApi, setBedrockProviderLoader } = await freshBedrock(served);
		let loads = 0;
		setBedrockProviderLoader(async () => {
			loads++;
			return recordingStreams("loader", served);
		});
		assert.equal(loads, 0);

		const message = await bedrockConverseStreamApi().streamSimple(bedrockModel, context).result();

		assert.equal(loads, 1);
		assert.deepEqual(served, ["loader"]);
		assert.equal(replyText(message), "loader");
	});

	it("keeps setBedrockProviderModule working, and the latest registration wins", async () => {
		const served: string[] = [];
		const { bedrockConverseStreamApi, setBedrockProviderLoader, setBedrockProviderModule } =
			await freshBedrock(served);
		const api = bedrockConverseStreamApi();

		setBedrockProviderModule(recordingStreams("module", served));
		await api.stream(bedrockModel, context).result();
		setBedrockProviderLoader(async () => recordingStreams("loader", served));
		await api.stream(bedrockModel, context).result();
		setBedrockProviderModule(recordingStreams("second module", served));
		await api.stream(bedrockModel, context).result();

		assert.deepEqual(served, ["module", "loader", "second module"]);
	});

	it("registerLazyBedrockProvider loads the Bedrock implementation in place of a registered module", async () => {
		const served: string[] = [];
		const { bedrockConverseStreamApi, registerLazyBedrockProvider, setBedrockProviderModule } =
			await freshBedrock(served);
		setBedrockProviderModule(recordingStreams("module", served));

		registerLazyBedrockProvider();
		const message = await bedrockConverseStreamApi().stream(bedrockModel, context).result();

		assert.deepEqual(served, ["implementation"]);
		assert.equal(replyText(message), "implementation");
	});
});

describe("lazy OAuth flow loading", () => {
	it("registerLazyOAuthFlows makes every loader return its flow module's export, replacing registered loaders", async () => {
		vi.resetModules();
		const load = await import("../src/auth/oauth/load.ts");
		const { registerLazyOAuthFlows } = await import("../src/lazy-oauth.ts");
		const placeholder: OAuthAuth = { ...(await import("../src/auth/oauth/meta.ts")).metaOAuth, name: "Placeholder" };
		const usePlaceholder = () => placeholder;
		load.registerBundledOAuthFlowLoaders({
			anthropic: usePlaceholder,
			openaiCodex: usePlaceholder,
			openaiChatGPT: usePlaceholder,
			githubCopilot: usePlaceholder,
			openrouter: usePlaceholder,
			kimiCoding: usePlaceholder,
			meta: usePlaceholder,
			xai: usePlaceholder,
		});
		assert.equal(await load.loadAnthropicOAuth(), placeholder);

		registerLazyOAuthFlows();

		const flows: [string, () => Promise<OAuthAuth>, OAuthAuth][] = [
			["anthropic", load.loadAnthropicOAuth, (await import("../src/auth/oauth/anthropic.ts")).anthropicOAuth],
			[
				"openai-codex",
				load.loadOpenAICodexOAuth,
				(await import("../src/auth/oauth/openai-codex.ts")).openaiCodexOAuth,
			],
			[
				"openai-chatgpt",
				load.loadOpenAIChatGPTOAuth,
				(await import("../src/auth/oauth/openai-chatgpt.ts")).openaiChatGPTOAuth,
			],
			[
				"github-copilot",
				load.loadGitHubCopilotOAuth,
				(await import("../src/auth/oauth/github-copilot.ts")).githubCopilotOAuth,
			],
			["openrouter", load.loadOpenRouterOAuth, (await import("../src/auth/oauth/openrouter.ts")).openRouterOAuth],
			["kimi-coding", load.loadKimiCodingOAuth, (await import("../src/auth/oauth/kimi-coding.ts")).kimiCodingOAuth],
			["meta", load.loadMetaOAuth, (await import("../src/auth/oauth/meta.ts")).metaOAuth],
			["xai", load.loadXaiOAuth, (await import("../src/auth/oauth/xai.ts")).xaiOAuth],
		];
		for (const [id, loadFlow, flow] of flows) {
			assert.equal(await loadFlow(), flow, `${id} loads its flow module's export`);
		}
	});

	it("lazyOAuth clears a rejected load promise so a later attempt retries and caches success", async () => {
		const { lazyOAuth } = await import("../src/auth/helpers.ts");
		let attempts = 0;
		const flow = lazyOAuth({
			name: "Transient OAuth",
			load: async () => {
				attempts += 1;
				if (attempts === 1) throw new Error("transient oauth module missing");
				return {
					name: "Transient OAuth",
					login: async () => ({ type: "oauth", access: "a", refresh: "r", expires: Date.now() + 60_000 }),
					refresh: async (cred) => cred,
					toAuth: async (cred) => ({ apiKey: `tok:${cred.access}` }),
				};
			},
		});

		const credential = { type: "oauth" as const, access: "ok", refresh: "r", expires: Date.now() + 60_000 };
		await assert.rejects(() => flow.toAuth(credential), /transient oauth module missing/);
		assert.deepEqual(await flow.toAuth(credential), { apiKey: "tok:ok" });
		assert.deepEqual(await flow.toAuth(credential), { apiKey: "tok:ok" });
		assert.equal(attempts, 2);
	});
});

describe("lazy image provider module loading", () => {
	it("generateImagesOpenRouter and generateImagesOpenAI retry after a transient module import rejection", async () => {
		vi.resetModules();
		let openRouterCalls = 0;
		let openAICalls = 0;
		vi.doMock("../src/api/openrouter-images.ts", () => {
			openRouterCalls += 1;
			if (openRouterCalls === 1) throw new Error("transient openrouter-images missing");
			return {
				generateImages: async (model: { api: string; provider: string; id: string }) => ({
					api: model.api,
					provider: model.provider,
					model: model.id,
					output: [],
					stopReason: "stop",
					timestamp: 1,
				}),
			};
		});
		vi.doMock("../src/api/openai-images.ts", () => {
			openAICalls += 1;
			if (openAICalls === 1) throw new Error("transient openai-images missing");
			return {
				generateImages: async (model: { api: string; provider: string; id: string }) => ({
					api: model.api,
					provider: model.provider,
					model: model.id,
					output: [],
					stopReason: "stop",
					timestamp: 1,
				}),
			};
		});

		const { generateImagesOpenRouter, generateImagesOpenAI } = await import(
			"../src/providers/images/register-builtins.ts"
		);
		const orModel = { id: "or-img", name: "or-img", api: "openrouter-images", provider: "openrouter" } as never;
		const oaModel = { id: "oa-img", name: "oa-img", api: "openai-images", provider: "openai" } as never;
		const imgCtx = { prompt: "cat" } as never;

		const orFirst = await generateImagesOpenRouter(orModel, imgCtx);
		assert.equal(orFirst.stopReason, "error");
		const orSecond = await generateImagesOpenRouter(orModel, imgCtx);
		assert.equal(orSecond.stopReason, "stop");
		const orThird = await generateImagesOpenRouter(orModel, imgCtx);
		assert.equal(orThird.stopReason, "stop");
		assert.equal(openRouterCalls, 2);

		const oaFirst = await generateImagesOpenAI(oaModel, imgCtx);
		assert.equal(oaFirst.stopReason, "error");
		const oaSecond = await generateImagesOpenAI(oaModel, imgCtx);
		assert.equal(oaSecond.stopReason, "stop");
		const oaThird = await generateImagesOpenAI(oaModel, imgCtx);
		assert.equal(oaThird.stopReason, "stop");
		assert.equal(openAICalls, 2);

		vi.doUnmock("../src/api/openrouter-images.ts");
		vi.doUnmock("../src/api/openai-images.ts");
	});
});
