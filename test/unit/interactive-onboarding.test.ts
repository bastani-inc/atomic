import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { ONBOARDING_COPY } from "../../packages/coding-agent/src/modes/interactive/interactive-onboarding.js";

describe("first-run onboarding copy", () => {
  test("is importable from package source through a .js specifier", () => {
    assert.equal(typeof ONBOARDING_COPY, "string");
    assert.notEqual(ONBOARDING_COPY.length, 0);
  });
});
