import assert from "node:assert/strict";
import { renderToolOutputType } from "@earendil-works/pi-codemode/declarations";
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

it("declares the CallToolResult scripts receive, keeping references in the server's output schema", () => {
	const content =
		'content: Array<{ data?: string; mimeType?: string; text?: string; type: "text" | "image" | "audio" | "resource_link" | "resource"; [key: string]: unknown; }>; isError?: boolean;';
	assert.equal(
		renderToolOutputType(createMcpResultSchema(undefined) as never),
		`{ ${content} structuredContent?: unknown; [key: string]: unknown; }`,
	);

	const hit = { type: "object", properties: { id: { type: "string" } }, required: ["id"] };
	const schema = createMcpResultSchema({
		type: "object",
		properties: {
			hits: { type: "array", items: { $ref: "#/$defs/Hit~1v1" } },
			again: { $ref: "#/properties/hits" },
			children: { type: "array", items: { $ref: "#" } },
			// A property named like a keyword whose value is data.
			default: { $ref: "#/definitions/Hit" },
			remote: { $ref: "https://example.com/schema.json" },
		},
		required: ["hits"],
		$defs: { "Hit/v1": { ...hit, default: { $ref: "#/stays" } } },
		definitions: { Hit: hit },
	}) as unknown as { properties: { structuredContent: { $defs: Record<string, { default: unknown }> } } };
	// Data that looks like a reference is kept as is.
	assert.deepEqual(schema.properties.structuredContent.$defs["Hit/v1"].default, { $ref: "#/stays" });
	assert.equal(
		renderToolOutputType(schema as never),
		`{ ${content} structuredContent?: { again?: Array<{ id: string; }>; children?: Array<{ again?: Array<{ id: string; }>; children?: Array<unknown>; default?: { id: string; }; hits: Array<{ id: string; }>; remote?: unknown; }>; default?: { id: string; }; hits: Array<{ id: string; }>; remote?: unknown; }; [key: string]: unknown; }`,
	);
});
