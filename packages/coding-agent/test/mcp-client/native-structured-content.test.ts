import assert from "node:assert/strict";
import { it } from "vitest";
import { convertMcpResult, createMcpResultSchema } from "../../src/extensions/mcp/tools.js";

it("preserves any JSON structured content for MCP scripts and model output (#10416)", async () => {
	assert.deepEqual(createMcpResultSchema(undefined).properties.structuredContent, {});
	for (const structuredContent of [[{ id: 1 }], null, "text", 3, false, { ok: true }]) {
		assert.deepEqual(await convertMcpResult("docs", "t", { content: [], structuredContent }), {
			content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
			details: { server: "docs", tool: "t" },
			structuredContent: { content: [], structuredContent },
		});
	}
});
