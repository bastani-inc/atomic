import assert from "node:assert/strict";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai/compat";
import { test } from "vitest";
import {
	_checkCompaction,
	_runAutoCompaction,
} from "../../packages/coding-agent/src/core/agent-session-auto-compaction.js";
import {
	_createRetryPromiseForAgentEnd,
	_processAgentEvent,
} from "../../packages/coding-agent/src/core/agent-session-events.js";
import { setThinkingLevel } from "../../packages/coding-agent/src/core/agent-session-models.js";
import {
	_clearFallbackModelScope,
	_handleRetryableError,
	_isFallbackableError,
	_isRetryableError,
	_restoreFallbackModel,
	_trySwitchToFallbackModel,
} from "../../packages/coding-agent/src/core/agent-session-retry.js";
import type { CreateAgentSessionFromServicesOptions } from "../../packages/coding-agent/src/core/agent-session-services.js";

function model(provider: string, id: string): Model<Api> {
	return {
		provider,
		id,
		api: provider as Api,
		contextWindow: 200_000,
		reasoning: true,
	} as Model<Api>;
}

function retryableMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		stopReason: "error",
		errorMessage: "Not Found",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		...overrides,
	} as AssistantMessage;
}

test("main-chat retry classifies structured provider transport diagnostics", () => {
	const session = { model: model("openai-codex", "gpt-5.5") };
	const diagnostics = [
		{
			type: "provider_transport_failure",
			timestamp: Date.now(),
			error: { message: "WebSocket error", status: 404 },
		},
	];
	const message = retryableMessage({ diagnostics } as unknown as Partial<AssistantMessage>);
	const diagnosticOnlyMessage = retryableMessage({
		errorMessage: undefined,
		diagnostics,
	} as unknown as Partial<AssistantMessage>);

	assert.equal(_isRetryableError.call(session as never, message), true);
	assert.equal(_isRetryableError.call(session as never, diagnosticOnlyMessage), true);
	assert.equal(_isRetryableError.call(session as never, retryableMessage({ errorMessage: "Tool not found" })), false);
	assert.equal(
		_isRetryableError.call(
			session as never,
			retryableMessage({
				errorMessage: "The model refused to complete the request",
				diagnostics: [{ type: "provider_transport_failure", error: { name: "AbortError", message: "aborted" } }],
			} as unknown as Partial<AssistantMessage>),
		),
		false,
	);
	assert.equal(_isRetryableError.call(session as never, retryableMessage({ errorMessage: "model not found" })), false);
	assert.equal(
		_isFallbackableError.call(session as never, retryableMessage({ errorMessage: "model not found" })),
		true,
	);
	assert.equal(
		_isRetryableError.call(
			session as never,
			retryableMessage({ errorMessage: undefined, code: "model_not_found" } as unknown as Partial<AssistantMessage>),
		),
		false,
	);
	assert.equal(
		_isFallbackableError.call(
			session as never,
			retryableMessage({ errorMessage: undefined, code: "model_not_found" } as unknown as Partial<AssistantMessage>),
		),
		true,
	);
});
test("main chat treats rejected credentials as fallbackable but not same-model retryable", () => {
	const session = { model: model("openai-codex", "gpt-5.5") };
	const message = retryableMessage({ errorMessage: "OAuth token invalidated" });

	assert.equal(_isFallbackableError.call(session as never, message), true);
	assert.equal(_isRetryableError.call(session as never, message), false);
});

test("main-chat fallback switches models after same-model retry exhaustion", async () => {
	const primary = model("openai-codex", "gpt-5.5");
	const fallback = model("anthropic", "claude-opus-4-8");
	const events: Array<{ type: string; [key: string]: unknown }> = [];
	let continued = false;
	const session = {
		model: primary,
		thinkingLevel: "high" as ThinkingLevel,
		_fallbackModels: ["anthropic/claude-opus-4-8:high"],
		_fallbackAttemptedKeys: new Set<string>(),
		_fallbackBlockedModels: [] as Model<Api>[],
		_retryAttempt: 0,
		settingsManager: {
			getRetrySettings: () => ({ enabled: true, maxRetries: 0, baseDelayMs: 1 }),
			getDefaultThinkingLevel: () => "high" as ThinkingLevel,
			getDefaultProvider: () => "openai-codex",
		},
		_modelRuntime: {
			getAvailableSnapshot: () => [primary, fallback],
			getModel: (provider: string, id: string) =>
				provider === fallback.provider && id === fallback.id ? fallback : undefined,
			hasConfiguredAuth: (provider: string) => provider === fallback.provider || provider === primary.provider,
		},
		agent: {
			state: {
				model: primary,
				thinkingLevel: "high" as ThinkingLevel,
				messages: [retryableMessage()],
			},
			continue: async () => {
				continued = true;
			},
		},
		sessionManager: {
			appendModelChange: (provider: string, id: string) => events.push({ type: "session_model", provider, id }),
			appendThinkingLevelChange: (level: ThinkingLevel) => events.push({ type: "session_thinking", level }),
		},
		_withContextWindowForModelSwitch: (candidate: Model<Api>) => candidate,
		_refreshBaseSystemPromptFromActiveTools: () => undefined,
		_emitModelChanged: (next: Model<Api>, previous: Model<Api> | undefined, source: string) =>
			events.push({ type: "model_changed", next: next.id, previous: previous?.id, source }),
		_emitModelSelect: async (next: Model<Api>, previous: Model<Api> | undefined, source: string) =>
			events.push({ type: "model_select", next: next.id, previous: previous?.id, source }),
		_emit: (event: { type: string; [key: string]: unknown }) => events.push(event),
		_resolveRetry: () => events.push({ type: "resolve_retry" }),
		_trySwitchToFallbackModel,
	};

	const handled = await _handleRetryableError.call(session as never, retryableMessage());
	const autoRetryEndIndex = events.findIndex((event) => event.type === "auto_retry_end");
	const fallbackStartIndex = events.findIndex((event) => event.type === "model_fallback_start");
	assert.ok(autoRetryEndIndex >= 0, "retry exhaustion should close the retry lifecycle before fallback");
	assert.ok(fallbackStartIndex >= 0, "fallback should start after retry exhaustion");
	assert.ok(autoRetryEndIndex < fallbackStartIndex, "retry cleanup should be emitted before fallback start");
	assert.equal(
		events.some((event) => event.type === "model_fallback_end"),
		false,
	);
	await new Promise((resolve) => setTimeout(resolve, 5));
	assert.equal(handled, true);
	assert.equal(session.agent.state.model, fallback);
	assert.equal(session.agent.state.thinkingLevel, "high");
	assert.equal(session.agent.state.messages.length, 0);
	assert.equal(continued, true);
	assert.ok(events.some((event) => event.type === "model_fallback_start" && event.to === "anthropic/claude-opus-4-8"));
	assert.ok(events.some((event) => event.type === "model_changed" && event.source === "fallback"));
	assert.ok(events.some((event) => event.type === "session_model" && event.provider === "anthropic"));
});

test("main-chat fallback restores the primary model at the next turn boundary", async () => {
	const primary = model("openai-codex", "gpt-5.5");
	const fallback = model("anthropic", "claude-opus-4-8");
	const events: Array<{ type: string; [key: string]: unknown }> = [];
	const session = {
		model: primary,
		thinkingLevel: "high" as ThinkingLevel,
		_fallbackModels: ["anthropic/claude-opus-4-8:high"],
		_fallbackAttemptedKeys: new Set<string>(),
		_fallbackBlockedModels: [] as Model<Api>[],
		_retryAttempt: 0,
		settingsManager: {
			getDefaultThinkingLevel: () => "high" as ThinkingLevel,
			getDefaultProvider: () => "openai-codex",
		},
		_modelRuntime: {
			getAvailableSnapshot: () => [primary, fallback],
			getModel: (provider: string, id: string) =>
				provider === fallback.provider && id === fallback.id ? fallback : undefined,
			hasConfiguredAuth: () => true,
		},
		agent: {
			state: { model: primary, thinkingLevel: "high" as ThinkingLevel, messages: [retryableMessage()] },
			continue: async () => undefined,
		},
		sessionManager: {
			appendModelChange: (provider: string, id: string) => events.push({ type: "session_model", provider, id }),
			appendThinkingLevelChange: (level: ThinkingLevel) => events.push({ type: "session_thinking", level }),
		},
		_withContextWindowForModelSwitch: (candidate: Model<Api>) => candidate,
		_refreshBaseSystemPromptFromActiveTools: () => undefined,
		_emitModelChanged: (next: Model<Api>, previous: Model<Api> | undefined, source: string) =>
			events.push({ type: "model_changed", next: next.id, previous: previous?.id, source }),
		_emitModelSelect: async () => undefined,
		_emit: (event: { type: string; [key: string]: unknown }) => events.push(event),
	};

	assert.equal(await _trySwitchToFallbackModel.call(session as never, retryableMessage()), true);
	await new Promise((resolve) => setTimeout(resolve, 5));
	assert.equal(session.agent.state.model, fallback);

	assert.equal(await _restoreFallbackModel.call(session as never), true);
	assert.equal(session.agent.state.model, primary);
	assert.equal(session.agent.state.thinkingLevel, "high");
	assert.ok(events.some((event) => event.type === "model_changed" && event.source === "restore"));
	assert.ok(events.some((event) => event.type === "model_fallback_end" && event.success === true));
	assert.equal(await _restoreFallbackModel.call(session as never), false);
});

test("a transient failure can still change reasoning on the same provider/model", async () => {
	// Rate limits and transport blips clear on their own, so the same model at
	// another reasoning level stays a legitimate candidate.
	const transient = retryableMessage({ errorMessage: "rate limit exceeded" });
	const primary = model("openai", "gpt-5-mini");
	const events: Array<{ type: string; [key: string]: unknown }> = [];
	const session = {
		model: primary,
		thinkingLevel: "high" as ThinkingLevel,
		_fallbackModels: ["openai/gpt-5-mini:low"],
		_fallbackAttemptedKeys: new Set<string>(),
		_fallbackBlockedModels: [] as Model<Api>[],
		_retryAttempt: 0,
		settingsManager: {
			getDefaultThinkingLevel: () => "high" as ThinkingLevel,
			getDefaultProvider: () => "openai",
		},
		_modelRuntime: {
			getAvailableSnapshot: () => [primary],
			getModel: (provider: string, id: string) =>
				provider === primary.provider && id === primary.id ? primary : undefined,
			hasConfiguredAuth: () => true,
		},
		agent: {
			state: { model: primary, thinkingLevel: "high" as ThinkingLevel, messages: [transient] },
			continue: async () => undefined,
		},
		sessionManager: {
			appendModelChange: (provider: string, id: string) => events.push({ type: "session_model", provider, id }),
			appendThinkingLevelChange: (level: ThinkingLevel) => events.push({ type: "session_thinking", level }),
		},
		_withContextWindowForModelSwitch: (candidate: Model<Api>) => candidate,
		_refreshBaseSystemPromptFromActiveTools: () => undefined,
		_emitModelChanged: () => undefined,
		_emitModelSelect: async () => undefined,
		_emit: (event: { type: string; [key: string]: unknown }) => events.push(event),
	};

	const handled = await _trySwitchToFallbackModel.call(session as never, transient);

	assert.equal(handled, true);
	assert.equal(session.agent.state.model, primary);
	assert.equal(session.agent.state.thinkingLevel, "low");
	assert.ok(events.some((event) => event.type === "model_fallback_start"));
	assert.ok(events.some((event) => event.type === "session_thinking" && event.level === "low"));
});

test("service-based SDK session options include fallbackModels", () => {
	const fallbackModels = ["anthropic/claude-opus-4-8:high"] satisfies NonNullable<
		CreateAgentSessionFromServicesOptions["fallbackModels"]
	>;
	assert.deepEqual(fallbackModels, ["anthropic/claude-opus-4-8:high"]);
});

test("main-chat retry-disabled fallback keeps prompt waiting for fallback completion", async () => {
	const primary = model("openai-codex", "gpt-5.5");
	const fallback = model("anthropic", "claude-opus-4-8");
	const message = retryableMessage({ errorMessage: "rate limit" });
	let continued = false;
	const session = {
		model: primary,
		thinkingLevel: "high" as ThinkingLevel,
		_fallbackModels: ["anthropic/claude-opus-4-8:high"],
		_fallbackAttemptedKeys: new Set<string>(),
		_fallbackBlockedModels: [] as Model<Api>[],
		_retryAttempt: 0,
		_retryPromise: undefined as Promise<void> | undefined,
		_retryResolve: undefined as (() => void) | undefined,
		settingsManager: {
			getRetrySettings: () => ({ enabled: false, maxRetries: 0, baseDelayMs: 1 }),
			getDefaultThinkingLevel: () => "high" as ThinkingLevel,
			getDefaultProvider: () => "openai-codex",
		},
		_modelRuntime: {
			getAvailableSnapshot: () => [primary, fallback],
			getModel: (provider: string, id: string) =>
				provider === fallback.provider && id === fallback.id ? fallback : undefined,
			hasConfiguredAuth: (provider: string) => provider === fallback.provider || provider === primary.provider,
		},
		agent: {
			state: { model: primary, thinkingLevel: "high" as ThinkingLevel, messages: [message] },
			continue: async () => {
				continued = true;
			},
		},
		sessionManager: {
			appendModelChange: () => undefined,
			appendThinkingLevelChange: () => undefined,
		},
		_findLastAssistantInMessages: () => message,
		_isRetryableError,
		_isEmptyCompletion: () => false,
		_isSafetyRefusal: () => false,
		_withContextWindowForModelSwitch: (candidate: Model<Api>) => candidate,
		_refreshBaseSystemPromptFromActiveTools: () => undefined,
		_emitModelChanged: () => undefined,
		_emitModelSelect: async () => undefined,
		_emit: () => undefined,
		_resolveRetry() {
			this._retryResolve?.();
			this._retryPromise = undefined;
			this._retryResolve = undefined;
		},
		_trySwitchToFallbackModel,
	};

	_createRetryPromiseForAgentEnd.call(session as never, { type: "agent_end", messages: [message] });
	assert.ok(session._retryPromise, "retry-disabled fallback should create a wait promise");

	const handled = await _handleRetryableError.call(session as never, message);
	assert.equal(handled, true);
	await new Promise((resolve) => setTimeout(resolve, 5));
	assert.equal(continued, true);

	const waitState = await Promise.race([
		session._retryPromise!.then(() => "resolved"),
		new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 5)),
	]);
	assert.equal(waitState, "pending");

	session._resolveRetry();
	await session._retryPromise;
});

test("main-chat fallback rejection settles the retry wait", async () => {
	const primary = model("openai-codex", "gpt-5.5");
	const fallback = model("anthropic", "claude-opus-4-8");
	const events: Array<{ type: string; [key: string]: unknown }> = [];
	let resolveRetry: (() => void) | undefined;
	const retryPromise = new Promise<void>((resolve) => {
		resolveRetry = resolve;
	});
	const session = {
		model: primary,
		thinkingLevel: "high" as ThinkingLevel,
		_fallbackModels: ["anthropic/claude-opus-4-8:high"],
		_fallbackAttemptedKeys: new Set<string>(),
		_fallbackBlockedModels: [] as Model<Api>[],
		_retryAttempt: 1,
		_retryPromise: retryPromise as Promise<void> | undefined,
		_retryResolve: resolveRetry as (() => void) | undefined,
		settingsManager: {
			getDefaultThinkingLevel: () => "high" as ThinkingLevel,
			getDefaultProvider: () => "openai-codex",
		},
		_modelRuntime: {
			getAvailableSnapshot: () => [primary, fallback],
			getModel: (provider: string, id: string) =>
				provider === fallback.provider && id === fallback.id ? fallback : undefined,
			hasConfiguredAuth: (provider: string) => provider === fallback.provider || provider === primary.provider,
		},
		agent: {
			state: { model: primary, thinkingLevel: "high" as ThinkingLevel, messages: [retryableMessage()] },
			continue: async () => {
				throw new Error("fallback auth failed");
			},
		},
		sessionManager: {
			appendModelChange: () => undefined,
			appendThinkingLevelChange: () => undefined,
		},
		_withContextWindowForModelSwitch: (candidate: Model<Api>) => candidate,
		_refreshBaseSystemPromptFromActiveTools: () => undefined,
		_emitModelChanged: () => undefined,
		_emitModelSelect: async () => undefined,
		_emit: (event: { type: string; [key: string]: unknown }) => events.push(event),
		_resolveRetry() {
			this._retryResolve?.();
			this._retryPromise = undefined;
			this._retryResolve = undefined;
		},
	};

	const handled = await _trySwitchToFallbackModel.call(session as never, retryableMessage());
	assert.equal(handled, true);

	const waitState = await Promise.race([
		retryPromise.then(() => "resolved"),
		new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 20)),
	]);

	assert.equal(waitState, "resolved");
	assert.equal(session._retryPromise, undefined);
	assert.ok(
		events.some(
			(event) =>
				event.type === "model_fallback_end" &&
				event.success === false &&
				event.finalError === "fallback auth failed",
		),
	);
});

test("main-chat fallback continuation resolution does not mark assistant errors successful", async () => {
	const primary = model("openai-codex", "gpt-5.5");
	const fallback = model("anthropic", "claude-opus-4-8");
	const fallbackError = retryableMessage({ errorMessage: "rate limit" });
	const events: Array<{ type: string; [key: string]: unknown }> = [];
	const session = {
		model: primary,
		thinkingLevel: "high" as ThinkingLevel,
		_fallbackModels: ["anthropic/claude-opus-4-8:high"],
		_fallbackAttemptedKeys: new Set<string>(),
		_fallbackBlockedModels: [] as Model<Api>[],
		_retryAttempt: 0,
		settingsManager: {
			getDefaultThinkingLevel: () => "high" as ThinkingLevel,
			getDefaultProvider: () => "openai-codex",
		},
		_modelRuntime: {
			getAvailableSnapshot: () => [primary, fallback],
			getModel: (provider: string, id: string) =>
				provider === fallback.provider && id === fallback.id ? fallback : undefined,
			hasConfiguredAuth: (provider: string) => provider === fallback.provider || provider === primary.provider,
		},
		agent: {
			state: { model: primary, thinkingLevel: "high" as ThinkingLevel, messages: [retryableMessage()] },
			async continue() {
				this.state.messages.push(fallbackError);
			},
		},
		sessionManager: {
			appendModelChange: () => undefined,
			appendThinkingLevelChange: () => undefined,
		},
		_withContextWindowForModelSwitch: (candidate: Model<Api>) => candidate,
		_refreshBaseSystemPromptFromActiveTools: () => undefined,
		_emitModelChanged: () => undefined,
		_emitModelSelect: async () => undefined,
		_emit: (event: { type: string; [key: string]: unknown }) => events.push(event),
	};

	const handled = await _trySwitchToFallbackModel.call(session as never, retryableMessage());
	assert.equal(handled, true);
	await new Promise((resolve) => setTimeout(resolve, 5));

	assert.equal(session.agent.state.messages.at(-1), fallbackError);
	assert.equal(
		events.some((event) => event.type === "model_fallback_end" && event.success === true),
		false,
	);
});

test("a rejected codex credential advances to the next candidate without re-requesting the same model", async () => {
	const primary = model("openai-codex", "gpt-5.5");
	const fallback = model("anthropic", "claude-opus-4-8");
	const invalidated = retryableMessage({ errorMessage: "OAuth token invalidated" });
	const events: Array<{ type: string; [key: string]: unknown }> = [];
	let continued = 0;
	const session = {
		model: primary,
		thinkingLevel: "high" as ThinkingLevel,
		_fallbackModels: ["anthropic/claude-opus-4-8:high"],
		_fallbackAttemptedKeys: new Set<string>(),
		_fallbackBlockedModels: [] as Model<Api>[],
		_retryAttempt: 0,
		settingsManager: {
			// Same-model retry is enabled and generously budgeted; a dead credential
			// must still skip it entirely.
			getRetrySettings: () => ({ enabled: true, maxRetries: 3, baseDelayMs: 1000 }),
			getDefaultThinkingLevel: () => "high" as ThinkingLevel,
			getDefaultProvider: () => "openai-codex",
		},
		_modelRuntime: {
			getAvailableSnapshot: () => [primary, fallback],
			getModel: (provider: string, id: string) =>
				provider === fallback.provider && id === fallback.id ? fallback : undefined,
			hasConfiguredAuth: () => true,
		},
		agent: {
			state: { model: primary, thinkingLevel: "high" as ThinkingLevel, messages: [invalidated] },
			continue: async () => {
				continued += 1;
			},
		},
		sessionManager: {
			appendModelChange: (provider: string, id: string) => events.push({ type: "session_model", provider, id }),
			appendThinkingLevelChange: () => undefined,
		},
		_withContextWindowForModelSwitch: (candidate: Model<Api>) => candidate,
		_refreshBaseSystemPromptFromActiveTools: () => undefined,
		_emitModelChanged: () => undefined,
		_emitModelSelect: async () => undefined,
		_emit: (event: { type: string; [key: string]: unknown }) => events.push(event),
		_resolveRetry: () => undefined,
		_isRetryableError,
		_isFallbackableError,
		_trySwitchToFallbackModel,
	};

	const handled = await _handleRetryableError.call(session as never, invalidated);
	await new Promise((resolve) => setTimeout(resolve, 5));

	assert.equal(handled, true);
	assert.equal(
		events.some((event) => event.type === "auto_retry_start"),
		false,
		"a revoked credential must not be re-requested on the same model",
	);
	assert.ok(events.some((event) => event.type === "model_fallback_start" && event.to === "anthropic/claude-opus-4-8"));
	assert.equal(session.agent.state.model, fallback);
	assert.equal(continued, 1);
});

test("an explicit /model choice during a fallback is not overwritten by the restore", async () => {
	const primary = model("openai-codex", "gpt-5.5");
	const fallback = model("anthropic", "claude-opus-4-8");
	const chosen = model("openai", "gpt-5-mini");
	const events: Array<{ type: string; [key: string]: unknown }> = [];
	const session = {
		model: primary,
		thinkingLevel: "high" as ThinkingLevel,
		_fallbackModels: ["anthropic/claude-opus-4-8:high"],
		_fallbackAttemptedKeys: new Set<string>(),
		_fallbackBlockedModels: [] as Model<Api>[],
		_retryAttempt: 0,
		settingsManager: {
			getDefaultThinkingLevel: () => "high" as ThinkingLevel,
			getDefaultProvider: () => "openai-codex",
		},
		_modelRuntime: {
			getAvailableSnapshot: () => [primary, fallback, chosen],
			getModel: (provider: string, id: string) =>
				provider === fallback.provider && id === fallback.id ? fallback : undefined,
			hasConfiguredAuth: () => true,
		},
		agent: {
			state: { model: primary, thinkingLevel: "high" as ThinkingLevel, messages: [retryableMessage()] },
			continue: async () => undefined,
		},
		sessionManager: {
			appendModelChange: (provider: string, id: string) => events.push({ type: "session_model", provider, id }),
			appendThinkingLevelChange: () => undefined,
		},
		_withContextWindowForModelSwitch: (candidate: Model<Api>) => candidate,
		_refreshBaseSystemPromptFromActiveTools: () => undefined,
		_emitModelChanged: (next: Model<Api>, previous: Model<Api> | undefined, source: string) =>
			events.push({ type: "model_changed", next: next.id, previous: previous?.id, source }),
		_emitModelSelect: async () => undefined,
		_emit: (event: { type: string; [key: string]: unknown }) => events.push(event),
	};

	assert.equal(await _trySwitchToFallbackModel.call(session as never, retryableMessage()), true);
	await new Promise((resolve) => setTimeout(resolve, 5));
	assert.equal(session.agent.state.model, fallback);

	// setModel()/cycleModel() cancel the pending restore before applying the
	// user's explicit choice.
	_clearFallbackModelScope.call(session as never);
	session.agent.state.model = chosen;

	assert.equal(await _restoreFallbackModel.call(session as never), false);
	assert.equal(session.agent.state.model, chosen, "the explicit choice must survive the turn boundary");
	assert.equal(
		events.some((event) => event.type === "model_changed" && event.source === "restore"),
		false,
	);
	assert.ok(events.some((event) => event.type === "model_fallback_end"));
});

function overflowMessage(): AssistantMessage {
	return retryableMessage({
		errorMessage: "context_length_exceeded: prompt is too long for this model",
		provider: "openai-codex",
		model: "gpt-5.5",
		timestamp: Date.now(),
	} as unknown as Partial<AssistantMessage>);
}

/** Session double for the `agent_end` branch of `_processAgentEvent`. */
function overflowTurnSession(checkCompaction: (session: Record<string, unknown>) => void): {
	session: Record<string, unknown>;
	switched: AssistantMessage[];
	restored: number;
} {
	const switched: AssistantMessage[] = [];
	const counters = { restored: 0 };
	const session: Record<string, unknown> = {
		model: model("openai-codex", "gpt-5.5"),
		_lastAssistantMessage: overflowMessage(),
		_protectedStreamingCustomMessages: [],
		_fallbackAttemptedKeys: new Set<string>(),
		_fallbackBlockedModels: [] as Model<Api>[],
		_postToolCompactionPreflightError: undefined,
		_pendingPostCompactionContinuation: undefined,
		_contextOverflowUnresolved: false,
		_applyInterruptAbortMessage: () => undefined,
		_applyProviderErrorGuidance: () => undefined,
		_emitExtensionEvent: async () => undefined,
		_emit: () => undefined,
		_isFallbackableError,
		_isRetryableError,
		_isEmptyCompletion: () => false,
		_isSafetyRefusal: () => false,
		_handleRetryableError: async () => false,
		_resolveRetry: () => undefined,
		_checkCompaction: async () => checkCompaction(session),
		_trySwitchToFallbackModel: async (message: AssistantMessage) => {
			switched.push(message);
			return true;
		},
		_restoreFallbackModel: async () => {
			counters.restored += 1;
			return false;
		},
	};
	return {
		session,
		switched,
		get restored() {
			return counters.restored;
		},
	};
}

test("a compactable context overflow does not spend a fallback candidate", async () => {
	// Compaction recovers the turn, so it must keep the current model.
	const probe = overflowTurnSession(() => undefined);

	await _processAgentEvent.call(probe.session as never, { type: "agent_end" } as never);

	assert.deepEqual(probe.switched, []);
	assert.equal(probe.session._contextOverflowUnresolved, false);
});

test("an unresolved context overflow advances to the next fallback candidate", async () => {
	const probe = overflowTurnSession((session) => {
		session._contextOverflowUnresolved = true;
	});

	await _processAgentEvent.call(probe.session as never, { type: "agent_end" } as never);

	assert.equal(probe.switched.length, 1, "an overflow compaction cannot fix must reach the fallback chain");
	assert.equal(probe.switched[0]?.errorMessage, overflowMessage().errorMessage);
	assert.equal(probe.session._contextOverflowUnresolved, false);
	assert.equal(probe.restored, 0, "a successful switch owns the turn and must not restore yet");
});

test("compaction disabled marks a same-model context overflow unresolved", async () => {
	const session = {
		model: model("openai-codex", "gpt-5.5"),
		_contextOverflowUnresolved: false,
		_pendingPostToolCompactionGuard: undefined,
		_postToolCompactionPreflightError: undefined,
		settingsManager: { getCompactionSettings: () => ({ enabled: false }) },
		_emit: () => undefined,
	};

	await _checkCompaction.call(session as never, overflowMessage());

	assert.equal(session._contextOverflowUnresolved, true);
});

test("compaction disabled leaves an ordinary provider error resolvable by same-model retry", async () => {
	const session = {
		model: model("openai-codex", "gpt-5.5"),
		_contextOverflowUnresolved: false,
		_pendingPostToolCompactionGuard: undefined,
		_postToolCompactionPreflightError: undefined,
		settingsManager: { getCompactionSettings: () => ({ enabled: false }) },
		_emit: () => undefined,
	};

	await _checkCompaction.call(
		session as never,
		retryableMessage({
			errorMessage: "rate limit",
			provider: "openai-codex",
			model: "gpt-5.5",
		} as unknown as Partial<AssistantMessage>),
	);

	assert.equal(session._contextOverflowUnresolved, false);
});

test("a failed overflow compaction advances the real fallback chain end to end", async () => {
	// Runs the production compaction path — _checkCompaction into
	// _runAutoCompaction — and the production fallback switch, rather than
	// injecting the unresolved flag.
	const primary = model("openai-codex", "gpt-5.5");
	const fallback = model("anthropic", "claude-opus-4-8");
	const overflow = overflowMessage();
	const events: Array<{ type: string; [key: string]: unknown }> = [];
	let continued = 0;
	const session: Record<string, unknown> = {
		model: primary,
		thinkingLevel: "high" as ThinkingLevel,
		_lastAssistantMessage: overflow,
		_protectedStreamingCustomMessages: [],
		_postToolCompactionPreflightError: undefined,
		_pendingPostToolCompactionGuard: undefined,
		_pendingPostCompactionContinuation: undefined,
		_contextOverflowUnresolved: false,
		_overflowRecoveryAttempted: false,
		_fallbackModels: ["anthropic/claude-opus-4-8:high"],
		_fallbackAttemptedKeys: new Set<string>(),
		_fallbackBlockedModels: [] as Model<Api>[],
		_retryAttempt: 0,
		settingsManager: {
			getCompactionSettings: () => ({ enabled: true }),
			getDefaultThinkingLevel: () => "high" as ThinkingLevel,
			getDefaultProvider: () => "openai-codex",
		},
		_modelRuntime: {
			getAvailableSnapshot: () => [primary, fallback],
			getModel: (provider: string, id: string) =>
				provider === fallback.provider && id === fallback.id ? fallback : undefined,
			hasConfiguredAuth: () => true,
		},
		agent: {
			state: { model: primary, thinkingLevel: "high" as ThinkingLevel, messages: [overflow] },
			continue: async () => {
				continued += 1;
			},
		},
		sessionManager: {
			getBranch: () => [],
			appendModelChange: (provider: string, id: string) => events.push({ type: "session_model", provider, id }),
			appendThinkingLevelChange: () => undefined,
		},
		// The compaction planner fails, which is what makes the overflow unresolved.
		_applyVerbatimCompaction: async () => {
			throw new Error("planner unavailable");
		},
		_getRequiredRequestAuth: async () => ({}),
		_dropTrailingAutoCompactionRetryAssistantIfPresent: () => undefined,
		_schedulePostAutoCompactionContinuationProbe: () => undefined,
		_withContextWindowForModelSwitch: (candidate: Model<Api>) => candidate,
		_refreshBaseSystemPromptFromActiveTools: () => undefined,
		_applyInterruptAbortMessage: () => undefined,
		_applyProviderErrorGuidance: () => undefined,
		_emitExtensionEvent: async () => undefined,
		_emit: (event: { type: string; [key: string]: unknown }) => events.push(event),
		_emitModelChanged: () => undefined,
		_emitModelSelect: async () => undefined,
		_resolveRetry: () => undefined,
		_isFallbackableError,
		_isRetryableError,
		_isEmptyCompletion: () => false,
		_isSafetyRefusal: () => false,
		_handleRetryableError: async () => false,
		_restoreFallbackModel: async () => false,
		// Production compaction and fallback implementations.
		_checkCompaction,
		_runAutoCompaction,
		_trySwitchToFallbackModel,
	};

	await _processAgentEvent.call(session as never, { type: "agent_end" } as never);
	await new Promise((resolve) => setTimeout(resolve, 5));

	assert.ok(
		events.some((event) => event.type === "compaction_end" && event.unresolvedOverflow === true),
		"a failed overflow compaction must report the overflow unresolved",
	);
	assert.ok(
		events.some((event) => event.type === "model_fallback_start" && event.to === "anthropic/claude-opus-4-8"),
		"the unresolved overflow must reach the fallback chain",
	);
	assert.equal((session.agent as { state: { model: Model<Api> } }).state.model, fallback);
	assert.equal(continued, 1);
	assert.equal(session._contextOverflowUnresolved, false);
});

/** Session double sufficient for `_trySwitchToFallbackModel` and `setThinkingLevel`. */
function thinkingLevelFallbackSession(
	primary: Model<Api>,
	fallback: Model<Api>,
	events: Array<{ type: string; [key: string]: unknown }>,
): Record<string, unknown> {
	return {
		model: primary,
		thinkingLevel: "high" as ThinkingLevel,
		_fallbackModels: ["anthropic/claude-opus-4-8:high"],
		_fallbackAttemptedKeys: new Set<string>(),
		_fallbackBlockedModels: [] as Model<Api>[],
		_retryAttempt: 0,
		settingsManager: {
			getDefaultThinkingLevel: () => "high" as ThinkingLevel,
			getDefaultProvider: () => "openai-codex",
			setDefaultThinkingLevel: (level: ThinkingLevel) => events.push({ type: "settings_thinking", level }),
		},
		_modelRuntime: {
			getAvailableSnapshot: () => [primary, fallback],
			getModel: (provider: string, id: string) =>
				provider === fallback.provider && id === fallback.id ? fallback : undefined,
			hasConfiguredAuth: () => true,
		},
		agent: {
			state: { model: primary, thinkingLevel: "high" as ThinkingLevel, messages: [retryableMessage()] },
			continue: async () => undefined,
		},
		sessionManager: {
			appendModelChange: (provider: string, id: string) => events.push({ type: "session_model", provider, id }),
			appendThinkingLevelChange: (level: ThinkingLevel) => events.push({ type: "session_thinking", level }),
		},
		getAvailableThinkingLevels: () => ["off", "low", "medium", "high"] as ThinkingLevel[],
		_clampThinkingLevel: (level: ThinkingLevel) => level,
		supportsThinking: () => true,
		_extensionRunner: { emit: async () => undefined },
		_withContextWindowForModelSwitch: (candidate: Model<Api>) => candidate,
		_refreshBaseSystemPromptFromActiveTools: () => undefined,
		_emitModelChanged: (next: Model<Api>, previous: Model<Api> | undefined, source: string) =>
			events.push({ type: "model_changed", next: next.id, previous: previous?.id, source }),
		_emitModelSelect: async () => undefined,
		_emit: (event: { type: string; [key: string]: unknown }) => events.push(event),
		_clearFallbackModelScope,
	};
}

test("a reasoning-level change during a fallback still restores the primary model", async () => {
	const primary = model("openai-codex", "gpt-5.5");
	const fallback = model("anthropic", "claude-opus-4-8");
	const events: Array<{ type: string; [key: string]: unknown }> = [];
	const session = thinkingLevelFallbackSession(primary, fallback, events);
	const state = (session.agent as { state: { model: Model<Api>; thinkingLevel: ThinkingLevel } }).state;

	assert.equal(await _trySwitchToFallbackModel.call(session as never, retryableMessage()), true);
	await new Promise((resolve) => setTimeout(resolve, 5));
	assert.equal(state.model, fallback);

	// A reasoning choice is not a model choice and must not cancel the restore.
	setThinkingLevel.call(session as never, "low" as ThinkingLevel);

	assert.equal(await _restoreFallbackModel.call(session as never), true);
	assert.equal(state.model, primary, "a reasoning change must not strand the session on the fallback");
	assert.equal(state.thinkingLevel, "low", "the explicit reasoning choice must survive the restore");
});

test("a registry refresh re-applying the current level leaves the pending restore intact", async () => {
	const primary = model("openai-codex", "gpt-5.5");
	const fallback = model("anthropic", "claude-opus-4-8");
	const events: Array<{ type: string; [key: string]: unknown }> = [];
	const session = thinkingLevelFallbackSession(primary, fallback, events);
	const state = (session.agent as { state: { model: Model<Api>; thinkingLevel: ThinkingLevel } }).state;

	assert.equal(await _trySwitchToFallbackModel.call(session as never, retryableMessage()), true);
	await new Promise((resolve) => setTimeout(resolve, 5));

	// agent-session-extension-bindings re-applies the current level on registry
	// refresh, which must be a no-op for the fallback scope.
	setThinkingLevel.call(session as never, state.thinkingLevel);

	assert.equal(await _restoreFallbackModel.call(session as never), true);
	assert.equal(state.model, primary);
	assert.equal(state.thinkingLevel, "high");
});

test("a gRPC ResourceExhausted failure is both same-model retryable and fallbackable", () => {
	// Upstream pi-ai retries this; the shared classifier must agree so a
	// session with no fallback chain still spends its same-model retry budget.
	const session = { model: model("openai", "gpt-5.5") };
	const message = retryableMessage({ errorMessage: "ResourceExhausted" });

	assert.equal(_isRetryableError.call(session as never, message), true);
	assert.equal(_isFallbackableError.call(session as never, message), true);
});

test("a terminal provider failure skips reasoning-only variants of the failed model", async () => {
	// The credential, not the reasoning effort, is what failed. Re-requesting the
	// same provider/model at another level would spend a candidate on the same
	// dead credential, so the chain must reach a different provider.
	const primary = model("openai-codex", "gpt-5.5");
	const anthropic = model("anthropic", "claude-opus-4-8");
	const invalidated = retryableMessage({ errorMessage: "OAuth token invalidated" });
	const events: Array<{ type: string; [key: string]: unknown }> = [];
	const continuedOn: Array<string | undefined> = [];
	const session = {
		model: primary,
		thinkingLevel: "high" as ThinkingLevel,
		_fallbackModels: ["openai-codex/gpt-5.5:low", "anthropic/claude-opus-4-8:high"],
		_fallbackAttemptedKeys: new Set<string>(),
		_fallbackBlockedModels: [] as Model<Api>[],
		_retryAttempt: 0,
		settingsManager: {
			getRetrySettings: () => ({ enabled: true, maxRetries: 3, baseDelayMs: 1000 }),
			getDefaultThinkingLevel: () => "high" as ThinkingLevel,
			getDefaultProvider: () => "openai-codex",
		},
		_modelRuntime: {
			getAvailableSnapshot: () => [primary, anthropic],
			getModel: (provider: string, id: string) => {
				if (provider === primary.provider && id === primary.id) return primary;
				return provider === anthropic.provider && id === anthropic.id ? anthropic : undefined;
			},
			hasConfiguredAuth: () => true,
		},
		agent: {
			state: { model: primary, thinkingLevel: "high" as ThinkingLevel, messages: [invalidated] },
			continue: async () => {
				continuedOn.push(session.agent.state.model.id === primary.id ? "openai-codex" : "anthropic");
			},
		},
		sessionManager: {
			appendModelChange: (provider: string, id: string) => events.push({ type: "session_model", provider, id }),
			appendThinkingLevelChange: () => undefined,
		},
		_withContextWindowForModelSwitch: (candidate: Model<Api>) => candidate,
		_refreshBaseSystemPromptFromActiveTools: () => undefined,
		_emitModelChanged: () => undefined,
		_emitModelSelect: async () => undefined,
		_emit: (event: { type: string; [key: string]: unknown }) => events.push(event),
		_resolveRetry: () => undefined,
		_isRetryableError,
		_isFallbackableError,
		_trySwitchToFallbackModel,
	};

	assert.equal(await _handleRetryableError.call(session as never, invalidated), true);
	await new Promise((resolve) => setTimeout(resolve, 5));

	assert.equal(
		events.some((event) => event.type === "auto_retry_start"),
		false,
		"a rejected credential must not be re-requested on the same model",
	);
	const starts = events.filter((event) => event.type === "model_fallback_start");
	assert.equal(starts.length, 1);
	assert.equal(starts[0]?.from, "openai-codex/gpt-5.5");
	assert.equal(starts[0]?.to, "anthropic/claude-opus-4-8", "the reasoning-only variant must be skipped");
	assert.notEqual(starts[0]?.from, starts[0]?.to);
	assert.equal(session.agent.state.model, anthropic);
	assert.deepEqual(continuedOn, ["anthropic"], "exactly one continuation, on a different provider");
});

test("a blocked model stays blocked for the rest of the turn", async () => {
	// After moving to another provider, a later failure must not walk back into a
	// reasoning variant of the model whose credential is already known dead.
	const primary = model("openai-codex", "gpt-5.5");
	const anthropic = model("anthropic", "claude-opus-4-8");
	const invalidated = retryableMessage({ errorMessage: "OAuth token invalidated" });
	const events: Array<{ type: string; [key: string]: unknown }> = [];
	const session = {
		model: primary,
		thinkingLevel: "high" as ThinkingLevel,
		_fallbackModels: ["anthropic/claude-opus-4-8:high", "openai-codex/gpt-5.5:low"],
		_fallbackAttemptedKeys: new Set<string>(),
		_fallbackBlockedModels: [] as Model<Api>[],
		_retryAttempt: 0,
		settingsManager: {
			getDefaultThinkingLevel: () => "high" as ThinkingLevel,
			getDefaultProvider: () => "openai-codex",
		},
		_modelRuntime: {
			getAvailableSnapshot: () => [primary, anthropic],
			getModel: (provider: string, id: string) => {
				if (provider === primary.provider && id === primary.id) return primary;
				return provider === anthropic.provider && id === anthropic.id ? anthropic : undefined;
			},
			hasConfiguredAuth: () => true,
		},
		agent: {
			state: { model: primary, thinkingLevel: "high" as ThinkingLevel, messages: [invalidated] },
			continue: async () => undefined,
		},
		sessionManager: {
			appendModelChange: () => undefined,
			appendThinkingLevelChange: () => undefined,
		},
		_withContextWindowForModelSwitch: (candidate: Model<Api>) => candidate,
		_refreshBaseSystemPromptFromActiveTools: () => undefined,
		_emitModelChanged: () => undefined,
		_emitModelSelect: async () => undefined,
		_emit: (event: { type: string; [key: string]: unknown }) => events.push(event),
	};

	// The dead credential moves the turn to Anthropic.
	assert.equal(await _trySwitchToFallbackModel.call(session as never, invalidated), true);
	await new Promise((resolve) => setTimeout(resolve, 5));
	assert.equal(session.agent.state.model, anthropic);

	// A transient Anthropic failure must not return to the blocked Codex model.
	const transient = retryableMessage({ errorMessage: "rate limit exceeded" });
	assert.equal(await _trySwitchToFallbackModel.call(session as never, transient), false);
	assert.equal(session.agent.state.model, anthropic);
	assert.equal(events.filter((event) => event.type === "model_fallback_start").length, 1);
});
