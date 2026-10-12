import assert from "node:assert/strict";
import { getModel, streamSimple } from "@bastani/pi-ai/compat";
import { describe, it } from "vitest";
import { generateSessionSummary } from "../src/core/compaction/session-summarization.js";
import type { SessionEntry } from "../src/core/session-manager.js";

describe("session summarization with required reasoning", () => {
	it("does not disable required thinking in the Anthropic Opus 5.5 request", async () => {
		const model = getModel("anthropic", "claude-opus-5-5");
		assert.equal(model.thinkingLevelMap?.off, null);
		let payload: { thinking?: { type: string }; max_tokens?: number } | undefined;
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "user-1",
				parentId: null,
				timestamp: new Date(0).toISOString(),
				message: { role: "user", content: "Fix resume picker summaries", timestamp: 0 },
			},
		];

		const result = await generateSessionSummary(entries, {
			model,
			apiKey: "fake-key",
			signal: new AbortController().signal,
			streamFn: (requestModel, context, options) =>
				streamSimple(requestModel, context, {
					...options,
					onPayload: (requestPayload) => {
						payload = requestPayload as typeof payload;
						throw new Error("Captured request before network access");
					},
				}),
		});

		assert.match(result.error ?? "", /Captured request before network access/);
		assert.ok(payload);
		assert.equal(payload.thinking?.type, "adaptive");
		assert.ok((payload.max_tokens ?? 0) > 1024);
	});
});
