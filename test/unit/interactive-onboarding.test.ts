import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { ONBOARDING_COPY } from "../../packages/coding-agent/src/modes/interactive/interactive-onboarding.js";

describe("first-run onboarding copy", () => {
  test("describes Atomic as a verifiable runtime without smart routing instructions", () => {
    assert.match(ONBOARDING_COPY, /verifiable coding agent runtime/i);
    assert.match(ONBOARDING_COPY, /verifiable software factory/i);
    assert.match(ONBOARDING_COPY, /Type a message or slash command below to continue normally/i);
    assert.doesNotMatch(ONBOARDING_COPY, /Paste a ticket/i);
    assert.doesNotMatch(ONBOARDING_COPY, /\/chat/i);
    assert.doesNotMatch(ONBOARDING_COPY, /goal.*ralph|ralph.*goal/i);
  });
});
