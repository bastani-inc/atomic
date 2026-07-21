import { test } from "bun:test";
import assert from "node:assert/strict";
import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
import { formatCodexProviderError } from "../../packages/coding-agent/src/core/codex-errors.js";
import {
  _applyProviderErrorGuidance,
  _createRetryPromiseForAgentEnd,
} from "../../packages/coding-agent/src/core/agent-session-events.js";
import { _isRetryableError } from "../../packages/coding-agent/src/core/agent-session-retry.js";

const GUIDANCE =
  "This Codex session may no longer be valid. Retry the request once in case the rejection is transient. If it persists, run `/logout` and select OpenAI ChatGPT Plus/Pro. Then run `/login`, authenticate OpenAI ChatGPT Plus/Pro again, and retry the request.";

function errorMessage(errorMessage: string, diagnostics?: object[]): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    provider: "openai-codex",
    model: "gpt-5.5",
    api: "openai-codex-responses",
    stopReason: "error",
    errorMessage,
    diagnostics,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: Date.now(),
  } as AssistantMessage;
}

const session = { model: { provider: "openai-codex", contextWindow: 200_000 } };

test("Codex invalidated OAuth errors include actionable reauthentication guidance", () => {
  const original = "Codex error: invalidated oauth token (request id: redacted)";
  assert.equal(formatCodexProviderError("openai-codex", original), `${original}\n\n${GUIDANCE}`);
});

test("Codex invalidated auth and token_revoked wording receive the same guidance", () => {
  for (const original of ["Codex error: invalidated auth token", "Codex error: token_revoked"]) {
    assert.equal(formatCodexProviderError("openai-codex", original), `${original}\n\n${GUIDANCE}`);
  }
});

test("Codex recovery guidance preserves unrelated errors and is idempotent", () => {
  assert.equal(formatCodexProviderError("openai-codex", "Codex error: usage limit"), "Codex error: usage limit");
  assert.equal(formatCodexProviderError("openai", "invalidated oauth token"), "invalidated oauth token");

  const guided = formatCodexProviderError("openai-codex", "Codex error: token_revoked");
  assert.equal(formatCodexProviderError("openai-codex", guided), guided);
});

test("definitive Codex token invalidation overrides an earlier transport diagnostic", () => {
  const diagnostic = {
    type: "provider_transport_failure",
    timestamp: Date.now(),
    error: { message: "WebSocket error; falling back to SSE", status: 404 },
  };

  for (const wording of ["invalidated oauth token", "invalidated auth token", "token_revoked"]) {
    const message = errorMessage(`Codex error: ${wording}`, [diagnostic]);
    assert.equal(_isRetryableError.call(session as never, message), false, wording);
  }
});

test("transport diagnostics remain retryable for other Codex errors", () => {
  const message = errorMessage("Codex error: request failed", [
    { type: "provider_transport_failure", error: { message: "WebSocket error" } },
  ]);
  assert.equal(_isRetryableError.call(session as never, message), true);
});

test("main-chat event handling renders guidance and does not open a retry lifecycle", () => {
  const message = errorMessage("Codex error: invalidated oauth token", [
    { type: "provider_transport_failure", error: { message: "WebSocket error" } },
  ]);
  const event = { type: "message_end", message } as const;
  const retrySession = {
    model: session.model,
    _retryPromise: undefined as Promise<void> | undefined,
    _retryResolve: undefined as (() => void) | undefined,
    _fallbackModels: [],
    settingsManager: { getRetrySettings: () => ({ enabled: true }) },
    _findLastAssistantInMessages: () => message,
    _isRetryableError,
    _isEmptyCompletion: () => false,
    _isSafetyRefusal: () => false,
  };

  _createRetryPromiseForAgentEnd.call(retrySession as never, { type: "agent_end", messages: [message] });
  assert.equal(retrySession._retryPromise, undefined);

  _applyProviderErrorGuidance.call(retrySession as never, event as never);
  assert.equal(message.errorMessage, `Codex error: invalidated oauth token\n\n${GUIDANCE}`);
});
