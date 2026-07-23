import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
  RESUME_CONTINUATION_PROMPT,
  shouldInjectResumeContinuation,
} from "../../packages/workflows/src/runs/foreground/executor.js";

describe("resume continuation decision", () => {
  test("uses the exact deterministic continuation prompt", () => {
    assert.equal(
      RESUME_CONTINUATION_PROMPT,
      "Continue where you left off. If you believe you are finished with your original task (or a redefined task if the user told you), stop.",
    );
  });

  test("resume + gate enabled + not aborted injects", () => {
    assert.equal(
      shouldInjectResumeContinuation({
        reason: "resume",
        gateEnabled: true,
        aborted: false,
      }),
      true,
    );
  });

  test("resume reason with gate disabled is a no-op", () => {
    assert.equal(
      shouldInjectResumeContinuation({
        reason: "resume",
        gateEnabled: false,
        aborted: false,
      }),
      false,
    );
  });

  test("queued user message reason does not require the readiness gate", () => {
    assert.equal(
      shouldInjectResumeContinuation({
        reason: "queued-user-message",
        gateEnabled: false,
        aborted: false,
      }),
      true,
    );
  });

  test("aborted run is a no-op", () => {
    assert.equal(
      shouldInjectResumeContinuation({
        reason: "resume",
        gateEnabled: true,
        aborted: true,
      }),
      false,
    );
  });

  test("no resume is a no-op", () => {
    assert.equal(
      shouldInjectResumeContinuation({
        reason: false,
        gateEnabled: true,
        aborted: false,
      }),
      false,
    );
  });
});
