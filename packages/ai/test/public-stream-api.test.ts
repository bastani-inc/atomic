import assert from "node:assert/strict";
import { test } from "vitest";
import * as ai from "../src/index.ts";

test("exports event streams without the removed assistant-message frame API", () => {
	assert.equal("AssistantMessageFrameEncoder" in ai, false);
	assert.equal("reduceAssistantMessageFrames" in ai, false);
	assert.equal(typeof ai.AssistantMessageEventStream, "function");
	assert.equal(typeof ai.createAssistantMessageEventStream, "function");
});
