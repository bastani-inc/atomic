import assert from "node:assert/strict";
import { test } from "vitest";
import { getModel } from "../src/compat.js";

test("Cloudflare Anthropic passthrough uses Anthropic's dashed model IDs", () => {
	const model = getModel("cloudflare-ai-gateway", "claude-sonnet-4-5");
	assert.ok(model);
	assert.equal(model.id, "claude-sonnet-4-5");
	assert.equal(model.api, "anthropic-messages");
});
