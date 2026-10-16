import type { AssistantMessage, Model } from "@bastani/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AgentSessionEvent } from "../../packages/coding-agent/src/core/agent-session.js";
import { _emitModelChanged } from "../../packages/coding-agent/src/core/agent-session-models.js";
import { _trySwitchToFallbackModel } from "../../packages/coding-agent/src/core/agent-session-retry.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { makeMockSession } from "../unit/stage-runner-helpers.js";
import { createMemoryTestBackend as createInMemoryTestBackend } from "./workflow-journal.js";

/** Real SDK fallback selection/events with a controlled transport and pending workflow prompts. */
export async function startFallbackWidgetScenario(explicitModel = true) {
	setDurableBackend(createInMemoryTestBackend());
	const store = createStore();
	const ready = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	const primary: Model<"openai-completions"> = {
		id: "model-a",
		name: "Model A",
		provider: "openai",
		api: "openai-completions",
		baseUrl: "https://fixture.invalid",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 10000,
		maxTokens: 1000,
	};
	const models = [
		primary,
		{ ...primary, provider: "other", id: "model-b-fast" },
		{ ...primary, id: "model-c:literal" },
	];
	const state = { model: primary, thinkingLevel: "high" as ThinkingLevel, messages: [] as AssistantMessage[] };
	const events: AgentSessionEvent[] = [];
	const prompts: string[] = [];
	const creations: string[] = [];
	const prompt = async (text: string) => {
		prompts.push(text);
		if (prompts.length === 2) ready.resolve();
		await finish.promise;
		return undefined;
	};
	const affected = makeMockSession({ prompt });
	Object.defineProperties(affected.session, {
		model: { get: () => state.model },
		thinkingLevel: { get: () => state.thinkingLevel },
	});
	const sibling = makeMockSession({ model: { ...primary, id: "unchanged" }, thinkingLevel: "low", prompt });
	const sdk = {
		get model() {
			return state.model;
		},
		get thinkingLevel() {
			return state.thinkingLevel;
		},
		agent: { state, continue: async () => undefined },
		_fallbackModels: ["other/model-b-fast:medium", "other/model-b-fast:low", "openai/model-c:literal:off"],
		_fallbackAttemptedKeys: new Set<string>(),
		_fallbackBlockedModels: [] as Model<"openai-completions">[],
		_retryAttempt: 0,
		settingsManager: { getDefaultThinkingLevel: () => "high", getDefaultProvider: () => "openai" },
		_modelRuntime: {
			getAvailableSnapshot: () => models,
			getModel: (provider: string, id: string) =>
				models.find((model) => model.provider === provider && model.id === id),
			hasConfiguredAuth: () => true,
		},
		sessionManager: { appendModelChange() {}, appendThinkingLevelChange() {} },
		_refreshBaseSystemPromptFromActiveTools() {},
		// Synthetic session: no projection to edit, and `state.messages` holds no attempt to omit.
		_omitTrailingAssistantAttempt: () => false,
		_emitModelChanged,
		_emitModelSelect: async () => undefined,
		_emit(event: AgentSessionEvent) {
			events.push(event);
			affected.emit(event);
		},
	};
	const execution = run(
		workflow({
			name: "fallback-widget",
			description: "",
			outputs: {},
			async run(ctx) {
				await Promise.all([
					ctx
						.stage("affected", explicitModel ? { model: "openai/model-a:high" } : {})
						.prompt("  affected input  "),
					ctx.stage("sibling", { model: "openai/unchanged:low" }).prompt("sibling input"),
				]);
				return {};
			},
		}),
		{},
		{
			store,
			adapters: {
				agentSession: {
					async create(_options, meta) {
						creations.push(meta!.stageName);
						return meta?.stageName === "affected" ? affected.session : sibling.session;
					},
				},
			},
		},
	);
	await ready.promise;
	return {
		store,
		runId: store.runs()[0]!.id,
		prompts,
		creations,
		events,
		emit: affected.emit,
		apply() {
			events.length = 0;
			return _trySwitchToFallbackModel.call(sdk as never, {
				role: "assistant",
				content: [],
				api: primary.api,
				provider: state.model.provider,
				model: state.model.id,
				stopReason: "error",
				errorMessage: "429 rate limit exceeded",
				timestamp: 0,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			});
		},
		async finish() {
			finish.resolve();
			return execution;
		},
	};
}
