import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { type ContentBlock, toLlmContent } from "../../src/extensions/mcp/client/index.js";

describe("toLlmContent", () => {
	it("passes text and images through and replaces other blocks with text", () => {
		const blocks: ContentBlock[] = [
			{ type: "text", text: "hello", annotations: { priority: 1 } },
			{ type: "image", data: "aW1n", mimeType: "image/png", _meta: { x: 1 } },
			{ type: "audio", data: "YXVk", mimeType: "audio/wav" },
			{ type: "resource_link", uri: "file:///a.txt", name: "a.txt" },
			{ type: "resource", resource: { uri: "file:///b.txt", text: "inline" } },
			{ type: "resource", resource: { uri: "file:///c.png", mimeType: "image/png", blob: "Yw==" } },
			{ type: "resource", resource: { uri: "file:///d.bin", blob: "ZA==" } },
		];
		assert.deepEqual(toLlmContent({ content: blocks }), [
			{ type: "text", text: "hello" },
			{ type: "image", data: "aW1n", mimeType: "image/png" },
			{ type: "text", text: "[audio audio/wav omitted]" },
			{ type: "text", text: "a.txt: file:///a.txt" },
			{ type: "text", text: "inline" },
			{ type: "image", data: "Yw==", mimeType: "image/png" },
			{ type: "text", text: "[binary resource file:///d.bin (unknown type) omitted]" },
		]);
	});

	it("falls back to the structured content as JSON when there are no blocks", () => {
		assert.deepEqual(toLlmContent({ content: [], structuredContent: { n: 1 } }), [
			{ type: "text", text: '{\n  "n": 1\n}' },
		]);
		assert.deepEqual(toLlmContent({ content: [{ type: "text", text: "n=1" }], structuredContent: { n: 1 } }), [
			{ type: "text", text: "n=1" },
		]);
	});
});
