import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { readRuntimeIntercomGroup, runtimeIntercomGroupEnvKey } from "../src/core/intercom-runtime-group.ts";

afterEach(() => vi.unstubAllEnvs());

test("an empty stored session ID retains its own runtime group", () => {
	vi.stubEnv(runtimeIntercomGroupEnvKey(""), "selected-group");
	assert.equal(readRuntimeIntercomGroup(""), "selected-group");
	assert.equal(readRuntimeIntercomGroup(undefined), undefined);
});
