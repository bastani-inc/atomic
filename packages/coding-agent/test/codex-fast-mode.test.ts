import {
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type OpenAICodexResponsesOptions,
	type OpenAIResponsesOptions,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	CODEX_FAST_MODE_SERVICE_TIER,
	type CodexFastModeStreamers,
	getCodexFastModeScope,
	hasSupportedCodexFastModeModel,
	isCodexFastModeEnabledForScope,
	isCodexFastModeEnabledForSession,
	isCodexFastModeCandidateModelId,
	isCodexFastModeSupportedProvider,
	shouldApplyCodexFastModeForScope,
	streamWithCodexFastMode,
	withCodexFastModePayload,
	withCodexFastModeStreamOptions,
} from "../src/core/codex-fast-mode.ts";
import type { OrchestrationContext } from "../src/core/extensions/index.ts";

function providerModel(provider: string): Pick<Model<Api>, "provider"> {
	return { provider };
}

function fullModel(partial: Partial<Model<Api>>): Model<Api> {
	return {
		id: "gpt-5.1-codex",
		name: "GPT-5.1 Codex",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.example/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
		...partial,
	};
}

interface CapturedStreamCall {
	name: keyof CodexFastModeStreamers;
	model: Model<Api>;
	options?: SimpleStreamOptions | OpenAIResponsesOptions | OpenAICodexResponsesOptions;
}

function doneStream(): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	stream.end();
	return stream;
}

function makeStreamers(calls: CapturedStreamCall[]): CodexFastModeStreamers {
	return {
		streamSimple: (streamModel, _context, options) => {
			calls.push({ name: "streamSimple", model: streamModel, options });
			return doneStream();
		},
		streamOpenAIResponses: (streamModel, _context, options) => {
			calls.push({ name: "streamOpenAIResponses", model: streamModel, options });
			return doneStream();
		},
		streamOpenAICodexResponses: (streamModel, _context, options) => {
			calls.push({ name: "streamOpenAICodexResponses", model: streamModel, options });
			return doneStream();
		},
	};
}

const emptyContext: Context = { messages: [] };

const workflowContext: OrchestrationContext = {
	kind: "workflow-stage",
	workflowRunId: "run-1",
	workflowStageId: "stage-1",
	workflowStageName: "Stage 1",
	constraints: {
		disableWorkflowTool: true,
		maxSubagentDepth: 0,
	},
};

describe("codex fast mode helpers", () => {
	it("supports only OpenAI and OpenAI Codex providers", () => {
		expect(isCodexFastModeSupportedProvider("openai")).toBe(true);
		expect(isCodexFastModeSupportedProvider("openai-codex")).toBe(true);
		expect(isCodexFastModeSupportedProvider("github-copilot")).toBe(false);
		expect(isCodexFastModeSupportedProvider("azure-openai-responses")).toBe(false);
	});

	it("detects supported models from provider IDs", () => {
		expect(hasSupportedCodexFastModeModel([providerModel("github-copilot")])).toBe(false);
		expect(hasSupportedCodexFastModeModel([providerModel("github-copilot"), providerModel("openai")])).toBe(true);
		expect(hasSupportedCodexFastModeModel([providerModel("openai-codex")])).toBe(true);
	});

	it("detects candidate model ids with the shared provider policy", () => {
		expect(isCodexFastModeCandidateModelId("openai/gpt-5.1-codex")).toBe(true);
		expect(isCodexFastModeCandidateModelId("openai-codex/gpt-5.1-codex")).toBe(true);
		expect(isCodexFastModeCandidateModelId("anthropic/claude-sonnet-4")).toBe(false);
		expect(isCodexFastModeCandidateModelId("gpt-5.1-codex")).toBe(false);
		expect(isCodexFastModeCandidateModelId(undefined)).toBe(false);
	});

	it("selects chat versus workflow scope from orchestration context", () => {
		expect(getCodexFastModeScope(undefined)).toBe("chat");
		expect(getCodexFastModeScope(workflowContext)).toBe("workflow");
		expect(isCodexFastModeEnabledForScope({ chat: true, workflow: false }, "chat")).toBe(true);
		expect(isCodexFastModeEnabledForScope({ chat: true, workflow: false }, "workflow")).toBe(false);
		expect(isCodexFastModeEnabledForSession({ chat: true, workflow: false }, undefined)).toBe(true);
		expect(isCodexFastModeEnabledForSession({ chat: true, workflow: false }, workflowContext)).toBe(false);
		expect(isCodexFastModeEnabledForSession({ chat: false, workflow: true }, workflowContext)).toBe(true);
		expect(shouldApplyCodexFastModeForScope(providerModel("openai"), { chat: false, workflow: true }, "workflow")).toBe(true);
		expect(shouldApplyCodexFastModeForScope(providerModel("github-copilot"), { chat: false, workflow: true }, "workflow")).toBe(false);
	});

	it("adds serviceTier to stream options only when enabled", () => {
		expect(withCodexFastModeStreamOptions(undefined, false)).toBeUndefined();
		expect(withCodexFastModeStreamOptions({ temperature: 0.2 }, false)).toEqual({ temperature: 0.2 });
		expect(withCodexFastModeStreamOptions({ temperature: 0.2 }, true)).toEqual({
			temperature: 0.2,
			serviceTier: CODEX_FAST_MODE_SERVICE_TIER,
		});
	});

	it("adds service_tier to object payloads without overwriting existing values", () => {
		expect(withCodexFastModePayload("not-object", true)).toBe("not-object");
		expect(withCodexFastModePayload(["array"], true)).toEqual(["array"]);
		expect(withCodexFastModePayload({ model: "gpt" }, false)).toEqual({ model: "gpt" });
		expect(withCodexFastModePayload({ model: "gpt" }, true)).toEqual({
			model: "gpt",
			service_tier: CODEX_FAST_MODE_SERVICE_TIER,
		});
		expect(withCodexFastModePayload({ service_tier: "default" }, true)).toEqual({ service_tier: "default" });
		expect(withCodexFastModePayload({ service_tier: undefined }, true)).toEqual({
			service_tier: CODEX_FAST_MODE_SERVICE_TIER,
		});
	});

	it("uses native OpenAI Responses streaming when fast mode is active", () => {
		const calls: CapturedStreamCall[] = [];
		const streamers = makeStreamers(calls);
		const options = withCodexFastModeStreamOptions(
			{ apiKey: "key", reasoning: "medium", sessionId: "session-1" },
			true,
		);

		streamWithCodexFastMode(
			fullModel({ api: "openai-responses", provider: "openai" }),
			emptyContext,
			options,
			streamers,
		);

		expect(calls).toHaveLength(1);
		expect(calls[0]?.name).toBe("streamOpenAIResponses");
		const providerOptions = calls[0]?.options as OpenAIResponsesOptions | undefined;
		expect(providerOptions?.serviceTier).toBe(CODEX_FAST_MODE_SERVICE_TIER);
		expect(providerOptions?.reasoningEffort).toBe("medium");
		expect(providerOptions?.apiKey).toBe("key");
		expect(providerOptions?.sessionId).toBe("session-1");
	});

	it("uses native OpenAI Codex Responses streaming when fast mode is active", () => {
		const calls: CapturedStreamCall[] = [];
		const streamers = makeStreamers(calls);
		const options = withCodexFastModeStreamOptions(
			{ apiKey: "key", reasoning: "xhigh", transport: "sse" },
			true,
		);

		streamWithCodexFastMode(
			fullModel({
				api: "openai-codex-responses",
				provider: "openai-codex",
				id: "gpt-5.5",
				thinkingLevelMap: { xhigh: "xhigh" },
			}),
			emptyContext,
			options,
			streamers,
		);

		expect(calls).toHaveLength(1);
		expect(calls[0]?.name).toBe("streamOpenAICodexResponses");
		const providerOptions = calls[0]?.options as OpenAICodexResponsesOptions | undefined;
		expect(providerOptions?.serviceTier).toBe(CODEX_FAST_MODE_SERVICE_TIER);
		expect(providerOptions?.reasoningEffort).toBe("xhigh");
		expect(providerOptions?.transport).toBe("sse");
	});

	it("falls back to the normal simple streamer when native fast mode should not apply", () => {
		const calls: CapturedStreamCall[] = [];
		const streamers = makeStreamers(calls);

		streamWithCodexFastMode(
			fullModel({ api: "openai-responses", provider: "openai" }),
			emptyContext,
			withCodexFastModeStreamOptions({ apiKey: "key" }, false),
			streamers,
		);
		streamWithCodexFastMode(
			fullModel({ api: "openai-responses", provider: "github-copilot" }),
			emptyContext,
			withCodexFastModeStreamOptions({ apiKey: "key" }, true),
			streamers,
		);

		expect(calls.map((call) => call.name)).toEqual(["streamSimple", "streamSimple"]);
	});
});
