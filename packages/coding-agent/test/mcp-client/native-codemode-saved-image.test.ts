import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/pi-ai/compat";
import { test } from "vitest";
import { createCodemodeExtension } from "../../src/extensions/codemode/index.js";
import { type JsonRpcRequest, LATEST_PROTOCOL_VERSION } from "../../src/extensions/mcp/client/index.js";
import { createInMemoryTransportPair } from "../../src/extensions/mcp/client/testing/index.js";
import { createMcpExtension } from "../../src/extensions/mcp/index.js";
import { createHarness } from "../suite/harness.js";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.js";
import { createTestUiContext } from "./native-test-ui.js";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

test("codemode MCP images follow their saved label without shifting later output (#3429)", async () => {
	const pair = createInMemoryTransportPair();
	pair.server.onMessage((message) => {
		if (!("id" in message) || !("method" in message)) return;
		const request = message as JsonRpcRequest;
		const result =
			request.method === "initialize"
				? {
						protocolVersion: LATEST_PROTOCOL_VERSION,
						capabilities: { tools: {} },
						serverInfo: { name: "shots", version: "1" },
					}
				: request.method === "tools/list"
					? {
							tools: [
								{
									name: "shot",
									description: "Returns an image",
									inputSchema: { type: "object", properties: {} },
								},
							],
						}
					: request.method === "tools/call"
						? { content: [{ type: "image", data: PNG, mimeType: "image/png" }] }
						: {};
		queueMicrotask(() => void pair.server.send({ jsonrpc: "2.0", id: request.id, result }));
	});
	await pair.server.start();
	const extensions = await createTestExtensionsResult([
		{ factory: createCodemodeExtension(), path: "builtin:codemode" },
		createMcpExtension({
			loadConfig: () => ({
				servers: [
					{ name: "shots", config: { url: "http://unused.invalid", exposure: "codemode" }, source: "test" },
				],
				errors: [],
			}),
			createTransport: () => pair.client,
		}),
	]);
	const harness = await createHarness({
		resourceLoader: { ...createTestResourceLoader(), getExtensions: () => extensions },
		initialActiveToolNames: ["codemode"],
	});
	let savedPath: string | undefined;
	try {
		await harness.session.bindExtensions({ uiContext: createTestUiContext() });
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("codemode", {
						code: "const shot = await tools.mcp__shots__shot({}); image(shot.content[0]); text({ done: true });",
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("take screenshot");
		const result = harness.session.messages.find((item) => item.role === "toolResult");
		assert.ok(result?.role === "toolResult");
		assert.equal(result.isError, false, JSON.stringify(result.content));
		assert.ok(result.content[1].type === "text");
		savedPath = /^\[Image saved to (\S+\.png) \(image\/png, \d+B\)\]$/.exec(result.content[1].text)?.[1];
		assert.ok(savedPath);
		assert.equal(readFileSync(savedPath).toString("base64"), PNG);
		assert.deepEqual(result.content[2], { type: "image", data: PNG, mimeType: "image/png" });
		assert.deepEqual(result.content[3], { type: "text", text: '{"done":true}' });
		assert.equal(result.content.length, 4);
	} finally {
		if (savedPath) rmSync(savedPath, { force: true });
		await harness.cleanup();
		await pair.server.close();
	}
});
