import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
  RESUME_CONTINUATION_PROMPT,
  shouldInjectResumeContinuation,
} from "../../packages/workflows/src/runs/foreground/executor.js";

describe("resume continuation decision", () => {
  test("uses the exact deterministic continuation prompt", () => {
    assert.equal(RESUME_CONTINUATION_PROMPT, "Continue where you left off.");
  });

  test("resume + gate enabled + not aborted injects", () => {
    assert.equal(
      shouldInjectResumeContinuation({
        resumeOccurred: true,
        gateEnabled: true,
        aborted: false,
      }),
      true,
    );
  });

  test("gate disabled is a no-op", () => {
    assert.equal(
      shouldInjectResumeContinuation({
        resumeOccurred: true,
        gateEnabled: false,
        aborted: false,
      }),
      false,
    );
  });

  test("aborted run is a no-op", () => {
    assert.equal(
      shouldInjectResumeContinuation({
        resumeOccurred: true,
        gateEnabled: true,
        aborted: true,
      }),
      false,
    );
  });

  test("no resume is a no-op", () => {
    assert.equal(
      shouldInjectResumeContinuation({
        resumeOccurred: false,
        gateEnabled: true,
        aborted: false,
      }),
      false,
    );
  });
});
