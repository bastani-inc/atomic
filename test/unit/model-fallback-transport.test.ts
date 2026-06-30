import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
  isRetryableModelFailure,
  normalizeModelFailureSignal,
} from "../../packages/workflows/src/runs/shared/model-fallback.js";

describe("workflow model fallback transport failures", () => {
  test("classifies generic connection failures as transport errors for provider-aware fallback", () => {
    const assistantFailure = {
      role: "assistant",
      stopReason: "error",
      errorMessage: "Connection error.",
    };

    const directSignal = normalizeModelFailureSignal(assistantFailure);
    assert.equal(directSignal.kind, "transport_error");
    assert.equal(directSignal.source, "assistant_message");
    assert.equal(isRetryableModelFailure(assistantFailure), true);

    const wrappedSignal = normalizeModelFailureSignal(
      new Error("Connection error.", { cause: assistantFailure }),
    );
    assert.equal(wrappedSignal.kind, "transport_error");
    assert.equal(isRetryableModelFailure(new Error("Connection error.", { cause: assistantFailure })), true);
  });
});
