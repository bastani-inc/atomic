import assert from "node:assert/strict";
import { test } from "vitest";
import { publishedModel } from "./live-catalog-model.ts";

test("Cloudflare Anthropic passthrough uses Anthropic's dashed model IDs", (ctx) => {
	const model = publishedModel("cloudflare-ai-gateway", "claude-sonnet-4-5", ctx);
	assert.ok(model);
	assert.equal(model.id, "claude-sonnet-4-5");
	assert.equal(model.api, "anthropic-messages");
});
