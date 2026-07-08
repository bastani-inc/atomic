import { test } from "bun:test";
import assert from "node:assert/strict";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai/compat";
import type { CreateAgentSessionFromServicesOptions } from "../../packages/coding-agent/src/core/agent-session-services.js";
import { _createRetryPromiseForAgentEnd } from "../../packages/coding-agent/src/core/agent-session-events.js";
import {
  _handleRetryableError,
  _isRetryableError,
  _trySwitchToFallbackModel,
} from "../../packages/coding-agent/src/core/agent-session-retry.js";

function model(provider: string, id: string): Model<Api> {
  return {
    provider,
    id,
    api: provider as Api,
    contextWindow: 200_000,
    defaultContextWindow: 200_000,
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
  assert.equal(_isRetryableError.call(session as never, retryableMessage({ errorMessage: "model not found" })), true);
  assert.equal(_isRetryableError.call(session as never, retryableMessage({ errorMessage: undefined, code: "model_not_found" } as unknown as Partial<AssistantMessage>)), true);
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
    _retryAttempt: 0,
    settingsManager: {
      getRetrySettings: () => ({ enabled: true, maxRetries: 0, baseDelayMs: 1 }),
      getDefaultThinkingLevel: () => "high" as ThinkingLevel,
      getDefaultProvider: () => "openai-codex",
    },
    _modelRegistry: {
      getAvailable: () => [primary, fallback],
      find: (provider: string, id: string) => provider === fallback.provider && id === fallback.id ? fallback : undefined,
      hasConfiguredAuth: (candidate: Model<Api>) => candidate.provider === fallback.provider || candidate.provider === primary.provider,
    },
    agent: {
      state: {
        model: primary,
        thinkingLevel: "high" as ThinkingLevel,
        messages: [retryableMessage()],
      },
      continue: async () => { continued = true; },
    },
    sessionManager: {
      appendModelChange: (provider: string, id: string) => events.push({ type: "session_model", provider, id }),
      appendThinkingLevelChange: (level: ThinkingLevel) => events.push({ type: "session_thinking", level }),
    },
    _withContextWindowForModelSwitch: (candidate: Model<Api>) => candidate,
    _appendContextWindowChangeIfChanged: () => undefined,
    _refreshBaseSystemPromptFromActiveTools: () => undefined,
    _emitModelChanged: (next: Model<Api>, previous: Model<Api> | undefined, source: string) => events.push({ type: "model_changed", next: next.id, previous: previous?.id, source }),
    _emitModelSelect: async (next: Model<Api>, previous: Model<Api> | undefined, source: string) => events.push({ type: "model_select", next: next.id, previous: previous?.id, source }),
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
  assert.equal(events.some((event) => event.type === "model_fallback_end"), false);
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

test("main-chat fallback can change reasoning on the same provider/model", async () => {
  const primary = model("openai", "gpt-5-mini");
  const events: Array<{ type: string; [key: string]: unknown }> = [];
  const session = {
    model: primary,
    thinkingLevel: "high" as ThinkingLevel,
    _fallbackModels: ["openai/gpt-5-mini:low"],
    _fallbackAttemptedKeys: new Set<string>(),
    _retryAttempt: 0,
    settingsManager: {
      getDefaultThinkingLevel: () => "high" as ThinkingLevel,
      getDefaultProvider: () => "openai",
    },
    _modelRegistry: {
      getAvailable: () => [primary],
      find: (provider: string, id: string) => provider === primary.provider && id === primary.id ? primary : undefined,
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
    _appendContextWindowChangeIfChanged: () => undefined,
    _refreshBaseSystemPromptFromActiveTools: () => undefined,
    _emitModelChanged: () => undefined,
    _emitModelSelect: async () => undefined,
    _emit: (event: { type: string; [key: string]: unknown }) => events.push(event),
  };

  const handled = await _trySwitchToFallbackModel.call(session as never, retryableMessage());

  assert.equal(handled, true);
  assert.equal(session.agent.state.model, primary);
  assert.equal(session.agent.state.thinkingLevel, "low");
  assert.ok(events.some((event) => event.type === "model_fallback_start"));
  assert.ok(events.some((event) => event.type === "session_thinking" && event.level === "low"));
});

test("service-based SDK session options include fallbackModels", () => {
  const fallbackModels = ["anthropic/claude-opus-4-8:high"] satisfies NonNullable<CreateAgentSessionFromServicesOptions["fallbackModels"]>;
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
    _retryAttempt: 0,
    _retryPromise: undefined as Promise<void> | undefined,
    _retryResolve: undefined as (() => void) | undefined,
    settingsManager: {
      getRetrySettings: () => ({ enabled: false, maxRetries: 0, baseDelayMs: 1 }),
      getDefaultThinkingLevel: () => "high" as ThinkingLevel,
      getDefaultProvider: () => "openai-codex",
    },
    _modelRegistry: {
      getAvailable: () => [primary, fallback],
      find: (provider: string, id: string) => provider === fallback.provider && id === fallback.id ? fallback : undefined,
      hasConfiguredAuth: (candidate: Model<Api>) => candidate.provider === fallback.provider || candidate.provider === primary.provider,
    },
    agent: {
      state: { model: primary, thinkingLevel: "high" as ThinkingLevel, messages: [message] },
      continue: async () => { continued = true; },
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
    _appendContextWindowChangeIfChanged: () => undefined,
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
    _retryAttempt: 1,
    _retryPromise: retryPromise as Promise<void> | undefined,
    _retryResolve: resolveRetry as (() => void) | undefined,
    settingsManager: {
      getDefaultThinkingLevel: () => "high" as ThinkingLevel,
      getDefaultProvider: () => "openai-codex",
    },
    _modelRegistry: {
      getAvailable: () => [primary, fallback],
      find: (provider: string, id: string) => provider === fallback.provider && id === fallback.id ? fallback : undefined,
      hasConfiguredAuth: (candidate: Model<Api>) => candidate.provider === fallback.provider || candidate.provider === primary.provider,
    },
    agent: {
      state: { model: primary, thinkingLevel: "high" as ThinkingLevel, messages: [retryableMessage()] },
      continue: async () => { throw new Error("fallback auth failed"); },
    },
    sessionManager: {
      appendModelChange: () => undefined,
      appendThinkingLevelChange: () => undefined,
    },
    _withContextWindowForModelSwitch: (candidate: Model<Api>) => candidate,
    _appendContextWindowChangeIfChanged: () => undefined,
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
  assert.ok(events.some((event) => event.type === "model_fallback_end" && event.success === false && event.finalError === "fallback auth failed"));
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
    _retryAttempt: 0,
    settingsManager: {
      getDefaultThinkingLevel: () => "high" as ThinkingLevel,
      getDefaultProvider: () => "openai-codex",
    },
    _modelRegistry: {
      getAvailable: () => [primary, fallback],
      find: (provider: string, id: string) => provider === fallback.provider && id === fallback.id ? fallback : undefined,
      hasConfiguredAuth: (candidate: Model<Api>) => candidate.provider === fallback.provider || candidate.provider === primary.provider,
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
    _appendContextWindowChangeIfChanged: () => undefined,
    _refreshBaseSystemPromptFromActiveTools: () => undefined,
    _emitModelChanged: () => undefined,
    _emitModelSelect: async () => undefined,
    _emit: (event: { type: string; [key: string]: unknown }) => events.push(event),
  };

  const handled = await _trySwitchToFallbackModel.call(session as never, retryableMessage());
  assert.equal(handled, true);
  await new Promise((resolve) => setTimeout(resolve, 5));

  assert.equal(session.agent.state.messages.at(-1), fallbackError);
  assert.equal(events.some((event) => event.type === "model_fallback_end" && event.success === true), false);
});
